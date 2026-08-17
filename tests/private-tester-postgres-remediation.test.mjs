import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { applyPostgresMigrations, loadPostgresMigrations } from "../scripts/migrate.ts";
import { registerRolloutController } from "../scripts/register-rollout-controller.ts";

const execFile = promisify(execFileCallback);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const aclGatePath = fileURLToPath(new URL("../scripts/private-tester-baseline-acl-gate.sql", import.meta.url));
const verifierDatabaseUser = "nearyou-private-tester-baseline@nearnight.iam.gserviceaccount.com";
const historicalMigrations = Object.freeze([
  ["0001_nearyou_tenant_foundation", "ae9a5e8f26190063382d76eae25565a6a991523edf6ceefa1abd74b1fd88a194"],
  ["0002_release_evidence_trust", "7ec295cb252f9d8cf54d951e899a59ddb834a1204de951a7d967eeeaf67c11f8"],
  ["0003_cutover_runtime", "ed449236853519c58fabbd13eca2587c515447bdff81b3a6153d9afe0436aede"],
  ["0004_product_readiness_evidence", "481c48d0b1ca224decdf5b049325ec44c048b7dcc90572c24a66dd2d1e5301c9"],
  ["0005_operational_evidence", "c8a30cc75d0bfb0debb2a0295d93cd3a47a42b88f738be18f00a5ecbbd10f824"],
  ["0006_private_canary_observation", "c0cfafb21767040dca10511c756bbdfdd4373a84cd6f3e2184310be9e7748500"],
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const migrationBody = (sql) => sql.replace(/^\s*BEGIN;\s*/i, "").replace(/\s*COMMIT;\s*$/i, "");
const ledgerChecksum = (files) => sha256(files.map((file) => `${file.id}:${file.checksum}`).join("\n"));

test("historical PostgreSQL ledger through 0006 upgrades forward through 0007 without conflict", async () => {
  const files = await loadPostgresMigrations();
  assert.notDeepEqual(files.slice(0, 3).map(({ id, checksum }) => [id, checksum]), historicalMigrations.slice(0, 3));
  assert.deepEqual(files.slice(3, 6).map(({ id, checksum }) => [id, checksum]), historicalMigrations.slice(3, 6));
  assert.equal(files[6]?.id, "0007_private_tester_deployment_manifest");

  const ledger = new Map(historicalMigrations);
  const executedBodies = [];
  const ledgerInserts = [];
  const pg = {
    transaction: async (run) => run({
      query: async (sql, args = []) => {
        if (sql.startsWith("SELECT checksum FROM nearyou.schema_migrations")) {
          const checksum = ledger.get(args[0]);
          return { rows: checksum ? [{ checksum }] : [] };
        }
        if (sql.startsWith("INSERT INTO nearyou.schema_migrations")) {
          ledgerInserts.push(args);
          ledger.set(args[0], args[1]);
          return { rows: [] };
        }
        if (sql.startsWith("SELECT pg_advisory_xact_lock") || sql.startsWith("CREATE SCHEMA IF NOT EXISTS") || sql.startsWith("CREATE TABLE IF NOT EXISTS")) return { rows: [] };
        executedBodies.push(sql);
        return { rows: [] };
      },
    }),
  };

  await applyPostgresMigrations(pg, files, ledgerChecksum(files));

  assert.deepEqual([...ledger], [...historicalMigrations, [files[6].id, files[6].checksum]]);
  assert.deepEqual(executedBodies, [migrationBody(files[6].sql)]);
  assert.match(executedBodies[0], /DROP FUNCTION nearyou\.register_rollout_controller_identity\(name,text\)/);
  assert.match(executedBodies[0], /CREATE FUNCTION nearyou\.register_rollout_controller_identity\(p_database_user name,p_principal text\) RETURNS TABLE\(database_user text,principal text,effective boolean\)/);
  assert.match(executedBodies[0], /pg_has_role\(p_database_user,'nearyou_rollout_controller','USAGE'\)/);
  assert.match(executedBodies[0], /ALTER ROLE nearyou_policy_owner NOLOGIN NOINHERIT NOBYPASSRLS/);
  assert.match(executedBodies[0], /CREATE POLICY policy_owner_member_select ON nearyou\.household_members FOR SELECT TO nearyou_policy_owner USING \(true\)/);

  await applyPostgresMigrations(pg, files, ledgerChecksum(files));
  assert.equal(executedBodies.length, 1, "a fully ledgered replay must execute no migration body");
  assert.deepEqual(ledgerInserts, [[files[6].id, files[6].checksum]], "the upgrade must only append 0007 to the ledger");
});

test("Cloud SQL policy owners use narrow RLS policy access instead of unavailable BYPASSRLS", async () => {
  const first = await readFile(new URL("../postgres/migrations/0001_nearyou_tenant_foundation.sql", import.meta.url), "utf8");
  const release = await readFile(new URL("../postgres/migrations/0002_release_evidence_trust.sql", import.meta.url), "utf8");
  const cutover = await readFile(new URL("../postgres/migrations/0003_cutover_runtime.sql", import.meta.url), "utf8");
  assert.doesNotMatch(`${first}\n${release}\n${cutover}`, /\bBYPASSRLS\b/);
  assert.match(first, /CREATE POLICY policy_owner_member_select ON nearyou\.household_members FOR SELECT TO nearyou_policy_owner\s+USING \(true\)/);
  assert.match(first, /CREATE POLICY member_select ON nearyou\.household_members FOR SELECT TO nearyou_app/);
});

test("migration compatibility accepts only the three exact retired checksums", async () => {
  const files = await loadPostgresMigrations();
  const pg = {
    transaction: async (run) => run({
      query: async (sql, args = []) => {
        if (sql.startsWith("SELECT checksum FROM nearyou.schema_migrations")) {
          return { rows: args[0] === files[0].id ? [{ checksum: "f".repeat(64) }] : [] };
        }
        return { rows: [] };
      },
    }),
  };
  await assert.rejects(() => applyPostgresMigrations(pg, files, ledgerChecksum(files)), /migration ledger conflict/);
});

test("production evidence builds the catalog from the complete 0001 through 0007 migration set", async () => {
  const workflow = await readFile(new URL("../.github/workflows/production-evidence.yml", import.meta.url), "utf8");
  assert.match(workflow, /Apply PostgreSQL migrations 0001-0007 in reviewed order/);
  assert.match(workflow, /node --import tsx scripts\/apply-catalog-migrations\.ts/);
  assert.doesNotMatch(workflow, /for migration in postgres\/migrations/);
  assert.doesNotMatch(workflow, /Apply PostgreSQL migrations 0001-0006 in reviewed order/);
});

test("baseline ACL gate has deliberate failure semantics for every negative assertion", async () => {
  const sql = await readFile(aclGatePath, "utf8");
  assert.match(sql, /\\quit 3/);
  assert.doesNotMatch(sql, /\\quit\s*(?:\r?\n|$)/);
  assert.match(sql, /IF nearyou\.consume_private_tester_deployment_manifest[\s\S]*IS DISTINCT FROM false THEN RAISE EXCEPTION 'invalid manifest nonce unexpectedly accepted'/);
  assert.match(sql, /has_function_privilege\('nearyou_release_verifier','nearyou\.consume_private_tester_deployment_manifest[^']*','EXECUTE'\).*RAISE EXCEPTION 'generic release verifier can consume baseline nonce'/);
  assert.match(sql, /has_table_privilege\('nearyou_rollout_controller','nearyou\.schema_migrations','SELECT'\).*RAISE EXCEPTION 'controller can read migration ledger'/);
  assert.match(sql, /has_table_privilege\('nearyou_rollout_controller','nearyou\.private_tester_baseline_verifier_identities','SELECT,INSERT,UPDATE,DELETE'\).*RAISE EXCEPTION 'controller baseline ACL widened'/);
  assert.match(sql, /SELECT \* FROM nearyou\.private_tester_baseline_verifier_identities/);
  assert.match(sql, /\\if :ERROR[\s\S]*raw mapping SELECT denied as expected[\s\S]*\\else[\s\S]*RAISE EXCEPTION 'raw mapping SELECT unexpectedly allowed'/);
});

async function findPsql() {
  const command = process.env.NEARYOU_TEST_PSQL ?? "psql";
  try {
    await access(command);
  } catch {
    if (command.includes("/")) return undefined;
  }
  try {
    await execFile(command, ["--version"], { timeout: 10_000 });
    return command;
  } catch {
    return undefined;
  }
}

const psql = await findPsql();
test("baseline ACL gate process exits nonzero when the verifier URL is missing", { skip: psql ? false : "psql is unavailable" }, async () => {
  await assert.rejects(
    execFile(psql, ["-X", "-f", aclGatePath], { cwd: repositoryRoot, timeout: 10_000 }),
    (error) => error.code === 3,
  );
});

const disposablePostgresUrl = process.env.NEARYOU_TEST_POSTGRES16_DATABASE_URL;
test("disposable PostgreSQL 16 executes the historical 0006 to 0007 upgrade and ACL process", { skip: disposablePostgresUrl ? false : "NEARYOU_TEST_POSTGRES16_DATABASE_URL is unset" }, async () => {
  assert.equal(process.env.NEARYOU_TEST_POSTGRES16_DISPOSABLE, "true", "PostgreSQL integration target must be explicitly disposable");
  assert.ok(psql, "psql is required when the PostgreSQL 16 integration target is enabled");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: disposablePostgresUrl });
  const client = await pool.connect();
  const pg = {
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
    const target = (await client.query("SELECT current_database()::text AS database_name,current_setting('server_version_num')::integer AS server_version,to_regnamespace('nearyou') IS NULL AS pristine")).rows[0];
    assert.equal(target.database_name, "nearyou");
    assert.ok(target.server_version >= 160000 && target.server_version < 170000, "integration target must run PostgreSQL 16");
    assert.equal(target.pristine, true, "integration target must be a pristine disposable database");
    assert.equal((await client.query("SELECT EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='vector') AS available")).rows[0].available, true, "integration target must provide pgvector");

    const files = await loadPostgresMigrations();
    assert.deepEqual(files.slice(0, 6).map(({ id, checksum }) => [id, checksum]), historicalMigrations);
    await applyPostgresMigrations(pg, files.slice(0, 6), ledgerChecksum(files.slice(0, 6)));
    assert.deepEqual((await client.query("SELECT id,checksum FROM nearyou.schema_migrations ORDER BY id COLLATE \"C\"")).rows.map(({ id, checksum }) => [id, checksum]), historicalMigrations);
    await applyPostgresMigrations(pg, files, ledgerChecksum(files));

    const controllerDatabaseUser = "nearyou-readiness-ctl@nearnight.iam.gserviceaccount.com";
    await client.query(`CREATE ROLE "${controllerDatabaseUser}" LOGIN`);
    const controller = await registerRolloutController(pg, controllerDatabaseUser, "service:nearyou-readiness-controller");
    assert.deepEqual(controller.artifact, { databaseUser: controllerDatabaseUser, principal: "service:nearyou-readiness-controller", effective: true });
    assert.deepEqual((await registerRolloutController(pg, controllerDatabaseUser, "service:nearyou-readiness-controller")).artifact, controller.artifact, "controller registration must converge after retry");

    const password = randomBytes(24).toString("base64url");
    await client.query(`CREATE ROLE "${verifierDatabaseUser}" LOGIN PASSWORD '${password}'`);
    await client.query(`GRANT nearyou_private_tester_baseline_verifier TO "${verifierDatabaseUser}" WITH INHERIT TRUE, SET TRUE`);
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE nearyou_migration");
      const registered = (await client.query("SELECT database_user,principal,effective FROM nearyou.register_private_tester_baseline_verifier_identity($1::name,$2)", [verifierDatabaseUser, "service:nearyou-private-tester-baseline-verifier"])).rows[0];
      assert.deepEqual(registered, { database_user: verifierDatabaseUser, principal: "service:nearyou-private-tester-baseline-verifier", effective: true });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const verifierUrl = new URL(disposablePostgresUrl);
    verifierUrl.username = verifierDatabaseUser;
    verifierUrl.password = password;
    await execFile(psql, ["-X", "-v", "ON_ERROR_STOP=1", "-v", `verifier_database_url=${verifierUrl.toString()}`, "-f", aclGatePath], { cwd: repositoryRoot, timeout: 60_000 });

    const finalLedger = (await client.query("SELECT id,checksum FROM nearyou.schema_migrations ORDER BY id COLLATE \"C\"")).rows;
    assert.deepEqual(finalLedger.map(({ id, checksum }) => [id, checksum]), files.map(({ id, checksum }) => [id, checksum]));
    assert.equal((await client.query("SELECT has_function_privilege('nearyou_release_verifier','nearyou.consume_private_tester_deployment_manifest(text,text,text,text,text,text,integer,text,timestamptz)','EXECUTE') AS allowed")).rows[0].allowed, false);
  } finally {
    client.release();
    await pool.end();
  }
});
