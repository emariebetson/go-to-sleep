import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDurableGenerationPostHandler, GenerationResultInvalidatedError } from "../lib/nearsleep-live-route.ts";

test("lost audio response plus consent revocation reaches durable failure without invoking the provider twice", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE generation_operations (id TEXT PRIMARY KEY, household_id TEXT NOT NULL, user_id TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error_code TEXT);
    CREATE TABLE saved_sessions (id TEXT PRIMARY KEY, household_id TEXT NOT NULL, status TEXT NOT NULL, audio_key TEXT);
    CREATE TABLE consent_leases (id TEXT PRIMARY KEY, household_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE allowance_reservations (id TEXT PRIMARY KEY, household_id TEXT NOT NULL, status TEXT NOT NULL);
  `);
  const objects = new Map();
  const fakeR2 = {
    async put(key, value, metadata) { objects.set(key, { value, metadata }); },
    async get(key) { return objects.get(key) || null; },
    async delete(key) { objects.delete(key); },
  };
  const requestId = "11111111-1111-4111-8111-111111111111";
  const householdId = "household_recovery";
  const userId = "adult_recovery";
  const operationId = `generation:${encodeURIComponent(householdId)}:audio:${requestId}`;
  const audioKey = `audio/${householdId}/session_recovery.mp3`;
  let providerCalls = 0;
  let failFirstStage = true;

  const handler = createDurableGenerationPostHandler({
    operation: "audio",
    enabled: () => true,
    authenticate: async () => ({ householdId, userId }),
    requireAdultGate: async () => undefined,
    parse: async () => ({ requestId, requestFingerprint: "fingerprint_recovery" }),
    identify: (input) => input,
    claim: async (input) => {
      const existing = database.prepare("SELECT * FROM generation_operations WHERE id = ?").get(input.operationId);
      if (!existing) {
        database.prepare("INSERT INTO generation_operations (id, household_id, user_id, request_hash, status) VALUES (?, ?, ?, ?, 'processing')")
          .run(input.operationId, input.householdId, input.userId, input.requestFingerprint);
        return { kind: "claimed" };
      }
      if (existing.household_id !== input.householdId || existing.user_id !== input.userId || existing.request_hash !== input.requestFingerprint) return { kind: "conflict" };
      if (existing.status === "failed") return { kind: "failed", error: { status: 409, error: "Consent invalidated.", code: existing.error_code } };
      if (existing.result) return { kind: "replay", result: JSON.parse(existing.result) };
      return { kind: "processing" };
    },
    execute: async () => {
      providerCalls += 1;
      database.exec(`
        INSERT INTO saved_sessions VALUES ('session_recovery', '${householdId}', 'generating', '${audioKey}');
        INSERT INTO consent_leases VALUES ('lease_recovery', '${householdId}', 'active');
        INSERT INTO allowance_reservations VALUES ('allowance_recovery', '${householdId}', 'reserved');
      `);
      const result = { generationMode: "save", sessionId: "session_recovery", audioUrl: "/api/audio/session_recovery" };
      await fakeR2.put(audioKey, new Uint8Array([1, 2, 3]), { operationId, householdId, result });
      return result;
    },
    recover: async () => {
      const object = await fakeR2.get(audioKey);
      if (!object) return null;
      const lease = database.prepare("SELECT status FROM consent_leases WHERE id = 'lease_recovery'").get();
      if (lease.status !== "active") {
        await fakeR2.delete(audioKey);
        database.exec(`
          UPDATE saved_sessions SET status = 'failed', audio_key = NULL WHERE id = 'session_recovery';
          UPDATE allowance_reservations SET status = 'released' WHERE id = 'allowance_recovery';
        `);
        throw new GenerationResultInvalidatedError({ status: 409, error: "Voice consent changed before recovery.", code: "generation_consent_invalidated" });
      }
      return object.metadata.result;
    },
    stageResult: async ({ operationId: id, result }) => {
      if (failFirstStage) { failFirstStage = false; throw new Error("simulated_lost_result_write"); }
      database.prepare("UPDATE generation_operations SET result = ? WHERE id = ? AND status = 'processing'").run(JSON.stringify(result), id);
    },
    succeed: async ({ operationId: id }) => { database.prepare("UPDATE generation_operations SET status = 'succeeded' WHERE id = ? AND result IS NOT NULL").run(id); },
    fail: async ({ operationId: id, error }) => { database.prepare("UPDATE generation_operations SET status = 'failed', error_code = ? WHERE id = ? AND status = 'processing' AND result IS NULL").run(error.code || "generation_failed", id); },
  });

  const first = await handler(new Request("https://example.test/api/sessions", { method: "POST" }));
  assert.equal(first.status, 503);
  assert.equal((await first.json()).code, "generation_result_reconciliation");
  assert.equal(providerCalls, 1);
  assert.ok(await fakeR2.get(audioKey));

  database.exec("UPDATE consent_leases SET status = 'revoked' WHERE id = 'lease_recovery'; UPDATE allowance_reservations SET status = 'released' WHERE id = 'allowance_recovery';");
  const retry = await handler(new Request("https://example.test/api/sessions", { method: "POST" }));
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).code, "generation_consent_invalidated");
  assert.equal(providerCalls, 1);
  assert.equal(await fakeR2.get(audioKey), null);
  assert.equal(database.prepare("SELECT status FROM saved_sessions WHERE id = 'session_recovery'").get().status, "failed");
  assert.equal(database.prepare("SELECT status FROM allowance_reservations WHERE id = 'allowance_recovery'").get().status, "released");
  assert.deepEqual({ ...database.prepare("SELECT status, error_code FROM generation_operations WHERE id = ?").get(operationId) }, { status: "failed", error_code: "generation_consent_invalidated" });
});
