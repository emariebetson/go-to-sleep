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

class Statement {
  constructor(db, source, params = []) { this.db = db; this.source = source; this.params = params; }
  bind(...params) { return new Statement(this.db, this.source, params); }
  execute() {
    const statement = this.db.prepare(this.source);
    if (statement.columns().length) return { success: true, results: statement.all(...this.params), meta: { changes: this.db.prepare("SELECT changes() value").get().value } };
    const result = statement.run(...this.params); return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  async raw() { const result = this.execute(); return result.results.map((row) => Object.values(row)); }
}
class D1 {
  constructor(db) { this.db = db; this.loseBatchResponse = false; }
  prepare(source) { return new Statement(this.db, source); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const results = statements.map((statement) => statement.execute()); this.db.exec("COMMIT"); if (this.loseBatchResponse) { this.loseBatchResponse = false; throw new Error("simulated_lost_batch_response"); } return results; }
    catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
}
class R2 {
  constructor() { this.objects = new Map(); this.failDeleteOnce = false; this.losePutAfterStoreMatching = null; this.beforePutOnceMatching = null; this.beforePutOnce = null; this.afterPutOnceMatching = null; this.afterPutOnce = null; }
  async put(key, value, options = {}) {
    if (this.beforePutOnceMatching && key.includes(this.beforePutOnceMatching) && this.beforePutOnce) { const hook = this.beforePutOnce; this.beforePutOnceMatching = null; this.beforePutOnce = null; await hook(key); }
    let bytes;
    if (value instanceof ReadableStream) {
      const reader = value.getReader(); const chunks = []; let length = 0;
      for (;;) { const { done, value: chunk } = await reader.read(); if (done) break; chunks.push(chunk); length += chunk.byteLength; }
      bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    } else if (value instanceof Uint8Array) bytes = value;
    else if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
    else bytes = new Uint8Array(value);
    this.objects.set(key, { bytes, customMetadata: options.customMetadata || {}, httpMetadata: options.httpMetadata || {} });
    if (this.losePutAfterStoreMatching && key.includes(this.losePutAfterStoreMatching)) { this.losePutAfterStoreMatching = null; throw new Error("simulated_r2_put_lost_response"); }
    if (this.afterPutOnceMatching && key.includes(this.afterPutOnceMatching) && this.afterPutOnce) { const hook = this.afterPutOnce; this.afterPutOnceMatching = null; this.afterPutOnce = null; await hook(key); }
  }
  async head(key) { const item = this.objects.get(key); return item ? { size: item.bytes.length, customMetadata: item.customMetadata, httpMetadata: item.httpMetadata } : null; }
  async get(key, options = {}) { const item = this.objects.get(key); if (!item) return null; const range = options.range; const bytes = range ? item.bytes.slice(range.offset, range.offset + range.length) : item.bytes; return { size: bytes.length, customMetadata: item.customMetadata, body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; }
  async delete(key) { if (this.failDeleteOnce) { this.failDeleteOnce = false; throw new Error("simulated_delete_failure"); } for (const item of Array.isArray(key) ? key : [key]) this.objects.delete(item); }
}

const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
for (const name of migrations) for (const statement of readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);
const d1 = new D1(db); const r2 = new R2(); globalThis.__TASK2B_CLOUDFLARE_ENV__ = { DB: d1, AUDIO: r2 };
Object.assign(process.env, {
  NEARYOU_ENABLE_FOUNDATION_API: "true", NEARYOU_ENABLE_PRODUCTION_UPGRADE_FOUNDATION: "true",
  NEARYOU_ENABLE_NEARSLEEP_PRODUCTION: "true", NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY: "true",
  NEARYOU_ENABLE_STORY: "true", NEARYOU_ENABLE_ASYNC_MEDIA_JOBS: "true", NEARYOU_ENABLE_USAGE_RESERVATIONS: "true",
  NEARYOU_REQUIRE_VERIFIED_VOICE_CONSENT: "true", OPENAI_API_KEY: "test-openai",
  ELEVENLABS_API_KEY: "test-eleven", NEARYOU_MEDIA_WORKER_URL: "https://media.test/mix",
  NEARYOU_MEDIA_WORKER_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", NEARYOU_STORY_WORKER_SECRET: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});
const now = Date.now();
db.prepare("UPDATE task2c_activation_state SET scheduler_heartbeat_at=?,scheduler_run_id='story-test' WHERE id='storage'").run(now);
db.prepare("UPDATE nearstory_activation_state SET status='ready',worker_heartbeat_at=?,checked_at=? WHERE id='parent-beta'").run(now, now);
db.prepare("INSERT INTO users (id,email,display_name,subscription_status,credits_remaining,created_at,updated_at) VALUES ('local-preview','adult@test','Adult','active',1,?,?)").run(now, now);
for (const suffix of ["one", "two"]) {
  const household = `house_${suffix}`;
  db.prepare("INSERT INTO households (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,'local-preview',?,?)").run(household, suffix, now, now);
  db.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,created_at,updated_at) VALUES (?,?,'local-preview','owner','active',?,?)").run(`member_${suffix}`, household, now, now);
  db.prepare("INSERT INTO entitlements (id,household_id,plan_id,source,status,allowance_milliunits,remaining_milliunits,valid_from,created_at,updated_at) VALUES (?,?, 'nearyou_plus','test','active',60000,60000,?,?,?)").run(`ent_${suffix}`, household, now - 1000, now, now);
  db.prepare("INSERT INTO child_profiles (id,household_id,nickname,normalized_nickname,pronunciation,age_months,created_at,updated_at) VALUES (?,?,?,?,?,48,?,?)").run(`22222222-2222-4222-8222-22222222222${suffix === "one" ? "2" : "3"}`, household, `Lou ${suffix}`, `lou ${suffix}`, "LOU", now, now);
  db.prepare("INSERT INTO voices (id,user_id,household_id,provider_voice_id,name,status,consent_attested_at,created_at) VALUES (?,'local-preview',?,?,?,'ready',?,?)").run(`33333333-3333-4333-8333-33333333333${suffix === "one" ? "3" : "4"}`, household, `pv_${suffix}`, `Voice ${suffix}`, now, now);
  db.prepare("INSERT INTO voice_consents (id,household_id,voice_id,adult_user_id,consent_version,scope,status,evidence,attested_at) VALUES (?,?,?,'local-preview','voice-v2-live-phrase','adult_self_private_narration','active_verified','{}',?)").run(`consent_${suffix}`, household, `33333333-3333-4333-8333-33333333333${suffix === "one" ? "3" : "4"}`, now);
  db.prepare("UPDATE voices SET current_consent_id=? WHERE household_id=?").run(`consent_${suffix}`, household);
}
let providerCalls = 0;
const ttsIdempotencyKeys = [];
const sfxIdempotencyKeys = [];
let oversizedModerationOnce = false;
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("/moderations")) { providerCalls += 1; if (oversizedModerationOnce) { oversizedModerationOnce = false; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`{"padding":"${"x".repeat(300_000)}"}`)); controller.close(); } }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "r".repeat(400) } }); } return new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200, headers: { "content-type": "application/json", "x-request-id": `mod_${providerCalls}` } }); }
  if (String(url).includes("/responses")) return new Response(JSON.stringify({ output_text: JSON.stringify({ segments: Array.from({ length: 5 }, (_, ordinal) => ({ ordinal, narration: `A calm and kind story segment number ${ordinal + 1}.` })) }) }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "writer_1" } });
  if (String(url).includes("/text-to-speech/")) { ttsIdempotencyKeys.push(new Headers(init.headers).get("idempotency-key")); return new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg", "request-id": `tts_${providerCalls++}` } }); }
  if (String(url).includes("/sound-generation")) { sfxIdempotencyKeys.push(new Headers(init.headers).get("idempotency-key")); return new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg", "request-id": "sfx_1" } }); }
  if (String(url) === "https://media.test/mix") return new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg", "x-audio-duration-seconds": "30", "x-segment-durations-ms": "[5000,5500,6000,6500,7000]" } });
  return new Response(null, { status: 204 });
};
const route = await import("../../app/api/v1/stories/route.ts");
const body = { requestId: "11111111-1111-4111-8111-111111111111", childProfileId: "22222222-2222-4222-8222-222222222222", voiceId: "33333333-3333-4333-8333-333333333333", mode: "bedtime", durationMinutes: 10, setting: "Kansas City", characters: "kind dinosaurs", interests: "excavators", lesson: "sharing", sensitivities: ["no storms"], soundscape: "construction", sourceUrl: "", sourceRightsAttested: false };
const headers = (household, id = body.requestId) => ({ origin: "https://example.test", "content-type": "application/json", "Idempotency-Key": id, "x-nearyou-household-id": household });
const send = (payload = body, household = "house_one") => route.POST(new Request("https://example.test/api/v1/stories", { method: "POST", headers: headers(household, payload.requestId), body: JSON.stringify(payload) }));
const first = await send(); assert.equal(first.status, 202, await first.clone().text()); assert.equal(providerCalls, 1);
assert.equal(db.prepare("SELECT remaining_milliunits value FROM entitlements WHERE id='ent_one'").get().value, 50_000);
assert.equal(db.prepare("SELECT count(*) value FROM jobs WHERE type='story_audio'").get().value, 1);
assert.equal(db.prepare("SELECT count(*) value FROM story_segments").get().value, 5);
assert.deepEqual({ ...db.prepare("SELECT product,operation,quantity,weight_milliunits AS weight FROM usage_ledger WHERE household_id='house_one' AND operation='story_audio_generation'").get() }, { product: "nearstory", operation: "story_audio_generation", quantity: 10, weight: 10_000 });
const replay = await send(); assert.equal(replay.status, 200); assert.equal(providerCalls, 1);
const changed = await send({ ...body, lesson: "patience" }); assert.equal(changed.status, 409); assert.equal(providerCalls, 1);
const foreign = await send({ ...body, requestId: "55555555-5555-4555-8555-555555555555", childProfileId: "22222222-2222-4222-8222-222222222223" }); assert.equal(foreign.status, 403);
const allowanceBeforeOversizedModeration = db.prepare("SELECT remaining_milliunits value FROM entitlements WHERE id='ent_one'").get().value; oversizedModerationOnce = true;
const oversizedModerationPayload = { ...body, requestId: "44444444-4444-4444-8444-444444444444" }; const oversizedModeration = await send(oversizedModerationPayload); assert.equal(oversizedModeration.status, 503); assert.equal(db.prepare("SELECT remaining_milliunits value FROM entitlements WHERE id='ent_one'").get().value, allowanceBeforeOversizedModeration); assert.equal(db.prepare("SELECT count(*) value FROM story_experiences WHERE idempotency_key=?").get(oversizedModerationPayload.requestId).value, 0);
d1.loseBatchResponse = true;
const lostPayload = { ...body, requestId: "66666666-6666-4666-8666-666666666666" };
const lost = await send(lostPayload); assert.equal(lost.status, 200, await lost.clone().text());
const lostBody = await lost.json();
assert.equal(db.prepare("SELECT count(*) value FROM story_experiences WHERE id=?").get(lostBody.story.id).value, 1);
assert.equal(db.prepare("SELECT remaining_milliunits value FROM entitlements WHERE id='ent_one'").get().value, 40_000);

const rootJobId = db.prepare("SELECT job_id value FROM story_experiences WHERE id=?").get(lostBody.story.id).value;
const consentState = db.prepare("SELECT l.status leaseStatus,l.expires_at expiresAt,s.status storyStatus,c.status consentStatus,v.status voiceStatus,v.current_consent_id currentConsent,l.consent_id leaseConsent,v.provider_voice_id providerVoice FROM story_experiences s JOIN voice_consent_leases l ON l.id=s.consent_lease_id JOIN voice_consents c ON c.id=l.consent_id JOIN voices v ON v.id=l.voice_id WHERE s.id=?").get(lostBody.story.id);
assert.deepEqual({ ...consentState, expiresAt: undefined }, { leaseStatus: "active", expiresAt: undefined, storyStatus: "queued", consentStatus: "active_verified", voiceStatus: "ready", currentConsent: "consent_one", leaseConsent: "consent_one", providerVoice: "pv_one" });
assert.ok(consentState.expiresAt > Date.now());
const { POST: dispatchStoryWorker } = await import("../../app/api/internal/nearstory-worker/route.ts");
let completed;
for (let attempt = 0; attempt < 100 && db.prepare("SELECT status value FROM jobs WHERE id=?").get(rootJobId).value !== "succeeded"; attempt += 1) {
  const dispatchResponse = await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: "{}" }));
  assert.equal(dispatchResponse.status, 200, await dispatchResponse.clone().text());
  completed = (await dispatchResponse.json()).result;
}
assert.equal(completed?.status, "completed", JSON.stringify(completed));
assert.equal(db.prepare("SELECT status value FROM jobs WHERE id=?").get(rootJobId).value, "succeeded");
assert.equal(db.prepare("SELECT status value FROM story_experiences WHERE id=?").get(lostBody.story.id).value, "completed");
assert.equal(db.prepare("SELECT count(*) value FROM story_media_bindings WHERE story_id=? AND status='ready'").get(lostBody.story.id).value, 6);
assert.equal(db.prepare("SELECT count(*) value FROM household_storage_reservations r JOIN story_media_bindings b ON b.media_asset_id=r.media_asset_id WHERE b.story_id=? AND r.status='committed'").get(lostBody.story.id).value, 6);
assert.equal(db.prepare("SELECT count(*) value FROM task2c_media_integrity i JOIN story_media_bindings b ON b.media_asset_id=i.media_asset_id WHERE b.story_id=?").get(lostBody.story.id).value, 6);
assert.equal(db.prepare("SELECT count(*) value FROM story_segments WHERE story_id=? AND status='ready' AND narration LIKE 'A calm%'").get(lostBody.story.id).value, 5);
assert.equal(db.prepare("SELECT count(*) value FROM story_segments WHERE story_id=? AND status='ready' AND start_ms IS NOT NULL AND end_ms>start_ms").get(lostBody.story.id).value, 5);
assert.equal(db.prepare("SELECT status value FROM voice_consent_leases WHERE id=(SELECT consent_lease_id FROM story_experiences WHERE id=?)").get(lostBody.story.id).value, "consumed");
assert.equal(db.prepare("SELECT status value FROM usage_reservations WHERE id=(SELECT reservation_id FROM story_experiences WHERE id=?)").get(lostBody.story.id).value, "committed");
assert.equal(db.prepare("SELECT count(*) value FROM story_persist_staging_objects WHERE story_id=? AND status='published'").get(lostBody.story.id).value, 6, JSON.stringify(db.prepare("SELECT status,storage_key FROM story_persist_staging_objects WHERE story_id=?").all(lostBody.story.id)));
await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: "{}" }));
assert.equal(db.prepare("SELECT count(*) value FROM story_worker_checkpoints WHERE story_id=?").get(lostBody.story.id).value, 0, "terminal checkpoint lifecycle cleanup must remove working files");

const crashPayload = { ...body, requestId: "99999999-9999-4999-8999-999999999999", durationMinutes: 5, soundscape: "none" };
const crashResponse = await send(crashPayload); assert.equal(crashResponse.status, 202, await crashResponse.clone().text()); const crashStory = (await crashResponse.json()).story;
const crashJobId = db.prepare("SELECT job_id value FROM story_experiences WHERE id=?").get(crashStory.id).value;
const ttsBeforeCrashStory = ttsIdempotencyKeys.length;
r2.losePutAfterStoreMatching = "checkpoints/speech-0-"; let observedLostPut = false;
for (let attempt = 0; attempt < 20 && !observedLostPut; attempt += 1) {
  const response = await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ jobId: crashJobId }) }));
  const payload = await response.json(); observedLostPut = response.status === 503 && payload.result?.code === "simulated_r2_put_lost_response";
}
assert.equal(observedLostPut, true, "the fixture must crash after the checkpoint object was stored");
db.prepare("UPDATE jobs SET worker_lease_expires_at=? WHERE id=?").run(Date.now() - 1, crashJobId);
for (let attempt = 0; attempt < 30 && db.prepare("SELECT status value FROM jobs WHERE id=?").get(crashJobId).value !== "succeeded"; attempt += 1) {
  const response = await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ jobId: crashJobId }) })); assert.ok([200, 409].includes(response.status), await response.clone().text());
}
assert.equal(db.prepare("SELECT status value FROM jobs WHERE id=?").get(crashJobId).value, "succeeded");
const crashStoryTtsKeys = ttsIdempotencyKeys.slice(ttsBeforeCrashStory);
assert.equal(new Set(crashStoryTtsKeys).size, 5, "a lost provider/checkpoint response must replay the same deterministic segment key");
assert.ok(crashStoryTtsKeys.length >= 6, "segment zero should be safely replayed after the lost checkpoint response");
await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ jobId: crashJobId }) }));
assert.equal(db.prepare("SELECT count(*) value FROM story_worker_checkpoints WHERE story_id=?").get(crashStory.id).value, 0);

const effectCrashPayload = { ...body, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", durationMinutes: 5, soundscape: "ocean" };
const effectCrashResponse = await send(effectCrashPayload); assert.equal(effectCrashResponse.status, 202, await effectCrashResponse.clone().text()); const effectCrashStory = (await effectCrashResponse.json()).story;
const effectCrashJobId = db.prepare("SELECT job_id value FROM story_experiences WHERE id=?").get(effectCrashStory.id).value; const sfxBeforeCrash = sfxIdempotencyKeys.length;
r2.losePutAfterStoreMatching = "story-effects/"; let observedEffectLostPut = false;
for (let attempt = 0; attempt < 20 && !observedEffectLostPut; attempt += 1) {
  const response = await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ jobId: effectCrashJobId }) })); const payload = await response.json(); observedEffectLostPut = response.status === 503 && payload.result?.code === "simulated_r2_put_lost_response";
}
assert.equal(observedEffectLostPut, true); const processingEffect = db.prepare("SELECT id,storage_key key,checksum,byte_size size,status FROM story_sound_assets WHERE status='processing'").get(); assert.ok(processingEffect?.key && processingEffect.checksum && processingEffect.size > 0);
db.prepare("UPDATE jobs SET worker_lease_expires_at=? WHERE id=?").run(Date.now() - 1, effectCrashJobId); db.prepare("UPDATE story_sound_assets SET attempt_expires_at=?,updated_at=? WHERE id=?").run(Date.now() - 1, Date.now() - 2, processingEffect.id);
for (let attempt = 0; attempt < 30 && db.prepare("SELECT status value FROM jobs WHERE id=?").get(effectCrashJobId).value !== "succeeded"; attempt += 1) {
  const response = await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ jobId: effectCrashJobId }) })); assert.ok([200, 409].includes(response.status), await response.clone().text());
}
assert.equal(db.prepare("SELECT status value FROM jobs WHERE id=?").get(effectCrashJobId).value, "succeeded"); assert.equal(db.prepare("SELECT status value FROM story_sound_assets WHERE id=?").get(processingEffect.id).value, "ready");
assert.equal(sfxIdempotencyKeys.length - sfxBeforeCrash, 1, "stale SFX processing must reconcile the stored object without a second provider charge");

const exhaustedPayload = { ...body, requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", durationMinutes: 5, soundscape: "none" }; const allowanceBeforeExhausted = db.prepare("SELECT remaining_milliunits value FROM entitlements WHERE id='ent_one'").get().value;
const exhaustedResponse = await send(exhaustedPayload); assert.equal(exhaustedResponse.status, 202, await exhaustedResponse.clone().text()); const exhaustedStory = (await exhaustedResponse.json()).story; const exhaustedJobId = db.prepare("SELECT job_id value FROM story_experiences WHERE id=?").get(exhaustedStory.id).value;
db.prepare("UPDATE jobs SET status='running',attempts=3,worker_attempt_token='exhausted-attempt-token-123456',worker_lease_expires_at=?,started_at=? WHERE id=?").run(Date.now() - 1, Date.now() - 20 * 60_000, exhaustedJobId);
await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ jobId: exhaustedJobId }) }));
assert.deepEqual({ ...db.prepare("SELECT j.status jobStatus,s.status storyStatus,u.status usageStatus,l.status leaseStatus FROM jobs j JOIN story_experiences s ON s.job_id=j.id JOIN usage_reservations u ON u.id=s.reservation_id JOIN voice_consent_leases l ON l.id=s.consent_lease_id WHERE j.id=?").get(exhaustedJobId) }, { jobStatus: "failed", storyStatus: "failed", usageStatus: "released", leaseStatus: "revoked" });
assert.equal(db.prepare("SELECT remaining_milliunits value FROM entitlements WHERE id='ent_one'").get().value, allowanceBeforeExhausted, "exhausted attempts must atomically refund unused narration allowance");

const concurrentPayload = { ...body, requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", durationMinutes: 5, soundscape: "none" }; const concurrentResponse = await send(concurrentPayload); assert.equal(concurrentResponse.status, 202, await concurrentResponse.clone().text()); const concurrentStory = (await concurrentResponse.json()).story; const concurrentJobId = db.prepare("SELECT job_id value FROM story_experiences WHERE id=?").get(concurrentStory.id).value;
for (let attempt = 0; attempt < 20 && db.prepare("SELECT progress_stage stage FROM jobs WHERE id=?").get(concurrentJobId).stage !== "persist"; attempt += 1) { const response = await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ jobId: concurrentJobId }) })); assert.equal(response.status, 200, await response.clone().text()); }
assert.equal(db.prepare("SELECT progress_stage stage FROM jobs WHERE id=?").get(concurrentJobId).stage, "persist");
r2.afterPutOnceMatching = "/segments/0.mp3"; r2.afterPutOnce = async () => {
  const takeoverToken = "takeover-attempt-token-123456789"; db.prepare("UPDATE jobs SET worker_attempt_token=?,worker_lease_expires_at=? WHERE id=? AND status='running'").run(takeoverToken, Date.now() + 60_000, concurrentJobId); db.prepare("UPDATE story_media_bindings SET attempt_token=?,updated_at=? WHERE story_id=? AND status='processing'").run(takeoverToken, Date.now(), concurrentStory.id); db.prepare("UPDATE jobs SET worker_lease_expires_at=? WHERE id=?").run(Date.now() - 1, concurrentJobId);
  for (let slice = 0; slice < 2; slice += 1) { const response = await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ jobId: concurrentJobId }) })); assert.equal(response.status, 200, await response.clone().text()); }
};
const stalePersistResponse = await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ jobId: concurrentJobId }) })); assert.equal(stalePersistResponse.status, 503);
assert.equal(db.prepare("SELECT status value FROM jobs WHERE id=?").get(concurrentJobId).value, "succeeded"); assert.equal(db.prepare("SELECT status value FROM story_experiences WHERE id=?").get(concurrentStory.id).value, "completed"); assert.equal(db.prepare("SELECT count(*) value FROM story_media_bindings WHERE story_id=? AND status='ready'").get(concurrentStory.id).value, 6); for (const row of db.prepare("SELECT m.storage_key key FROM story_media_bindings b JOIN media_assets m ON m.id=b.media_asset_id WHERE b.story_id=?").all(concurrentStory.id)) assert.ok(await r2.head(row.key), `stale attempt deleted takeover media ${row.key}`);

const deletionRacePayload = { ...body, requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", durationMinutes: 5, soundscape: "none" }; const deletionRaceResponse = await send(deletionRacePayload); assert.equal(deletionRaceResponse.status, 202, await deletionRaceResponse.clone().text()); const deletionRaceStory = (await deletionRaceResponse.json()).story; const deletionRaceJobId = db.prepare("SELECT job_id value FROM story_experiences WHERE id=?").get(deletionRaceStory.id).value;
for (let attempt = 0; attempt < 20 && db.prepare("SELECT progress_stage stage FROM jobs WHERE id=?").get(deletionRaceJobId).stage !== "persist"; attempt += 1) { const response = await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ jobId: deletionRaceJobId }) })); assert.equal(response.status, 200, await response.clone().text()); }
assert.equal(db.prepare("SELECT progress_stage stage FROM jobs WHERE id=?").get(deletionRaceJobId).stage, "persist");
const deletionRacePrefix = `households/house_one/stories/${encodeURIComponent(deletionRaceStory.id)}/staging/`; const deletionRaceKey = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
r2.beforePutOnceMatching = "/segments/0.mp3"; r2.beforePutOnce = async () => {
  const detail = await import("../../app/api/v1/stories/[id]/route.ts");
  for (let attempt = 0; attempt < 10 && db.prepare("SELECT status value FROM story_experiences WHERE id=?").get(deletionRaceStory.id).value !== "deleted"; attempt += 1) { const response = await detail.DELETE(new Request(`https://example.test/api/v1/stories/${deletionRaceStory.id}`, { method: "DELETE", headers: { origin: "https://example.test", "idempotency-key": deletionRaceKey, "x-nearyou-household-id": "house_one" } }), { params: Promise.resolve({ id: deletionRaceStory.id }) }); assert.ok([200, 202].includes(response.status), await response.clone().text()); }
  assert.equal(db.prepare("SELECT status value FROM story_experiences WHERE id=?").get(deletionRaceStory.id).value, "deleted", "delete must complete while the stale worker is paused before PUT");
};
const deletionRaceWorker = await dispatchStoryWorker(new Request("https://app.test/api/internal/nearstory-worker", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_STORY_WORKER_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ jobId: deletionRaceJobId }) })); assert.equal(deletionRaceWorker.status, 503);
assert.equal(db.prepare("SELECT status value FROM story_experiences WHERE id=?").get(deletionRaceStory.id).value, "deleted");
assert.deepEqual([...r2.objects.keys()].filter((key) => key.startsWith(deletionRacePrefix)), [], "a stale post-deletion PUT must clean only its attempt-unique staging objects");
const missingReadyStoryObjects = [];
for (const row of db.prepare("SELECT b.story_id storyId,m.storage_key key FROM story_media_bindings b JOIN media_assets m ON m.id=b.media_asset_id WHERE b.household_id='house_one' AND b.status='ready' AND m.status='ready'").all()) if (!await r2.head(row.key)) missingReadyStoryObjects.push(row);
assert.deepEqual(missingReadyStoryObjects, [], `ready Story media missing before export: ${JSON.stringify(missingReadyStoryObjects)}`);

const exportRoute = await import("../../app/api/account/export/route.ts");
const exportRequestId = "77777777-7777-4777-8777-777777777777";
const exportRequest = () => new Request("https://example.test/api/account/export", { method: "POST", headers: { ...headers("house_one", exportRequestId), "x-nearyou-household-id": "house_one" }, body: JSON.stringify({ requestId: exportRequestId }) });
let exportPayload;
for (let attempt = 0; attempt < 100; attempt += 1) { const response = await exportRoute.POST(exportRequest()); assert.ok([201, 202].includes(response.status), await response.clone().text()); exportPayload = (await response.json()).export; if (exportPayload.status === "succeeded") break; }
assert.equal(exportPayload?.status, "succeeded", JSON.stringify({ exportPayload, row: db.prepare("SELECT status,error_code,inventory_stage FROM household_exports WHERE id=?").get(exportPayload.id) }));
const exportId = exportPayload.id;
assert.equal(db.prepare("SELECT count(*) value FROM household_export_parts p JOIN story_media_bindings b ON b.media_asset_id=p.source_media_asset_id WHERE p.export_id=? AND b.story_id=?").get(exportId, lostBody.story.id).value, 6);
const storyMetadata = db.prepare("SELECT storage_key key FROM household_export_metadata_pages WHERE export_id=? AND kind='stories' LIMIT 1").get(exportId);
assert.ok(storyMetadata?.key && new TextDecoder().decode(r2.objects.get(storyMetadata.key).bytes).includes(lostBody.story.id));

const audioRoute = await import("../../app/api/v1/stories/[id]/audio/route.ts");
const rangePlayback = await audioRoute.GET(new Request(`https://example.test/api/v1/stories/${lostBody.story.id}/audio`, { headers: { "x-nearyou-household-id": "house_one", range: "bytes=0-3" } }), { params: Promise.resolve({ id: lostBody.story.id }) }); assert.equal(rangePlayback.status, 206); assert.equal(rangePlayback.headers.get("content-range"), "bytes 0-3/14"); assert.equal((await rangePlayback.arrayBuffer()).byteLength, 4);
assert.equal((await audioRoute.GET(new Request(`https://example.test/api/v1/stories/${lostBody.story.id}/audio`, { headers: { "x-nearyou-household-id": "house_two" } }), { params: Promise.resolve({ id: lostBody.story.id }) })).status, 404);
const detailRoute = await import("../../app/api/v1/stories/[id]/route.ts");
const deleteKey = "88888888-8888-4888-8888-888888888888"; r2.failDeleteOnce = true;
let deleted = await detailRoute.DELETE(new Request(`https://example.test/api/v1/stories/${lostBody.story.id}`, { method: "DELETE", headers: { origin: "https://example.test", "idempotency-key": deleteKey, "x-nearyou-household-id": "house_one" } }), { params: Promise.resolve({ id: lostBody.story.id }) });
assert.ok([200, 202].includes(deleted.status));
for (let attempt = 0; attempt < 10 && db.prepare("SELECT status value FROM story_experiences WHERE id=?").get(lostBody.story.id).value !== "deleted"; attempt += 1) deleted = await detailRoute.DELETE(new Request(`https://example.test/api/v1/stories/${lostBody.story.id}`, { method: "DELETE", headers: { origin: "https://example.test", "idempotency-key": deleteKey, "x-nearyou-household-id": "house_one" } }), { params: Promise.resolve({ id: lostBody.story.id }) });
assert.equal(db.prepare("SELECT status value FROM story_experiences WHERE id=?").get(lostBody.story.id).value, "deleted");
assert.equal(db.prepare("SELECT count(*) value FROM story_media_bindings WHERE story_id=? AND status<>'deleted'").get(lostBody.story.id).value, 0);
