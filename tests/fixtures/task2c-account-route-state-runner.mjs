import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migrations = [
  "0000_nearnight_foundation.sql", "0001_google_apple_auth.sql", "0002_sharp_shinobi_shaw.sql", "0003_white_groot.sql",
  "0004_salty_sugar_man.sql", "0005_pronunciation_frequency_layers.sql", "0006_nearyou_shared_foundation.sql",
  "0007_nearsleep_production_upgrade.sql", "0008_nearsleep_live_integration.sql", "0009_nearsleep_audio_atomic.sql",
  "0010_child_profile_pronunciation.sql", "0011_household_billing_accounts.sql", "0012_nearsleep_library_privacy.sql",
  "0013_nearstory_parent_beta.sql",
];

class D1Statement {
  constructor(database, source, parameters = []) { this.database = database; this.source = source; this.parameters = parameters; }
  bind(...parameters) { return new D1Statement(this.database, this.source, parameters); }
  execute() {
    const statement = this.database.prepare(this.source);
    if (statement.columns().length) {
      const results = statement.all(...this.parameters);
      return { success: true, results, meta: { changes: this.database.prepare("SELECT changes() AS value").get().value } };
    }
    const result = statement.run(...this.parameters);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  async raw() { const statement = this.database.prepare(this.source); statement.setReturnArrays(true); return statement.all(...this.parameters); }
}

class D1DatabaseFixture {
  constructor(database) { this.database = database; this.maxBatchSize = 0; }
  prepare(source) { return new D1Statement(this.database, source); }
  async batch(statements) {
    this.maxBatchSize = Math.max(this.maxBatchSize, statements.length);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class R2Fixture {
  constructor() { this.objects = new Map(); this.deleteLostKey = null; }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
      if (this.deleteLostKey === key) { this.deleteLostKey = null; throw new Error("simulated_r2_delete_lost_response"); }
    }
  }
  async head(key) { return this.objects.has(key) ? { size: this.objects.get(key).byteLength } : null; }
}

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
for (const name of migrations) {
  const source = readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
}
const r2 = new R2Fixture();
const d1 = new D1DatabaseFixture(database);
globalThis.__TASK2B_CLOUDFLARE_ENV__ = { DB: d1, AUDIO: r2 };
Object.assign(process.env, {
  NEARYOU_ENABLE_FOUNDATION_API: "true",
  NEARYOU_ENABLE_PRODUCTION_UPGRADE_FOUNDATION: "true",
  NEARYOU_ENABLE_NEARSLEEP_PRODUCTION: "true",
  NEARYOU_ENABLE_USAGE_RESERVATIONS: "true",
  NEARYOU_REQUIRE_VERIFIED_VOICE_CONSENT: "true",
  NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY: "false",
  NEARYOU_ENABLE_STORY: "true",
  STRIPE_SECRET_KEY: "sk_test_task2c",
  STRIPE_TEST_MODE_ONLY: "true",
  ELEVENLABS_API_KEY: "eleven-task2c",
  NEARYOU_RECONCILIATION_SECRET: "S".repeat(43),
  STRIPE_PRICE_NEARYOU_PLUS_MONTHLY: "price_plus_month",
});

const stripeCalls = [];
let providerLostReference = "provider_ordinary_voice";
globalThis.fetch = async (url, init = {}) => {
  stripeCalls.push({ url: String(url), method: init.method || "GET" });
  if (providerLostReference && String(url).endsWith(`/voices/${providerLostReference}`)) { providerLostReference = null; throw new Error("simulated_provider_lost_response"); }
  return new Response(JSON.stringify({ id: "cs_test_late", status: "expired" }), { status: 200, headers: { "content-type": "application/json" } });
};

const now = Date.now();
database.prepare("UPDATE task2c_activation_state SET scheduler_heartbeat_at=?, scheduler_run_id='account-fixture' WHERE id='storage'").run(now);
database.prepare("INSERT INTO users (id,email,display_name,subscription_status,credits_remaining,created_at,updated_at) VALUES ('local-preview','preview@nearnight.local','Preview Parent','active',1,?,?),('guest-one','guest1@example.test','Guest One','active',1,?,?),('guest-two','guest2@example.test','Guest Two','active',1,?,?)").run(now, now, now, now, now, now);
database.prepare("INSERT INTO households (id,name,owner_user_id,created_at,updated_at) VALUES ('household:local-preview','Personal','local-preview',?,?),('house_dark','Dark transfer','local-preview',?,?),('house_guard','Guarded transfer','local-preview',?,?)").run(now, now, now, now, now, now);
database.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,created_at,updated_at) VALUES ('household-member:local-preview','household:local-preview','local-preview','owner','active',?,?),('dark_owner','house_dark','local-preview','owner','active',?,?),('guard_owner','house_guard','local-preview','owner','active',?,?)").run(now, now, now, now, now, now);
for (const [id, householdId] of [["entitlement:legacy:local-preview", "household:local-preview"], ["grant_dark", "house_dark"], ["grant_guard", "house_guard"]]) {
  database.prepare("INSERT INTO entitlements (id,household_id,plan_id,source,status,allowance_milliunits,remaining_milliunits,valid_from,created_at,updated_at) VALUES (?,?,'nearyou_plus','manual','active',60000,60000,?,?,?)").run(id, householdId, now - 1000, now, now);
}
database.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,created_at,updated_at) VALUES ('dark_target','house_dark','guest-one','adult_manager','active',?,?),('guard_target','house_guard','guest-two','adult_manager','active',?,?),('personal_guest','household:local-preview','guest-one','listener','active',?,?)").run(now, now, now, now, now, now);

const [ownerRoute, selfMemberRoute, memberRoute, invitationAcceptRoute, reauthRoute, accountRoute, checkoutRoute, checkoutProduction, sessionsProduction, continuationRoute, accountProduction, stripeProduction] = await Promise.all([
  import("../../app/api/v1/household/owner/route.ts"),
  import("../../app/api/v1/household/members/self/route.ts"),
  import("../../app/api/v1/household/members/[userId]/route.ts"),
  import("../../app/api/v1/household/invitations/accept/route.ts"),
  import("../../app/api/account/reauth/route.ts"),
  import("../../app/api/account/route.ts"),
  import("../../app/api/billing/checkout/route.ts"),
  import("../../app/api/billing/checkout/production.ts"),
  import("../../app/api/sessions/production.ts"),
  import("../../app/api/internal/task2c-reconcile/route.ts"),
  import("../../app/api/account/production.ts"),
  import("../../app/api/webhooks/stripe/production.ts"),
]);

const mutationHeaders = (householdId, sessionId = "preview-session", createdAt = now - 10_000) => ({
  origin: "https://example.test",
  "content-type": "application/json",
  "x-nearyou-household-id": householdId,
  "x-nearyou-preview-session-id": sessionId,
  "x-nearyou-preview-session-created-at": String(createdAt),
});

const transferRequest = (householdId, userId) => new Request("https://example.test/api/v1/household/owner", {
  method: "PUT", headers: mutationHeaders(householdId), body: JSON.stringify({ newOwnerUserId: userId }),
});
const darkSessionId = "dark_saved_session";
const darkAudioKey = `audio/${encodeURIComponent("household:local-preview")}/${darkSessionId}.mp3`;
database.prepare("INSERT INTO child_profiles (id,household_id,nickname,normalized_nickname,pronunciation,created_at,updated_at) VALUES ('dark_child','household:local-preview','Moon','moon','',?,?)").run(now, now);
database.prepare("INSERT INTO sleep_sessions (id,user_id,household_id,title,script,script_mode,content_type,narration_kind,theme,style,background_sound,duration_minutes,status,created_at) VALUES (?,'local-preview','household:local-preview','Dark saved audio','safe','curated','story','demo_narrator','moonlit-meadow','gentle','none',5,'generating',?)").run(darkSessionId, now);
await sessionsProduction.finalizeSavedSession({ sessionId: darkSessionId, householdId: "household:local-preview", userId: "local-preview", childProfileId: "dark_child", audioKey: darkAudioKey, byteSize: 32, checksum: "b".repeat(64) });
await sessionsProduction.finalizeSavedSession({ sessionId: darkSessionId, householdId: "household:local-preview", userId: "local-preview", childProfileId: "dark_child", audioKey: darkAudioKey, byteSize: 32, checksum: "b".repeat(64) });
assert.deepEqual({ ...database.prepare("SELECT s.status AS sessionStatus,m.status AS mediaStatus,r.status AS reservationStatus FROM sleep_sessions s JOIN media_assets m ON m.id=s.media_asset_id JOIN household_storage_reservations r ON r.media_asset_id=m.id WHERE s.id=?").get(darkSessionId) }, { sessionStatus: "ready", mediaStatus: "ready", reservationStatus: "committed" });

const darkTransfer = await ownerRoute.PUT(transferRequest("house_dark", "guest-one"));
assert.equal(darkTransfer.status, 200);
assert.equal(database.prepare("SELECT owner_user_id AS ownerUserId FROM households WHERE id = 'house_dark'").get().ownerUserId, "guest-one");
database.prepare("INSERT INTO playlists (id,household_id,created_by_user_id,name,private,created_at,updated_at) VALUES ('former_shared_playlist','house_dark','local-preview','Shared bedtime',1,?,?)").run(now, now);

process.env.NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY = "true";
const darkTransferRetry = await ownerRoute.PUT(transferRequest("house_dark", "guest-one"));
assert.equal(darkTransferRetry.status, 200);
assert.equal((await darkTransferRetry.json()).duplicate, true);
const leaveRequest = (householdId) => new Request("https://example.test/api/v1/household/members/self", { method: "DELETE", headers: mutationHeaders(householdId) });
assert.equal((await selfMemberRoute.DELETE(leaveRequest("house_dark"))).status, 200);
const leaveDarkRetry = await selfMemberRoute.DELETE(leaveRequest("house_dark"));
assert.equal(leaveDarkRetry.status, 200);
assert.equal((await leaveDarkRetry.json()).duplicate, true);
assert.match(leaveDarkRetry.headers.get("set-cookie") || "", /Max-Age=0/);

const formerKey = "audio/house_dark/former_subject_session.mp3";
const formerBytes = new TextEncoder().encode("former household subject audio");
database.prepare("INSERT INTO sleep_sessions (id,user_id,household_id,title,script,script_mode,content_type,narration_kind,theme,style,background_sound,duration_minutes,status,audio_key,created_at,completed_at) VALUES ('former_subject_session','local-preview','house_dark','Former session','safe','curated','story','demo_narrator','moonlit-meadow','gentle','none',5,'ready',?,?,?)").run(formerKey, now, now);
database.prepare("INSERT INTO media_assets (id,household_id,owner_user_id,legacy_session_id,kind,status,storage_key,content_type,byte_size,checksum,private,created_at,updated_at) VALUES ('former_subject_media','house_dark','local-preview','former_subject_session','narration','processing',?,'audio/mpeg',?,?,1,?,?)").run(formerKey, formerBytes.byteLength, "f".repeat(64), now, now);
database.prepare("INSERT INTO household_storage_reservations (id,household_id,media_asset_id,byte_size,status,created_at,updated_at) VALUES ('former_subject_reservation','house_dark','former_subject_media',?,'reserved',?,?)").run(formerBytes.byteLength, now, now);
database.prepare("UPDATE sleep_sessions SET media_asset_id='former_subject_media' WHERE id='former_subject_session'").run();
database.prepare("UPDATE media_assets SET status='ready' WHERE id='former_subject_media'").run();
database.prepare("INSERT INTO task2c_media_integrity (media_asset_id,byte_size,checksum,verified_at) VALUES ('former_subject_media',?,?,?)").run(formerBytes.byteLength, "f".repeat(64), now);
r2.objects.set(formerKey, formerBytes);
database.prepare("INSERT INTO voices (id,user_id,household_id,provider_voice_id,name,status,consent_attested_at,created_at) VALUES ('former_subject_voice','local-preview','house_dark','provider_former_subject','Former voice','ready',?,?)").run(now, now);
const formerManifestKey = "exports/house_dark/former/manifest.json";
const formerPartKey = "exports/house_dark/former/parts/00000000.mp3";
const formerGuestPartKey = "exports/house_dark/former/parts/00000001.mp3";
const formerPageKey = "exports/house_dark/former/metadata/00000000.json";
const survivingGuestSourceKey = "media/house_dark/guest-owned.bin";
const survivingGuestBytes = new TextEncoder().encode("guest household content must survive");
database.prepare("INSERT INTO media_assets (id,household_id,owner_user_id,kind,status,storage_key,content_type,byte_size,checksum,private,created_at,updated_at) VALUES ('guest_owned_media','house_dark','guest-one','photo','processing',?,'application/octet-stream',?,?,1,?,?)").run(survivingGuestSourceKey, survivingGuestBytes.byteLength, "e".repeat(64), now, now);
database.prepare("INSERT INTO household_storage_reservations (id,household_id,media_asset_id,byte_size,status,created_at,updated_at) VALUES ('guest_owned_reservation','house_dark','guest_owned_media',?,'reserved',?,?)").run(survivingGuestBytes.byteLength, now, now);
database.prepare("UPDATE media_assets SET status='ready' WHERE id='guest_owned_media'").run();
database.prepare("INSERT INTO task2c_media_integrity (media_asset_id,byte_size,checksum,verified_at) VALUES ('guest_owned_media',?,?,?)").run(survivingGuestBytes.byteLength, "e".repeat(64), now);
database.prepare("INSERT INTO household_exports (id,household_id,requested_by_user_id,idempotency_key,request_hash,snapshot,status,inventory_stage,inventory_count,metadata_page_count,cursor_position,manifest_storage_key,expires_at,created_at,updated_at) VALUES ('former_export','house_dark','guest-one','former-export-request','former-hash','{}','running','copy',2,1,2,?,?,?,?)").run(formerManifestKey, now + 7 * 86400000, now, now);
database.prepare("INSERT INTO household_export_parts (id,export_id,source_media_asset_id,source_storage_key,export_storage_key,content_type,byte_size,checksum,status,expires_at,created_at,updated_at) VALUES ('former_export_part','former_export','former_subject_media',?,?,'audio/mpeg',?,?, 'copied',?,?,?)").run(formerKey, formerPartKey, formerBytes.byteLength, "f".repeat(64), now + 7 * 86400000, now, now);
database.prepare("INSERT INTO household_export_parts (id,export_id,source_media_asset_id,source_storage_key,export_storage_key,content_type,byte_size,checksum,status,expires_at,created_at,updated_at) VALUES ('former_guest_export_part','former_export','guest_owned_media',?,?,'application/octet-stream',?,?, 'copied',?,?,?)").run(survivingGuestSourceKey, formerGuestPartKey, survivingGuestBytes.byteLength, "e".repeat(64), now + 7 * 86400000, now, now);
database.prepare("INSERT INTO household_export_metadata_pages (id,export_id,position,kind,storage_key,item_count,byte_size,checksum,status,expires_at,created_at) VALUES ('former_export_page','former_export',0,'sessions',?,1,10,?,'ready',?,?)").run(formerPageKey, "9".repeat(64), now + 7 * 86400000, now);
database.prepare("UPDATE household_exports SET status='succeeded',completed_at=? WHERE id='former_export'").run(now);
r2.objects.set(formerManifestKey, new TextEncoder().encode("{}"));
r2.objects.set(formerPartKey, formerBytes);
r2.objects.set(formerGuestPartKey, survivingGuestBytes);
r2.objects.set(formerPageKey, new TextEncoder().encode("metadata"));
r2.objects.set(survivingGuestSourceKey, survivingGuestBytes);

const guardedTransfer = await ownerRoute.PUT(transferRequest("house_guard", "guest-two"));
assert.equal(guardedTransfer.status, 200);
assert.equal(database.prepare("SELECT COUNT(*) AS value FROM household_owner_transfer_guards").get().value, 0);
assert.equal((await ownerRoute.PUT(transferRequest("house_guard", "guest-two"))).status, 200);
assert.equal((await selfMemberRoute.DELETE(leaveRequest("house_guard"))).status, 200);
assert.equal((await selfMemberRoute.DELETE(leaveRequest("house_guard"))).status, 200);
const formerConsentManifestKey = "exports/house_guard/consent-only/manifest.json";
const formerConsentPageKey = "exports/house_guard/consent-only/metadata/00000000.json";
database.prepare("INSERT INTO voices (id,user_id,household_id,provider_voice_id,name,status,consent_attested_at,created_at) VALUES ('former_consent_voice','local-preview','house_guard','provider_consent_subject','Former consent voice','ready',?,?)").run(now, now);
database.prepare("INSERT INTO voice_consents (id,household_id,voice_id,adult_user_id,consent_version,scope,status,evidence,attested_at) VALUES ('former_consent_only','house_guard','former_consent_voice','local-preview','voice-v1','adult_self_private_narration','active_verified','{}',?)").run(now);
database.prepare("UPDATE voices SET current_consent_id='former_consent_only' WHERE id='former_consent_voice'").run();
database.prepare("INSERT INTO household_exports (id,household_id,requested_by_user_id,idempotency_key,request_hash,snapshot,status,inventory_stage,inventory_count,metadata_page_count,cursor_position,manifest_storage_key,expires_at,created_at,updated_at) VALUES ('former_consent_export','house_guard','guest-two','former-consent-request','former-consent-hash','{}','running','copy',0,1,0,?,?,?,?)").run(formerConsentManifestKey, now + 7 * 86400000, now, now);
database.prepare("INSERT INTO household_export_metadata_pages (id,export_id,position,kind,storage_key,item_count,byte_size,checksum,status,expires_at,created_at) VALUES ('former_consent_page','former_consent_export',0,'consents',?,1,10,?,'ready',?,?)").run(formerConsentPageKey, "6".repeat(64), now + 7 * 86400000, now);
database.prepare("UPDATE household_exports SET status='succeeded',completed_at=? WHERE id='former_consent_export'").run(now);
r2.objects.set(formerConsentManifestKey, new TextEncoder().encode("{}"));
r2.objects.set(formerConsentPageKey, new TextEncoder().encode("consent metadata"));

const removeGuestRequest = () => new Request("https://example.test/api/v1/household/members/guest-one", { method: "DELETE", headers: mutationHeaders("household:local-preview") });
assert.equal((await memberRoute.DELETE(removeGuestRequest(), { params: Promise.resolve({ userId: "guest-one" }) })).status, 200);
const removeGuestRetry = await memberRoute.DELETE(removeGuestRequest(), { params: Promise.resolve({ userId: "guest-one" }) });
assert.equal(removeGuestRetry.status, 200);
assert.equal((await removeGuestRetry.json()).duplicate, true);

const reauthStart = await reauthRoute.POST(new Request("https://example.test/api/account/reauth", { method: "POST", headers: mutationHeaders("household:local-preview", "old-session", now - 10_000), body: "{}" }));
assert.equal(reauthStart.status, 201);
const { challengeId } = await reauthStart.json();
const staleReauth = await reauthRoute.PUT(new Request("https://example.test/api/account/reauth", { method: "PUT", headers: mutationHeaders("household:local-preview", "old-session", now - 10_000), body: JSON.stringify({ challengeId }) }));
assert.equal(staleReauth.status, 403);
const freshSessionCreatedAt = Date.now() + 1_000;
const verifiedReauth = await reauthRoute.PUT(new Request("https://example.test/api/account/reauth", { method: "PUT", headers: mutationHeaders("household:local-preview", "fresh-session", freshSessionCreatedAt), body: JSON.stringify({ challengeId }) }));
assert.equal(verifiedReauth.status, 200);
const verifiedReauthReload = await reauthRoute.PUT(new Request("https://example.test/api/account/reauth", { method: "PUT", headers: mutationHeaders("household:local-preview", "fresh-session", freshSessionCreatedAt), body: JSON.stringify({ challengeId }) }));
assert.equal(verifiedReauthReload.status, 200);
assert.equal((await verifiedReauthReload.json()).duplicate, true);

const personalHousehold = "household:local-preview";
const storageKeys = [];
for (let index = 0; index < 12; index += 1) {
  const sessionId = `account_session_${String(index).padStart(2, "0")}`;
  const mediaId = `account_media_${String(index).padStart(2, "0")}`;
  const key = `audio/${encodeURIComponent(personalHousehold)}/${encodeURIComponent(sessionId)}.mp3`;
  const bytes = new TextEncoder().encode(`private account audio ${index}`);
  database.prepare("INSERT INTO sleep_sessions (id,user_id,household_id,title,script,script_mode,content_type,narration_kind,theme,style,background_sound,duration_minutes,status,audio_key,created_at,completed_at) VALUES (?,'local-preview',?,'Night','safe','curated','story','demo_narrator','moonlit-meadow','gentle','none',5,'ready',?,?,?)").run(sessionId, personalHousehold, key, now, now);
  database.prepare("INSERT INTO media_assets (id,household_id,owner_user_id,legacy_session_id,kind,status,storage_key,content_type,byte_size,checksum,private,created_at,updated_at) VALUES (?,?,'local-preview',?,'narration','processing',?,'audio/mpeg',?,?,1,?,?)").run(mediaId, personalHousehold, sessionId, key, bytes.byteLength, "a".repeat(64), now, now);
  database.prepare("INSERT INTO household_storage_reservations (id,household_id,media_asset_id,byte_size,status,created_at,updated_at) VALUES (?,?,?,?,'reserved',?,?)").run(`account_reservation_${index}`, personalHousehold, mediaId, bytes.byteLength, now, now);
  database.prepare("UPDATE sleep_sessions SET media_asset_id = ? WHERE id = ?").run(mediaId, sessionId);
  database.prepare("UPDATE media_assets SET status = 'ready', updated_at = ? WHERE id = ?").run(now, mediaId);
  database.prepare("INSERT INTO task2c_media_integrity (media_asset_id,byte_size,checksum,verified_at) VALUES (?,?,?,?)").run(mediaId, bytes.byteLength, "a".repeat(64), now);
  r2.objects.set(key, bytes);
  storageKeys.push(key);
}

const storyCheckpointKey = `households/${encodeURIComponent(personalHousehold)}/stories/account-story/checkpoints/speech-0-account-attempt.mp3`;
const storyCheckpointBytes = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
database.prepare("INSERT INTO voices (id,user_id,household_id,provider_voice_id,name,status,consent_attested_at,created_at) VALUES ('account_story_voice','local-preview',?,'provider_account_story','Story voice','ready',?,?)").run(personalHousehold, now, now);
database.prepare("INSERT INTO voice_consents (id,household_id,voice_id,adult_user_id,consent_version,scope,status,evidence,attested_at) VALUES ('account_story_consent',?,'account_story_voice','local-preview','voice-v2-live-phrase','adult_self_private_narration','active_verified','{}',?)").run(personalHousehold, now);
database.prepare("UPDATE voices SET current_consent_id='account_story_consent' WHERE id='account_story_voice'").run();
database.prepare("INSERT INTO voice_consent_leases (id,household_id,voice_id,consent_id,consent_version,status,expires_at,created_at) VALUES ('account_story_lease',?,'account_story_voice','account_story_consent','voice-v2-live-phrase','active',?,?)").run(personalHousehold, now + 30 * 60_000, now);
database.prepare("INSERT INTO jobs (id,household_id,requested_by_user_id,type,status,idempotency_key,request_hash,input,attempts,created_at,updated_at) VALUES ('account_story_job',?,'local-preview','story_audio','queued','account-story-idem','account-story-hash','{}',0,?,?)").run(personalHousehold, now, now);
database.prepare("INSERT INTO usage_reservations (id,household_id,user_id,entitlement_id,operation,quantity,weight_milliunits,idempotency_key,request_hash,status,consent_lease_id,created_at,updated_at) VALUES ('account_story_usage',?,'local-preview','entitlement:legacy:local-preview','story_audio_generation',5,5000,'story-usage:account-story-idem','account-story-hash','reserved','account_story_lease',?,?)").run(personalHousehold, now, now);
database.prepare("INSERT INTO story_experiences (id,household_id,requested_by_user_id,child_profile_id,voice_id,consent_id,consent_version,consent_lease_id,mode,duration_minutes,plan,status,job_id,reservation_id,provider_budget_hold_ids,idempotency_key,request_hash,created_at,updated_at) VALUES ('account_story',?,'local-preview','dark_child','account_story_voice','account_story_consent','voice-v2-live-phrase','account_story_lease','bedtime',5,'{}','queued','account_story_job','account_story_usage','[]','account-story-idem','account-story-hash',?,?)").run(personalHousehold, now, now);
database.prepare("UPDATE jobs SET status='running',worker_attempt_token='account-attempt-token-1234567890',worker_lease_expires_at=?,attempts=1,started_at=? WHERE id='account_story_job'").run(now + 10 * 60_000, now);
database.prepare("INSERT INTO story_worker_checkpoints (id,household_id,story_id,attempt_token,stage,ordinal,payload,storage_key,byte_size,checksum,status,created_at,updated_at) VALUES ('account_story_checkpoint',?,'account_story','account-attempt-token-1234567890','speech',0,'{}',?,?,?,'ready',?,?)").run(personalHousehold, storyCheckpointKey, storyCheckpointBytes.byteLength, "c".repeat(64), now, now);
r2.objects.set(storyCheckpointKey, storyCheckpointBytes);
database.prepare("UPDATE voices SET status='deleted',deleted_at=? WHERE id='account_story_voice'").run(now);
process.env.NEARYOU_ENABLE_STORY = "false";

database.prepare("INSERT INTO voices (id,user_id,household_id,provider_voice_id,name,status,consent_attested_at,created_at,deleted_at) VALUES ('ordinary_deleted_voice','local-preview',?,'provider_ordinary_voice','Ordinary deleted voice','deleted',?,?,?)").run(personalHousehold, now, now, now);
database.prepare("INSERT INTO deletion_reconciliations (id,scope,scope_id,status,storage_keys,provider_references,error_code,created_at,updated_at) VALUES ('voice-delete:ordinary_deleted_voice','voice','ordinary_deleted_voice','cleanup_pending','[]','[\"provider_ordinary_voice\"]','provider_cleanup_retry',?,?)").run(now - 10_000, now - 10_000);
const previewCleanupKey = `audio-previews/${encodeURIComponent(personalHousehold)}/ordinary-preview.mp3`;
r2.objects.set(previewCleanupKey, new Uint8Array([1, 2, 3]));
database.prepare("INSERT INTO deletion_reconciliations (id,scope,scope_id,status,storage_keys,provider_references,error_code,created_at,updated_at) VALUES ('preview-cleanup:ordinary','session',?,'cleanup_pending',?,'[]','storage_cleanup_retry',?,?)").run(darkSessionId, JSON.stringify([previewCleanupKey]), now - 9_000, now - 9_000);
r2.deleteLostKey = previewCleanupKey;
const unauthorizedContinuation = await continuationRoute.POST(new Request("https://example.test/api/internal/task2c-reconcile", { method: "POST", headers: { authorization: "Bearer wrong" } }));
assert.equal(unauthorizedContinuation.status, 401);
const continuationRequest = () => new Request("https://example.test/api/internal/task2c-reconcile", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_RECONCILIATION_SECRET}` } });
assert.equal((await continuationRoute.POST(continuationRequest())).status, 200);
assert.equal(database.prepare("SELECT status FROM deletion_reconciliations WHERE id = 'voice-delete:ordinary_deleted_voice'").get().status, "failed");
assert.equal(database.prepare("SELECT status FROM deletion_reconciliations WHERE id = 'preview-cleanup:ordinary'").get().status, "failed");
assert.equal((await continuationRoute.POST(continuationRequest())).status, 200);
assert.equal(database.prepare("SELECT status FROM deletion_reconciliations WHERE id = 'voice-delete:ordinary_deleted_voice'").get().status, "completed");
assert.equal(database.prepare("SELECT status FROM deletion_reconciliations WHERE id = 'preview-cleanup:ordinary'").get().status, "completed");
assert.equal(await r2.head(previewCleanupKey), null);

database.prepare("INSERT INTO voices (id,user_id,household_id,provider_voice_id,name,status,consent_attested_at,created_at,deleted_at) VALUES ('deleted_voice','local-preview',?,'provider_deleted_voice','Deleted voice','deleted',?,?,?)").run(personalHousehold, now, now, now);
database.prepare("INSERT INTO deletion_reconciliations (id,scope,scope_id,status,storage_keys,provider_references,error_code,created_at,updated_at) VALUES ('voice-delete:deleted_voice','voice','deleted_voice','cleanup_pending','[]','[\"provider_deleted_voice\"]','provider_cleanup_retry',?,?)").run(now, now);
assert.equal(database.prepare("SELECT household_id AS householdId FROM deletion_reconciliations WHERE id = 'voice-delete:deleted_voice'").get().householdId, personalHousehold);
database.prepare("INSERT INTO adult_onboarding_acceptances (id,household_id,adult_user_id,version,attestation,accepted_at) VALUES ('replacement_onboarding',?,'local-preview','adult-v1','accepted',?)").run(personalHousehold, now);
database.prepare("INSERT INTO voices (id,user_id,household_id,provider_voice_id,name,status,consent_attested_at,created_at) VALUES ('replacement_voice','local-preview',?,'provider_original_voice','Replacement source','ready',?,?)").run(personalHousehold, now, now);
database.prepare("INSERT INTO voice_consents (id,household_id,voice_id,adult_user_id,consent_version,scope,status,evidence,attested_at) VALUES ('replacement_consent',?,'replacement_voice','local-preview','voice-v1','adult_self_private_narration','active_verified','{}',?)").run(personalHousehold, now);
database.prepare("UPDATE voices SET current_consent_id = 'replacement_consent' WHERE id = 'replacement_voice'").run();
database.prepare("INSERT INTO voice_verification_challenges (id,household_id,voice_id,adult_user_id,onboarding_acceptance_id,version,phrase,phrase_hash,status,attempts,expires_at,created_at) VALUES ('replacement_challenge',?,'replacement_voice','local-preview','replacement_onboarding','live-v1','safe phrase',?,'failed',1,?,?)").run(personalHousehold, "c".repeat(64), now + 60_000, now);
database.prepare("INSERT INTO voice_replacements (id,household_id,voice_id,challenge_id,adult_user_id,original_provider_voice_id,original_consent_id,replacement_provider_voice_id,consent_id,consent_version,evidence,status,error_code,created_at,updated_at,completed_at) VALUES ('failed_replacement',?,'replacement_voice','replacement_challenge','local-preview','provider_original_voice','replacement_consent','provider_failed_clone','replacement_new_consent','voice-v1','{}','failed','activation_cleanup_pending',?,?,?)").run(personalHousehold, now, now, now);
database.prepare("INSERT INTO deletion_reconciliations (id,scope,scope_id,status,storage_keys,provider_references,error_code,created_at,updated_at) VALUES ('voice-replacement-delete:failed_replacement','voice','failed_replacement','cleanup_pending','[]','[\"provider_failed_clone\"]','voice_replacement_activation_failed',?,?)").run(now, now);
assert.equal(database.prepare("SELECT household_id AS householdId FROM deletion_reconciliations WHERE id = 'voice-replacement-delete:failed_replacement'").get().householdId, personalHousehold);
database.prepare("INSERT INTO voice_verification_challenges (id,household_id,voice_id,adult_user_id,onboarding_acceptance_id,version,phrase,phrase_hash,status,attempts,expires_at,created_at) VALUES ('live_replacement_challenge',?,'replacement_voice','local-preview','replacement_onboarding','live-v1','safe live phrase',?,'processing',1,?,?)").run(personalHousehold, "e".repeat(64), now + 60_000, now);
database.prepare("INSERT INTO voice_replacements (id,household_id,voice_id,challenge_id,adult_user_id,original_provider_voice_id,original_consent_id,consent_id,consent_version,evidence,status,created_at,updated_at) VALUES ('live_replacement',?,'replacement_voice','live_replacement_challenge','local-preview','provider_original_voice','replacement_consent','live_new_consent','voice-v1','{}','processing',?,?)").run(personalHousehold, now, now);
database.prepare("INSERT INTO sleep_sessions (id,user_id,household_id,title,script,script_mode,content_type,narration_kind,theme,style,background_sound,duration_minutes,status,created_at) VALUES ('live_generation_session','local-preview',?,'Live generation','safe','curated','story','demo_narrator','moonlit-meadow','gentle','none',5,'queued',?)").run(personalHousehold, now);
database.prepare("INSERT INTO generation_operations (id,household_id,user_id,operation,request_hash,status,created_at,updated_at) VALUES ('generation:script:live',?,'local-preview','script','live_hash','processing',?,?)").run(personalHousehold, now, now);
database.prepare("INSERT INTO jobs (id,household_id,requested_by_user_id,type,status,idempotency_key,request_hash,input,attempts,progress_percent,progress_stage,created_at,updated_at) VALUES ('live_job',?,'local-preview','nearsleep_audio','queued','live_job_key','live_job_hash','{}',0,0,'queued',?,?)").run(personalHousehold, now, now);
const bulkReconciliationKeys = Array.from({ length: 60 }, (_, index) => `account-bulk/${String(index).padStart(2, "0")}.bin`);
for (const key of bulkReconciliationKeys) r2.objects.set(key, new Uint8Array([1, 2, 3]));
database.prepare("INSERT INTO deletion_reconciliations (id,household_id,scope,scope_id,status,storage_keys,provider_references,error_code,created_at,updated_at) VALUES ('account-bulk-references',?,'account',?,'cleanup_pending',?,'[]','storage_cleanup_retry',?,?)").run(personalHousehold, personalHousehold, JSON.stringify(bulkReconciliationKeys), now, now);

database.prepare("INSERT INTO household_billing_accounts (household_id,status,checkout_pending_at,checkout_operation_id,checkout_price_id,checkout_status,checkout_expires_at,created_at,updated_at) VALUES (?,'free',?,'creating-operation','price_test','creating',?,?,?)").run(personalHousehold, now, now + 60_000, now, now);
const receiptToken = "R".repeat(43);
const deletionRequestId = "12345678-1234-4234-8234-123456789abc";
const graceExportKey = `exports/${encodeURIComponent(personalHousehold)}/grace/metadata/00000000.json`;
database.prepare("INSERT INTO household_exports (id,household_id,requested_by_user_id,idempotency_key,request_hash,snapshot,status,inventory_stage,inventory_count,metadata_page_count,cursor_position,expires_at,created_at,updated_at) VALUES ('grace_export',?,'local-preview','grace-export-request','grace-export-hash','{}','queued','sessions',0,0,0,?,?,?)").run(personalHousehold, now + 30 * 86400000, now, now);
r2.objects.set(graceExportKey, new TextEncoder().encode("grace data remains untouched"));
const graceInviteToken = "invite_account_deletion_subject_1234567890";
const graceInviteHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(graceInviteToken)))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
database.prepare("INSERT INTO household_invitations (id,household_id,invited_by_user_id,invited_email,role,token_hash,status,expires_at,created_at,updated_at) VALUES ('grace_subject_invite','house_guard','guest-two','preview@nearnight.local','listener',?,'pending',?,?,?)").run(graceInviteHash, now + 60_000, now, now);

const graceReceiptToken = "G".repeat(43);
const graceBody = { requestId: "22345678-1234-4234-8234-123456789abc", reauthChallengeId: challengeId, receiptToken: graceReceiptToken, confirmation: "DELETE MY ACCOUNT", exportPolicy: "skip", exportId: null, exportDownloaded: false, graceHours: 24 };
const graceRequest = () => new Request("https://example.test/api/account", { method: "DELETE", headers: mutationHeaders(personalHousehold, "fresh-session", freshSessionCreatedAt), body: JSON.stringify(graceBody) });
database.prepare("UPDATE task2c_activation_state SET status='pending', unresolved_ready_media=1 WHERE id='storage'").run();
const activationBlocked = await accountRoute.DELETE(graceRequest());
assert.equal(activationBlocked.status, 503);
assert.equal(database.prepare("SELECT status FROM account_reauth_challenges WHERE id=?").get(challengeId).status, "verified");
assert.equal(database.prepare("SELECT COUNT(*) AS value FROM account_deletion_operations").get().value, 0);
database.prepare("UPDATE task2c_activation_state SET status='ready', unresolved_ready_media=0, scheduler_heartbeat_at=?, scheduler_run_id='account-restored' WHERE id='storage'").run(Date.now());

database.prepare("UPDATE household_billing_accounts SET checkout_pending_at = NULL, checkout_status = 'expired'").run();
const graceExternalCalls = stripeCalls.length;
const graceObjects = r2.objects.size;
const graceStart = await accountRoute.DELETE(graceRequest());
assert.equal(graceStart.status, 202);
const graceOperation = database.prepare("SELECT id,status FROM account_deletion_operations WHERE user_id='local-preview'").get();
assert.equal(graceOperation.status, "grace_period");
assert.equal(stripeCalls.length, graceExternalCalls);
assert.equal(r2.objects.size, graceObjects);
assert.equal(database.prepare("SELECT COUNT(*) AS value FROM account_deletion_items WHERE operation_id=?").get(graceOperation.id).value, 0);
assert.equal(database.prepare("SELECT status FROM household_exports WHERE id='grace_export'").get().status, "queued");
assert.equal(await r2.head(graceExportKey) !== null, true);
const inviteWhileDeleting = await invitationAcceptRoute.POST(new Request("https://example.test/api/v1/household/invitations/accept", { method: "POST", headers: mutationHeaders("house_guard", "fresh-session", freshSessionCreatedAt), body: JSON.stringify({ token: graceInviteToken }) }));
assert.equal(inviteWhileDeleting.status, 423);
assert.equal(database.prepare("SELECT status FROM household_invitations WHERE id='grace_subject_invite'").get().status, "pending");
const canceledGrace = await accountRoute.PATCH(new Request("https://example.test/api/account", { method: "PATCH", headers: mutationHeaders(personalHousehold, "fresh-session", freshSessionCreatedAt), body: JSON.stringify({ receiptToken: graceReceiptToken }) }));
assert.equal(canceledGrace.status, 200);
assert.equal(database.prepare("SELECT status FROM account_deletion_operations WHERE id=?").get(graceOperation.id).status, "canceled");
assert.equal(database.prepare("SELECT status FROM household_exports WHERE id='grace_export'").get().status, "queued");
database.prepare("UPDATE household_exports SET status='expired' WHERE id='grace_export'").run();
database.prepare("UPDATE household_invitations SET status='revoked' WHERE id='grace_subject_invite'").run();

const destructiveReauthStart = await reauthRoute.POST(new Request("https://example.test/api/account/reauth", { method: "POST", headers: mutationHeaders(personalHousehold, "fresh-session", freshSessionCreatedAt), body: "{}" }));
assert.equal(destructiveReauthStart.status, 201);
const { challengeId: destructiveChallengeId } = await destructiveReauthStart.json();
const destructiveSessionCreatedAt = freshSessionCreatedAt + 2_000;
assert.equal((await reauthRoute.PUT(new Request("https://example.test/api/account/reauth", { method: "PUT", headers: mutationHeaders(personalHousehold, "destructive-session", destructiveSessionCreatedAt), body: JSON.stringify({ challengeId: destructiveChallengeId }) }))).status, 200);

const deleteBody = { requestId: deletionRequestId, reauthChallengeId: destructiveChallengeId, receiptToken, confirmation: "DELETE MY ACCOUNT", exportPolicy: "skip", exportId: null, exportDownloaded: false, graceHours: 0 };
const deleteRequest = () => new Request("https://example.test/api/account", { method: "DELETE", headers: mutationHeaders(personalHousehold, "destructive-session", destructiveSessionCreatedAt), body: JSON.stringify(deleteBody) });
database.prepare("UPDATE household_billing_accounts SET checkout_pending_at=?, checkout_status='creating' WHERE household_id=?").run(now, personalHousehold);
const creatingCheckoutBlock = await accountRoute.DELETE(deleteRequest());
assert.equal(creatingCheckoutBlock.status, 409);
database.prepare("UPDATE household_billing_accounts SET checkout_pending_at = NULL, checkout_status = 'expired'").run();
const liveExportPageKey = `exports/${encodeURIComponent(personalHousehold)}/live-account/metadata/00000000.json`;
database.prepare("INSERT INTO household_exports (id,household_id,requested_by_user_id,idempotency_key,request_hash,snapshot,status,attempt_token,attempt_expires_at,inventory_stage,inventory_count,metadata_page_count,cursor_position,expires_at,created_at,updated_at) VALUES ('live_account_export',?,'local-preview','live-account-export-request','live-account-hash','{}','running','live-export-attempt',?,'sessions',0,1,0,?,?,?)").run(personalHousehold, now + 120000, now + 30 * 86400000, now, now);
database.prepare("INSERT INTO household_export_metadata_pages (id,export_id,position,kind,storage_key,item_count,byte_size,checksum,status,expires_at,created_at) VALUES ('live_account_export_page','live_account_export',0,'sessions',?,1,10,?,'pending',?,?)").run(liveExportPageKey, "8".repeat(64), now + 30 * 86400000, now);
r2.objects.set(liveExportPageKey, new TextEncoder().encode("late-page"));
const crossRequesterLivePageKey = "exports/house_dark/guest-live/metadata/00000000.json";
database.prepare("INSERT INTO households (id,name,owner_user_id,created_at,updated_at) VALUES ('house_cross_live','Cross live','guest-one',?,?)").run(now, now);
database.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,created_at,updated_at) VALUES ('cross_live_owner','house_cross_live','guest-one','owner','active',?,?)").run(now, now);
database.prepare("INSERT INTO sleep_sessions (id,user_id,household_id,title,script,script_mode,content_type,narration_kind,theme,style,background_sound,duration_minutes,status,audio_key,created_at,completed_at) VALUES ('cross_live_subject_session','local-preview','house_cross_live','Cross-live contribution','safe','curated','story','demo_narrator','moonlit-meadow','gentle','none',5,'ready','audio/house_cross_live/subject.mp3',?,?)").run(now, now);
database.prepare("INSERT INTO household_exports (id,household_id,requested_by_user_id,idempotency_key,request_hash,snapshot,status,attempt_token,attempt_expires_at,inventory_stage,inventory_count,metadata_page_count,cursor_position,expires_at,created_at,updated_at) VALUES ('cross_requester_live_export','house_cross_live','guest-one','cross-live-export-request','cross-live-hash','{}','running','cross-live-attempt',?,'sessions',0,1,0,?,?,?)").run(now + 120000, now + 30 * 86400000, now, now);
database.prepare("INSERT INTO household_export_metadata_pages (id,export_id,position,kind,storage_key,item_count,byte_size,checksum,status,expires_at,created_at) VALUES ('cross_requester_live_page','cross_requester_live_export',0,'sessions',?,1,10,?,'pending',?,?)").run(crossRequesterLivePageKey, "5".repeat(64), now + 30 * 86400000, now);
r2.objects.set(crossRequesterLivePageKey, new TextEncoder().encode("cross requester late page"));

const externalCallsBeforeDelete = stripeCalls.length;
const deleteStart = await accountRoute.DELETE(deleteRequest());
assert.equal(deleteStart.status, 202);
const operationId = database.prepare("SELECT id FROM account_deletion_operations WHERE user_id = 'local-preview'").get().id;
assert.ok(database.prepare("SELECT COUNT(*) AS value FROM account_deletion_items WHERE operation_id=?").get(operationId).value <= 50);
assert.equal(database.prepare("SELECT status FROM account_reauth_challenges WHERE id = ?").get(destructiveChallengeId).status, "consumed");
for (let attempt = 0; attempt < 10; attempt += 1) {
  const errorCode = database.prepare("SELECT error_code AS errorCode FROM account_deletion_operations WHERE id = ?").get(operationId).errorCode;
  if (errorCode === "export_in_progress") break;
  await accountProduction.reconcilePendingAccountDeletions(10);
}
assert.equal(database.prepare("SELECT error_code AS errorCode FROM account_deletion_operations WHERE id = ?").get(operationId).errorCode, "export_in_progress");
assert.throws(() => database.prepare("INSERT INTO household_export_metadata_pages (id,export_id,position,kind,storage_key,item_count,byte_size,checksum,status,expires_at,created_at) VALUES ('late_fenced_page','live_account_export',1,'sessions','late',1,1,?,'pending',?,?)").run("7".repeat(64), now + 30 * 86400000, now), /account_deletion_(?:subject_)?fenced/);
assert.throws(() => database.prepare("INSERT INTO household_export_metadata_pages (id,export_id,position,kind,storage_key,item_count,byte_size,checksum,status,expires_at,created_at) VALUES ('cross_requester_late_page','cross_requester_live_export',1,'sessions','cross-late',1,1,?,'pending',?,?)").run("4".repeat(64), now + 30 * 86400000, now), /account_deletion_subject_fenced/);
database.prepare("UPDATE household_exports SET status='canceled', attempt_token=NULL, attempt_expires_at=NULL, error_code='account_deletion_fenced' WHERE id IN ('live_account_export','cross_requester_live_export')").run();
for (let attempt = 0; attempt < 10; attempt += 1) {
  const errorCode = database.prepare("SELECT error_code AS errorCode FROM account_deletion_operations WHERE id = ?").get(operationId).errorCode;
  if (errorCode === "generation_in_progress") break;
  await accountProduction.reconcilePendingAccountDeletions(10);
}
assert.equal(database.prepare("SELECT error_code AS errorCode FROM account_deletion_operations WHERE id = ?").get(operationId).errorCode, "generation_in_progress");
assert.equal(stripeCalls.length, externalCallsBeforeDelete);

const stripeCallsBeforeFence = stripeCalls.length;
const checkoutWhileFenced = await checkoutRoute.POST(new Request("https://example.test/api/billing/checkout", {
  method: "POST", headers: { ...mutationHeaders(personalHousehold, "fresh-session", freshSessionCreatedAt), "content-type": "application/json" }, body: JSON.stringify({ plan: "nearyou_plus", interval: "month" }),
}));
assert.equal(checkoutWhileFenced.status, 423);
assert.equal(stripeCalls.length, stripeCallsBeforeFence);

await checkoutProduction.expireFencedCheckout(personalHousehold, "late-race", "cs_test_late", "checkout-fence-expire");
assert.equal(database.prepare("SELECT status FROM account_deletion_items WHERE operation_id=? AND kind='billing_checkout' AND reference='cs_test_late'").get(operationId).status, "completed");
assert.equal(database.prepare("SELECT COUNT(*) AS value FROM account_deletion_billing_tombstones WHERE kind='billing_checkout'").get().value, 1);
const staleAt = Date.now() - 16 * 60_000;
database.prepare("UPDATE generation_operations SET updated_at = ? WHERE id = 'generation:script:live'").run(staleAt);
database.prepare("UPDATE voice_replacements SET updated_at = ? WHERE id = 'live_replacement'").run(staleAt);
database.prepare("UPDATE jobs SET updated_at = ? WHERE id = 'live_job'").run(staleAt);
database.prepare("UPDATE sleep_sessions SET created_at = ? WHERE id = 'live_generation_session'").run(staleAt);
database.prepare("UPDATE account_deletion_operations SET quiescent_at = ?, updated_at = ? WHERE id = ?").run(Date.now() - 180_000, Date.now() - 180_000, operationId);
r2.deleteLostKey = storageKeys[0];

for (let attempt = 0; attempt < 180; attempt += 1) {
  assert.equal((await continuationRoute.POST(continuationRequest())).status, 200);
  const status = database.prepare("SELECT status FROM account_deletion_operations WHERE id = ?").get(operationId).status;
  if (status === "completed") break;
  database.prepare("UPDATE account_deletion_operations SET quiescent_at = COALESCE(quiescent_at, ?), updated_at = ? WHERE id = ?").run(Date.now() - 180_000, Date.now() - 180_000, operationId);
}

const terminal = database.prepare("SELECT * FROM account_deletion_operations WHERE id = ?").get(operationId);
assert.equal(terminal.status, "completed", JSON.stringify({ terminal, pending: database.prepare("SELECT kind,reference,status FROM account_deletion_items WHERE operation_id=? AND status='pending'").all(operationId) }));
assert.equal(terminal.user_id, null);
assert.equal(terminal.household_id, null);
assert.equal(terminal.idempotency_key, "redacted");
assert.equal(terminal.request_hash, "redacted");
assert.equal(terminal.reauth_challenge_id, "redacted");
assert.equal(terminal.reauth_session_id, "redacted");
assert.equal(terminal.snapshot, "{}");
assert.equal(terminal.error_code, null);
assert.equal(terminal.attempt_token, null);
assert.equal(database.prepare("SELECT COUNT(*) AS value FROM account_deletion_items WHERE operation_id = ?").get(operationId).value, 0);
assert.equal(database.prepare("SELECT COUNT(*) AS value FROM users WHERE id = 'local-preview'").get().value, 0);
assert.equal(database.prepare("SELECT COUNT(*) AS value FROM households WHERE id = ?").get(personalHousehold).value, 0);
assert.equal(database.prepare("SELECT owner_user_id AS ownerUserId FROM households WHERE id = 'house_dark'").get().ownerUserId, "guest-one");
assert.equal(database.prepare("SELECT owner_user_id AS ownerUserId FROM households WHERE id = 'house_guard'").get().ownerUserId, "guest-two");
assert.deepEqual({ ...database.prepare("SELECT created_by_user_id AS createdByUserId,name FROM playlists WHERE id='former_shared_playlist'").get() }, { createdByUserId: "guest-one", name: "Shared bedtime" });
assert.equal(database.prepare("SELECT COUNT(*) AS value FROM users WHERE id='guest-one'").get().value, 1);
assert.ok(storageKeys.every((key) => !r2.objects.has(key)));
assert.equal(await r2.head(storyCheckpointKey), null, "account erasure must HEAD-verify removal of intermediate Story audio");
assert.ok(bulkReconciliationKeys.every((key) => !r2.objects.has(key)));
assert.ok(d1.maxBatchSize <= 51, `bounded D1 batch exceeded: ${d1.maxBatchSize}`);
assert.equal(await r2.head(formerKey), null);
assert.equal(await r2.head(formerManifestKey), null);
assert.equal(await r2.head(formerPartKey), null);
assert.equal(await r2.head(formerGuestPartKey), null);
assert.equal(await r2.head(formerPageKey), null);
assert.equal(await r2.head(formerConsentManifestKey), null);
assert.equal(await r2.head(formerConsentPageKey), null);
assert.equal(await r2.head(liveExportPageKey), null);
assert.equal(await r2.head(crossRequesterLivePageKey), null);
assert.equal(await r2.head(survivingGuestSourceKey) !== null, true);
assert.deepEqual({ ...database.prepare("SELECT owner_user_id AS ownerUserId,status FROM media_assets WHERE id='guest_owned_media'").get() }, { ownerUserId: "guest-one", status: "ready" });
assert.equal(database.prepare("SELECT status FROM household_exports WHERE id='former_export'").get().status, "canceled");
assert.equal(database.prepare("SELECT status FROM household_exports WHERE id='former_consent_export'").get().status, "canceled");
assert.equal(database.prepare("SELECT status FROM household_exports WHERE id='cross_requester_live_export'").get().status, "canceled");
assert.ok(stripeCalls.some(({ url }) => url.endsWith("/checkout/sessions/cs_test_late/expire")));
assert.ok(stripeCalls.some(({ url }) => url.endsWith("/voices/provider_deleted_voice")));
assert.ok(stripeCalls.some(({ url }) => url.endsWith("/voices/provider_failed_clone")));
assert.ok(stripeCalls.some(({ url }) => url.endsWith("/voices/provider_former_subject")));
assert.ok(stripeCalls.some(({ url }) => url.endsWith("/voices/provider_consent_subject")));
assert.equal(database.prepare("SELECT COUNT(*) AS value FROM account_deletion_billing_tombstones").get().value > 0, true);

const lateWebhook = await stripeProduction.handleProductionStripeEvent({
  id: "evt_after_terminal_delete",
  type: "checkout.session.completed",
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  data: { object: { id: "cs_test_late", customer: "cus_after_delete", subscription: "sub_after_delete", mode: "subscription", payment_status: "paid", metadata: { user_id: "local-preview", household_id: personalHousehold, checkout_operation_id: "late" } } },
});
assert.equal(lateWebhook.status, 200);
assert.equal(database.prepare("SELECT COUNT(*) AS value FROM users WHERE id='local-preview'").get().value, 0);
assert.equal(database.prepare("SELECT COUNT(*) AS value FROM households WHERE id=?").get(personalHousehold).value, 0);

const receipt = await accountRoute.GET(new Request("https://example.test/api/account", { headers: { authorization: `Bearer ${receiptToken}` } }));
assert.equal(receipt.status, 200);
assert.equal((await receipt.json()).deletion.status, "completed");
const queryReceipt = await accountRoute.GET(new Request(`https://example.test/api/account?receiptToken=${receiptToken}`));
assert.equal(queryReceipt.status, 200);
assert.equal((await queryReceipt.json()).deletion, null);
