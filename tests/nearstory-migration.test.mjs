import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrations = [
  "0000_nearnight_foundation.sql", "0001_google_apple_auth.sql", "0002_sharp_shinobi_shaw.sql",
  "0003_white_groot.sql", "0004_salty_sugar_man.sql", "0005_pronunciation_frequency_layers.sql",
  "0006_nearyou_shared_foundation.sql", "0007_nearsleep_production_upgrade.sql",
  "0008_nearsleep_live_integration.sql", "0009_nearsleep_audio_atomic.sql",
  "0010_child_profile_pronunciation.sql", "0011_household_billing_accounts.sql",
  "0012_nearsleep_library_privacy.sql", "0013_nearstory_parent_beta.sql",
];

function apply(database, name) {
  const sql = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
}

test("NearStory migration is additive, tenant-scoped, and rejects cross-household child and narrator references", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) apply(db, migration);
  for (const table of ["story_experiences", "story_segments", "story_branch_requests", "story_sound_assets"]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table), `missing ${table}`);
  }
  db.exec(`
    INSERT INTO users (id,email,subscription_status,credits_remaining,created_at,updated_at) VALUES ('u1','a@x.test','free',1,1,1),('u2','b@x.test','free',1,1,1);
    INSERT INTO households (id,name,owner_user_id,created_at,updated_at) VALUES ('h1','One','u1',1,1),('h2','Two','u2',1,1);
    INSERT INTO household_members (id,household_id,user_id,role,status,created_at,updated_at) VALUES ('m1','h1','u1','owner','active',1,1),('m2','h2','u2','owner','active',1,1);
    INSERT INTO entitlements (id,household_id,plan_id,source,status,allowance_milliunits,remaining_milliunits,valid_from,created_at,updated_at) VALUES ('e1','h1','nearyou_plus','test','active',60000,60000,1,1,1),('e2','h2','nearyou_plus','test','active',60000,60000,1,1,1);
    INSERT INTO child_profiles (id,household_id,nickname,normalized_nickname,pronunciation,created_at,updated_at) VALUES ('c1','h1','Lou','lou','LOU',1,1);
    INSERT INTO voices (id,user_id,household_id,provider_voice_id,name,status,consent_attested_at,created_at) VALUES ('v2','u2','h2','pv2','Voice','ready',1,1);
    INSERT INTO voice_consents (id,household_id,voice_id,adult_user_id,consent_version,scope,status,attested_at) VALUES ('vc2','h2','v2','u2','voice-consent-v2','adult_self_private_narration','active_verified',1);
    UPDATE voices SET current_consent_id='vc2' WHERE id='v2';
  `);
  assert.throws(() => db.exec(`INSERT INTO story_experiences (id,household_id,requested_by_user_id,child_profile_id,voice_id,mode,duration_minutes,plan,status,idempotency_key,request_hash,created_at,updated_at) VALUES ('s','h1','u1','c1','v2','bedtime',10,'{}','queued','r','x',1,1)`), /household/i);
  const sql = readFileSync(new URL("../drizzle/0013_nearstory_parent_beta.sql", import.meta.url), "utf8");
  assert.match(sql, /FOREIGN KEY \(`household_id`,`child_profile_id`\)/);
  assert.match(sql, /FOREIGN KEY \(`household_id`,`voice_id`\)/);
  assert.match(sql, /FOREIGN KEY \(`household_id`,`requested_by_user_id`\)/);
  assert.match(sql, /FOREIGN KEY \(`household_id`,`consent_id`\)/);
  assert.match(sql, /FOREIGN KEY \(`household_id`,`job_id`\)/);
  assert.match(sql, /FOREIGN KEY \(`household_id`,`reservation_id`\)/);
  assert.match(sql, /CHECK \(`ordinal` BETWEEN 0 AND 4\)/);
  assert.match(sql, /story_segments_story_branch_ordinal_idx/);
  assert.match(sql, /story_branch_target_unplayed/);
  assert.match(sql, /story_sound_assets_rights/);
  assert.match(sql, /story_sound_assets_processing_lease_(?:insert|update)/);
  assert.throws(() => db.exec(`INSERT INTO story_sound_assets (id,cache_key,descriptor,provenance,license_policy_version,provider,status,created_at,updated_at) VALUES ('fx-bad','calm','calm ambience','nearyou-allowlisted-effect','story-sfx-rights-v1','elevenlabs','processing',100,100)`), /processing_lease/);
  db.exec(`INSERT INTO story_sound_assets (id,cache_key,descriptor,provenance,license_policy_version,provider,attempt_token,attempt_expires_at,status,created_at,updated_at) VALUES ('fx','calm-v1','calm ambience','nearyou-allowlisted-effect','story-sfx-rights-v1','elevenlabs','attempt-token-1234567890',200,'processing',100,100)`);
  assert.throws(() => db.exec(`UPDATE story_sound_assets SET attempt_token='new-attempt-token-1234',attempt_expires_at=200,updated_at=200 WHERE id='fx'`), /processing_lease/);
  db.exec(`UPDATE story_sound_assets SET attempt_token='new-attempt-token-1234',attempt_expires_at=400,updated_at=300 WHERE id='fx'`);
  assert.equal(db.prepare("SELECT attempt_token token FROM story_sound_assets WHERE id='fx'").get().token, "new-attempt-token-1234");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
