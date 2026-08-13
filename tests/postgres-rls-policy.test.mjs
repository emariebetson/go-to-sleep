import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { withPostgresTenant } from "../lib/postgres-tenant.ts";

const sql = readFileSync(new URL("../postgres/migrations/0001_nearyou_tenant_foundation.sql", import.meta.url), "utf8");

function hasTopLevelComma(value) {
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) return true;
  }
  return false;
}

function multiObjectOwnerStatements(source) {
  return source
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => /^ALTER\s+(?:FUNCTION|TABLE|SEQUENCE)\s+/i.test(statement) && /\sOWNER\s+TO\s+/i.test(statement))
    .filter((statement) => hasTopLevelComma(statement.replace(/^ALTER\s+(?:FUNCTION|TABLE|SEQUENCE)\s+/i, "").split(/\sOWNER\s+TO\s+/i)[0]));
}

test("PostgreSQL ownership changes target exactly one object per ALTER statement", () => {
  const migrations = ["0001_nearyou_tenant_foundation.sql", "0002_release_evidence_trust.sql", "0003_cutover_runtime.sql", "0004_product_readiness_evidence.sql", "0005_operational_evidence.sql"]
    .map((name) => readFileSync(new URL(`../postgres/migrations/${name}`, import.meta.url), "utf8"))
    .join("\n");
  assert.equal(multiObjectOwnerStatements("ALTER FUNCTION nearyou.one(text,text), nearyou.two(text) OWNER TO owner").length, 1);
  assert.deepEqual(multiObjectOwnerStatements(migrations), []);
});

test("security-definer migrations schema-qualify pgcrypto digest calls", () => {
  const migration = readFileSync(new URL("../postgres/migrations/0005_operational_evidence.sql", import.meta.url), "utf8");
  const digestCalls = [...migration.matchAll(/(?:[A-Za-z_][A-Za-z0-9_]*\.)?digest\(/g)].map((match) => match[0]);
  assert.ok(digestCalls.length >= 2);
  assert.deepEqual(new Set(digestCalls), new Set(["nearyou_crypto.digest("]));
  assert.match(migration, /GRANT USAGE ON SCHEMA nearyou_crypto TO nearyou_policy_owner/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION nearyou_crypto\.digest\(bytea,text\) TO nearyou_policy_owner/);
});

test("rollout audit trigger helper is policy-owned and not publicly executable", () => {
  const migration = readFileSync(new URL("../postgres/migrations/0004_product_readiness_evidence.sql", import.meta.url), "utf8");
  assert.match(migration, /ALTER FUNCTION nearyou\.reject_product_audit_mutation\(\) OWNER TO nearyou_release_policy_owner/);
  assert.match(migration, /REVOKE ALL ON FUNCTION nearyou\.reject_product_audit_mutation\(\) FROM PUBLIC/);
});

test("tenant RLS avoids recursive membership policies and grants app-scoped writes", () => {
  const memberPolicy = sql.match(/CREATE POLICY member_select[\s\S]*?;/)?.[0] || "";
  assert.match(memberPolicy, /is_active_household_member\(household_id\)/);
  assert.match(sql, /CREATE ROLE nearyou_policy_owner NOLOGIN NOINHERIT BYPASSRLS/);
  assert.match(sql, /ALTER FUNCTION nearyou\.is_active_household_member\(text\) OWNER TO nearyou_policy_owner/);
  assert.match(sql, /GRANT USAGE ON SCHEMA nearyou TO nearyou_policy_owner/);
  assert.match(sql, /GRANT SELECT ON nearyou\.household_members TO nearyou_policy_owner/);
  assert.match(sql, /REVOKE ALL ON FUNCTION nearyou\.current_household_id\(\), nearyou\.current_user_id\(\) FROM PUBLIC/);
  assert.match(sql, /CREATE POLICY member_select[\s\S]*household_id = nearyou\.current_household_id\(\)/);
  assert.match(sql, /CREATE POLICY tenant_record_app_mutation[\s\S]*TO nearyou_app[\s\S]*is_household_manager\(household_id\)/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON nearyou\.tenant_records TO nearyou_app/);
});

test("application identities cannot inherit migration or bypass RLS privileges", () => {
  assert.match(sql, /CREATE ROLE nearyou_migration NOLOGIN NOINHERIT/);
  assert.match(sql, /CREATE ROLE nearyou_app NOLOGIN NOINHERIT NOBYPASSRLS/);
  assert.match(sql, /CREATE ROLE nearyou_billing_worker NOLOGIN NOINHERIT NOBYPASSRLS/);
  assert.match(sql, /CREATE ROLE nearyou_job_worker NOLOGIN NOINHERIT NOBYPASSRLS/);
  assert.doesNotMatch(sql, /GRANT nearyou_migration TO nearyou_(?:app|billing_worker|job_worker)/);
  for (const role of ["nearyou_app", "nearyou_billing_worker", "nearyou_job_worker"]) assert.match(sql, new RegExp(`ALTER ROLE ${role} NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`));
  assert.match(sql, /ALTER ROLE nearyou_policy_owner NOLOGIN NOINHERIT BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION/);
});

test("tenant transaction requires a checked-out connection and resets context before returning it", async () => {
  const statements = [];
  const client = {
    checkedOutConnection: true,
    async query(query, parameters) { statements.push([query, parameters]); return { rows: [] }; },
  };
  await withPostgresTenant(client, { householdId: "house_1", userId: "user_1" }, async (connection) => {
    assert.equal(connection, client);
  });
  assert.deepEqual(statements.map(([query]) => query), [
    "BEGIN",
    "SELECT set_config('app.household_id', $1, true), set_config('app.user_id', $2, true)",
    "COMMIT",
  ]);
  await assert.rejects(() => withPostgresTenant({ ...client, checkedOutConnection: false }, { householdId: "house_1", userId: "user_1" }, async () => {}), /checked-out/);
});
