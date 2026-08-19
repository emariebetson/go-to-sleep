import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLocalGenerationZeroCanaryStore,
  finalizePrivateTesterCanaryWindow,
  recordPrivateTesterCanarySample,
} from "../scripts/canary-evidence-cli.ts";

const interval = 15 * 60_000;
const startedAt = 1_800_000_000_000;
const identity = Object.freeze({ releaseId: "rel_20260819_window_01", buildId: "build_20260819_window_01", deploymentId: "deploy_20260819_window_01", startedAt });
const rollback = Object.freeze({ version: 1, passed: true, releaseId: identity.releaseId, gatesRemainOff: true, resultHash: "a".repeat(64) });
const signReceipt = async () => ({ keyId: "local-test-key", signature: "b".repeat(64) });

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
    const first = await finalizePrivateTesterCanaryWindow(identity, { store, rollbackRecheck: async () => rollback, signReceipt, requestKill: async () => { throw new Error("kill should not be requested"); } });
    const second = await finalizePrivateTesterCanaryWindow(identity, { store, rollbackRecheck: async () => rollback, signReceipt, requestKill: async () => { throw new Error("kill should not be requested"); } });

    assert.equal(first.passed, true);
    assert.equal(first.sampleCount, 96);
    assert.equal(resumed.resumed, true);
    assert.equal(first.coveredUntil, startedAt + 96 * interval);
    assert.deepEqual(first.signature, { keyId: "local-test-key", signature: "b".repeat(64) });
    assert.match(first.receiptSha256, /^[a-f0-9]{64}$/);
    assert.equal(first.receiptSha256, second.receiptSha256);
  });
});

test("rejects missing, late, duplicate, or changed release/build/deployment sample identities", async () => {
  await withStore(async (store) => {
    await completeWindow(store);
    await assert.rejects(() => finalizePrivateTesterCanaryWindow(identity, { store: { ...store, list: async (key) => (await store.list(key)).filter((sample) => sample.slot !== 41) }, rollbackRecheck: async () => rollback, signReceipt, requestKill: async () => {} }), /private tester canary failed: discontinuity/);
    await assert.rejects(() => recordPrivateTesterCanarySample(identity, proof(0, { observedAt: startedAt + 2_000 }), { store, currentBinding: async () => identity, requestKill: async () => {} }), /private tester canary failed: duplicate/);
    await withStore(async (lateStore) => {
      await assert.rejects(() => recordPrivateTesterCanarySample(identity, proof(95, { observedAt: startedAt + 96 * interval + 1 }), { store: lateStore, currentBinding: async () => identity, requestKill: async () => {} }), /private tester canary failed: late/);
    });
    await withStore(async (bindingStore) => {
      await assert.rejects(() => recordPrivateTesterCanarySample(identity, proof(0, { deploymentId: "deploy_20260819_changed_01" }), { store: bindingStore, currentBinding: async () => identity, requestKill: async () => {} }), /private tester canary failed: binding/);
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
    await assert.rejects(() => finalizePrivateTesterCanaryWindow(identity, { store, rollbackRecheck: async () => ({ ...rollback, passed: false }), signReceipt, requestKill: async (reason) => { requests.push(reason); } }), /private tester canary failed: rollback/);
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
