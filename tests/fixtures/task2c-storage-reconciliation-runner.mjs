import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migrations = ["0000_nearnight_foundation.sql","0001_google_apple_auth.sql","0002_sharp_shinobi_shaw.sql","0003_white_groot.sql","0004_salty_sugar_man.sql","0005_pronunciation_frequency_layers.sql","0006_nearyou_shared_foundation.sql","0007_nearsleep_production_upgrade.sql","0008_nearsleep_live_integration.sql","0009_nearsleep_audio_atomic.sql","0010_child_profile_pronunciation.sql","0011_household_billing_accounts.sql"];
function apply(database, name) {
  const source = readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
}
class Statement {
  constructor(database, source, values = []) { this.database = database; this.source = source; this.values = values; }
  bind(...values) { return new Statement(this.database, this.source, values); }
  execute() { const statement = this.database.prepare(this.source); if (statement.columns().length) return { success: true, results: statement.all(...this.values), meta: { changes: 0 } }; const result = statement.run(...this.values); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
  async all() { return this.execute(); } async run() { return this.execute(); }
  async raw() { const statement = this.database.prepare(this.source); statement.setReturnArrays(true); return statement.all(...this.values); }
}
class D1 { constructor(database) { this.database = database; } prepare(source) { return new Statement(this.database, source); } async batch(statements) { this.database.exec("BEGIN IMMEDIATE"); try { const result = statements.map((statement) => statement.execute()); this.database.exec("COMMIT"); return result; } catch (error) { this.database.exec("ROLLBACK"); throw error; } } }
class R2 {
  constructor(key, bytes) { this.objects = new Map([[key, { bytes, customMetadata: {}, contentType: "audio/mpeg" }]]); }
  async head(key) { const object = this.objects.get(key); return object ? { size: object.bytes.byteLength, customMetadata: object.customMetadata, httpMetadata: { contentType: object.contentType } } : null; }
  async get(key) { const object = this.objects.get(key); return object ? { async arrayBuffer() { return object.bytes.buffer.slice(object.bytes.byteOffset, object.bytes.byteOffset + object.bytes.byteLength); } } : null; }
  async put(key, value, options = {}) { this.objects.set(key, { bytes: new Uint8Array(value), customMetadata: options.customMetadata || {}, contentType: options.httpMetadata?.contentType || "application/octet-stream" }); }
}

const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys=ON"); migrations.forEach((name) => apply(database, name));
const now = Date.now(); const key = "audio/legacy-house/legacy-session.mp3"; const bytes = new TextEncoder().encode("legacy private saved night");
const wrongKey = "audio/legacy-house/wrong-valid-checksum.mp3"; const wrongBytes = new TextEncoder().encode("same size cannot justify a stale checksum");
database.prepare("INSERT INTO users (id,email,subscription_status,credits_remaining,created_at,updated_at) VALUES ('legacy-user','legacy@example.test','active',1,?,?)").run(now, now);
database.prepare("INSERT INTO households (id,name,owner_user_id,created_at,updated_at) VALUES ('legacy-house','Legacy','legacy-user',?,?)").run(now, now);
database.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,created_at,updated_at) VALUES ('legacy-member','legacy-house','legacy-user','owner','active',?,?)").run(now, now);
database.prepare("INSERT INTO entitlements (id,household_id,plan_id,source,status,allowance_milliunits,remaining_milliunits,valid_from,created_at,updated_at) VALUES ('legacy-grant','legacy-house','nearyou_plus','manual','active',60000,60000,?,?,?)").run(now - 1000, now, now);
database.prepare("INSERT INTO sleep_sessions (id,user_id,household_id,title,script,script_mode,content_type,narration_kind,theme,style,background_sound,duration_minutes,status,audio_key,created_at,completed_at) VALUES ('legacy-session','legacy-user','legacy-house','Legacy night','safe','curated','story','demo_narrator','moonlit-meadow','gentle','none',5,'ready',?,?,?)").run(key, now, now);
database.prepare("INSERT INTO media_assets (id,household_id,owner_user_id,legacy_session_id,kind,status,storage_key,content_type,private,created_at,updated_at) VALUES ('legacy-media','legacy-house','legacy-user','legacy-session','narration','ready',?,'audio/mpeg',1,?,?)").run(key, now, now);
database.prepare("UPDATE sleep_sessions SET media_asset_id='legacy-media' WHERE id='legacy-session'").run();
database.prepare("INSERT INTO sleep_sessions (id,user_id,household_id,title,script,script_mode,content_type,narration_kind,theme,style,background_sound,duration_minutes,status,audio_key,created_at,completed_at) VALUES ('wrong-session','legacy-user','legacy-house','Wrong checksum night','safe','curated','story','demo_narrator','moonlit-meadow','gentle','none',5,'ready',?,?,?)").run(wrongKey, now, now);
database.prepare("INSERT INTO media_assets (id,household_id,owner_user_id,legacy_session_id,kind,status,storage_key,content_type,byte_size,checksum,private,created_at,updated_at) VALUES ('wrong-media','legacy-house','legacy-user','wrong-session','narration','ready',?,'audio/mpeg',?,?,1,?,?)").run(wrongKey, wrongBytes.byteLength, "0".repeat(64), now, now);
database.prepare("UPDATE sleep_sessions SET media_asset_id='wrong-media' WHERE id='wrong-session'").run();
apply(database, "0012_nearsleep_library_privacy.sql");
assert.deepEqual({ ...database.prepare("SELECT status,unresolved_ready_media AS unresolved FROM task2c_activation_state WHERE id='storage'").get() }, { status: "pending", unresolved: 2 });

const r2 = new R2(key, bytes); r2.objects.set(wrongKey, { bytes: wrongBytes, customMetadata: {}, contentType: "audio/mpeg" }); globalThis.__TASK2B_CLOUDFLARE_ENV__ = { DB: new D1(database), AUDIO: r2 };
Object.assign(process.env, { NEARYOU_ENABLE_FOUNDATION_API: "true", NEARYOU_ENABLE_PRODUCTION_UPGRADE_FOUNDATION: "true", NEARYOU_ENABLE_NEARSLEEP_PRODUCTION: "true", NEARYOU_ENABLE_USAGE_RESERVATIONS: "true", NEARYOU_REQUIRE_VERIFIED_VOICE_CONSENT: "true", NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY: "false", NEARYOU_ENABLE_NEARSLEEP_LIBRARY_RECONCILIATION: "true", NEARYOU_RECONCILIATION_SECRET: "S".repeat(43) });
const [continuation, library] = await Promise.all([import("../../app/api/internal/task2c-reconcile/route.ts"), import("../../app/api/v1/library/route.ts")]);
const response = await continuation.POST(new Request("https://example.test/api/internal/task2c-reconcile", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_RECONCILIATION_SECRET}` } }));
assert.equal(response.status, 200); assert.deepEqual((await response.json()).storageReconciliation, { processed: 1, unresolvedReadyMedia: 1, ready: false });
assert.equal(database.prepare("SELECT COUNT(*) AS value FROM task2c_media_integrity WHERE media_asset_id='wrong-media'").get().value, 0);
assert.deepEqual({ ...database.prepare("SELECT checksum,status FROM media_assets WHERE id='wrong-media'").get() }, { checksum: "0".repeat(64), status: "ready" });
assert.equal(database.prepare("SELECT status FROM task2c_activation_state WHERE id='storage'").get().status, "pending");
process.env.NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY = "true";
assert.equal((await library.GET(new Request("https://example.test/api/v1/library"))).status, 503);
process.env.NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY = "false";
database.prepare("UPDATE media_assets SET status='deleted', deleted_at=?, updated_at=? WHERE id='wrong-media'").run(now + 1, now + 1);
const readyResponse = await continuation.POST(new Request("https://example.test/api/internal/task2c-reconcile", { method: "POST", headers: { authorization: `Bearer ${process.env.NEARYOU_RECONCILIATION_SECRET}` } }));
assert.equal(readyResponse.status, 200); assert.deepEqual((await readyResponse.json()).storageReconciliation, { processed: 0, unresolvedReadyMedia: 0, ready: true });
assert.ok(database.prepare("SELECT scheduler_heartbeat_at AS heartbeat,scheduler_run_id AS runId FROM task2c_activation_state WHERE id='storage'").get().heartbeat > now);
assert.equal((await library.GET(new Request("https://example.test/api/v1/library"))).status, 404);
process.env.NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY = "true";
assert.notEqual((await library.GET(new Request("https://example.test/api/v1/library"))).status, 503);
database.prepare("UPDATE task2c_activation_state SET scheduler_heartbeat_at=? WHERE id='storage'").run(Date.now() - 16 * 60_000);
assert.equal((await library.GET(new Request("https://example.test/api/v1/library"))).status, 503);
assert.deepEqual({ ...database.prepare("SELECT byte_size AS byteSize,checksum FROM media_assets WHERE id='legacy-media'").get() }, { byteSize: bytes.byteLength, checksum: r2.objects.get(key).customMetadata.checksum });
assert.equal(database.prepare("SELECT status FROM household_storage_reservations WHERE media_asset_id='legacy-media'").get().status, "committed");
assert.deepEqual({ ...database.prepare("SELECT byte_size AS byteSize,checksum FROM task2c_media_integrity WHERE media_asset_id='legacy-media'").get() }, { byteSize: bytes.byteLength, checksum: r2.objects.get(key).customMetadata.checksum });
assert.throws(() => database.prepare("UPDATE media_assets SET byte_size=byte_size+1 WHERE id='legacy-media'").run(), /ready_media_binding_immutable/);
assert.throws(() => database.prepare("UPDATE media_assets SET checksum=? WHERE id='legacy-media'").run("f".repeat(64)), /ready_media_binding_immutable/);
