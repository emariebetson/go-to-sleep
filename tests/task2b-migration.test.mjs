import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrations = [
  "0000_nearnight_foundation.sql",
  "0001_google_apple_auth.sql",
  "0002_sharp_shinobi_shaw.sql",
  "0003_white_groot.sql",
  "0004_salty_sugar_man.sql",
  "0005_pronunciation_frequency_layers.sql",
  "0006_nearyou_shared_foundation.sql",
  "0007_nearsleep_production_upgrade.sql",
  "0008_nearsleep_live_integration.sql",
  "0009_nearsleep_audio_atomic.sql",
  "0010_child_profile_pronunciation.sql",
  "0011_household_billing_accounts.sql",
];

function applyMigration(database, name) {
  const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) applyMigration(database, migration);
  database.exec(`
    INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at)
    VALUES ('adult_1', 'adult@example.com', 'active', 12, 1786420000000, 1786420000000);
    INSERT INTO households (id, name, owner_user_id, created_at, updated_at)
    VALUES ('household_1', 'Home', 'adult_1', 1786420000000, 1786420000000);
    INSERT INTO household_members (id, household_id, user_id, role, status, created_at, updated_at)
    VALUES ('member_1', 'household_1', 'adult_1', 'owner', 'active', 1786420000000, 1786420000000);
    INSERT INTO entitlements (id, household_id, plan_id, source, status, allowance_milliunits, remaining_milliunits, valid_from, created_at, updated_at)
    VALUES ('entitlement_fixture', 'household_1', 'nearsleep_free', 'manual', 'active', 1000, 1000, 1786420000000, 1786420000000, 1786420000000);
    INSERT INTO voices (id, user_id, household_id, provider_voice_id, name, status, consent_attested_at, created_at)
    VALUES ('voice_1', 'adult_1', 'household_1', 'provider_secret_1', 'Parent', 'ready', 1786420000000, 1786420000000);
    INSERT INTO voice_consents (id, household_id, voice_id, adult_user_id, consent_version, scope, status, evidence, attested_at)
    VALUES ('consent_pending', 'household_1', 'voice_1', 'adult_1', 'legacy-voice-checkbox-v1', 'adult_self_private_narration', 'pending_verification', '{}', 1786420000000);
    UPDATE voices SET current_consent_id = 'consent_pending' WHERE id = 'voice_1';
  `);
  return database;
}

test("0011 fails with an explicit duplicate-live-voice preflight before creating the partial unique index", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations.slice(0, -1)) applyMigration(database, migration);
  database.exec(`
    INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at)
    VALUES ('preflight_adult', 'preflight@example.com', 'active', 12, 1786420000000, 1786420000000);
    INSERT INTO households (id, name, owner_user_id, created_at, updated_at)
    VALUES ('preflight_household', 'Home', 'preflight_adult', 1786420000000, 1786420000000);
    INSERT INTO household_members (id, household_id, user_id, role, status, created_at, updated_at)
    VALUES ('preflight_member', 'preflight_household', 'preflight_adult', 'owner', 'active', 1786420000000, 1786420000000);
    INSERT INTO voices (id, user_id, household_id, provider_voice_id, name, status, consent_attested_at, created_at) VALUES
      ('preflight_voice_1', 'preflight_adult', 'preflight_household', 'provider_preflight_1', 'First', 'ready', 1786420000000, 1786420000000),
      ('preflight_voice_2', 'preflight_adult', 'preflight_household', 'provider_preflight_2', 'Second', 'ready', 1786420000000, 1786420001000);
  `);
  assert.throws(() => applyMigration(database, migrations.at(-1)), /task_2b_duplicate_live_voice_preflight/);
  assert.equal(database.prepare("SELECT count(*) AS value FROM sqlite_master WHERE type = 'table' AND name = 'household_billing_accounts'").get().value, 0);
  assert.equal(database.prepare("SELECT count(*) AS value FROM sqlite_master WHERE type = 'index' AND name = 'voices_household_user_live_idx'").get().value, 0);
  assert.equal(database.prepare("SELECT count(*) AS value FROM pragma_table_info('voices') WHERE name = 'creation_request_id'").get().value, 0);
  assert.equal(database.prepare("SELECT count(*) AS value FROM pragma_table_info('entitlements') WHERE name = 'billing_period_start'").get().value, 0);
  assert.equal(database.prepare("SELECT count(*) AS value FROM pragma_table_info('stripe_events') WHERE name = 'attempt_token'").get().value, 0);
});

test("consent leases can only bind the current active verified voice and revocation wins against in-flight output", () => {
  const database = fixture();
  assert.throws(() => database.exec(`INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, status, expires_at, created_at)
    VALUES ('lease_pending', 'household_1', 'voice_1', 'consent_pending', 'legacy-voice-checkbox-v1', 'active', 1786420300000, 1786420000000)`), /(?:invalid_voice_consent_lease|voice_consent_version_not_current)/);

  database.exec(`
    INSERT INTO voice_consents (id, household_id, voice_id, adult_user_id, consent_version, scope, status, evidence, attested_at)
    VALUES ('consent_verified', 'household_1', 'voice_1', 'adult_1', 'voice-v2-live-phrase', 'adult_self_private_narration', 'active_verified', '{"verified":true}', 1786420000000);
    UPDATE voices SET current_consent_id = 'consent_verified' WHERE id = 'voice_1';
    INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, status, expires_at, created_at)
    VALUES ('lease_1', 'household_1', 'voice_1', 'consent_verified', 'voice-v2-live-phrase', 'active', 1786420300000, 1786420000000);
    UPDATE voice_consents SET status = 'revoked', revoked_at = 1786420001000 WHERE id = 'consent_verified';
  `);
  assert.equal(database.prepare("SELECT status FROM voice_consent_leases WHERE id = 'lease_1'").get().status, "revoked");
});

test("voice slots are claimed atomically per actor and household plan before provider work", () => {
  const database = fixture();
  database.exec(`
    INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at)
    VALUES ('adult_2', 'second@example.com', 'free', 1, 1786420000000, 1786420000000);
    INSERT INTO household_members (id, household_id, user_id, role, status, created_at, updated_at)
    VALUES ('member_2', 'household_1', 'adult_2', 'adult_manager', 'active', 1786420000000, 1786420000000);
  `);
  assert.throws(() => database.exec(`INSERT INTO voices
    (id, user_id, household_id, provider_voice_id, name, status, consent_attested_at, created_at)
    VALUES ('voice_over_limit', 'adult_2', 'household_1', 'pending:2', 'Second', 'processing', 1786420000000, 1786420000000)`), /household_voice_limit_reached/);
  assert.throws(() => database.exec(`INSERT INTO voices
    (id, user_id, household_id, provider_voice_id, name, status, consent_attested_at, created_at)
    VALUES ('voice_duplicate_actor', 'adult_1', 'household_1', 'pending:3', 'Duplicate', 'processing', 1786420000000, 1786420000000)`), /(?:UNIQUE|household_voice_limit_reached)/);
  database.exec(`
    UPDATE entitlements SET plan_id = 'nearyou_family', allowance_milliunits = 120000, remaining_milliunits = 120000 WHERE id = 'entitlement_fixture';
    INSERT INTO voices
      (id, user_id, household_id, provider_voice_id, name, status, consent_attested_at, created_at)
    VALUES ('voice_family_second', 'adult_2', 'household_1', 'pending:4', 'Second', 'processing', 1786420000000, 1786420000000);
  `);
  assert.equal(database.prepare("SELECT count(*) AS value FROM voices WHERE household_id = 'household_1' AND status IN ('processing','ready')").get().value, 2);
});

test("a current paid grace entitlement outranks the permanent Free grant for voice capacity", () => {
  const database = fixture();
  database.exec(`
    INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at)
    VALUES ('adult_grace_2', 'grace-second@example.com', 'free', 1, 1786420000000, 1786420000000);
    INSERT INTO household_members (id, household_id, user_id, role, status, created_at, updated_at)
    VALUES ('member_grace_2', 'household_1', 'adult_grace_2', 'adult_manager', 'active', 1786420000000, 1786420000000);
    INSERT INTO entitlements (id, household_id, plan_id, source, status, allowance_milliunits, remaining_milliunits, valid_from, valid_until, created_at, updated_at)
    VALUES ('entitlement_family_grace', 'household_1', 'nearyou_family', 'stripe', 'grace', 120000, 70000, 1786420000000, 4102444800000, 1786420000000, 1786420000000);
    INSERT INTO voices (id, user_id, household_id, provider_voice_id, name, status, consent_attested_at, created_at)
    VALUES ('voice_grace_second', 'adult_grace_2', 'household_1', 'pending:grace-second', 'Second', 'processing', 1786420000000, 1786420000000);
  `);
  assert.equal(database.prepare("SELECT count(*) AS value FROM voices WHERE household_id = 'household_1' AND status IN ('processing','ready')").get().value, 2);
});

test("a pending local slot activates its first clone only after the live challenge", () => {
  const database = fixture();
  database.exec(`
    UPDATE voices SET status = 'deleted', deleted_at = 1786420000100 WHERE id = 'voice_1';
    UPDATE entitlements SET plan_id = 'nearyou_plus', allowance_milliunits = 60000, remaining_milliunits = 60000 WHERE id = 'entitlement_fixture';
    INSERT INTO voices (id, user_id, household_id, creation_request_id, provider_voice_id, name, status, consent_attested_at, created_at)
    VALUES ('11111111-1111-4111-8111-111111111111', 'adult_1', 'household_1', '22222222-2222-4222-8222-222222222222', 'pending:household_1:22222222-2222-4222-8222-222222222222', 'Parent voice', 'processing', 1786420001000, 1786420001000);
    INSERT INTO voice_consents (id, household_id, voice_id, adult_user_id, consent_version, scope, status, evidence, attested_at)
    VALUES ('consent_first_claim', 'household_1', '11111111-1111-4111-8111-111111111111', 'adult_1', 'adult-self-claim-v1', 'adult_self_private_narration', 'pending_verification', '{"verified":false}', 1786420001000);
    UPDATE voices SET current_consent_id = 'consent_first_claim' WHERE id = '11111111-1111-4111-8111-111111111111';
    INSERT INTO adult_onboarding_acceptances (id, household_id, adult_user_id, version, attestation, accepted_at)
    VALUES ('onboarding_first', 'household_1', 'adult_1', 'adult-caregiver-v1', 'accepted', 1786420001000);
    INSERT INTO voice_verification_challenges (id, household_id, voice_id, adult_user_id, onboarding_acceptance_id, version, phrase, phrase_hash, status, attempts, expires_at, created_at)
    VALUES ('33333333-3333-4333-8333-333333333333', 'household_1', '11111111-1111-4111-8111-111111111111', 'adult_1', 'onboarding_first', 'live-phrase-v1', 'phrase', 'hash', 'processing', 1, 4102444800000, 1786420002000);
    INSERT INTO voice_replacements (id, household_id, voice_id, challenge_id, adult_user_id, original_provider_voice_id, original_consent_id, replacement_provider_voice_id, consent_id, consent_version, evidence, status, created_at, updated_at)
    VALUES ('replacement_first', 'household_1', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'adult_1', 'pending:household_1:22222222-2222-4222-8222-222222222222', 'consent_first_claim', 'provider_verified_first', 'consent_first_verified', 'voice-v2-live-phrase', '{"verified":true}', 'provider_created', 1786420002000, 1786420003000);
    UPDATE voice_replacements SET status = 'activating' WHERE id = 'replacement_first';
  `);
  assert.deepEqual({ ...database.prepare("SELECT status, provider_voice_id, current_consent_id FROM voices WHERE id = '11111111-1111-4111-8111-111111111111'").get() }, {
    status: "ready",
    provider_voice_id: "provider_verified_first",
    current_consent_id: "consent_first_verified",
  });
  assert.deepEqual({ ...database.prepare("SELECT status, phrase FROM voice_verification_challenges WHERE id = '33333333-3333-4333-8333-333333333333'").get() }, { status: "verified", phrase: "" });
  assert.equal(database.prepare("SELECT status FROM voice_consents WHERE id = 'consent_first_verified'").get().status, "active_verified");
  assert.equal(database.prepare("SELECT status FROM voice_replacements WHERE id = 'replacement_first'").get().status, "cleanup_pending");

  database.exec(`
    UPDATE voice_replacements SET status = 'completed', completed_at = 1786420004000, updated_at = 1786420004000 WHERE id = 'replacement_first';
    INSERT INTO voice_consent_leases
      (id, household_id, voice_id, consent_id, consent_version, status, expires_at, created_at)
    VALUES ('lease_before_reverify', 'household_1', '11111111-1111-4111-8111-111111111111', 'consent_first_verified', 'voice-v2-live-phrase', 'active', 4102444800000, 1786420004000);
    INSERT INTO voice_verification_challenges (id, household_id, voice_id, adult_user_id, onboarding_acceptance_id, version, phrase, phrase_hash, status, attempts, expires_at, created_at)
    VALUES ('44444444-4444-4444-8444-444444444444', 'household_1', '11111111-1111-4111-8111-111111111111', 'adult_1', 'onboarding_first', 'live-phrase-v1', 'second phrase', 'second-hash', 'processing', 1, 4102444800000, 1786420005000);
    INSERT INTO voice_replacements (id, household_id, voice_id, challenge_id, adult_user_id, original_provider_voice_id, original_consent_id, replacement_provider_voice_id, consent_id, consent_version, evidence, status, created_at, updated_at)
    VALUES ('replacement_second', 'household_1', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', 'adult_1', 'provider_verified_first', 'consent_first_verified', 'provider_verified_second', 'verified-consent:11111111-1111-4111-8111-111111111111:44444444-4444-4444-8444-444444444444:voice-v2-live-phrase', 'voice-v2-live-phrase', '{"verified":true}', 'provider_created', 1786420005000, 1786420006000);
    UPDATE voice_replacements SET status = 'activating' WHERE id = 'replacement_second';
  `);
  assert.deepEqual({ ...database.prepare("SELECT provider_voice_id, current_consent_id FROM voices WHERE id = '11111111-1111-4111-8111-111111111111'").get() }, {
    provider_voice_id: "provider_verified_second",
    current_consent_id: "verified-consent:11111111-1111-4111-8111-111111111111:44444444-4444-4444-8444-444444444444:voice-v2-live-phrase",
  });
  assert.equal(database.prepare("SELECT status FROM voice_consents WHERE id = 'consent_first_verified'").get().status, "revoked");
  assert.equal(database.prepare("SELECT status FROM voice_consent_leases WHERE id = 'lease_before_reverify'").get().status, "revoked");
  assert.throws(() => database.exec("UPDATE voice_consent_leases SET status = 'consumed', finalized_at = 1786420007000 WHERE id = 'lease_before_reverify'"), /invalid_voice_consent_lease_transition/);
});

test("Free households cannot reserve a private provider-clone slot", () => {
  const database = fixture();
  database.exec("UPDATE voices SET status = 'deleted', deleted_at = 1786420001000 WHERE id = 'voice_1'");
  assert.throws(() => database.exec(`INSERT INTO voices
    (id, user_id, household_id, creation_request_id, provider_voice_id, name, status, consent_attested_at, created_at)
    VALUES ('free_voice_first', 'adult_1', 'household_1', 'free-request-first', 'pending:free-first', 'Parent voice', 'processing', 1786420002000, 1786420002000)`), /free_voice_clone_unavailable/);
  assert.equal(database.prepare("SELECT count(*) AS value FROM voices WHERE household_id = 'household_1' AND status IN ('processing','ready')").get().value, 0);
});

test("child capacity is serialized in the database and paid grace outranks Free", () => {
  const database = fixture();
  database.exec(`INSERT INTO child_profiles
    (id, household_id, nickname, normalized_nickname, pronunciation, age_months, bedtime_challenge, created_at, updated_at)
    VALUES ('child_1', 'household_1', 'One', 'one', '', 12, 'settling', 1786420000000, 1786420000000)`);
  assert.throws(() => database.exec(`INSERT INTO child_profiles
    (id, household_id, nickname, normalized_nickname, pronunciation, age_months, bedtime_challenge, created_at, updated_at)
    VALUES ('child_free_over', 'household_1', 'Two', 'two', '', 24, 'settling', 1786420000000, 1786420000000)`), /household_child_limit_reached/);
  database.exec(`
    INSERT INTO entitlements (id, household_id, plan_id, source, status, allowance_milliunits, remaining_milliunits, valid_from, valid_until, created_at, updated_at)
    VALUES ('family_grace_children', 'household_1', 'nearyou_family', 'stripe', 'grace', 120000, 70000, 1786420000000, 4102444800000, 1786420000000, 1786420000000);
    INSERT INTO child_profiles (id, household_id, nickname, normalized_nickname, pronunciation, age_months, bedtime_challenge, created_at, updated_at) VALUES
      ('child_2', 'household_1', 'Two', 'two', '', 24, 'settling', 1786420000000, 1786420000000),
      ('child_3', 'household_1', 'Three', 'three', '', 36, 'settling', 1786420000000, 1786420000000),
      ('child_4', 'household_1', 'Four', 'four', '', 48, 'settling', 1786420000000, 1786420000000),
      ('child_5', 'household_1', 'Five', 'five', '', 60, 'settling', 1786420000000, 1786420000000);
  `);
  assert.throws(() => database.exec(`INSERT INTO child_profiles
    (id, household_id, nickname, normalized_nickname, pronunciation, age_months, bedtime_challenge, created_at, updated_at)
    VALUES ('child_family_over', 'household_1', 'Six', 'six', '', 72, 'settling', 1786420000000, 1786420000000)`), /household_child_limit_reached/);
  assert.equal(database.prepare("SELECT count(*) AS value FROM child_profiles WHERE household_id = 'household_1' AND archived_at IS NULL").get().value, 5);
});

test("voice deletion revokes active or just-consumed generation leases atomically", () => {
  const database = fixture();
  database.exec(`
    UPDATE voice_consents SET status = 'active_verified', consent_version = 'voice-v2-live-phrase' WHERE id = 'consent_pending';
    INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, status, expires_at, created_at)
    VALUES ('lease_active', 'household_1', 'voice_1', 'consent_pending', 'voice-v2-live-phrase', 'active', 4102444800000, 1786420000000);
    INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, status, expires_at, created_at)
    VALUES ('lease_consumed', 'household_1', 'voice_1', 'consent_pending', 'voice-v2-live-phrase', 'active', 4102444800000, 1786420000000);
    UPDATE voice_consent_leases SET status = 'consumed', finalized_at = 1786420001000 WHERE id = 'lease_consumed';
    UPDATE voices SET status = 'deleted', deleted_at = 1786420002000 WHERE id = 'voice_1';
  `);
  assert.deepEqual(database.prepare("SELECT id, status, finalized_at FROM voice_consent_leases ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "lease_active", status: "revoked", finalized_at: 1786420002000 },
    { id: "lease_consumed", status: "revoked", finalized_at: 1786420001000 },
  ]);
});

test("allowance reservations fail if their consent lease is no longer valid", () => {
  const database = fixture();
  database.exec(`
    UPDATE voice_consents SET status = 'active_verified', consent_version = 'voice-v2-live-phrase' WHERE id = 'consent_pending';
    INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, status, expires_at, created_at)
    VALUES ('lease_1', 'household_1', 'voice_1', 'consent_pending', 'voice-v2-live-phrase', 'active', 1786420300000, 1786420000000);
    UPDATE voice_consents SET status = 'revoked', revoked_at = 1786420001000 WHERE id = 'consent_pending';
    INSERT INTO entitlements (id, household_id, plan_id, source, status, allowance_milliunits, remaining_milliunits, valid_from, created_at, updated_at)
    VALUES ('entitlement_1', 'household_1', 'nearyou_plus', 'manual', 'active', 60000, 60000, 1786420000000, 1786420000000, 1786420000000);
  `);
  assert.throws(() => database.exec(`INSERT INTO usage_reservations
    (id, household_id, user_id, entitlement_id, operation, quantity, weight_milliunits, idempotency_key, request_hash, status, consent_lease_id, created_at, updated_at)
    VALUES ('reservation_1', 'household_1', 'adult_1', 'entitlement_1', 'nearsleep_audio_generation', 1, 5000, 'audio:req_1', 'hash_1', 'reserved', 'lease_1', 1786420002000, 1786420002000)`), /invalid_voice_consent_lease/);
});

test("generation operation terminal states require a durable result or bounded error", () => {
  const database = fixture();
  assert.throws(() => database.exec(`INSERT INTO generation_operations
    (id, household_id, user_id, operation, request_hash, status, created_at, updated_at)
    VALUES ('script:req_1', 'household_1', 'adult_1', 'script', '', 'processing', 1786420000000, 1786420000000)`), /invalid_generation_operation/);
  database.exec(`INSERT INTO generation_operations
    (id, household_id, user_id, operation, request_hash, status, created_at, updated_at)
    VALUES ('script:req_1', 'household_1', 'adult_1', 'script', 'hash_1', 'processing', 1786420000000, 1786420000000)`);
  assert.throws(() => database.exec("UPDATE generation_operations SET status = 'succeeded' WHERE id = 'script:req_1'"), /invalid_generation_operation/);
  assert.throws(() => database.exec("UPDATE generation_operations SET status = 'failed' WHERE id = 'script:req_1'"), /invalid_generation_operation/);
});

test("deletion reconciliation and ordered Stripe event state are durable", () => {
  const database = fixture();
  database.exec(`INSERT INTO deletion_reconciliations
    (id, scope, scope_id, status, storage_keys, created_at, updated_at)
    VALUES ('delete_1', 'account', 'household_1', 'cleanup_pending', '["audio/adult_1/session.mp3"]', 1786420000000, 1786420000000)`);
  const eventColumns = database.prepare("PRAGMA table_info('stripe_events')").all().map((row) => row.name);
  assert.ok(eventColumns.includes("event_created_at"));
  assert.ok(eventColumns.includes("status"));
  assert.ok(eventColumns.includes("error_code"));
  assert.ok(eventColumns.includes("attempt_token"));
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("migration marks historical claimed Stripe events completed with their processed timestamp", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations.slice(0, 8)) applyMigration(database, migration);
  database.exec("INSERT INTO stripe_events (id, type, processed_at) VALUES ('evt_historical', 'invoice.paid', 1786420000000)");
  applyMigration(database, "0008_nearsleep_live_integration.sql");
  assert.deepEqual({ ...database.prepare("SELECT status, event_created_at, processed_at, updated_at FROM stripe_events WHERE id = 'evt_historical'").get() }, {
    status: "completed",
    event_created_at: 1786420000000,
    processed_at: 1786420000000,
    updated_at: 1786420000000,
  });
});

test("audio atomic migration is additive and preserves historical Stripe event state", () => {
  const source = readFileSync(new URL("../drizzle/0009_nearsleep_audio_atomic.sql", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:DROP|ALTER) TABLE `stripe_events`|__new_stripe_events|PRAGMA foreign_keys/i);

  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations.slice(0, 9)) applyMigration(database, migration);
  database.exec(`INSERT INTO stripe_events
    (id, type, event_created_at, status, error_code, processed_at, updated_at)
    VALUES ('evt_preserved', 'customer.subscription.updated', 1786420000123, 'failed', 'transient', 1786420000456, 1786420000789)`);
  const before = { ...database.prepare("SELECT * FROM stripe_events WHERE id = 'evt_preserved'").get() };

  applyMigration(database, "0009_nearsleep_audio_atomic.sql");

  assert.deepEqual({ ...database.prepare("SELECT * FROM stripe_events WHERE id = 'evt_preserved'").get() }, before);
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
});

test("canonical child pronunciation is additively backfilled with a tenant-scoped legacy bridge", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations.slice(0, 10)) applyMigration(database, migration);
  database.exec(`
    INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at)
    VALUES ('adult_child', 'child-owner@example.com', 'free', 1, 1786420000000, 1786420000000);
    INSERT INTO households (id, name, owner_user_id, created_at, updated_at)
    VALUES ('household_child', 'Child home', 'adult_child', 1786420000000, 1786420000000);
    INSERT INTO children (id, user_id, household_id, nickname, normalized_nickname, pronunciation, created_at, updated_at)
    VALUES ('legacy_child', 'adult_child', 'household_child', 'Mia', 'mia', 'MEE-ah', 1786420000000, 1786420000000);
    INSERT INTO child_profiles (id, household_id, legacy_child_id, nickname, normalized_nickname, age_months, created_at, updated_at)
    VALUES ('profile_child', 'household_child', 'legacy_child', 'Mia', 'mia', 60, 1786420000000, 1786420000000);
  `);
  applyMigration(database, "0010_child_profile_pronunciation.sql");
  assert.deepEqual({ ...database.prepare("SELECT pronunciation, age_months FROM child_profiles WHERE id = 'profile_child'").get() }, {
    pronunciation: "MEE-ah",
    age_months: 60,
  });
});

test("household billing binding is additively backfilled from legacy personal-account Stripe state", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations.slice(0, 11)) applyMigration(database, migration);
  database.exec(`
    INSERT INTO users (id, email, stripe_customer_id, subscription_id, subscription_price_id, subscription_status, subscription_event_created_at, checkout_pending_at, last_credited_invoice_id, last_credited_period_start, credits_remaining, created_at, updated_at)
    VALUES ('adult_billing', 'billing@example.com', 'cus_test', 'sub_test', 'price_legacy12', 'active', 1786420000, 1786420000000, 'in_test', 1786420000, 8, 1786400000000, 1786420000000);
    INSERT INTO households (id, name, owner_user_id, created_at, updated_at)
    VALUES ('household:adult_billing', 'Billing home', 'adult_billing', 1786400000000, 1786420000000);
  `);
  applyMigration(database, "0011_household_billing_accounts.sql");
  assert.deepEqual({ ...database.prepare("SELECT household_id, customer_id, subscription_id, price_id, status, subscription_event_created_at, last_credited_invoice_id, last_credited_period_start FROM household_billing_accounts").get() }, {
    household_id: "household:adult_billing",
    customer_id: "cus_test",
    subscription_id: "sub_test",
    price_id: "price_legacy12",
    status: "active",
    subscription_event_created_at: 1786420000,
    last_credited_invoice_id: "in_test",
    last_credited_period_start: 1786420000,
  });
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("lease consumption requires an unexpired current verified consent and terminal leases cannot revive", () => {
  const database = fixture();
  database.exec(`
    UPDATE voice_consents SET status = 'active_verified', consent_version = 'voice-v2-live-phrase' WHERE id = 'consent_pending';
    INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, status, expires_at, created_at)
    VALUES ('lease_valid', 'household_1', 'voice_1', 'consent_pending', 'voice-v2-live-phrase', 'active', 4102444800000, 1786420000000);
    UPDATE voice_consent_leases SET status = 'consumed', finalized_at = 1786420001000 WHERE id = 'lease_valid';
  `);
  assert.throws(() => database.exec("UPDATE voice_consent_leases SET status = 'active' WHERE id = 'lease_valid'"), /invalid_voice_consent_lease_transition/);

  database.exec(`INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, status, expires_at, created_at)
    VALUES ('lease_expired', 'household_1', 'voice_1', 'consent_pending', 'voice-v2-live-phrase', 'active', 1786420001000, 1786420000000)`);
  assert.throws(() => database.exec("UPDATE voice_consent_leases SET status = 'consumed', finalized_at = 4102444800000 WHERE id = 'lease_expired'"), /invalid_voice_consent_lease_transition/);

  database.exec(`
    INSERT INTO voice_consents (id, household_id, voice_id, adult_user_id, consent_version, scope, status, evidence, attested_at)
    VALUES ('consent_new', 'household_1', 'voice_1', 'adult_1', 'voice-v3-future', 'adult_self_private_narration', 'active_verified', '{}', 1786420002000);
    UPDATE voices SET current_consent_id = 'consent_new' WHERE id = 'voice_1';
  `);
  assert.throws(() => database.exec(`INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, status, expires_at, created_at)
    VALUES ('lease_stale', 'household_1', 'voice_1', 'consent_new', 'voice-v3-future', 'active', 4102444800000, 1786420002000)`), /voice_consent_version_not_current/);
});

test("a lease can only bind a session from its household", () => {
  const database = fixture();
  database.exec(`
    UPDATE voice_consents SET status = 'active_verified', consent_version = 'voice-v2-live-phrase' WHERE id = 'consent_pending';
    INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at)
    VALUES ('adult_2', 'other@example.com', 'free', 1, 1786420000000, 1786420000000);
    INSERT INTO households (id, name, owner_user_id, created_at, updated_at)
    VALUES ('household_2', 'Other', 'adult_2', 1786420000000, 1786420000000);
    INSERT INTO sleep_sessions (id, user_id, household_id, title, script, script_mode, content_type, narration_kind, theme, style, background_sound, duration_minutes, status, created_at)
    VALUES ('session_other', 'adult_2', 'household_2', 'Other', 'A sufficiently long safe script for the fixture', 'curated', 'story', 'demo_narrator', 'moonlit-meadow', 'slow-story', 'none', 5, 'queued', 1786420000000);
    INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, status, expires_at, created_at)
    VALUES ('lease_1', 'household_1', 'voice_1', 'consent_pending', 'voice-v2-live-phrase', 'active', 4102444800000, 1786420000000);
  `);
  assert.throws(() => database.exec("UPDATE voice_consent_leases SET session_id = 'session_other' WHERE id = 'lease_1'"), /invalid_voice_consent_lease_session/);
});

test("revocation releases tied reserved allowance and prevents a later commit", () => {
  const database = fixture();
  database.exec(`
    UPDATE voice_consents SET status = 'active_verified', consent_version = 'voice-v2-live-phrase' WHERE id = 'consent_pending';
    INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, status, expires_at, created_at)
    VALUES ('lease_1', 'household_1', 'voice_1', 'consent_pending', 'voice-v2-live-phrase', 'active', 4102444800000, 1786420000000);
    INSERT INTO entitlements (id, household_id, plan_id, source, status, allowance_milliunits, remaining_milliunits, valid_from, created_at, updated_at)
    VALUES ('entitlement_1', 'household_1', 'nearyou_plus', 'manual', 'active', 60000, 60000, 1786420000000, 1786420000000, 1786420000000);
    INSERT INTO usage_reservations
    (id, household_id, user_id, entitlement_id, operation, quantity, weight_milliunits, idempotency_key, request_hash, status, consent_lease_id, created_at, updated_at)
    VALUES ('reservation_1', 'household_1', 'adult_1', 'entitlement_1', 'nearsleep_audio_generation', 1, 5000, 'audio:req_1', 'hash_1', 'reserved', 'lease_1', 1786420001000, 1786420001000);
    UPDATE voice_consents SET status = 'revoked', revoked_at = 1786420002000 WHERE id = 'consent_pending';
  `);
  assert.equal(database.prepare("SELECT status FROM usage_reservations WHERE id = 'reservation_1'").get().status, "released");
  assert.equal(database.prepare("SELECT remaining_milliunits FROM entitlements WHERE id = 'entitlement_1'").get().remaining_milliunits, 60000);
  assert.throws(() => database.exec("UPDATE usage_reservations SET status = 'committed', finalized_at = 1786420003000 WHERE id = 'reservation_1'"), /invalid_usage_reservation_transition/);
});

test("session readiness atomically validates consumed consent and commits its allowance", () => {
  const database = fixture();
  database.exec(`
    UPDATE voice_consents SET status = 'active_verified', consent_version = 'voice-v2-live-phrase' WHERE id = 'consent_pending';
    INSERT INTO sleep_sessions (id, user_id, household_id, voice_id, title, script, script_mode, content_type, narration_kind, theme, style, background_sound, duration_minutes, status, created_at)
    VALUES ('session_1', 'adult_1', 'household_1', 'voice_1', 'Moon', 'A sufficiently long safe script for the fixture', 'curated', 'story', 'parent_clone', 'moonlit-meadow', 'slow-story', 'none', 5, 'generating', 1786420000000);
    INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, session_id, status, expires_at, created_at)
    VALUES ('lease_1', 'household_1', 'voice_1', 'consent_pending', 'voice-v2-live-phrase', 'session_1', 'active', 4102444800000, 1786420000000);
    INSERT INTO entitlements (id, household_id, plan_id, source, status, allowance_milliunits, remaining_milliunits, valid_from, created_at, updated_at)
    VALUES ('entitlement_1', 'household_1', 'nearyou_plus', 'manual', 'active', 60000, 60000, 1786420000000, 1786420000000, 1786420000000);
    INSERT INTO usage_reservations
    (id, household_id, user_id, entitlement_id, operation, quantity, weight_milliunits, idempotency_key, request_hash, status, consent_lease_id, created_at, updated_at)
    VALUES ('reservation_1', 'household_1', 'adult_1', 'entitlement_1', 'nearsleep_audio_generation', 1, 5000, 'audio:req_1', 'hash_1', 'reserved', 'lease_1', 1786420001000, 1786420001000);
    UPDATE sleep_sessions SET consent_id = 'consent_pending', consent_version = 'voice-v2-live-phrase', consent_lease_id = 'lease_1', allowance_reservation_id = 'reservation_1' WHERE id = 'session_1';
    UPDATE voice_consent_leases SET status = 'consumed', finalized_at = 1786420002000 WHERE id = 'lease_1';
  `);
  assert.throws(() => database.exec("UPDATE sleep_sessions SET status = 'ready', completed_at = 1786420003000 WHERE id = 'session_1'"), /invalid_session_generation_finalize/);
  database.exec("UPDATE sleep_sessions SET status = 'ready', audio_key = 'audio/household_1/session_1.mp3', completed_at = 1786420003000 WHERE id = 'session_1'");
  assert.equal(database.prepare("SELECT status FROM usage_reservations WHERE id = 'reservation_1'").get().status, "committed");
  assert.equal(database.prepare("SELECT status FROM sleep_sessions WHERE id = 'session_1'").get().status, "ready");
  assert.throws(() => database.exec("UPDATE sleep_sessions SET status = 'failed' WHERE id = 'session_1'"), /invalid_session_generation_transition/);
  assert.throws(() => database.exec("UPDATE sleep_sessions SET audio_key = 'audio/household_1/replaced.mp3' WHERE id = 'session_1'"), /invalid_session_generation_transition/);
  assert.deepEqual({ ...database.prepare("SELECT status, audio_key, allowance_reservation_id FROM sleep_sessions WHERE id = 'session_1'").get() }, {
    status: "ready",
    audio_key: "audio/household_1/session_1.mp3",
    allowance_reservation_id: "reservation_1",
  });

  database.exec(`
    INSERT INTO sleep_sessions (id, user_id, household_id, voice_id, title, script, script_mode, content_type, narration_kind, theme, style, background_sound, duration_minutes, status, created_at)
    VALUES ('session_bypass', 'adult_1', 'household_1', 'voice_1', 'Bypass', 'A sufficiently long safe script for the fixture', 'curated', 'story', 'parent_clone', 'moonlit-meadow', 'slow-story', 'none', 5, 'queued', 1786420004000);
    INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, session_id, status, expires_at, created_at)
    VALUES ('lease_bypass', 'household_1', 'voice_1', 'consent_pending', 'voice-v2-live-phrase', 'session_bypass', 'active', 4102444800000, 1786420004000);
    INSERT INTO usage_reservations
    (id, household_id, user_id, entitlement_id, operation, quantity, weight_milliunits, idempotency_key, request_hash, status, consent_lease_id, created_at, updated_at)
    VALUES ('reservation_bypass', 'household_1', 'adult_1', 'entitlement_1', 'nearsleep_audio_generation', 1, 5000, 'audio:req_bypass', 'hash_bypass', 'reserved', 'lease_bypass', 1786420005000, 1786420005000);
    UPDATE sleep_sessions SET consent_id = 'consent_pending', consent_version = 'voice-v2-live-phrase', consent_lease_id = 'lease_bypass', allowance_reservation_id = 'reservation_bypass' WHERE id = 'session_bypass';
    UPDATE voice_consent_leases SET status = 'consumed', finalized_at = 1786420006000 WHERE id = 'lease_bypass';
  `);
  assert.throws(() => database.exec("UPDATE sleep_sessions SET status = 'ready', audio_key = 'audio/household_1/session_bypass.mp3', completed_at = 1786420007000 WHERE id = 'session_bypass'"), /invalid_session_generation_transition/);
  assert.equal(database.prepare("SELECT status FROM usage_reservations WHERE id = 'reservation_bypass'").get().status, "reserved");

  database.exec(`
    INSERT INTO sleep_sessions (id, user_id, household_id, voice_id, title, script, script_mode, content_type, narration_kind, theme, style, background_sound, duration_minutes, status, created_at)
    VALUES ('session_2', 'adult_1', 'household_1', 'voice_1', 'Moon two', 'Another sufficiently long safe script for the fixture', 'curated', 'story', 'parent_clone', 'moonlit-meadow', 'slow-story', 'none', 5, 'generating', 1786420010000);
    INSERT INTO voice_consent_leases
    (id, household_id, voice_id, consent_id, consent_version, session_id, status, expires_at, created_at)
    VALUES ('lease_2', 'household_1', 'voice_1', 'consent_pending', 'voice-v2-live-phrase', 'session_2', 'active', 4102444800000, 1786420010000);
    INSERT INTO usage_reservations
    (id, household_id, user_id, entitlement_id, operation, quantity, weight_milliunits, idempotency_key, request_hash, status, consent_lease_id, created_at, updated_at)
    VALUES ('reservation_2', 'household_1', 'adult_1', 'entitlement_1', 'nearsleep_audio_generation', 1, 5000, 'audio:req_2', 'hash_2', 'reserved', 'lease_2', 1786420011000, 1786420011000);
    UPDATE sleep_sessions SET consent_id = 'consent_pending', consent_version = 'voice-v2-live-phrase', consent_lease_id = 'lease_2', allowance_reservation_id = 'reservation_2' WHERE id = 'session_2';
    UPDATE voice_consents SET status = 'revoked', revoked_at = 1786420012000 WHERE id = 'consent_pending';
  `);
  assert.throws(() => database.exec("UPDATE sleep_sessions SET status = 'ready', completed_at = 1786420013000 WHERE id = 'session_2'"), /invalid_session_generation_finalize/);
  assert.equal(database.prepare("SELECT status FROM usage_reservations WHERE id = 'reservation_2'").get().status, "released");
});
