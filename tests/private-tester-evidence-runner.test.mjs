import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGoogleStorageGenerationZeroStore, runPrivateTesterEvidence } from "../scripts/run-private-tester-evidence.ts";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const now = Date.parse("2026-08-19T12:00:00.000Z");
const projectId = "appgprj_6a79f8a66eb4819198bb42a2b26addea";
const releaseId = "rel_20260819_private_01";
const deploymentId = "appgdep_12345678";
const buildId = "11111111-1111-4111-8111-111111111111";
const catalogHash = "c".repeat(64);
const schemaDigest = "d".repeat(64);
const migrationDigest = "e".repeat(64);
const versionId = `${projectId}~appgver_live`;

function artifactSet(overrides = {}) {
  const manifest = { claims: { schemaVersion: 3, releaseId, projectId, live: { version: versionId, commitSha: "a".repeat(40) }, rollback: { version: `${projectId}~appgver_rollback`, commitSha: "b".repeat(40) }, resources: [{ provider: "sites-managed", binding: "AUDIO", kind: "r2", physicalId: "unknown-managed", archiveSha256: "f".repeat(64), deploymentId, buildId }, { provider: "sites-managed", binding: "DB", kind: "d1", physicalId: "unknown-managed", buildId, schemaDigest, schemaObjectCount: 501, migrationDigest, migrationCount: 27 }] }, signature: "signature" };
  const review = { version: 1, reviewRequired: true, capturedAt: now, release: { releaseId }, sites: { deployment: { deploymentId, versionId }, buildReceipt: { buildId }, resources: manifest.claims.resources }, d1: { schemaHash: schemaDigest, appliedLedgerHash: migrationDigest }, postgres: { catalogHash }, gates: { nearfamily: false, nearstory: false, scheduler: false } };
  const reviewRaw = `${JSON.stringify(review)}\n`;
  const provider = { version: 1, provider: "sites-worker-logs", candidateSha256: sha(reviewRaw), scriptName: "site---6a79f8a66eb4819198bb42a2b26addea", scriptVersionId: "22222222-2222-4222-8222-222222222222", capturedAt: now, observations: [] };
  const promoted = { ...review, reviewRequired: false, sites: { ...review.sites, logReceiptSha256: sha(`${JSON.stringify(provider)}\n`) } };
  return {
    signedManifest: `${JSON.stringify(manifest)}\n`,
    reviewBaseline: reviewRaw,
    providerLogReceipt: `${JSON.stringify(provider)}\n`,
    promotedBaseline: `${JSON.stringify(promoted)}\n`,
    ...overrides,
  };
}

function memoryStore(options = {}) {
  const values = new Map(), writes = [];
  let loseNext = options.loseNext ?? false;
  return {
    writes,
    values,
    async get(key) { return values.get(key) ?? null; },
    async putIfAbsent(key, raw) {
      writes.push({ key, raw, ifGenerationMatch: 0 });
      if (!values.has(key)) values.set(key, raw);
      if (loseNext) { loseNext = false; throw new Error("response lost after commit"); }
      return values.get(key) === raw ? "created" : "exists";
    },
  };
}

function input(artifacts = artifactSet()) {
  return { operationId: "pt-evidence-20260819-0001", startedAt: now, artifactPrefix: "private-tester-evidence", artifacts };
}

test("first run publishes a complete, review-required immutable evidence set", async () => {
  const store = memoryStore();
  const result = await runPrivateTesterEvidence(input(), { store, now: () => now });

  assert.equal(result.releaseId, releaseId);
  assert.equal(result.deploymentId, deploymentId);
  assert.equal(result.buildId, buildId);
  assert.equal(result.artifacts.length, 5);
  assert.ok(result.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
  assert.ok(store.writes.every((write) => write.ifGenerationMatch === 0));
  assert.deepEqual(store.writes.map((write) => write.key), [
    "private-tester-evidence/pt-evidence-20260819-0001/signed-manifest.json",
    "private-tester-evidence/pt-evidence-20260819-0001/review-baseline.json",
    "private-tester-evidence/pt-evidence-20260819-0001/provider-log-receipt.json",
    "private-tester-evidence/pt-evidence-20260819-0001/promoted-baseline.json",
    "private-tester-evidence/pt-evidence-20260819-0001/evidence-index.json",
  ]);
});

test("a lost write response converges by reading and hashing the committed bytes", async () => {
  const store = memoryStore({ loseNext: true });
  const first = await runPrivateTesterEvidence(input(), { store, now: () => now });
  const second = await runPrivateTesterEvidence(input(), { store, now: () => now });

  assert.deepEqual(second, first);
  assert.equal(store.values.size, 5);
});

test("an immutable operation ID and start time make retries byte-identical", async () => {
  const store = memoryStore();
  const first = await runPrivateTesterEvidence(input(), { store, now: () => now });
  const second = await runPrivateTesterEvidence(input(), { store, now: () => now + 60_000 });

  assert.deepEqual(second, first);
  await assert.rejects(() => runPrivateTesterEvidence({ ...input(), startedAt: now + 1 }, { store, now: () => now }), /immutable/);
});

test("concurrent runners converge only when every conflicting raw SHA matches", async () => {
  const store = memoryStore();
  const [left, right] = await Promise.all([
    runPrivateTesterEvidence(input(), { store, now: () => now }),
    runPrivateTesterEvidence(input(), { store, now: () => now }),
  ]);

  assert.deepEqual(left, right);
  await assert.rejects(() => runPrivateTesterEvidence(input(artifactSet({ promotedBaseline: `${JSON.stringify({ bad: true })}\n` })), { store, now: () => now }), /artifact invalid|conflict/);
});

test("stale observations and partial artifact sets fail closed without publishing an index", async () => {
  const stale = artifactSet();
  stale.reviewBaseline = stale.reviewBaseline.replace(`"capturedAt":${now}`, `"capturedAt":${now - 300_001}`);
  const staleStore = memoryStore();
  await assert.rejects(() => runPrivateTesterEvidence(input(stale), { store: staleStore, now: () => now }), /stale|artifact invalid/);
  assert.equal(staleStore.values.size, 0);

  const partialStore = memoryStore();
  const seed = input();
  partialStore.values.set("private-tester-evidence/pt-evidence-20260819-0001/signed-manifest.json", seed.artifacts.signedManifest);
  partialStore.values.set("private-tester-evidence/pt-evidence-20260819-0001/review-baseline.json", seed.artifacts.reviewBaseline);
  const completed = await runPrivateTesterEvidence(seed, { store: partialStore, now: () => now });
  assert.equal(completed.artifacts.length, 5);
  assert.equal(partialStore.values.size, 5);
});

test("the object-store adapter uses generation zero and fetches raw bytes on a collision", async () => {
  const requests = [];
  const store = createGoogleStorageGenerationZeroStore({
    bucket: "private-tester-evidence-prod",
    accessToken: async () => "token_abcdefghijklmnopqrstuvwxyz",
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (init.method === "POST") return new Response(JSON.stringify({ error: { code: 412 } }), { status: 412 });
      return new Response("exact stored bytes\n", { status: 200 });
    },
  });

  assert.equal(await store.putIfAbsent("private-tester-evidence/op/file.json", "new bytes\n"), "exists");
  assert.equal(await store.get("private-tester-evidence/op/file.json"), "exact stored bytes\n");
  assert.match(requests[0].url, /upload\/storage\/v1\/b\/private-tester-evidence-prod\/o\?uploadType=media&ifGenerationMatch=0&name=/);
  assert.equal(requests[0].init.headers.authorization, "Bearer token_abcdefghijklmnopqrstuvwxyz");
  assert.equal(requests[1].init.method, "GET");
  assert.match(requests[1].url, /alt=media/);
});
