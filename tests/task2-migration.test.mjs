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
];

function applyMigration(database, name) {
  const sql = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
}

test("the production upgrade adds durable consent, reservation, budget, and playback state without rewriting legacy data", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations.slice(0, -1)) applyMigration(database, migration);
  database.exec(`
    INSERT INTO users (id, email, display_name, subscription_status, credits_remaining, created_at, updated_at)
    VALUES ('user_1', 'adult@example.com', 'Adult', 'active', 7, 1786420000000, 1786420000000);
  `);
  applyMigration(database, migrations.at(-1));

  const tables = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(({ name }) => name));
  for (const table of [
    "adult_onboarding_acceptances",
    "voice_verification_challenges",
    "voice_consent_leases",
    "voice_replacements",
    "usage_reservations",
    "provider_spend_reservations",
    "provider_budget_policies",
    "provider_circuits",
    "generation_operations",
    "bedtime_queue_items",
  ]) assert.ok(tables.has(table), `missing ${table}`);

  const jobColumns = new Set(database.prepare("PRAGMA table_info('jobs')").all().map(({ name }) => name));
  for (const column of ["progress_percent", "progress_stage", "reservation_id", "consent_id", "consent_version"]) assert.ok(jobColumns.has(column), `jobs.${column} missing`);
  const sessionColumns = new Set(database.prepare("PRAGMA table_info('sleep_sessions')").all().map(({ name }) => name));
  for (const column of ["consent_id", "consent_version", "favorite", "repeat_minutes"]) assert.ok(sessionColumns.has(column), `sleep_sessions.${column} missing`);

  assert.deepEqual({ ...database.prepare("SELECT subscription_status, credits_remaining FROM users WHERE id = 'user_1'").get() }, {
    subscription_status: "active",
    credits_remaining: 7,
  });
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  const sessionConsentFk = database.prepare("PRAGMA foreign_key_list('sleep_sessions')").all().find(({ from }) => from === "consent_id");
  const jobReservationFk = database.prepare("PRAGMA foreign_key_list('jobs')").all().find(({ from }) => from === "reservation_id");
  const jobConsentFk = database.prepare("PRAGMA foreign_key_list('jobs')").all().find(({ from }) => from === "consent_id");
  assert.equal(sessionConsentFk.on_delete.toLowerCase(), "set null");
  assert.equal(jobReservationFk.on_delete.toLowerCase(), "set null");
  assert.equal(jobConsentFk.on_delete.toLowerCase(), "set null");
});

test("voice replacement activation is one CAS-bound transaction and revocation wins races", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) applyMigration(database, migration);
  database.exec(`
    INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at)
    VALUES ('user_1', 'adult@example.com', 'active', 1, 1786420000000, 1786420000000);
    INSERT INTO households (id, name, owner_user_id, created_at, updated_at)
    VALUES ('household:user_1', 'Home', 'user_1', 1786420000000, 1786420000000);
    INSERT INTO adult_onboarding_acceptances (id, household_id, adult_user_id, version, attestation, accepted_at)
    VALUES ('onboarding_1', 'household:user_1', 'user_1', 'adult-caregiver-v1', 'accepted', 1786420000000);
    INSERT INTO voices (id, user_id, household_id, provider_voice_id, name, status, consent_attested_at, created_at)
    VALUES ('voice_1', 'user_1', 'household:user_1', 'provider_old', 'Adult voice', 'ready', 1786420000000, 1786420000000);
    INSERT INTO voice_consents (id, household_id, voice_id, adult_user_id, consent_version, scope, status, evidence, attested_at)
    VALUES ('consent_old', 'household:user_1', 'voice_1', 'user_1', 'legacy-voice-checkbox-v1', 'adult_self_private_narration', 'pending_verification', '{}', 1786420000000);
    UPDATE voices SET current_consent_id = 'consent_old' WHERE id = 'voice_1';
    INSERT INTO voice_verification_challenges (id, household_id, voice_id, adult_user_id, onboarding_acceptance_id, version, phrase, phrase_hash, status, attempts, expires_at, created_at)
    VALUES ('challenge_1', 'household:user_1', 'voice_1', 'user_1', 'onboarding_1', 'live-phrase-v1', 'gentle moon amber river quiet cloud', 'phrase_hash', 'processing', 1, 1786442700000, 1786442400000);
    INSERT INTO voice_replacements (id, household_id, voice_id, challenge_id, adult_user_id, original_provider_voice_id, original_consent_id, replacement_provider_voice_id, consent_id, consent_version, evidence, status, created_at, updated_at)
    VALUES ('replacement_1', 'household:user_1', 'voice_1', 'challenge_1', 'user_1', 'provider_old', 'consent_old', 'provider_new', 'consent_new', 'voice-v2-live-phrase', '{"verified":true}', 'provider_created', 1786442400000, 1786442400000);
  `);
  database.exec(`UPDATE voice_replacements SET status = 'activating', updated_at = 1786442401000
    WHERE id = 'replacement_1' AND status = 'provider_created'
    AND EXISTS (SELECT 1 FROM voices WHERE id = voice_replacements.voice_id AND status = 'ready' AND provider_voice_id = voice_replacements.original_provider_voice_id AND current_consent_id = voice_replacements.original_consent_id)`);
  assert.deepEqual({ ...database.prepare("SELECT provider_voice_id, current_consent_id, status FROM voices WHERE id = 'voice_1'").get() }, { provider_voice_id: "provider_new", current_consent_id: "consent_new", status: "ready" });
  assert.equal(database.prepare("SELECT status FROM voice_consents WHERE id = 'consent_new'").get().status, "active_verified");
  assert.equal(database.prepare("SELECT status FROM voice_verification_challenges WHERE id = 'challenge_1'").get().status, "verified");
  assert.equal(database.prepare("SELECT status FROM voice_replacements WHERE id = 'replacement_1'").get().status, "cleanup_pending");

  database.exec(`
    INSERT INTO voices (id, user_id, household_id, provider_voice_id, name, status, consent_attested_at, created_at)
    VALUES ('voice_2', 'user_1', 'household:user_1', 'provider_old_2', 'Other voice', 'deleted', 1786420000000, 1786420000000);
    INSERT INTO voice_consents (id, household_id, voice_id, adult_user_id, consent_version, scope, status, evidence, attested_at, revoked_at)
    VALUES ('consent_old_2', 'household:user_1', 'voice_2', 'user_1', 'legacy-voice-checkbox-v1', 'adult_self_private_narration', 'revoked', '{}', 1786420000000, 1786442400000);
    UPDATE voices SET current_consent_id = 'consent_old_2' WHERE id = 'voice_2';
    INSERT INTO voice_verification_challenges (id, household_id, voice_id, adult_user_id, onboarding_acceptance_id, version, phrase, phrase_hash, status, attempts, expires_at, created_at)
    VALUES ('challenge_2', 'household:user_1', 'voice_2', 'user_1', 'onboarding_1', 'live-phrase-v1', 'gentle moon amber river quiet cloud', 'phrase_hash_2', 'processing', 1, 1786442700000, 1786442400000);
    INSERT INTO voice_replacements (id, household_id, voice_id, challenge_id, adult_user_id, original_provider_voice_id, original_consent_id, replacement_provider_voice_id, consent_id, consent_version, evidence, status, created_at, updated_at)
    VALUES ('replacement_2', 'household:user_1', 'voice_2', 'challenge_2', 'user_1', 'provider_old_2', 'consent_old_2', 'provider_new_2', 'consent_new_2', 'voice-v2-live-phrase', '{"verified":true}', 'provider_created', 1786442400000, 1786442400000);
  `);
  database.exec(`UPDATE voice_replacements SET status = 'activating', updated_at = 1786442401000
    WHERE id = 'replacement_2' AND status = 'provider_created'
    AND EXISTS (SELECT 1 FROM voices WHERE id = voice_replacements.voice_id AND status = 'ready' AND provider_voice_id = voice_replacements.original_provider_voice_id AND current_consent_id = voice_replacements.original_consent_id)`);
  assert.equal(database.prepare("SELECT count(*) AS value FROM voice_consents WHERE id = 'consent_new_2'").get().value, 0);
  assert.equal(database.prepare("SELECT status FROM voice_replacements WHERE id = 'replacement_2'").get().status, "provider_created");

  database.exec(`
    UPDATE voice_replacements SET status = 'failed', error_code = 'provider_capacity' WHERE id = 'replacement_2';
    UPDATE voice_verification_challenges SET status = 'failed', phrase = '' WHERE id = 'challenge_2';
    INSERT INTO voice_verification_challenges (id, household_id, voice_id, adult_user_id, onboarding_acceptance_id, version, phrase, phrase_hash, status, attempts, expires_at, created_at)
    VALUES ('challenge_3', 'household:user_1', 'voice_2', 'user_1', 'onboarding_1', 'live-phrase-v1', 'silver tide amber willow quiet moon', 'phrase_hash_3', 'processing', 1, 1786442800000, 1786442500000);
    INSERT INTO voice_replacements (id, household_id, voice_id, challenge_id, adult_user_id, original_provider_voice_id, original_consent_id, consent_id, consent_version, status, created_at, updated_at)
    VALUES ('replacement_3', 'household:user_1', 'voice_2', 'challenge_3', 'user_1', 'provider_old_2', 'consent_old_2', 'consent_new_3', 'voice-v2-live-phrase', 'processing', 1786442500000, 1786442500000);
  `);
  assert.equal(database.prepare("SELECT status FROM voice_replacements WHERE id = 'replacement_3'").get().status, "processing");
});
