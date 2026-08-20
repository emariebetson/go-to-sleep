import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { applyPostgresMigrations, loadPostgresMigrations } from "../scripts/migrate.ts";

const migrationPath = new URL("../postgres/migrations/0012_nearfamily_private_tester_decision.sql", import.meta.url);
const manifestPath = new URL("../postgres/catalog-manifest.json", import.meta.url);
const terraformPath = new URL("../infra/production/main.tf", import.meta.url);

test("NearFamily decision migration defines the fixed execute-only authority", () => {
  assert.equal(existsSync(migrationPath), true, "the NearFamily decision migration must exist");
  const sql = readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE FUNCTION nearyou\.authorize_nearfamily_private_tester\(p_household_hash text,p_release_id text,p_observed_at timestamptz\) RETURNS TABLE\(allowed boolean,expires_at timestamptz\)/);
  assert.match(sql, /s\.product='nearfamily'/);
  assert.match(sql, /s\.release_id=p_release_id/);
  assert.match(sql, /i\.household_hash=p_household_hash/);
  assert.match(sql, /i\.release_id=p_release_id/);
  assert.match(sql, /i\.revoked_at IS NULL/);
  assert.match(sql, /NOT s\.terminal_kill/);
  assert.match(sql, /i\.expires_at>p_observed_at/);
  assert.match(sql, /i\.expires_at>statement_timestamp\(\)/);
  assert.match(sql, /CREATE ROLE nearyou_private_tester_decision NOLOGIN NOINHERIT/);
  assert.match(sql, /IF EXISTS\(SELECT 1 FROM pg_roles WHERE rolname='nearyou_private_tester_decision'\) THEN\s+RAISE EXCEPTION 'private tester decision role already exists'/);
  assert.match(sql, /REVOKE nearyou_private_tester_decision FROM nearyou_rollout_controller/);
  assert.match(sql, /REVOKE nearyou_rollout_controller FROM nearyou_private_tester_decision/);
  assert.match(sql, /REVOKE ALL ON FUNCTION nearyou\.authorize_nearfamily_private_tester\(text,text,timestamptz\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION nearyou\.authorize_nearfamily_private_tester\(text,text,timestamptz\) TO nearyou_private_tester_decision/);
});

test("catalog and production Terraform require the 0012 decision authority and complete forced-RLS set", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const terraform = readFileSync(terraformPath, "utf8");
  const forcedRls = [
    "household_members",
    "tenant_records",
    "private_tester_activation_baselines",
    "private_tester_activation_state",
    "private_tester_activation_invites",
    "private_tester_activation_audit",
  ];

  assert.equal(manifest.migrationHead, "0012_nearfamily_private_tester_decision");
  assert.deepEqual(manifest.requireForcedRls, forcedRls);
  assert.match(terraform, /migrationHead, ""\) == "0012_nearfamily_private_tester_decision"/);
  assert.match(terraform, /requireForcedRls, \[\]\) == \["household_members", "tenant_records", "private_tester_activation_baselines", "private_tester_activation_state", "private_tester_activation_invites", "private_tester_activation_audit"\]/);
});

const disposablePostgresUrl = process.env.NEARYOU_TEST_POSTGRES16_DATABASE_URL;
test("disposable PostgreSQL 16 gives the decision identity only fixed NearFamily read authority", { skip: disposablePostgresUrl ? false : "NEARYOU_TEST_POSTGRES16_DATABASE_URL is unset" }, async () => {
  assert.equal(process.env.NEARYOU_TEST_POSTGRES16_DISPOSABLE, "true", "PostgreSQL integration target must be explicitly disposable");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: disposablePostgresUrl });
  const client = await pool.connect();
  const decisionUser = "nearyou-pt-decision@nearnight.iam";
  const controllerUser = "nearyou-readiness-ctl@nearnight.iam";
  const decisionPassword = randomBytes(24).toString("base64url");
  const hash = "a".repeat(64);
  const deniedHash = "b".repeat(64);
  const release = "rel_20260819_nearfamily_01";
  const query = "SELECT allowed,expires_at FROM nearyou.authorize_nearfamily_private_tester($1,$2,$3)";
  const transactionalPg = {
    transaction: async (run) => {
      await client.query("BEGIN");
      try {
        const result = await run({ query: (sql, args = []) => client.query(sql, args) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  };

  try {
    const target = (await client.query("SELECT current_database()::text AS database_name,current_setting('server_version_num')::integer AS server_version,to_regnamespace('nearyou') IS NULL AS pristine,EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='vector') AS vector_available")).rows[0];
    assert.equal(target.database_name, "nearyou");
    assert.ok(target.server_version >= 160000 && target.server_version < 170000, "integration target must run PostgreSQL 16");
    assert.equal(target.pristine, true, "integration target must be a pristine disposable database");
    assert.equal(target.vector_available, true, "integration target must provide pgvector");

    const migrations = await loadPostgresMigrations();
    const checksum = (await import("node:crypto")).createHash("sha256").update(migrations.map(({ id, checksum }) => `${id}:${checksum}`).join("\n")).digest("hex");
    const priorMigrations = migrations.slice(0, -1);
    const priorChecksum = (await import("node:crypto")).createHash("sha256").update(priorMigrations.map(({ id, checksum }) => `${id}:${checksum}`).join("\n")).digest("hex");
    await applyPostgresMigrations(transactionalPg, priorMigrations, priorChecksum);
    await client.query("CREATE ROLE nearyou_private_tester_decision LOGIN");
    await assert.rejects(() => applyPostgresMigrations(transactionalPg, migrations, checksum), /migration execution failed:0012_nearfamily_private_tester_decision/);
    await client.query("DROP ROLE nearyou_private_tester_decision");
    await applyPostgresMigrations(transactionalPg, migrations, checksum);
    await client.query(`CREATE ROLE "${decisionUser}" LOGIN PASSWORD '${decisionPassword}'`);
    await client.query(`CREATE ROLE "${controllerUser}" LOGIN`);
    await client.query(`GRANT nearyou_private_tester_decision TO "${decisionUser}" WITH INHERIT TRUE, SET TRUE`);
    await client.query(`GRANT nearyou_rollout_controller TO "${controllerUser}" WITH INHERIT TRUE, SET TRUE`);

    const memberships = (await client.query("SELECT member.rolname AS member,role.rolname AS role FROM pg_auth_members membership JOIN pg_roles member ON member.oid=membership.member JOIN pg_roles role ON role.oid=membership.roleid WHERE member.rolname IN ($1,$2) AND role.rolname LIKE 'nearyou_%' ORDER BY member,role", [controllerUser, decisionUser])).rows;
    assert.deepEqual(memberships, [
      { member: decisionUser, role: "nearyou_private_tester_decision" },
      { member: controllerUser, role: "nearyou_rollout_controller" },
    ]);
    const grants = (await client.query("SELECT has_function_privilege($1,'nearyou.authorize_nearfamily_private_tester(text,text,timestamptz)','EXECUTE') AS decision_execute,has_function_privilege($2,'nearyou.authorize_nearfamily_private_tester(text,text,timestamptz)','EXECUTE') AS controller_execute,has_table_privilege($1,'nearyou.private_tester_activation_state','SELECT,INSERT,UPDATE,DELETE') AS decision_state,has_table_privilege($1,'nearyou.private_tester_activation_invites','SELECT,INSERT,UPDATE,DELETE') AS decision_invites,has_table_privilege($2,'nearyou.private_tester_activation_state','SELECT,INSERT,UPDATE,DELETE') AS controller_state,has_table_privilege($2,'nearyou.private_tester_activation_invites','SELECT,INSERT,UPDATE,DELETE') AS controller_invites", [decisionUser, controllerUser])).rows[0];
    assert.deepEqual(grants, { decision_execute: true, controller_execute: false, decision_state: false, decision_invites: false, controller_state: false, controller_invites: false });
    const effectiveTablePrivileges = (await client.query("SELECT principal,namespace.nspname||'.'||relation.relname AS identity FROM (VALUES ($1::text),($2::text)) identities(principal) JOIN pg_class relation ON relation.relkind IN ('r','p','v','m','f') JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname='nearyou' AND has_table_privilege(principal,relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ORDER BY principal,identity", [decisionUser, controllerUser])).rows;
    assert.deepEqual(effectiveTablePrivileges, [], "decision and controller identities may not directly access any Nearyou relation");
    const effectiveDecisionFunctions = (await client.query("SELECT procedure.proname FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace WHERE namespace.nspname='nearyou' AND has_function_privilege($1,procedure.oid,'EXECUTE') ORDER BY procedure.proname", [decisionUser])).rows;
    assert.deepEqual(effectiveDecisionFunctions, [{ proname: "authorize_nearfamily_private_tester" }], "the decision identity may execute only the fixed NearFamily function");

    await client.query("UPDATE nearyou.private_tester_activation_state SET release_id=$1,terminal_kill=false WHERE product='nearfamily'", [release]);
    await client.query("INSERT INTO nearyou.private_tester_activation_invites(product,household_hash,release_id,expires_at) VALUES('nearfamily',$1,$2,statement_timestamp()+interval '10 minutes')", [hash, release]);
    const decisionUrl = new URL(disposablePostgresUrl);
    decisionUrl.username = decisionUser;
    decisionUrl.password = decisionPassword;
    const decisionPool = new Pool({ connectionString: decisionUrl.toString() });
    try {
      const decide = async (householdHash, releaseId) => {
        const observed = (await decisionPool.query("SELECT statement_timestamp() AS observed_at")).rows[0].observed_at;
        return (await decisionPool.query(query, [householdHash, releaseId, observed])).rows[0];
      };
      const invited = await decide(hash, release);
      assert.equal(invited.allowed, true);
      assert.ok(invited.expires_at instanceof Date);
      assert.deepEqual(await decide(deniedHash, release), { allowed: false, expires_at: null });
      assert.deepEqual(await decide(hash, "rel_20260819_nearfamily_other_01"), { allowed: false, expires_at: null });
      await client.query("UPDATE nearyou.private_tester_activation_invites SET expires_at=statement_timestamp()-interval '1 second' WHERE product='nearfamily' AND household_hash=$1", [hash]);
      assert.deepEqual(await decide(hash, release), { allowed: false, expires_at: null });
      await client.query("UPDATE nearyou.private_tester_activation_invites SET expires_at=statement_timestamp()+interval '10 minutes',revoked_at=statement_timestamp() WHERE product='nearfamily' AND household_hash=$1", [hash]);
      assert.deepEqual(await decide(hash, release), { allowed: false, expires_at: null });
      await client.query("UPDATE nearyou.private_tester_activation_invites SET revoked_at=NULL WHERE product='nearfamily' AND household_hash=$1", [hash]);
      await client.query("UPDATE nearyou.private_tester_activation_state SET terminal_kill=true WHERE product='nearfamily'");
      assert.deepEqual(await decide(hash, release), { allowed: false, expires_at: null });
      await assert.rejects(() => decisionPool.query("UPDATE nearyou.private_tester_activation_state SET terminal_kill=true WHERE product='nearfamily'"), /permission denied/);
    } finally {
      await decisionPool.end();
    }

    const state = await client.query("SELECT terminal_kill FROM nearyou.private_tester_activation_state WHERE product='nearfamily'");
    assert.equal(state.rows[0].terminal_kill, true, "the controller's terminal kill must remain in force after decision calls");
  } finally {
    client.release();
    await pool.end();
  }
});
