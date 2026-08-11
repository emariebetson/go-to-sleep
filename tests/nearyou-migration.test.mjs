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
];

function applyMigration(database, name) {
  const sql = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    database.exec(statement);
  }
}

test("the additive NearYou bridge preserves and household-scopes legacy records", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations.slice(0, -1)) applyMigration(database, migration);
  database.exec(`
    INSERT INTO users (
      id, email, display_name, subscription_id, subscription_price_id,
      subscription_status, credits_remaining, consent_version, consented_at,
      created_at, updated_at
    ) VALUES (
      'user_1', 'adult@example.com', 'Adult', 'sub_legacy', 'price_legacy',
      'active', 7, 'voice-v1', 1786420000000, 1786420000000, 1786420000000
    );
    INSERT INTO users (id, email, display_name, subscription_status, credits_remaining, created_at, updated_at)
    VALUES ('user_2', 'listener@example.com', 'Listener', 'free', 1, 1786420000000, 1786420000000);
    INSERT INTO children (
      id, user_id, nickname, normalized_nickname, pronunciation, age_months,
      bedtime_challenge, created_at, updated_at
    ) VALUES (
      'child_1', 'user_1', 'Mia', 'mia', 'MEE-ah', 18,
      'settling', 1786420000000, 1786420000000
    );
    INSERT INTO children (id, user_id, nickname, normalized_nickname, created_at, updated_at)
    VALUES
      ('child_2', 'user_1', 'Lou', NULL, 1786420000001, 1786420000001),
      ('child_3', 'user_1', 'lou', NULL, 1786420000002, 1786420000002);
    INSERT INTO voices (
      id, user_id, provider_voice_id, name, status, consent_attested_at, created_at
    ) VALUES (
      'voice_1', 'user_1', 'provider_voice_1', 'Adult voice', 'ready',
      1786420000000, 1786420000000
    );
    INSERT INTO voices (id, user_id, provider_voice_id, name, status, consent_attested_at, created_at, deleted_at)
    VALUES ('voice_2', 'user_2', 'provider_voice_2', 'Deleted voice', 'deleted', 1786420000000, 1786420000000, 1786421000000);
    INSERT INTO sleep_sessions (
      id, user_id, child_id, voice_id, title, script, script_mode, content_type,
      narration_kind, theme, style, background_sound, pronunciation,
      frequency_layers, duration_minutes, status, audio_key, created_at, completed_at
    ) VALUES (
      'session_1', 'user_1', 'child_1', 'voice_1', 'Moon', 'Sleep now', 'curated',
      'story', 'parent_clone', 'moonlit-meadow', 'slow-story', 'soft-rain', 'MEE-ah',
      '[]', 10, 'ready', 'audio/user_1/session_1.mp3', 1786420000000, 1786421000000
    );
    INSERT INTO usage_events (id, user_id, session_id, type, units, metadata, created_at)
    VALUES ('usage_1', 'user_1', 'session_1', 'audio_generation', 1, '{}', 1786420000000);
  `);

  applyMigration(database, migrations.at(-1));

  const tableNames = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(({ name }) => name);
  for (const required of [
    "child_profiles", "contributors", "entitlements", "household_invitations", "household_members", "households",
    "jobs", "media_assets", "playlist_items", "playlists", "usage_ledger", "voice_consents",
  ]) assert.ok(tableNames.includes(required), `missing ${required}`);

  assert.deepEqual({ ...database.prepare("SELECT owner_user_id, name FROM households WHERE owner_user_id = 'user_1'").get() }, {
    owner_user_id: "user_1",
    name: "Adult's household",
  });
  assert.deepEqual({ ...database.prepare("SELECT household_id, role, status FROM household_members WHERE user_id = 'user_1'").get() }, {
    household_id: "household:user_1",
    role: "owner",
    status: "active",
  });
  assert.deepEqual({ ...database.prepare("SELECT household_id, legacy_child_id, nickname FROM child_profiles WHERE legacy_child_id = 'child_1'").get() }, {
    household_id: "household:user_1",
    legacy_child_id: "child_1",
    nickname: "Mia",
  });
  const louProfiles = database.prepare("SELECT normalized_nickname FROM child_profiles WHERE legacy_child_id IN ('child_2', 'child_3') ORDER BY legacy_child_id").all();
  assert.equal(new Set(louProfiles.map(({ normalized_nickname }) => normalized_nickname)).size, 2);
  assert.ok(louProfiles.some(({ normalized_nickname }) => normalized_nickname === "lou"));
  assert.deepEqual({ ...database.prepare("SELECT plan_id, remaining_milliunits, legacy_credits_remaining FROM entitlements WHERE household_id = 'household:user_1'").get() }, {
    plan_id: "nearsleep_plus_legacy",
    remaining_milliunits: 7000,
    legacy_credits_remaining: 7,
  });
  assert.deepEqual({ ...database.prepare("SELECT consent_version, scope, status FROM voice_consents WHERE voice_id = 'voice_1'").get() }, {
    consent_version: "legacy-voice-checkbox-v1",
    scope: "adult_self_private_narration",
    status: "pending_verification",
  });
  assert.deepEqual({ ...database.prepare("SELECT consent_version, status, revoked_at FROM voice_consents WHERE voice_id = 'voice_2'").get() }, {
    consent_version: "legacy-voice-checkbox-v1",
    status: "revoked",
    revoked_at: 1786421000000,
  });
  assert.deepEqual({ ...database.prepare("SELECT plan_id, remaining_milliunits FROM entitlements WHERE household_id = 'household:user_2'").get() }, {
    plan_id: "nearsleep_free",
    remaining_milliunits: 1000,
  });
  assert.equal(database.prepare("SELECT household_id FROM children WHERE id = 'child_1'").get().household_id, "household:user_1");
  assert.equal(database.prepare("SELECT household_id FROM voices WHERE id = 'voice_1'").get().household_id, "household:user_1");
  assert.equal(database.prepare("SELECT household_id FROM sleep_sessions WHERE id = 'session_1'").get().household_id, "household:user_1");
  assert.equal(database.prepare("SELECT subscription_id FROM users WHERE id = 'user_1'").get().subscription_id, "sub_legacy");
  assert.equal(database.prepare("SELECT credits_remaining FROM users WHERE id = 'user_1'").get().credits_remaining, 7);
  assert.equal(database.prepare("SELECT audio_key FROM sleep_sessions WHERE id = 'session_1'").get().audio_key, "audio/user_1/session_1.mp3");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  const ownerForeignKey = database.prepare("PRAGMA foreign_key_list('households')").all().find(({ from }) => from === "owner_user_id");
  assert.equal(ownerForeignKey.on_delete.toLowerCase(), "restrict");
  database.exec("UPDATE households SET owner_user_id = 'user_2' WHERE id = 'household:user_1'");
  assert.equal(database.prepare("SELECT owner_user_id FROM households WHERE id = 'household:user_1'").get().owner_user_id, "user_2");
  assert.ok(database.prepare("PRAGMA table_info('jobs')").all().some(({ name, notnull }) => name === "request_hash" && notnull === 1));
});
