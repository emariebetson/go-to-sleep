import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrations = ["0000_nearnight_foundation.sql", "0001_google_apple_auth.sql", "0002_sharp_shinobi_shaw.sql", "0003_white_groot.sql", "0004_salty_sugar_man.sql", "0005_pronunciation_frequency_layers.sql", "0006_nearyou_shared_foundation.sql", "0007_nearsleep_production_upgrade.sql"];
function applyMigration(database, name) {
  const sql = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
}
function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) applyMigration(database, migration);
  database.exec(`
    INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at)
    VALUES ('user_1', 'adult@example.com', 'active', 7, 1786420000000, 1786420000000);
    INSERT INTO households (id, name, owner_user_id, created_at, updated_at)
    VALUES ('household:user_1', 'Home', 'user_1', 1786420000000, 1786420000000);
    INSERT INTO entitlements (id, household_id, plan_id, source, status, allowance_milliunits, remaining_milliunits, legacy_credits_remaining, valid_from, created_at, updated_at)
    VALUES ('entitlement_1', 'household:user_1', 'nearsleep_plus_legacy', 'legacy', 'active', 7000, 1000, 1, 1786420000000, 1786420000000, 1786420000000);
  `);
  return database;
}

test("allowance reservations debit once and a release refunds once", () => {
  const database = fixture();
  const insert = `INSERT OR IGNORE INTO usage_reservations
    (id, household_id, user_id, entitlement_id, operation, quantity, weight_milliunits, idempotency_key, request_hash, status, created_at, updated_at)
    VALUES ('reservation_1', 'household:user_1', 'user_1', 'entitlement_1', 'nearsleep_audio_generation', 1, 900, 'save:req_1', 'hash_1', 'reserved', 1786442400000, 1786442400000)`;
  database.exec(insert);
  assert.equal(database.prepare("SELECT remaining_milliunits FROM entitlements WHERE id = 'entitlement_1'").get().remaining_milliunits, 100);
  database.exec(insert);
  assert.equal(database.prepare("SELECT remaining_milliunits FROM entitlements WHERE id = 'entitlement_1'").get().remaining_milliunits, 100);
  database.exec("UPDATE usage_reservations SET status = 'released', finalized_at = 1786442401000 WHERE id = 'reservation_1' AND status = 'reserved'");
  assert.equal(database.prepare("SELECT remaining_milliunits FROM entitlements WHERE id = 'entitlement_1'").get().remaining_milliunits, 1000);
  database.exec("UPDATE usage_reservations SET status = 'released' WHERE id = 'reservation_1' AND status = 'reserved'");
  assert.equal(database.prepare("SELECT remaining_milliunits FROM entitlements WHERE id = 'entitlement_1'").get().remaining_milliunits, 1000);
  assert.deepEqual(database.prepare("SELECT direction FROM usage_ledger ORDER BY created_at").all().map(({ direction }) => direction), ["reservation", "release"]);
});

test("allowance reservations fail closed when household funds are insufficient or the idempotency payload changes", () => {
  const database = fixture();
  assert.throws(() => database.exec(`INSERT INTO usage_reservations
    (id, household_id, user_id, entitlement_id, operation, quantity, weight_milliunits, idempotency_key, request_hash, status, created_at, updated_at)
    VALUES ('reservation_big', 'household:user_1', 'user_1', 'entitlement_1', 'nearsleep_audio_generation', 2, 1800, 'save:req_big', 'hash_big', 'reserved', 1786442400000, 1786442400000)`), /allowance_exhausted/);
  assert.throws(() => database.exec(`INSERT INTO usage_reservations
    (id, household_id, user_id, entitlement_id, operation, quantity, weight_milliunits, idempotency_key, request_hash, status, created_at, updated_at)
    VALUES ('reservation_negative', 'household:user_1', 'user_1', 'entitlement_1', 'nearsleep_audio_generation', 1, -10, 'save:req_negative', 'hash_negative', 'reserved', 1786442400000, 1786442400000)`), /invalid_usage_reservation/);
  assert.throws(() => database.exec(`INSERT INTO usage_reservations
    (id, household_id, user_id, entitlement_id, operation, quantity, weight_milliunits, idempotency_key, request_hash, status, created_at, updated_at)
    VALUES ('reservation_committed', 'household:user_1', 'user_1', 'entitlement_1', 'nearsleep_audio_generation', 1, 10, 'save:req_committed', 'hash_committed', 'committed', 1786442400000, 1786442400000)`), /invalid_usage_reservation/);
  database.exec(`INSERT INTO usage_reservations
    (id, household_id, user_id, entitlement_id, operation, quantity, weight_milliunits, idempotency_key, request_hash, status, created_at, updated_at)
    VALUES ('reservation_1', 'household:user_1', 'user_1', 'entitlement_1', 'nearsleep_audio_generation', 1, 900, 'save:req_1', 'hash_1', 'reserved', 1786442400000, 1786442400000)`);
  assert.throws(() => database.exec(`INSERT INTO usage_reservations
    (id, household_id, user_id, entitlement_id, operation, quantity, weight_milliunits, idempotency_key, request_hash, status, created_at, updated_at)
    VALUES ('reservation_2', 'household:user_1', 'user_1', 'entitlement_1', 'nearsleep_audio_generation', 1, 100, 'save:req_1', 'changed', 'reserved', 1786442400001, 1786442400001)`), /UNIQUE/);
});

test("provider spend reservations enforce rolling household, global concurrency, and open-circuit ceilings atomically", () => {
  const database = fixture();
  database.exec("UPDATE provider_budget_policies SET max_concurrent = 2, household_window_microcents = 1000, global_window_microcents = 2000 WHERE provider = 'openai'");
  const spend = (id, household, cost, created = 1786442400000, expires = created + 120000) => database.exec(`INSERT INTO provider_spend_reservations
    (id, household_id, user_id, provider, operation, idempotency_key, estimated_microcents, status, expires_at, created_at, updated_at)
    VALUES ('${id}', '${household}', 'user_1', 'openai', 'script', '${id}', ${cost}, 'in_flight', ${expires}, ${created}, ${created})`);
  spend("spend_1", "household:user_1", 400);
  spend("spend_2", "household:user_1", 400);
  assert.throws(() => spend("spend_3", "household:user_1", 100), /provider_concurrency_limit/);
  database.exec("UPDATE provider_spend_reservations SET status = 'charge_committed', charge_committed_at = 1786442400001 WHERE id = 'spend_1'");
  database.exec("UPDATE provider_spend_reservations SET status = 'settled', actual_microcents = 400 WHERE id = 'spend_1'");
  assert.throws(() => spend("spend_4", "household:user_1", 300), /household_spend_limit/);
  database.exec("INSERT INTO provider_circuits (provider, consecutive_failures, open_until, updated_at) VALUES ('elevenlabs', 5, 1786442500000, 1786442400000)");
  assert.throws(() => database.exec(`INSERT INTO provider_spend_reservations
    (id, household_id, user_id, provider, operation, idempotency_key, estimated_microcents, status, expires_at, created_at, updated_at)
    VALUES ('spend_voice', 'household:user_1', 'user_1', 'elevenlabs', 'audio', 'spend_voice', 100, 'in_flight', 1786442520000, 1786442400000, 1786442400000)`), /provider_circuit_open/);
  assert.throws(() => spend("spend_negative", "household:user_1", -10), /invalid_provider_spend_reservation/);
});

test("expired in-flight provider reservations do not permanently consume concurrency", () => {
  const database = fixture();
  database.exec("UPDATE provider_budget_policies SET max_concurrent = 1 WHERE provider = 'openai'");
  database.exec(`INSERT INTO provider_spend_reservations
    (id, household_id, user_id, provider, operation, idempotency_key, estimated_microcents, status, expires_at, created_at, updated_at)
    VALUES ('expired', 'household:user_1', 'user_1', 'openai', 'script', 'expired', 100, 'in_flight', 1786442399999, 1786442300000, 1786442300000)`);
  database.exec(`INSERT INTO provider_spend_reservations
    (id, household_id, user_id, provider, operation, idempotency_key, estimated_microcents, status, expires_at, created_at, updated_at)
    VALUES ('fresh', 'household:user_1', 'user_1', 'openai', 'script', 'fresh', 100, 'in_flight', 1786442520000, 1786442400000, 1786442400000)`);
  assert.equal(database.prepare("SELECT count(*) AS value FROM provider_spend_reservations").get().value, 2);
});

test("charge-committed provider work keeps its concurrency slot and remains spend-accounted after expiry", () => {
  const database = fixture();
  database.exec("UPDATE provider_budget_policies SET max_concurrent = 1, household_window_microcents = 1000 WHERE provider = 'openai'");
  database.exec(`INSERT INTO provider_spend_reservations
    (id, household_id, user_id, provider, operation, idempotency_key, estimated_microcents, status, expires_at, created_at, updated_at)
    VALUES ('committed', 'household:user_1', 'user_1', 'openai', 'script', 'committed', 700, 'in_flight', 1786442520000, 1786442400000, 1786442400000)`);
  database.exec("UPDATE provider_spend_reservations SET status = 'charge_committed', charge_committed_at = 1786442401000, updated_at = 1786442401000 WHERE id = 'committed' AND status = 'in_flight'");
  assert.throws(() => database.exec(`INSERT INTO provider_spend_reservations
    (id, household_id, user_id, provider, operation, idempotency_key, estimated_microcents, status, expires_at, created_at, updated_at)
    VALUES ('concurrent', 'household:user_1', 'user_1', 'openai', 'script', 'concurrent', 100, 'in_flight', 1786442520000, 1786442402000, 1786442402000)`), /provider_concurrency_limit/);

  assert.throws(() => database.exec(`INSERT INTO provider_spend_reservations
    (id, household_id, user_id, provider, operation, idempotency_key, estimated_microcents, status, expires_at, created_at, updated_at)
    VALUES ('after_expiry', 'household:user_1', 'user_1', 'openai', 'script', 'after_expiry', 400, 'in_flight', 1786442700000, 1786442600000, 1786442600000)`), /household_spend_limit/);
  database.exec("UPDATE provider_spend_reservations SET status = 'settled', updated_at = 1786442600000 WHERE id = 'committed' AND status = 'charge_committed'");
  assert.deepEqual({ ...database.prepare("SELECT status, actual_microcents FROM provider_spend_reservations WHERE id = 'committed'").get() }, {
    status: "settled",
    actual_microcents: null,
  });
  assert.throws(() => database.exec("UPDATE provider_spend_reservations SET actual_microcents = -1 WHERE id = 'committed'"), /invalid_provider_spend_actual/);
});
