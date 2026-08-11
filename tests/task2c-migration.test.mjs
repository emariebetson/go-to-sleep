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
  "0012_nearsleep_library_privacy.sql",
];

function applyMigration(database, name) {
  const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
}

function fixture(planId = "nearsleep_free") {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) applyMigration(database, migration);
  const now = Date.now();
  database.prepare("INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at) VALUES ('adult_1', 'one@example.test', 'active', 1, ?, ?)").run(now, now);
  database.prepare("INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at) VALUES ('adult_2', 'two@example.test', 'active', 1, ?, ?)").run(now, now);
  database.prepare("INSERT INTO households (id, name, owner_user_id, created_at, updated_at) VALUES ('house_1', 'One', 'adult_1', ?, ?)").run(now, now);
  database.prepare("INSERT INTO households (id, name, owner_user_id, created_at, updated_at) VALUES ('house_2', 'Two', 'adult_2', ?, ?)").run(now, now);
  database.prepare("INSERT INTO household_members (id, household_id, user_id, role, status, created_at, updated_at) VALUES ('member_1', 'house_1', 'adult_1', 'owner', 'active', ?, ?)").run(now, now);
  database.prepare("INSERT INTO household_members (id, household_id, user_id, role, status, created_at, updated_at) VALUES ('member_2', 'house_2', 'adult_2', 'owner', 'active', ?, ?)").run(now, now);
  database.prepare("INSERT INTO entitlements (id, household_id, plan_id, source, status, allowance_milliunits, remaining_milliunits, valid_from, created_at, updated_at) VALUES ('grant_1', 'house_1', ?, 'manual', 'active', 1000, 1000, ?, ?, ?)").run(planId, now - 1000, now, now);
  database.prepare("INSERT INTO entitlements (id, household_id, plan_id, source, status, allowance_milliunits, remaining_milliunits, valid_from, created_at, updated_at) VALUES ('grant_2', 'house_2', 'nearyou_plus', 'manual', 'active', 60000, 60000, ?, ?, ?)").run(now - 1000, now, now);
  return database;
}

function readyMedia(database, suffix, householdId, userId, byteSize = 100) {
  const now = Date.now();
  database.prepare("INSERT INTO media_assets (id, household_id, owner_user_id, kind, status, storage_key, content_type, byte_size, checksum, private, created_at, updated_at) VALUES (?, ?, ?, 'photo', 'processing', ?, 'application/octet-stream', ?, ?, 1, ?, ?)")
    .run(`media_${suffix}`, householdId, userId, `media/${householdId}/${suffix}.bin`, byteSize, "a".repeat(64), now, now);
  database.prepare("INSERT INTO household_storage_reservations (id, household_id, media_asset_id, byte_size, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'reserved', ?, ?)")
    .run(`storage_${suffix}`, householdId, `media_${suffix}`, byteSize, now, now);
  database.prepare("UPDATE media_assets SET status = 'ready', updated_at = ? WHERE id = ?").run(now, `media_${suffix}`);
}

test("0012 adds durable export, session deletion, and account deletion state", () => {
  const database = fixture();
  const tables = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(({ name }) => name));
  assert.ok(tables.has("household_exports"));
  assert.ok(tables.has("household_export_parts"));
  assert.ok(tables.has("household_export_metadata_pages"));
  assert.ok(tables.has("household_export_download_confirmations"));
  assert.ok(tables.has("account_deletion_operations"));
  assert.ok(tables.has("account_reauth_challenges"));
  assert.ok(tables.has("household_storage_reservations"));
  const columns = new Set(database.prepare("PRAGMA table_info('sleep_sessions')").all().map(({ name }) => name));
  assert.ok(columns.has("deletion_status"));
  assert.ok(columns.has("deletion_requested_at"));
  assert.ok(columns.has("deleted_at"));
  const activationColumns = new Set(database.prepare("PRAGMA table_info('task2c_activation_state')").all().map(({ name }) => name));
  assert.ok(activationColumns.has("scheduler_heartbeat_at"));
  assert.ok(activationColumns.has("scheduler_run_id"));
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("completed export deletion requires a server-recorded full package confirmation", () => {
  const database = fixture("nearyou_plus");
  const now = Date.now();
  database.prepare("INSERT INTO household_exports (id,household_id,requested_by_user_id,idempotency_key,request_hash,snapshot,status,inventory_stage,inventory_count,metadata_page_count,cursor_position,manifest_storage_key,manifest_byte_size,manifest_checksum,expires_at,created_at,updated_at,completed_at) VALUES ('export_confirm','house_1','adult_1','export-request','hash','{}','succeeded','copy',0,1,0,'exports/manifest.json',2,?, ?,?,?,?)").run("a".repeat(64), now + 60_000, now, now, now);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM household_export_download_confirmations WHERE export_id='export_confirm'").get().count, 0);
  database.prepare("INSERT INTO household_export_download_confirmations (export_id,user_id,manifest_checksum,artifact_count,confirmed_at) VALUES ('export_confirm','adult_1',?,1,?)").run("a".repeat(64), now);
  assert.equal(database.prepare("SELECT artifact_count FROM household_export_download_confirmations WHERE export_id='export_confirm'").get().artifact_count, 1);
});

test("0012 fails its named owner-membership preflight before creating the unique owner index", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations.slice(0, -1)) applyMigration(database, migration);
  const now = Date.now();
  database.prepare("INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at) VALUES ('owner_expected', 'expected@example.test', 'active', 1, ?, ?)").run(now, now);
  database.prepare("INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at) VALUES ('owner_wrong', 'wrong@example.test', 'active', 1, ?, ?)").run(now, now);
  database.prepare("INSERT INTO households (id, name, owner_user_id, created_at, updated_at) VALUES ('broken_house', 'Broken', 'owner_expected', ?, ?)").run(now, now);
  database.prepare("INSERT INTO household_members (id, household_id, user_id, role, status, created_at, updated_at) VALUES ('wrong_owner_member', 'broken_house', 'owner_wrong', 'owner', 'active', ?, ?)").run(now, now);

  assert.throws(() => applyMigration(database, migrations.at(-1)), /task_2c_owner_membership_preflight/);
  assert.equal(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'household_members_active_owner_idx'").get(), undefined);
});

test("pending invitations and active member restoration share one database-enforced plan cap", () => {
  const database = fixture();
  const now = Date.now();
  assert.throws(() => database.prepare("INSERT INTO household_invitations (id, household_id, invited_by_user_id, invited_email, role, token_hash, status, expires_at, created_at, updated_at) VALUES ('invite_over', 'house_1', 'adult_1', 'new@example.test', 'listener', 'hash_over', 'pending', ?, ?, ?)").run(now + 60_000, now, now), /household_member_limit_reached/);
  database.prepare("UPDATE entitlements SET plan_id = 'nearyou_plus' WHERE id = 'grant_1'").run();
  database.prepare("INSERT INTO household_invitations (id, household_id, invited_by_user_id, invited_email, role, token_hash, status, expires_at, created_at, updated_at) VALUES ('invite_one', 'house_1', 'adult_1', 'new@example.test', 'listener', 'hash_one', 'pending', ?, ?, ?)").run(now + 60_000, now, now);
  assert.throws(() => database.prepare("INSERT INTO household_invitations (id, household_id, invited_by_user_id, invited_email, role, token_hash, status, expires_at, created_at, updated_at) VALUES ('invite_two', 'house_1', 'adult_1', 'other@example.test', 'listener', 'hash_two', 'pending', ?, ?, ?)").run(now + 60_000, now, now), /household_member_limit_reached/);
  database.prepare("UPDATE household_invitations SET status = 'revoked' WHERE id = 'invite_one'").run();
  database.prepare("INSERT INTO household_members (id, household_id, user_id, role, status, created_at, updated_at) VALUES ('inactive_member', 'house_1', 'adult_2', 'listener', 'removed', ?, ?)").run(now, now);
  database.prepare("INSERT INTO household_invitations (id, household_id, invited_by_user_id, invited_email, role, token_hash, status, expires_at, created_at, updated_at) VALUES ('invite_reserved', 'house_1', 'adult_1', 'reserved@example.test', 'listener', 'hash_reserved', 'pending', ?, ?, ?)").run(now + 60_000, now, now);
  assert.throws(() => database.prepare("UPDATE household_members SET status = 'active', updated_at = ? WHERE id = 'inactive_member'").run(now), /household_member_limit_reached/);
});

test("playlist limits and playlist media tenant binding are atomic database invariants", () => {
  const database = fixture();
  const now = Date.now();
  readyMedia(database, "own", "house_1", "adult_1");
  readyMedia(database, "foreign", "house_2", "adult_2");
  database.prepare("INSERT INTO playlists (id, household_id, created_by_user_id, name, private, created_at, updated_at) VALUES ('list_1', 'house_1', 'adult_1', 'Bedtime', 1, ?, ?)").run(now, now);
  assert.throws(() => database.prepare("INSERT INTO playlists (id, household_id, created_by_user_id, name, private, created_at, updated_at) VALUES ('list_2', 'house_1', 'adult_1', 'More', 1, ?, ?)").run(now, now), /household_playlist_limit_reached/);
  database.prepare("INSERT INTO playlist_items (id, playlist_id, media_asset_id, position, created_at) VALUES ('item_1', 'list_1', 'media_own', 0, ?)").run(now);
  assert.throws(() => database.prepare("INSERT INTO playlist_items (id, playlist_id, media_asset_id, position, created_at) VALUES ('item_foreign', 'list_1', 'media_foreign', 1, ?)").run(now), /playlist_media_household_mismatch/);
  assert.throws(() => database.prepare("UPDATE playlists SET private = 0 WHERE id = 'list_1'").run(), /playlist_tenant_binding_immutable/);
  assert.throws(() => database.prepare("UPDATE playlist_items SET media_asset_id = 'media_foreign' WHERE id = 'item_1'").run(), /playlist_item_binding_immutable/);
});

test("bedtime queue requires an active ready same-household session and enforces its cap in the write", () => {
  const database = fixture();
  const now = Date.now();
  for (let index = 0; index < 10; index += 1) {
    database.prepare("INSERT INTO sleep_sessions (id, user_id, household_id, title, script, script_mode, content_type, narration_kind, theme, style, background_sound, duration_minutes, status, audio_key, created_at, completed_at) VALUES (?, 'adult_1', 'house_1', 'Night', 'script', 'curated', 'story', 'demo_narrator', 'moonlit-meadow', 'gentle', 'none', 5, 'ready', ?, ?, ?)")
      .run(`session_${index}`, `audio/house_1/session_${index}.mp3`, now, now);
    database.prepare("INSERT INTO bedtime_queue_items (id, household_id, queued_by_user_id, session_id, position, status, created_at, updated_at) VALUES (?, 'house_1', 'adult_1', ?, ?, 'queued', ?, ?)")
      .run(`queue_${index}`, `session_${index}`, index, now, now);
  }
  database.prepare("INSERT INTO sleep_sessions (id, user_id, household_id, title, script, script_mode, content_type, narration_kind, theme, style, background_sound, duration_minutes, status, audio_key, created_at, completed_at) VALUES ('session_over', 'adult_1', 'house_1', 'Night', 'script', 'curated', 'story', 'demo_narrator', 'moonlit-meadow', 'gentle', 'none', 5, 'ready', 'audio/house_1/over.mp3', ?, ?)").run(now, now);
  assert.throws(() => database.prepare("INSERT INTO bedtime_queue_items (id, household_id, queued_by_user_id, session_id, position, status, created_at, updated_at) VALUES ('queue_over', 'house_1', 'adult_1', 'session_over', 10, 'queued', ?, ?)").run(now, now), /household_queue_limit_reached/);
  database.prepare("UPDATE sleep_sessions SET deletion_status = 'delete_pending', deletion_requested_at = ? WHERE id = 'session_over'").run(now);
  database.prepare("UPDATE bedtime_queue_items SET status = 'removed' WHERE id = 'queue_0'").run();
  assert.throws(() => database.prepare("INSERT INTO bedtime_queue_items (id, household_id, queued_by_user_id, session_id, position, status, created_at, updated_at) VALUES ('queue_pending', 'house_1', 'adult_1', 'session_over', 10, 'queued', ?, ?)").run(now, now), /queue_session_unavailable/);
  database.prepare("INSERT INTO sleep_sessions (id, user_id, household_id, title, script, script_mode, content_type, narration_kind, theme, style, background_sound, duration_minutes, status, audio_key, created_at, completed_at) VALUES ('session_foreign', 'adult_2', 'house_2', 'Night', 'script', 'curated', 'story', 'demo_narrator', 'moonlit-meadow', 'gentle', 'none', 5, 'ready', 'audio/house_2/foreign.mp3', ?, ?)").run(now, now);
  assert.throws(() => database.prepare("INSERT INTO bedtime_queue_items (id, household_id, queued_by_user_id, session_id, position, status, created_at, updated_at) VALUES ('queue_foreign', 'house_1', 'adult_1', 'session_foreign', 10, 'queued', ?, ?)").run(now, now), /queue_session_unavailable/);
  assert.throws(() => database.prepare("UPDATE bedtime_queue_items SET session_id = 'session_foreign' WHERE id = 'queue_1'").run(), /queue_binding_immutable/);
});

test("ready media storage is enforced atomically and deleted media releases quota", () => {
  const database = fixture();
  readyMedia(database, "full", "house_1", "adult_1", 999_999_950);
  assert.throws(() => readyMedia(database, "over", "house_1", "adult_1", 100), /household_storage_limit_reached/);
  const now = Date.now();
  database.prepare("UPDATE media_assets SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = 'media_full'").run(now, now);
  readyMedia(database, "after_delete", "house_1", "adult_1", 100);
  assert.equal(database.prepare("SELECT status FROM media_assets WHERE id = 'media_after_delete'").get().status, "ready");
  assert.throws(() => database.prepare("INSERT INTO media_assets (id, household_id, owner_user_id, kind, status, storage_key, content_type, byte_size, checksum, private, created_at, updated_at) VALUES ('media_direct', 'house_1', 'adult_1', 'photo', 'ready', 'media/house_1/direct.bin', 'application/octet-stream', 1, ?, 1, ?, ?)").run("b".repeat(64), now, now), /media_storage_not_reserved/);
  assert.throws(() => database.prepare("UPDATE media_assets SET byte_size = 1 WHERE id = 'media_after_delete'").run(), /ready_media_binding_immutable/);
  database.prepare("INSERT INTO media_assets (id, household_id, owner_user_id, kind, status, storage_key, content_type, byte_size, checksum, private, created_at, updated_at) VALUES ('media_aborted', 'house_1', 'adult_1', 'photo', 'processing', 'media/house_1/aborted.bin', 'application/octet-stream', 50, ?, 1, ?, ?)").run("c".repeat(64), now, now);
  database.prepare("INSERT INTO household_storage_reservations (id, household_id, media_asset_id, byte_size, status, created_at, updated_at) VALUES ('storage_aborted', 'house_1', 'media_aborted', 50, 'reserved', ?, ?)").run(now, now);
  database.prepare("UPDATE media_assets SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = 'media_aborted'").run(now, now);
  assert.equal(database.prepare("SELECT status FROM household_storage_reservations WHERE id = 'storage_aborted'").get().status, "released");
});

test("account deletion atomically requires a sole owner membership and fences invitation acceptance", () => {
  const database = fixture("nearyou_plus");
  const now = Date.now();
  database.prepare("INSERT INTO account_reauth_challenges (id,user_id,initial_session_id,verified_session_id,status,expires_at,created_at,verified_at) VALUES ('reauth_1','adult_1','old_session','new_session','verified',?,?,?)").run(now + 60_000, now - 1_000, now);
  const startDeletion = () => database.prepare("INSERT INTO account_deletion_operations (id,user_id,household_id,subject_receipt_hash,idempotency_key,request_hash,reauth_challenge_id,reauth_session_id,status,stage,export_policy,grace_until,snapshot,created_at,updated_at) VALUES ('delete_1','adult_1','house_1',?,'request_1','request_hash','reauth_1','new_session','grace_period','fenced','skip',?,'{}',?,?)")
    .run("f".repeat(64), now, now, now);

  database.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,created_at,updated_at) VALUES ('cross_member','house_2','adult_1','listener','active',?,?)").run(now, now);
  assert.throws(startDeletion, /account_deletion_membership_conflict/);
  database.prepare("UPDATE household_members SET status = 'removed' WHERE id = 'cross_member'").run();
  database.prepare("INSERT INTO household_billing_accounts (household_id,status,checkout_pending_at,checkout_operation_id,checkout_price_id,checkout_status,checkout_expires_at,created_at,updated_at) VALUES ('house_1','free',?,'checkout_operation','price_test','creating',?,?,?)").run(now, now + 60_000, now, now);
  assert.throws(startDeletion, /account_deletion_checkout_in_progress/);
  database.prepare("UPDATE household_billing_accounts SET checkout_pending_at = NULL, checkout_status = 'expired'").run();
  database.prepare("INSERT INTO household_invitations (id,household_id,invited_by_user_id,invited_email,role,token_hash,status,expires_at,created_at,updated_at) VALUES ('invite_before_delete','house_1','adult_1','invitee@example.test','listener','hash_before','pending',?,?,?)").run(now + 60_000, now, now);
  startDeletion();

  assert.throws(() => database.prepare("UPDATE household_invitations SET status = 'accepted' WHERE id = 'invite_before_delete'").run(), /account_deletion_fenced/);
  database.prepare("UPDATE household_invitations SET status = 'revoked' WHERE id = 'invite_before_delete'").run();
  assert.throws(() => database.prepare("INSERT INTO household_invitations (id,household_id,invited_by_user_id,invited_email,role,token_hash,status,expires_at,created_at,updated_at) VALUES ('invite_after_delete','house_1','adult_1','late@example.test','listener','hash_after','pending',?,?,?)").run(now + 60_000, now, now), /account_deletion_fenced/);
  assert.throws(() => database.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,created_at,updated_at) VALUES ('late_member','house_1','adult_2','listener','active',?,?)").run(now, now), /account_deletion_fenced/);
  assert.throws(() => database.prepare("UPDATE household_billing_accounts SET checkout_pending_at = ?, checkout_status = 'creating' WHERE household_id = 'house_1'").run(now), /account_deletion_fenced/);
  assert.throws(() => database.prepare("UPDATE household_members SET status = 'active' WHERE id = 'cross_member'").run(), /account_deletion_subject_fenced/);
  assert.throws(() => database.prepare("UPDATE households SET owner_user_id = 'adult_1' WHERE id = 'house_2'").run(), /account_deletion_subject_fenced/);

  database.prepare("UPDATE account_deletion_operations SET status = 'canceled', stage = 'canceled', user_id = NULL, household_id = NULL WHERE id = 'delete_1'").run();
  database.prepare("UPDATE household_members SET status = 'active' WHERE id = 'cross_member'").run();
  assert.equal(database.prepare("SELECT status FROM household_members WHERE id = 'cross_member'").get().status, "active");
});
