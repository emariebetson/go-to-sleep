import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const checksumOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

const migrations = [
  "0000_nearnight_foundation.sql", "0001_google_apple_auth.sql", "0002_sharp_shinobi_shaw.sql", "0003_white_groot.sql",
  "0004_salty_sugar_man.sql", "0005_pronunciation_frequency_layers.sql", "0006_nearyou_shared_foundation.sql",
  "0007_nearsleep_production_upgrade.sql", "0008_nearsleep_live_integration.sql", "0009_nearsleep_audio_atomic.sql",
  "0010_child_profile_pronunciation.sql", "0011_household_billing_accounts.sql", "0012_nearsleep_library_privacy.sql",
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
  async raw() {
    const statement = this.database.prepare(this.source);
    statement.setReturnArrays(true);
    return statement.all(...this.parameters);
  }
}

class D1DatabaseFixture {
  constructor(database) { this.database = database; }
  prepare(source) { return new D1Statement(this.database, source); }
  async batch(statements) {
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
  constructor() { this.objects = new Map(); this.deleteLostKey = null; this.putLostKeyPrefix = null; this.putLostKeyPrefixes = new Set(); this.headChecksumOverrides = []; this.afterPut = null; }
  async put(key, value, options = {}) {
    const bytes = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer())
      : typeof value === "string" ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value);
    this.objects.set(key, { bytes, contentType: options.httpMetadata?.contentType || "application/octet-stream", customMetadata: options.customMetadata || {} });
    if (this.afterPut && key.startsWith(this.afterPut.prefix)) {
      const callback = this.afterPut.callback;
      this.afterPut = null;
      await callback(key);
    }
    if (this.putLostKeyPrefix && key.startsWith(this.putLostKeyPrefix)) { this.putLostKeyPrefix = null; throw new Error("simulated_r2_put_lost_response"); }
    const lostPrefix = [...this.putLostKeyPrefixes].find((prefix) => key.startsWith(prefix));
    if (lostPrefix) { this.putLostKeyPrefixes.delete(lostPrefix); throw new Error("simulated_r2_put_lost_response"); }
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
      if (this.deleteLostKey === key) { this.deleteLostKey = null; throw new Error("simulated_r2_delete_lost_response"); }
    }
  }
  async head(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    const override = this.headChecksumOverrides.find((entry) => entry.remaining > 0 && key.startsWith(entry.prefix));
    const customMetadata = { ...object.customMetadata };
    if (override) {
      override.remaining -= 1;
      if (override.value === null) delete customMetadata.checksum;
      else customMetadata.checksum = override.value;
    }
    return {
      size: object.bytes.byteLength,
      httpMetadata: { contentType: object.contentType },
      customMetadata,
      writeHttpMetadata(headers) { headers.set("content-type", object.contentType); headers.set("cache-control", "public, max-age=9999"); },
    };
  }
  async get(key, options) {
    const object = this.objects.get(key);
    if (!object) return null;
    const offset = options?.range?.offset || 0;
    const length = options?.range?.length ?? object.bytes.byteLength;
    const bytes = object.bytes.slice(offset, offset + length);
    return {
      size: bytes.byteLength,
      body: new Blob([bytes]).stream(),
      httpMetadata: { contentType: object.contentType },
      customMetadata: object.customMetadata,
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    };
  }
}

function applyMigrations(database) {
  for (const name of migrations) {
    const source = readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
  }
}

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
applyMigrations(database);
const r2 = new R2Fixture();
globalThis.__TASK2B_CLOUDFLARE_ENV__ = { DB: new D1DatabaseFixture(database), AUDIO: r2 };
Object.assign(process.env, {
  NEARYOU_ENABLE_FOUNDATION_API: "true",
  NEARYOU_ENABLE_PRODUCTION_UPGRADE_FOUNDATION: "true",
  NEARYOU_ENABLE_NEARSLEEP_PRODUCTION: "true",
  NEARYOU_ENABLE_USAGE_RESERVATIONS: "true",
  NEARYOU_REQUIRE_VERIFIED_VOICE_CONSENT: "true",
  NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY: "true",
  ELEVENLABS_API_KEY: "eleven-task2c",
});
globalThis.fetch = async () => new Response(null, { status: 204 });

const now = Date.now();
database.prepare("UPDATE task2c_activation_state SET scheduler_heartbeat_at=?, scheduler_run_id='route-fixture' WHERE id='storage'").run(now);
database.prepare("INSERT INTO users (id,email,display_name,subscription_status,credits_remaining,created_at,updated_at) VALUES ('local-preview','preview@nearnight.local','Preview Parent','active',1,?,?)").run(now, now);
for (const suffix of ["one", "two"]) {
  const householdId = `house_${suffix}`;
  database.prepare("INSERT INTO households (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,'local-preview',?,?)").run(householdId, suffix, now, now);
  database.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,created_at,updated_at) VALUES (?,?,'local-preview','owner','active',?,?)").run(`member_${suffix}`, householdId, now, now);
  database.prepare("INSERT INTO entitlements (id,household_id,plan_id,source,status,allowance_milliunits,remaining_milliunits,valid_from,created_at,updated_at) VALUES (?,?, 'nearyou_family','manual','active',120000,120000,?,?,?)").run(`grant_${suffix}`, householdId, now - 1000, now, now);
}

function seedSession(suffix) {
  const householdId = `house_${suffix}`;
  const sessionId = `session_${suffix}`;
  const mediaId = `media_${suffix}`;
  const key = `audio/${householdId}/${sessionId}.mp3`;
  const bytes = new TextEncoder().encode(`private audio ${suffix}`);
  const checksum = checksumOf(bytes);
  database.prepare("INSERT INTO sleep_sessions (id,user_id,household_id,title,script,script_mode,content_type,narration_kind,theme,style,background_sound,duration_minutes,status,audio_key,created_at,completed_at) VALUES (?,'local-preview',?,'Night','safe script','curated','story','demo_narrator','moonlit-meadow','gentle','none',5,'ready',?,?,?)").run(sessionId, householdId, key, now, now);
  database.prepare("INSERT INTO media_assets (id,household_id,owner_user_id,legacy_session_id,kind,status,storage_key,content_type,byte_size,checksum,private,created_at,updated_at) VALUES (?,?,'local-preview',?,'narration','processing',?,'audio/mpeg',?,?,1,?,?)").run(mediaId, householdId, sessionId, key, bytes.byteLength, checksum, now, now);
  database.prepare("INSERT INTO household_storage_reservations (id,household_id,media_asset_id,byte_size,status,created_at,updated_at) VALUES (?,?,?,?,'reserved',?,?)").run(`reservation_${suffix}`, householdId, mediaId, bytes.byteLength, now, now);
  database.prepare("UPDATE sleep_sessions SET media_asset_id = ? WHERE id = ?").run(mediaId, sessionId);
  database.prepare("UPDATE media_assets SET status = 'ready', updated_at = ? WHERE id = ?").run(now, mediaId);
  r2.objects.set(key, { bytes, contentType: "audio/mpeg", customMetadata: { checksum } });
  return { householdId, sessionId, mediaId, key, bytes };
}

const one = seedSession("one");
const two = seedSession("two");
database.prepare("UPDATE sleep_sessions SET background_sound='soft-rain', frequency_layers='[\"binaural-theta\"]', favorite=1, repeat_minutes=30, pronunciation='Mara=MAH-rah', source_url='https://www.youtube.com/watch?v=portable', source_title='Portable source' WHERE id=?").run(one.sessionId);
database.prepare("INSERT INTO child_profiles (id,household_id,nickname,normalized_nickname,pronunciation,created_at,updated_at) VALUES ('child_one','house_one','Moon','moon','Moon=MOON',?,?)").run(now, now);
database.prepare("INSERT INTO child_profiles (id,household_id,nickname,normalized_nickname,pronunciation,archived_at,created_at,updated_at) VALUES ('child_archived','house_one','Old profile','old profile','',?,?,?)").run(now, now, now);
for (const [suffix, householdId] of [["one", one.householdId], ["two", two.householdId]]) {
  database.prepare("INSERT INTO voices (id,user_id,household_id,provider_voice_id,name,status,consent_attested_at,created_at) VALUES (?, 'local-preview', ?, ?, ?, 'ready', ?, ?)").run(`voice_${suffix}`, householdId, `provider_voice_${suffix}`, `Voice ${suffix}`, now, now);
  database.prepare("INSERT INTO voice_consents (id,household_id,voice_id,adult_user_id,consent_version,scope,status,evidence,attested_at) VALUES (?, ?, ?, 'local-preview','voice-v1','adult_self_private_narration','active_verified','{}',?)").run(`consent_${suffix}`, householdId, `voice_${suffix}`, now);
  database.prepare("UPDATE voices SET current_consent_id=? WHERE id=?").run(`consent_${suffix}`, `voice_${suffix}`);
}
database.prepare("INSERT INTO voices (id,user_id,household_id,provider_voice_id,name,status,consent_attested_at,created_at) VALUES ('voice_failed','local-preview','house_one','provider_voice_failed','Failed voice','failed',?,?)").run(now, now);
const routes = await Promise.all([
  import("../../app/api/v1/library/route.ts"),
  import("../../app/api/v1/library/filters/route.ts"),
  import("../../app/api/v1/library/[id]/route.ts"),
  import("../../app/api/audio/[id]/route.ts"),
  import("../../app/api/v1/playlists/route.ts"),
  import("../../app/api/v1/playlists/[id]/items/route.ts"),
  import("../../app/api/v1/bedtime-queue/route.ts"),
  import("../../app/api/account/export/route.ts"),
  import("../../app/api/account/export/[id]/route.ts"),
  import("../../app/api/account/export/[id]/parts/[partId]/route.ts"),
  import("../../app/api/account/export/[id]/metadata/[position]/route.ts"),
  import("../../app/api/account/export/[id]/archive/route.ts"),
  import("../../app/api/voices/route.ts"),
  import("../../app/api/sessions/production.ts"),
]);
const [library, libraryFilters, libraryItem, audio, playlist, playlistItems, queue, exportRoute, exportManifest, exportPart, exportMetadata, exportArchive, voiceRoute, sessionsProduction] = routes;

const householdHeaders = (householdId, mutation = false) => ({
  "x-nearyou-household-id": householdId,
  ...(mutation ? { origin: "https://example.test", "content-type": "application/json" } : {}),
});
const requestId = "12345678-1234-4234-8234-123456789abc";

const libraryOne = await library.GET(new Request("https://example.test/api/v1/library?limit=1", { headers: householdHeaders(one.householdId) }));
assert.equal(libraryOne.status, 200);
assert.deepEqual((await libraryOne.json()).sessions.map(({ id }) => id), [one.sessionId]);
const filterResponse = await libraryFilters.GET(new Request("https://example.test/api/v1/library/filters", { headers: householdHeaders(one.householdId) }));
assert.equal(filterResponse.status, 200);
assert.deepEqual(await filterResponse.json(), { children: [{ id: "child_one", label: "Moon" }], voices: [{ id: "voice_one", label: "Voice one" }] });
const foreignPatch = await libraryItem.PATCH(new Request(`https://example.test/api/v1/library/${two.sessionId}`, {
  method: "PATCH", headers: householdHeaders(one.householdId, true), body: JSON.stringify({ favorite: true, repeatMinutes: null }),
}), { params: Promise.resolve({ id: two.sessionId }) });
assert.equal(foreignPatch.status, 404);
const favorite = await libraryItem.PATCH(new Request(`https://example.test/api/v1/library/${one.sessionId}`, {
  method: "PATCH", headers: householdHeaders(one.householdId, true), body: JSON.stringify({ favorite: true, repeatMinutes: 30 }),
}), { params: Promise.resolve({ id: one.sessionId }) });
assert.equal(favorite.status, 200);
assert.deepEqual(await favorite.json(), { session: { id: one.sessionId, favorite: true, repeatMinutes: 30 } });

const playback = await audio.GET(new Request(`https://example.test/api/audio/${one.sessionId}?download=true`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: one.sessionId }) });
assert.equal(playback.status, 200);
assert.equal(playback.headers.get("cache-control"), "private, no-store");
assert.match(playback.headers.get("content-disposition"), /^attachment;/);
const audioMetadataChecksum = r2.objects.get(one.key).customMetadata.checksum;
r2.objects.get(one.key).customMetadata.checksum = "0".repeat(64);
const tamperedRangePlayback = await audio.GET(new Request(`https://example.test/api/audio/${one.sessionId}`, { headers: { ...householdHeaders(one.householdId), range: "bytes=0-3" } }), { params: Promise.resolve({ id: one.sessionId }) });
assert.equal(tamperedRangePlayback.status, 503);
r2.objects.get(one.key).customMetadata.checksum = audioMetadataChecksum;
const foreignPlayback = await audio.GET(new Request(`https://example.test/api/audio/${two.sessionId}`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: two.sessionId }) });
assert.equal(foreignPlayback.status, 404);

async function createPlaylist(householdId) {
  const response = await playlist.POST(new Request("https://example.test/api/v1/playlists", { method: "POST", headers: householdHeaders(householdId, true), body: JSON.stringify({ requestId, name: "Bedtime" }) }));
  assert.equal(response.status, 201);
  return (await response.json()).playlist.id;
}
const listOne = await createPlaylist(one.householdId);
const listTwo = await createPlaylist(two.householdId);
assert.notEqual(listOne, listTwo);
for (const [listId, session] of [[listOne, one], [listTwo, two]]) {
  const response = await playlistItems.POST(new Request(`https://example.test/api/v1/playlists/${listId}/items`, { method: "POST", headers: householdHeaders(session.householdId, true), body: JSON.stringify({ requestId, mediaAssetId: session.mediaId, position: 0 }) }), { params: Promise.resolve({ id: listId }) });
  assert.equal(response.status, 201);
}
assert.equal(database.prepare("SELECT COUNT(DISTINCT id) AS value FROM playlist_items").get().value, 2);
for (const session of [one, two]) {
  const response = await queue.POST(new Request("https://example.test/api/v1/bedtime-queue", { method: "POST", headers: householdHeaders(session.householdId, true), body: JSON.stringify({ requestId, sessionId: session.sessionId, position: 0 }) }));
  assert.equal(response.status, 201);
}
assert.equal(database.prepare("SELECT COUNT(DISTINCT id) AS value FROM bedtime_queue_items").get().value, 2);

for (let index = 0; index < 55; index += 1) {
  const sessionId = `zz_export_session_${String(index).padStart(3, "0")}`;
  const mediaId = `zz_export_media_${String(index).padStart(3, "0")}`;
  const key = `audio/${one.householdId}/${sessionId}.mp3`;
  const bytes = new TextEncoder().encode(`paged export audio ${index}`);
  database.prepare("INSERT INTO sleep_sessions (id,user_id,household_id,title,script,script_mode,content_type,narration_kind,theme,style,background_sound,duration_minutes,status,audio_key,created_at,completed_at) VALUES (?,'local-preview',?,'Paged Night',?,'curated','story','demo_narrator','moonlit-meadow','gentle','none',5,'ready',?,?,?)").run(sessionId, one.householdId, index === 0 ? "🌙".repeat(18_000) : "safe script", key, now, now);
  const checksum = checksumOf(bytes);
  database.prepare("INSERT INTO media_assets (id,household_id,owner_user_id,legacy_session_id,kind,status,storage_key,content_type,byte_size,checksum,private,created_at,updated_at) VALUES (?,?,'local-preview',?,'narration','processing',?,'audio/mpeg',?,?,1,?,?)").run(mediaId, one.householdId, sessionId, key, bytes.byteLength, checksum, now, now);
  database.prepare("INSERT INTO household_storage_reservations (id,household_id,media_asset_id,byte_size,status,created_at,updated_at) VALUES (?,?,?,?,'reserved',?,?)").run(`zz_export_reservation_${index}`, one.householdId, mediaId, bytes.byteLength, now, now);
  database.prepare("UPDATE sleep_sessions SET media_asset_id = ? WHERE id = ?").run(mediaId, sessionId);
  database.prepare("UPDATE media_assets SET status = 'ready', updated_at = ? WHERE id = ?").run(now, mediaId);
  r2.objects.set(key, { bytes, contentType: "audio/mpeg", customMetadata: { checksum } });
}
const lateBytes = new TextEncoder().encode("late point in time audio");
const lateChecksum = checksumOf(lateBytes);
database.prepare("INSERT INTO sleep_sessions (id,user_id,household_id,title,script,script_mode,content_type,narration_kind,theme,style,background_sound,duration_minutes,status,created_at) VALUES ('zz_late_session','local-preview',?,'Later Night','late safe script','curated','story','demo_narrator','moonlit-meadow','gentle','none',5,'generating',?)").run(one.householdId, now);
r2.objects.set("audio/house_one/zz_late_session.mp3", { bytes: lateBytes, contentType: "audio/mpeg", customMetadata: { checksum: lateChecksum } });

const sameMillisecondFirst = await library.GET(new Request("https://example.test/api/v1/library?limit=20", { headers: householdHeaders(one.householdId) }));
const sameMillisecondFirstBody = await sameMillisecondFirst.json();
assert.equal(sameMillisecondFirstBody.sessions.length, 20);
assert.equal(typeof sameMillisecondFirstBody.nextCursor, "string");
const sameMillisecondSecond = await library.GET(new Request(`https://example.test/api/v1/library?limit=20&cursor=${encodeURIComponent(sameMillisecondFirstBody.nextCursor)}`, { headers: householdHeaders(one.householdId) }));
const sameMillisecondSecondBody = await sameMillisecondSecond.json();
assert.equal(sameMillisecondSecondBody.sessions.length, 20);
assert.equal(new Set([...sameMillisecondFirstBody.sessions, ...sameMillisecondSecondBody.sessions].map(({ id }) => id)).size, 40);

const orphanRequestId = "32345678-1234-4234-8234-123456789abc";
const orphanRequest = () => new Request("https://example.test/api/account/export", { method: "POST", headers: householdHeaders(two.householdId, true), body: JSON.stringify({ requestId: orphanRequestId }) });
r2.putLostKeyPrefix = `exports/${encodeURIComponent(two.householdId)}/export%3A${encodeURIComponent(two.householdId)}%3A${orphanRequestId}/metadata/`;
r2.headChecksumOverrides.push({ prefix: `exports/${encodeURIComponent(two.householdId)}/export%3A${encodeURIComponent(two.householdId)}%3A${orphanRequestId}/metadata/`, value: null, remaining: 2 });
let orphanResponse;
for (let attempt = 0; attempt < 10; attempt += 1) {
  orphanResponse = await exportRoute.POST(orphanRequest());
  const state = (await orphanResponse.clone().json()).export.status;
  if (state === "failed" && r2.headChecksumOverrides[0].remaining === 0) break;
}
const orphanRecord = database.prepare("SELECT id FROM household_exports WHERE household_id = ?").get(two.householdId);
const orphanPage = database.prepare("SELECT storage_key AS storageKey,status FROM household_export_metadata_pages WHERE export_id = ?").get(orphanRecord.id);
assert.equal(orphanPage.status, "pending");
assert.equal((await orphanResponse.clone().json()).export.status, "failed");
assert.ok(await r2.head(orphanPage.storageKey));
database.prepare("UPDATE household_exports SET expires_at = ? WHERE id = ?").run(Date.now() - 1, orphanRecord.id);
for (let attempt = 0; attempt < 10; attempt += 1) {
  orphanResponse = await exportRoute.POST(orphanRequest());
  if ((await orphanResponse.clone().json()).export.status === "expired") break;
}
assert.equal((await orphanResponse.json()).export.status, "expired");
assert.equal(await r2.head(orphanPage.storageKey), null);

const consentDuringRequestId = "42345678-1234-4234-8234-123456789abc";
const consentDuringRequest = () => new Request("https://example.test/api/account/export", { method: "POST", headers: householdHeaders(two.householdId, true), body: JSON.stringify({ requestId: consentDuringRequestId }) });
const seedRaceConsent = (id) => database.prepare("INSERT INTO voice_consents (id,household_id,voice_id,adult_user_id,consent_version,scope,status,evidence,attested_at) VALUES (?,?,'voice_two','local-preview','voice-v1','adult_self_private_narration','active_verified','{}',?)").run(id, two.householdId, Date.now());
const invalidateAfterPut = (exportId, consentId, prefix) => {
  r2.afterPut = {
    prefix,
    callback: async () => {
      database.prepare("UPDATE household_exports SET attempt_expires_at=? WHERE id=? AND status='running'").run(Date.now() + 10, exportId);
      database.prepare("UPDATE voice_consents SET status='revoked',revoked_at=? WHERE id=?").run(Date.now(), consentId);
    },
  };
};
const expireInvalidatedExport = async (request, exportId) => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await exportRoute.POST(request());
    if (database.prepare("SELECT status FROM household_exports WHERE id=?").get(exportId).status === "expired") break;
  }
  assert.equal(database.prepare("SELECT status FROM household_exports WHERE id=?").get(exportId).status, "expired");
};

seedRaceConsent("consent_two_metadata_race");
assert.equal((await exportRoute.POST(consentDuringRequest())).status, 202);
const consentDuringExport = database.prepare("SELECT id FROM household_exports WHERE household_id=? AND idempotency_key=?").get(two.householdId, consentDuringRequestId);
const metadataPrefix = `exports/${encodeURIComponent(two.householdId)}/${encodeURIComponent(consentDuringExport.id)}/metadata/`;
invalidateAfterPut(consentDuringExport.id, "consent_two_metadata_race", metadataPrefix);
for (let attempt = 0; attempt < 10; attempt += 1) {
  await exportRoute.POST(consentDuringRequest());
  if (database.prepare("SELECT status FROM household_exports WHERE id=?").get(consentDuringExport.id).status === "failed") break;
}
assert.deepEqual({ ...database.prepare("SELECT status,error_code AS errorCode FROM household_exports WHERE id=?").get(consentDuringExport.id) }, { status: "failed", errorCode: "consent_revoked_cleanup_pending" });
const invalidatedMetadataPage = database.prepare("SELECT storage_key AS storageKey,status FROM household_export_metadata_pages WHERE export_id=? ORDER BY position DESC LIMIT 1").get(consentDuringExport.id);
assert.equal(invalidatedMetadataPage.status, "pending");
assert.equal(await r2.head(invalidatedMetadataPage.storageKey), null);
assert.equal((await exportManifest.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(consentDuringExport.id)}`, { headers: householdHeaders(two.householdId) }), { params: Promise.resolve({ id: consentDuringExport.id }) })).status, 404);
await expireInvalidatedExport(consentDuringRequest, consentDuringExport.id);

const partRaceRequestId = "43345678-1234-4234-8234-123456789abc";
const partRaceRequest = () => new Request("https://example.test/api/account/export", { method: "POST", headers: householdHeaders(two.householdId, true), body: JSON.stringify({ requestId: partRaceRequestId }) });
seedRaceConsent("consent_two_part_race");
assert.equal((await exportRoute.POST(partRaceRequest())).status, 202);
const partRaceExport = database.prepare("SELECT id FROM household_exports WHERE household_id=? AND idempotency_key=?").get(two.householdId, partRaceRequestId);
for (let attempt = 0; attempt < 20; attempt += 1) {
  await exportRoute.POST(partRaceRequest());
  if (database.prepare("SELECT inventory_stage AS stage FROM household_exports WHERE id=?").get(partRaceExport.id).stage === "copy") break;
}
const invalidatedPart = database.prepare("SELECT id,export_storage_key AS exportStorageKey FROM household_export_parts WHERE export_id=? AND status='pending' ORDER BY id LIMIT 1").get(partRaceExport.id);
invalidateAfterPut(partRaceExport.id, "consent_two_part_race", invalidatedPart.exportStorageKey);
await exportRoute.POST(partRaceRequest());
assert.deepEqual({ ...database.prepare("SELECT status,error_code AS errorCode FROM household_exports WHERE id=?").get(partRaceExport.id) }, { status: "failed", errorCode: "consent_revoked_cleanup_pending" });
assert.equal(database.prepare("SELECT status FROM household_export_parts WHERE id=?").get(invalidatedPart.id).status, "pending");
assert.equal(await r2.head(invalidatedPart.exportStorageKey), null);
await expireInvalidatedExport(partRaceRequest, partRaceExport.id);

const manifestRaceRequestId = "44345678-1234-4234-8234-123456789abc";
const manifestRaceRequest = () => new Request("https://example.test/api/account/export", { method: "POST", headers: householdHeaders(two.householdId, true), body: JSON.stringify({ requestId: manifestRaceRequestId }) });
seedRaceConsent("consent_two_manifest_race");
assert.equal((await exportRoute.POST(manifestRaceRequest())).status, 202);
const manifestRaceExport = database.prepare("SELECT id FROM household_exports WHERE household_id=? AND idempotency_key=?").get(two.householdId, manifestRaceRequestId);
const invalidatedManifestKey = `exports/${encodeURIComponent(two.householdId)}/${encodeURIComponent(manifestRaceExport.id)}/manifest.json`;
invalidateAfterPut(manifestRaceExport.id, "consent_two_manifest_race", invalidatedManifestKey);
for (let attempt = 0; attempt < 30; attempt += 1) {
  await exportRoute.POST(manifestRaceRequest());
  if (database.prepare("SELECT error_code AS errorCode FROM household_exports WHERE id=?").get(manifestRaceExport.id).errorCode === "consent_revoked_cleanup_pending") break;
}
assert.deepEqual({ ...database.prepare("SELECT status,error_code AS errorCode FROM household_exports WHERE id=?").get(manifestRaceExport.id) }, { status: "failed", errorCode: "consent_revoked_cleanup_pending" });
assert.equal(await r2.head(invalidatedManifestKey), null);
await expireInvalidatedExport(manifestRaceRequest, manifestRaceExport.id);

const exportRequest = () => new Request("https://example.test/api/account/export", { method: "POST", headers: householdHeaders(one.householdId, true), body: JSON.stringify({ requestId }) });
const exportFirst = await exportRoute.POST(exportRequest());
assert.equal(exportFirst.status, 202);
assert.equal((await exportFirst.json()).export.status, "queued");
const liveConflict = await exportRoute.POST(new Request("https://example.test/api/account/export", { method: "POST", headers: householdHeaders(one.householdId, true), body: JSON.stringify({ requestId: "97654321-4321-4321-8321-cba987654321" }) }));
assert.equal(liveConflict.status, 409);
let inventoryRecord;
for (let attempt = 0; attempt < 20; attempt += 1) {
  await exportRoute.POST(exportRequest());
  inventoryRecord = database.prepare("SELECT id,created_at AS createdAt,inventory_stage AS inventoryStage,inventory_cursor AS inventoryCursor FROM household_exports WHERE household_id = ?").get(one.householdId);
  if (inventoryRecord.inventoryStage === "sessions" && inventoryRecord.inventoryCursor) break;
}
assert.equal(inventoryRecord.inventoryStage, "sessions", JSON.stringify(database.prepare("SELECT status,error_code AS errorCode,inventory_stage AS stage,inventory_cursor AS cursor,metadata_page_count AS pages FROM household_exports WHERE household_id = ?").all(one.householdId)));
assert.ok(inventoryRecord.inventoryCursor);
const favoriteDuringSnapshot = await libraryItem.PATCH(new Request(`https://example.test/api/v1/library/${one.sessionId}`, { method: "PATCH", headers: householdHeaders(one.householdId, true), body: JSON.stringify({ favorite: false, repeatMinutes: null }) }), { params: Promise.resolve({ id: one.sessionId }) });
assert.equal(favoriteDuringSnapshot.status, 409);
const playlistDuringSnapshot = await playlist.POST(new Request("https://example.test/api/v1/playlists", { method: "POST", headers: householdHeaders(one.householdId, true), body: JSON.stringify({ requestId: "52345678-1234-4234-8234-123456789abc", name: "Racing list" }) }));
assert.equal(playlistDuringSnapshot.status, 409);
const itemDuringSnapshot = await playlistItems.POST(new Request(`https://example.test/api/v1/playlists/${listOne}/items`, { method: "POST", headers: householdHeaders(one.householdId, true), body: JSON.stringify({ requestId: "62345678-1234-4234-8234-123456789abc", mediaAssetId: one.mediaId, position: 1 }) }), { params: Promise.resolve({ id: listOne }) });
assert.equal(itemDuringSnapshot.status, 409);
const queueDuringSnapshot = await queue.POST(new Request("https://example.test/api/v1/bedtime-queue", { method: "POST", headers: householdHeaders(one.householdId, true), body: JSON.stringify({ requestId: "72345678-1234-4234-8234-123456789abc", sessionId: one.sessionId, position: 1 }) }));
assert.equal(queueDuringSnapshot.status, 409);
assert.throws(() => database.prepare("UPDATE child_profiles SET nickname='Changed mid-export' WHERE id='child_one'").run(), /household_export_snapshot_locked/);
assert.throws(() => database.prepare("INSERT INTO sleep_sessions (id,user_id,household_id,title,script,script_mode,content_type,narration_kind,theme,style,background_sound,duration_minutes,status,created_at) VALUES ('stalled_insert','local-preview','house_one','Stalled insert','safe','curated','story','demo_narrator','moonlit-meadow','gentle','none',5,'queued',?)").run(inventoryRecord.createdAt - 1), /household_export_snapshot_locked/);
await assert.rejects(() => sessionsProduction.finalizeSavedSession({ sessionId: "zz_late_session", householdId: one.householdId, userId: "local-preview", childProfileId: "child_one", audioKey: "audio/house_one/zz_late_session.mp3", byteSize: lateBytes.byteLength, checksum: lateChecksum }), /household_export_snapshot_locked/);
assert.deepEqual({ ...database.prepare("SELECT s.status AS sessionStatus,m.status AS mediaStatus,r.status AS reservationStatus FROM sleep_sessions s JOIN media_assets m ON m.id='media:zz_late_session' JOIN household_storage_reservations r ON r.media_asset_id=m.id WHERE s.id='zz_late_session'").get() }, { sessionStatus: "generating", mediaStatus: "processing", reservationStatus: "reserved" });
for (let attempt = 0; attempt < 20; attempt += 1) {
  await exportRoute.POST(exportRequest());
  if (database.prepare("SELECT inventory_stage AS stage FROM household_exports WHERE id=?").get(inventoryRecord.id).stage === "copy") break;
}
assert.equal(database.prepare("SELECT inventory_stage AS stage FROM household_exports WHERE id=?").get(inventoryRecord.id).stage, "copy");
const exportPartsPrefix = `exports/${encodeURIComponent(one.householdId)}/${encodeURIComponent(inventoryRecord.id)}/parts/`;
const firstPendingPart = database.prepare("SELECT id,source_storage_key AS sourceStorageKey,export_storage_key AS exportStorageKey FROM household_export_parts WHERE export_id=? AND status='pending' ORDER BY id LIMIT 1").get(inventoryRecord.id);
const sourceMetadata = r2.objects.get(firstPendingPart.sourceStorageKey).customMetadata;
delete sourceMetadata.checksum;
const exportMissingSourceMetadata = await exportRoute.POST(exportRequest());
assert.equal((await exportMissingSourceMetadata.json()).export.status, "failed");
assert.equal(database.prepare("SELECT status FROM household_export_parts WHERE id=?").get(firstPendingPart.id).status, "pending");
sourceMetadata.checksum = "0".repeat(64);
const exportWrongSourceMetadata = await exportRoute.POST(exportRequest());
assert.equal((await exportWrongSourceMetadata.json()).export.status, "failed");
assert.equal(database.prepare("SELECT status FROM household_export_parts WHERE id=?").get(firstPendingPart.id).status, "pending");
sourceMetadata.checksum = checksumOf(one.bytes);
r2.putLostKeyPrefixes.add(exportPartsPrefix);
const exportLostCopy = await exportRoute.POST(exportRequest());
assert.equal(exportLostCopy.status, 202);
assert.equal((await exportLostCopy.json()).export.status, "failed");
assert.ok(await r2.head(firstPendingPart.exportStorageKey));
r2.headChecksumOverrides.push({ prefix: firstPendingPart.exportStorageKey, value: "0".repeat(64), remaining: 1 });
const exportWrongPartMetadata = await exportRoute.POST(exportRequest());
assert.equal((await exportWrongPartMetadata.json()).export.status, "failed");
assert.equal(database.prepare("SELECT status FROM household_export_parts WHERE id=?").get(firstPendingPart.id).status, "pending");
for (let attempt = 0; attempt < 20; attempt += 1) {
  await exportRoute.POST(exportRequest());
  const remaining = database.prepare("SELECT COUNT(*) AS value FROM household_export_parts WHERE export_id=? AND status='pending'").get(inventoryRecord.id).value;
  if (remaining <= 10) break;
}
const manifestPrefix = `exports/${encodeURIComponent(one.householdId)}/${encodeURIComponent(inventoryRecord.id)}/manifest.json`;
r2.putLostKeyPrefixes.add(manifestPrefix);
const exportLostManifest = await exportRoute.POST(exportRequest());
assert.equal((await exportLostManifest.json()).export.status, "failed");
const stagedManifestKey = database.prepare("SELECT manifest_storage_key AS key FROM household_exports WHERE id=?").get(inventoryRecord.id).key;
assert.equal(stagedManifestKey, manifestPrefix);
assert.ok(await r2.head(stagedManifestKey));
r2.headChecksumOverrides.push({ prefix: stagedManifestKey, value: null, remaining: 2 });
const exportMissingManifestMetadata = await exportRoute.POST(exportRequest());
assert.equal((await exportMissingManifestMetadata.json()).export.status, "failed");
let exportRetry;
for (let attempt = 0; attempt < 40; attempt += 1) {
  exportRetry = await exportRoute.POST(exportRequest());
  if (exportRetry.status === 201) break;
}
assert.equal(exportRetry.status, 201, JSON.stringify(database.prepare("SELECT status,error_code AS errorCode,cursor_position AS cursorPosition,inventory_count AS inventoryCount,inventory_stage AS inventoryStage FROM household_exports").all()));
const exportRecord = (await exportRetry.json()).export;
assert.equal(exportRecord.status, "succeeded");
assert.ok(new Date(exportRecord.expiresAt).getTime() - Date.now() > 6.9 * 24 * 60 * 60 * 1000);
const manifestKey = database.prepare("SELECT manifest_storage_key AS key FROM household_exports WHERE id=?").get(exportRecord.id).key;
const originalManifestBytes = r2.objects.get(manifestKey).bytes;
const tamperedManifestBytes = originalManifestBytes.slice(); tamperedManifestBytes[0] ^= 1; r2.objects.get(manifestKey).bytes = tamperedManifestBytes;
assert.equal((await exportManifest.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(exportRecord.id)}`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: exportRecord.id }) })).status, 503);
r2.objects.get(manifestKey).bytes = originalManifestBytes;
const manifestResponse = await exportManifest.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(exportRecord.id)}`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: exportRecord.id }) });
assert.equal(manifestResponse.status, 200);
assert.doesNotMatch(manifestResponse.headers.get("content-disposition") || "", /:/);
const manifest = await manifestResponse.json();
assert.equal(typeof manifest.metadataPages.urlTemplate, "string");
const metadataItems = [];
const firstPageKey = database.prepare("SELECT storage_key AS key FROM household_export_metadata_pages WHERE export_id=? AND status='ready' ORDER BY position LIMIT 1").get(exportRecord.id).key;
const originalPageBytes = r2.objects.get(firstPageKey).bytes; const tamperedPageBytes = originalPageBytes.slice(); tamperedPageBytes[0] ^= 1; r2.objects.get(firstPageKey).bytes = tamperedPageBytes;
assert.equal((await exportMetadata.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(exportRecord.id)}/metadata/0`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: exportRecord.id, position: "0" }) })).status, 503);
r2.objects.get(firstPageKey).bytes = originalPageBytes;
for (let position = 0; position < manifest.metadataPages.count + manifest.integrityCatalog.count; position += 1) {
  const response = await exportMetadata.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(exportRecord.id)}/metadata/${position}`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: exportRecord.id, position: String(position) }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-nearyou-sha256") || "", /^[0-9a-f]{64}$/);
  metadataItems.push(await response.json());
}
const exportedSessions = metadataItems.filter((page) => page.kind === "sessions").flatMap((page) => page.items);
const exportedQueue = metadataItems.filter((page) => page.kind === "bedtime_queue").flatMap((page) => page.items);
assert.equal(exportedSessions[0].id, one.sessionId);
assert.equal(exportedSessions.length, 56);
assert.equal(exportedSessions.some(({ id }) => id === "zz_late_session"), false);
assert.equal(database.prepare("SELECT inventory_count AS inventoryCount FROM household_exports WHERE id = ?").get(exportRecord.id).inventoryCount, 56);
assert.equal("storageKey" in exportedSessions[0], false);
assert.deepEqual({
  backgroundSound: exportedSessions[0].backgroundSound,
  frequencyLayers: exportedSessions[0].frequencyLayers,
  favorite: exportedSessions[0].favorite,
  repeatMinutes: exportedSessions[0].repeatMinutes,
  pronunciation: exportedSessions[0].pronunciation,
  sourceUrl: exportedSessions[0].sourceUrl,
  sourceTitle: exportedSessions[0].sourceTitle,
}, { backgroundSound: "soft-rain", frequencyLayers: '["binaural-theta"]', favorite: true, repeatMinutes: 30, pronunciation: "Mara=MAH-rah", sourceUrl: "https://www.youtube.com/watch?v=portable", sourceTitle: "Portable source" });
assert.equal(Object.keys(exportedSessions[0]).some((key) => /provider/i.test(key)), false);
assert.equal("consentId" in exportedSessions[0], true);
assert.equal("consentVersion" in exportedSessions[0], true);
assert.deepEqual(exportedQueue.map(({ sessionId, position, status }) => ({ sessionId, position, status })), [{ sessionId: one.sessionId, position: 0, status: "queued" }]);
assert.ok(database.prepare("SELECT MAX(byte_size) AS maxBytes FROM household_export_metadata_pages WHERE export_id = ?").get(exportRecord.id).maxBytes < 1024 * 1024);
assert.ok(database.prepare("SELECT length(snapshot) AS bytes FROM household_exports WHERE id = ?").get(exportRecord.id).bytes < 2048);
const part = database.prepare("SELECT id, export_storage_key AS exportStorageKey,byte_size AS byteSize,checksum FROM household_export_parts WHERE export_id = ?").get(exportRecord.id);
const copiedPartChecksum = r2.objects.get(part.exportStorageKey).customMetadata.checksum;
r2.objects.get(part.exportStorageKey).customMetadata.checksum = "0".repeat(64);
assert.equal((await exportPart.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(exportRecord.id)}/parts/${encodeURIComponent(part.id)}`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: exportRecord.id, partId: part.id }) })).status, 503);
r2.objects.get(part.exportStorageKey).customMetadata.checksum = copiedPartChecksum;
const partResponse = await exportPart.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(exportRecord.id)}/parts/${encodeURIComponent(part.id)}`, { headers: { ...householdHeaders(one.householdId), range: "bytes=0-3" } }), { params: Promise.resolve({ id: exportRecord.id, partId: part.id }) });
assert.equal(partResponse.status, 206, JSON.stringify({ part, object: { size: r2.objects.get(part.exportStorageKey).bytes.byteLength, customMetadata: r2.objects.get(part.exportStorageKey).customMetadata }, body: await partResponse.clone().text() }));
assert.equal(partResponse.headers.get("digest"), null);
assert.match(partResponse.headers.get("x-nearyou-sha256") || "", /^[0-9a-f]{64}$/);
assert.equal((await partResponse.arrayBuffer()).byteLength, 4);
const archiveResponse = await exportArchive.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(exportRecord.id)}/archive`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: exportRecord.id }) });
assert.equal(archiveResponse.status, 200);
const archiveBytes = new Uint8Array(await archiveResponse.arrayBuffer());
assert.equal(new TextDecoder().decode(archiveBytes.slice(257, 262)), "ustar");
assert.ok(archiveBytes.byteLength > originalManifestBytes.byteLength);
assert.equal(database.prepare("SELECT artifact_count AS artifactCount FROM household_export_download_confirmations WHERE export_id=?").get(exportRecord.id).artifactCount, 1 + manifest.metadataPages.count + manifest.integrityCatalog.count + manifest.mediaParts.count);
const crossTenantExport = await exportManifest.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(exportRecord.id)}`, { headers: householdHeaders(two.householdId) }), { params: Promise.resolve({ id: exportRecord.id }) });
assert.equal(crossTenantExport.status, 404);
database.prepare("UPDATE household_exports SET expires_at = ? WHERE id = ?").run(Date.now() - 1, exportRecord.id);
r2.deleteLostKey = part.exportStorageKey;
let expiredReplay;
for (let attempt = 0; attempt < 10; attempt += 1) {
  expiredReplay = await exportRoute.POST(exportRequest());
  if (database.prepare("SELECT error_code AS errorCode FROM household_exports WHERE id = ?").get(exportRecord.id).errorCode === "export_expiry_cleanup_retry") break;
}
assert.equal(expiredReplay.status, 202);
assert.equal((await expiredReplay.json()).export.status, "failed");
assert.equal(database.prepare("SELECT error_code AS errorCode FROM household_exports WHERE id = ?").get(exportRecord.id).errorCode, "export_expiry_cleanup_retry");
assert.equal(await r2.head(part.exportStorageKey), null);
let expiredRetry;
for (let attempt = 0; attempt < 10; attempt += 1) {
  expiredRetry = await exportRoute.POST(exportRequest());
  if ((await expiredRetry.clone().json()).export.status === "expired") break;
}
assert.equal(expiredRetry.status, 202);
assert.equal((await expiredRetry.json()).export.status, "expired");
assert.equal(await r2.head(database.prepare("SELECT manifest_storage_key AS manifestStorageKey FROM household_exports WHERE id = ?").get(exportRecord.id).manifestStorageKey), null);
await sessionsProduction.finalizeSavedSession({ sessionId: "zz_late_session", householdId: one.householdId, userId: "local-preview", childProfileId: "child_one", audioKey: "audio/house_one/zz_late_session.mp3", byteSize: lateBytes.byteLength, checksum: lateChecksum });
assert.deepEqual({ ...database.prepare("SELECT s.status AS sessionStatus,m.status AS mediaStatus,i.checksum FROM sleep_sessions s JOIN media_assets m ON m.id=s.media_asset_id JOIN task2c_media_integrity i ON i.media_asset_id=m.id WHERE s.id='zz_late_session'").get() }, { sessionStatus: "ready", mediaStatus: "ready", checksum: lateChecksum });
const newExportRequestId = "87654321-4321-4321-8321-cba987654321";
const replacementRequest = () => new Request("https://example.test/api/account/export", {
  method: "POST", headers: householdHeaders(one.householdId, true), body: JSON.stringify({ requestId: newExportRequestId }),
});
let replacementExport;
for (let attempt = 0; attempt < 40; attempt += 1) {
  replacementExport = await exportRoute.POST(replacementRequest());
  if (replacementExport.status === 201) break;
}
assert.equal(replacementExport.status, 201);
const replacementRecord = (await replacementExport.json()).export;
assert.notEqual(replacementRecord.id, exportRecord.id);
const replacementManifestResponse = await exportManifest.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(replacementRecord.id)}`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: replacementRecord.id }) });
const replacementManifest = await replacementManifestResponse.json();
let replacementSessionCount = 0;
for (let position = 0; position < replacementManifest.metadataPages.count; position += 1) {
  const response = await exportMetadata.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(replacementRecord.id)}/metadata/${position}`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: replacementRecord.id, position: String(position) }) });
  const page = await response.json();
  if (page.kind === "sessions") replacementSessionCount += page.items.length;
}
assert.equal(replacementSessionCount, 57);
const replacementManifestKey = database.prepare("SELECT manifest_storage_key AS key FROM household_exports WHERE id=?").get(replacementRecord.id).key;
const invalidatedArchive = await exportArchive.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(replacementRecord.id)}/archive`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: replacementRecord.id }) });
assert.equal(invalidatedArchive.status, 200);
const invalidatedReader = invalidatedArchive.body.getReader();
assert.equal((await invalidatedReader.read()).done, false);
const revokeAfterExport = await voiceRoute.DELETE(new Request("https://example.test/api/voices?voiceId=voice_one", { method: "DELETE", headers: householdHeaders(one.householdId, true) }));
assert.equal(revokeAfterExport.status, 200);
assert.deepEqual({ ...database.prepare("SELECT status,revoked_at IS NOT NULL AS revoked FROM voice_consents WHERE id='consent_one'").get() }, { status: "revoked", revoked: 1 });
assert.deepEqual({ ...database.prepare("SELECT status,error_code AS errorCode FROM household_exports WHERE id=?").get(replacementRecord.id) }, { status: "failed", errorCode: "consent_revoked_cleanup_pending" });
await assert.rejects(async () => { while (!(await invalidatedReader.read()).done) { /* consume until invalidation */ } }, /invalidated/);
assert.equal(database.prepare("SELECT COUNT(*) AS count FROM household_export_download_confirmations WHERE export_id=?").get(replacementRecord.id).count, 0);
assert.equal((await exportManifest.GET(new Request(`https://example.test/api/account/export/${encodeURIComponent(replacementRecord.id)}`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: replacementRecord.id }) })).status, 404);
for (let attempt = 0; attempt < 40; attempt += 1) {
  await exportRoute.POST(replacementRequest());
  if (database.prepare("SELECT status FROM household_exports WHERE id=?").get(replacementRecord.id).status === "expired") break;
}
assert.equal(database.prepare("SELECT status FROM household_exports WHERE id=?").get(replacementRecord.id).status, "expired");
assert.equal(await r2.head(replacementManifestKey), null);

r2.deleteLostKey = one.key;
const deleteRequest = () => new Request(`https://example.test/api/v1/library/${one.sessionId}`, { method: "DELETE", headers: householdHeaders(one.householdId, true) });
const deleteFirst = await libraryItem.DELETE(deleteRequest(), { params: Promise.resolve({ id: one.sessionId }) });
assert.equal(deleteFirst.status, 202);
assert.equal(database.prepare("SELECT deletion_status FROM sleep_sessions WHERE id = ?").get(one.sessionId).deletion_status, "delete_pending");
const deniedPlayback = await audio.GET(new Request(`https://example.test/api/audio/${one.sessionId}`, { headers: householdHeaders(one.householdId) }), { params: Promise.resolve({ id: one.sessionId }) });
assert.equal(deniedPlayback.status, 404);
const deleteRetry = await libraryItem.DELETE(deleteRequest(), { params: Promise.resolve({ id: one.sessionId }) });
assert.equal(deleteRetry.status, 200);
assert.equal(database.prepare("SELECT deletion_status FROM sleep_sessions WHERE id = ?").get(one.sessionId).deletion_status, "deleted");
assert.equal(database.prepare("SELECT status FROM media_assets WHERE id = ?").get(one.mediaId).status, "deleted");
assert.equal(database.prepare("SELECT status FROM household_storage_reservations WHERE media_asset_id = ?").get(one.mediaId).status, "released");
const deleteDuplicate = await libraryItem.DELETE(deleteRequest(), { params: Promise.resolve({ id: one.sessionId }) });
assert.equal(deleteDuplicate.status, 200);

database.prepare("INSERT INTO household_exports (id,household_id,requested_by_user_id,idempotency_key,request_hash,snapshot,status,cursor_position,inventory_count,expires_at,created_at,updated_at) VALUES ('export:blocking','house_two','local-preview','blocking','hash','{}','running',0,1,?,?,?)").run(now + 60_000, now, now);
database.prepare("INSERT INTO household_export_parts (id,export_id,source_media_asset_id,source_storage_key,export_storage_key,content_type,byte_size,checksum,status,expires_at,created_at,updated_at) VALUES ('export:blocking:part','export:blocking',?,?,?,?,?,?,'pending',?,?,?)")
  .run(two.mediaId, two.key, "exports/blocking.mp3", "audio/mpeg", two.bytes.byteLength, checksumOf(two.bytes), now + 60_000, now, now);
database.prepare("UPDATE household_exports SET status='queued' WHERE id='export:blocking'").run();
const deleteTwoRequest = () => new Request(`https://example.test/api/v1/library/${two.sessionId}`, { method: "DELETE", headers: householdHeaders(two.householdId, true) });
const blockedByExport = await libraryItem.DELETE(deleteTwoRequest(), { params: Promise.resolve({ id: two.sessionId }) });
assert.equal(blockedByExport.status, 409);
database.prepare("UPDATE household_exports SET status = 'expired', expires_at = ? WHERE id = 'export:blocking'").run(now - 1);
const resumedAfterExpiry = await libraryItem.DELETE(deleteTwoRequest(), { params: Promise.resolve({ id: two.sessionId }) });
assert.equal(resumedAfterExpiry.status, 200);
database.prepare("INSERT INTO sleep_sessions (id,user_id,household_id,title,script,script_mode,content_type,narration_kind,theme,style,background_sound,duration_minutes,status,created_at) VALUES ('session_unready','local-preview','house_two','Generating','script','curated','story','demo_narrator','moonlit-meadow','gentle','none',5,'queued',?)").run(now);
const unreadyDelete = await libraryItem.DELETE(new Request("https://example.test/api/v1/library/session_unready", { method: "DELETE", headers: householdHeaders(two.householdId, true) }), { params: Promise.resolve({ id: "session_unready" }) });
assert.equal(unreadyDelete.status, 404);
assert.equal(database.prepare("SELECT deletion_status FROM sleep_sessions WHERE id = 'session_unready'").get().deletion_status, "active");
