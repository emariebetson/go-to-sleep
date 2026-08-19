import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { createSyntheticPrivateTesterFixture, syntheticPrivateTesterHouseholdHash } from "../scripts/private-canary-smoke.ts";
import {
  createTrustedCanaryReceiptVerifier,
  createLocalGenerationZeroCanaryStore,
  finalizePrivateTesterCanaryWindow,
  privateTesterCanaryWindowKey,
  recordPrivateTesterCanarySample,
} from "../scripts/canary-evidence-cli.ts";

const interval = 15 * 60_000;
const startedAt = 1_800_000_000_000;
const identity = Object.freeze({ releaseId: "rel_20260819_window_01", buildId: "build_20260819_window_01", deploymentId: "deploy_20260819_window_01", startedAt });
let rollback;
let signReceipt, verifier;
function stable(value) { return Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value; }
before(async () => {
  const fixture = await createSyntheticPrivateTesterFixture({ releaseId: identity.releaseId, invitedHouseholdHash: syntheticPrivateTesterHouseholdHash(identity.releaseId, "invited"), deniedHouseholdHash: syntheticPrivateTesterHouseholdHash(identity.releaseId, "denied"), priorSitesVersion: "sites_20260818_01", fixtureNamespace: "task6-private-tester", fixtureMarker: `synthetic:${identity.releaseId}` });
  const observations = { before: {}, transitions: {}, after: {} };
  rollback = Object.freeze({ version: 1, passed: true, releaseId: identity.releaseId, gatesRemainOff: true, fixture, observations, resultHash: createHash("sha256").update(JSON.stringify(stable({ fixture, observations }))).digest("hex") });
  const pair = await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  verifier = createTrustedCanaryReceiptVerifier({ keyId: "local-test-key", keyVersion: 1, key: pair.publicKey });
  signReceipt = async (body) => ({ algorithm: "RSA-PSS-SHA256", keyId: "local-test-key", keyVersion: 1, value: Buffer.from(await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, pair.privateKey, new TextEncoder().encode(body))).toString("base64url") });
});

function proof(slot, overrides = {}) {
  return {
    releaseId: identity.releaseId,
    buildId: identity.buildId,
    deploymentId: identity.deploymentId,
    scheduledAt: startedAt + slot * interval,
    observedAt: startedAt + slot * interval + 1_000,
    nearStoryInvited: true,
    nearStoryDenied: false,
    nearFamilyInvited: true,
    nearFamilyDenied: false,
    dataIntegrity: true,
    deadLetters: 0,
    workerFailures: 0,
    errorRateBps: 0,
    heartbeatAt: startedAt + slot * interval,
    ...overrides,
  };
}

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), "private-tester-canary-"));
  try { await run(createLocalGenerationZeroCanaryStore(directory)); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function completeWindow(store, overrides = {}) {
  for (let slot = 0; slot < 96; slot++) await recordPrivateTesterCanarySample(identity, proof(slot, overrides[slot]), { store, currentBinding: async () => identity, requestKill: async () => { throw new Error("kill should not be requested"); } });
}

test("records an exact resumable 96-sample local window and emits a deterministic final receipt after the Task 6 rollback recheck", async () => {
  await withStore(async (store) => {
    await completeWindow(store);
    const resumed = await recordPrivateTesterCanarySample(identity, proof(0), { store, currentBinding: async () => identity, requestKill: async () => { throw new Error("kill should not be requested"); } });
    const first = await finalizePrivateTesterCanaryWindow(identity, { store, rollbackRecheck: async () => rollback, signReceipt, verifier, requestKill: async () => { throw new Error("kill should not be requested"); } });
    const second = await finalizePrivateTesterCanaryWindow(identity, { store, rollbackRecheck: async () => rollback, signReceipt, verifier, requestKill: async () => { throw new Error("kill should not be requested"); } });

    assert.equal(first.passed, true);
    assert.equal(first.sampleCount, 96);
    assert.equal(resumed.resumed, true);
    assert.equal(first.coveredUntil, startedAt + 96 * interval);
    assert.equal(first.signature.algorithm, "RSA-PSS-SHA256");
    assert.match(first.receiptSha256, /^[a-f0-9]{64}$/);
    assert.equal(first.receiptSha256, second.receiptSha256);
  });
});

test("rejects missing, late, duplicate, or changed release/build/deployment sample identities", async () => {
  await withStore(async (store) => {
    await completeWindow(store);
    await assert.rejects(() => finalizePrivateTesterCanaryWindow(identity, { store: { ...store, list: async (key) => (await store.list(key)).filter((sample) => sample.slot !== 41) }, rollbackRecheck: async () => rollback, signReceipt, verifier, requestKill: async () => {} }), /private tester canary failed: discontinuity/);
    await assert.rejects(() => recordPrivateTesterCanarySample(identity, proof(0, { observedAt: startedAt + 2_000 }), { store, currentBinding: async () => identity, requestKill: async () => {} }), /private tester canary failed: duplicate/);
    await withStore(async (lateStore) => {
      await assert.rejects(() => recordPrivateTesterCanarySample(identity, proof(95, { observedAt: startedAt + 96 * interval + 1 }), { store: lateStore, currentBinding: async () => identity, requestKill: async () => {} }), /private tester canary failed: late/);
    });
    await withStore(async (bindingStore) => {
      await assert.rejects(() => recordPrivateTesterCanarySample(identity, proof(0, { deploymentId: "deploy_20260819_changed_01" }), { store: bindingStore, currentBinding: async () => identity, requestKill: async () => {} }), /private tester canary failed: proof/);
      await assert.rejects(() => recordPrivateTesterCanarySample(identity, proof(0), { store: bindingStore, currentBinding: async () => ({ ...identity, buildId: "build_20260819_changed_01" }), requestKill: async () => {} }), /private tester canary failed: binding/);
      await assert.rejects(() => recordPrivateTesterCanarySample(identity, proof(0), { store: bindingStore, currentBinding: async () => ({ ...identity, releaseId: "rel_20260819_changed_01" }), requestKill: async () => {} }), /private tester canary failed: binding/);
    });
  });
});

test("fails closed and requests a test-provided kill action for authorization leaks, integrity failures, worker failures, error spikes, DLQ, or stale heartbeat", async () => {
  for (const override of [
    { nearFamilyDenied: true },
    { dataIntegrity: false },
    { workerFailures: 1 },
    { errorRateBps: 101 },
    { deadLetters: 1 },
    { heartbeatAt: startedAt - 300_001 },
  ]) {
    await withStore(async (store) => {
      const requests = [];
      await assert.rejects(() => recordPrivateTesterCanarySample(identity, proof(0, override), { store, currentBinding: async () => identity, requestKill: async (reason) => { requests.push(reason); } }), /private tester canary failed/);
      assert.equal(requests.length, 1);
    });
  }
});

test("fails closed and requests a test-provided kill action when final rollback proof fails", async () => {
  await withStore(async (store) => {
    await completeWindow(store);
    const requests = [];
    await assert.rejects(() => finalizePrivateTesterCanaryWindow(identity, { store, rollbackRecheck: async () => ({ ...rollback, passed: false }), signReceipt, verifier, requestKill: async (reason) => { requests.push(reason); } }), /private tester canary failed: rollback/);
    assert.deepEqual(requests, ["rollback"]);
  });
});

test("fails closed and requests a test-provided kill action when generation-zero storage cannot preserve evidence", async () => {
  await withStore(async (store) => {
    const requests = [];
    await assert.rejects(() => recordPrivateTesterCanarySample(identity, proof(0), { store: { ...store, insert: async () => { throw new Error("disk failure"); } }, currentBinding: async () => identity, requestKill: async (reason) => { requests.push(reason); } }), /private tester canary failed: storage/);
    assert.deepEqual(requests, ["storage"]);
  });
});

test("uses the exact release/build/deployment resume key and rejects unknown or non-boolean proof fields", async () => {
  assert.equal(privateTesterCanaryWindowKey(identity), privateTesterCanaryWindowKey({ ...identity, startedAt: startedAt + interval }));
  await withStore(async (store) => {
    for (const malformed of [{ ...proof(0), extra: true }, proof(0, { nearStoryInvited: 1 })]) {
      await assert.rejects(() => recordPrivateTesterCanarySample(identity, malformed, { store, currentBinding: async () => identity, requestKill: async () => {} }), /private tester canary failed: proof/);
    }
  });
});

test("rejects actual observation gaps over fifteen minutes and reuses a verified existing receipt before signing again", async () => {
  await withStore(async (store) => {
    await completeWindow(store);
    const signed = [];
    const first = await finalizePrivateTesterCanaryWindow(identity, { store, rollbackRecheck: async () => rollback, verifier, signReceipt: async (body) => { signed.push(body); return signReceipt(body); }, requestKill: async () => {} });
    const second = await finalizePrivateTesterCanaryWindow(identity, { store, rollbackRecheck: async () => rollback, verifier, signReceipt: async (body) => { signed.push(body); return signReceipt(body); }, requestKill: async () => {} });
    assert.equal(first.receiptSha256, second.receiptSha256);
    assert.equal(signed.length, 1);
  });
  await withStore(async (store) => {
    await completeWindow(store, { 1: { observedAt: startedAt + 2 * interval, heartbeatAt: startedAt + 2 * interval } });
    await assert.rejects(() => finalizePrivateTesterCanaryWindow(identity, { store, rollbackRecheck: async () => rollback, signReceipt, verifier, requestKill: async () => {} }), /private tester canary failed: discontinuity/);
  });
});

test("rejects a Task 6 rollback proof whose deterministic result hash or fixture binding is forged", async () => {
  for (const forged of [{ ...rollback, resultHash: "f".repeat(64) }, { ...rollback, fixture: { ...rollback.fixture, jobId: "forged" } }]) {
    await withStore(async (store) => {
      await completeWindow(store);
      await assert.rejects(() => finalizePrivateTesterCanaryWindow(identity, { store, rollbackRecheck: async () => forged, signReceipt, verifier, requestKill: async () => {} }), /private tester canary failed: rollback/);
    });
  }
});
