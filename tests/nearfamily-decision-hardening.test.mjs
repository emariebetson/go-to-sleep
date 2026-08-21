import assert from "node:assert/strict";
import test from "node:test";
import {
  requireNearfamilyDecisionHardeningEnvironment,
  runNearfamilyDecisionHardening,
} from "../scripts/apply-nearfamily-decision-hardening.ts";

const instance = "nearnight:us-central1:nearyou-evidence-20260820";

test("decision hardening requires the exact restored disposable clone", () => {
  assert.throws(() => requireNearfamilyDecisionHardeningEnvironment({}), /disposable/);
  assert.throws(() => requireNearfamilyDecisionHardeningEnvironment({ NEARYOU_DECISION_HARDENING_DISPOSABLE: "true", NEARYOU_DECISION_HARDENING_INSTANCE: "nearnight:us-central1:nearyou-production", READINESS_CONTROL_DATABASE_URL: "postgres://x/y" }), /instance/);
  assert.equal(requireNearfamilyDecisionHardeningEnvironment({ NEARYOU_DECISION_HARDENING_DISPOSABLE: "true", NEARYOU_DECISION_HARDENING_INSTANCE: instance, READINESS_CONTROL_DATABASE_URL: "postgres://admin@127.0.0.1/nearyou" }).instance, instance);
});

test("decision hardening requires 0012, applies 0013 once, and verifies narrow ACLs", async () => {
  const prior = Array.from({ length: 12 }, (_, index) => ({ id: `${String(index + 1).padStart(4, "0")}_migration_${index + 1}`, checksum: String(index + 1).repeat(64).slice(0, 64) }));
  prior[11] = { id: "0012_nearfamily_private_tester_decision", checksum: "c".repeat(64) };
  const files = [...prior.map((row) => ({ ...row, sql: "BEGIN; COMMIT;" })), { id: "0013_nearfamily_decision_nonce_and_evidence", checksum: "d".repeat(64), sql: "BEGIN; COMMIT;" }];
  const queries = [];
  const connection = { query: async (sql) => {
    queries.push(sql);
    if (sql.includes("server_version_num")) return { rows: [{ database_name: "nearyou", server_version: 160011, database_user: "nearyou_migration_admin" }] };
    if (sql.includes("relforcerowsecurity")) return { rows: [{ migration_head: "0013_nearfamily_decision_nonce_and_evidence", nonce_force_rls: true, public_execute_count: "0", decision_authorize: true, decision_nonce: true, decision_table_access: false }] };
    if (sql.includes("schema_migrations") && sql.includes("ORDER BY")) return { rows: prior };
    throw new Error("unexpected SQL");
  }, close: async () => {} };
  let applied;
  const result = await runNearfamilyDecisionHardening({ instance, databaseUrl: "postgres://admin@127.0.0.1/nearyou", disposable: true }, {
    files,
    connect: async () => connection,
    apply: async (_pg, actual, checksum) => { applied = { actual, checksum }; return { migrationLedgerChecksum: checksum }; },
  });
  assert.equal(applied.actual.at(-1).id, "0013_nearfamily_decision_nonce_and_evidence");
  assert.equal(result.ready, true);
  assert.equal(result.migrationHead, "0013_nearfamily_decision_nonce_and_evidence");
  assert.match(result.schemaChecksum, /^[a-f0-9]{64}$/);
  assert.equal(queries.length, 3);
});
