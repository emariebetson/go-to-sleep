import assert from "node:assert/strict";
import test from "node:test";
import { runBackfill, finalizeCutover, resumeCutover } from "../lib/postgres-cutover-orchestrator.ts";

const row = (sequence) => ({ tenant: "h1", table: "children", id: String(sequence), sequence, payload: { sequence }, deleted: false });

function fixture() {
  const state = { mode: "d1", snapshot: { highWater: 3, cursor: null }, checkpoint: null, lease: { owner: "runner", fence: 7, expiresAt: Date.now() + 60_000 }, frozen: false, transitioned: false, freezeCommitted: false, freeze: null, delta: null, transition: null };
  return {
    state,
    source: {
      async acquireSnapshot() { return { ...state.snapshot }; },
      async page({ highWater, cursor }) { const start = cursor ?? 0; const rows = start >= highWater ? [] : [row(start + 1)]; return { highWater, cursor, rows, nextCursor: rows.length ? rows[0].sequence : null }; },
      async freeze({ expectedHighWater, operationId }) { assert.equal(expectedHighWater, 3); assert.match(operationId, /^freeze:/); state.frozen = true; state.freeze ??= { operationId, token: "freeze-1", highWater: 4 }; return { ...state.freeze }; },
      async loadFreeze(operationId) { return state.freeze?.operationId === operationId ? { ...state.freeze } : null; },
      async unfreeze(token) { assert.equal(token, state.freeze.token); state.frozen = false; },
      async commitFreeze(token) { assert.equal(token, state.freeze.token); state.freezeCommitted = true; },
    },
    target: {
      async now() { return Date.now(); },
      async acquireLease() { return { ...state.lease }; },
      async renewLease(lease) { assert.equal(lease.fence, 7); state.lease.expiresAt = Date.now() + 60_000; return { ...state.lease }; },
      async initializeSnapshot({ snapshot, lease }) { state.checkpoint ??= { highWater: snapshot.highWater, cursor: null, fence: lease.fence }; return { ...state.checkpoint }; },
      async loadCheckpoint() { return state.checkpoint && { ...state.checkpoint }; },
      async transaction(fn) { await fn({ assertLease: async () => {}, stage: async () => {}, tombstone: async () => {}, checkpoint: async ({ cursor }) => { state.checkpoint.cursor = cursor; } }); },
      async applyFinalDelta({ operationId, freezeToken, fromHighWater, toHighWater }) { assert.match(operationId, /^delta:/); assert.equal(freezeToken, "freeze-1"); assert.equal(fromHighWater, 3); assert.equal(toHighWater, 4); state.delta ??= { operationId, freezeToken, fromHighWater, highWater: 4 }; return { ...state.delta }; },
      async loadFinalDelta(operationId) { return state.delta?.operationId === operationId ? { ...state.delta } : null; },
      async shadow({ heartbeat }) { await heartbeat(); return { sourceChecksum: "a".repeat(64), targetChecksum: "a".repeat(64), sampleCount: 3, mismatchCount: 0, startedAt: Date.now() - 70_000, endedAt: Date.now() - 1000 }; },
      async verifyEvidence() { return { digest: "b".repeat(64), nonce: "abcdefghijklmnopqrstuv", releaseId: "release-1" }; },
      async transitionAtomically(input) { assert.equal(input.freezeToken, state.freeze.token); assert.equal(input.evidenceDigest, "b".repeat(64)); state.mode = "postgres"; state.transitioned = true; state.transition = { operationId: input.operationId, freezeToken: input.freezeToken, highWater: input.highWater, fence: input.fence, evidenceDigest: input.evidenceDigest }; return { ...state.transition }; },
      async mode() { return state.mode; },
      async loadTransition() { return state.transition && { ...state.transition }; },
    },
  };
}

test("backfill acquires one immutable snapshot and resumes from a durable cursor", async () => {
  const f = fixture();
  const first = await runBackfill(f, { owner: "runner", maximumPages: 2, pageSize: 1, now: Date.now() });
  assert.deepEqual(first, { complete: false, highWater: 3, cursor: 2, pages: 2 });
  const second = await runBackfill(f, { owner: "runner", maximumPages: 2, pageSize: 1, now: Date.now() });
  assert.deepEqual(second, { complete: true, highWater: 3, cursor: 3, pages: 2 });
});

test("finalize keeps D1 frozen once postgres routing commits even if freeze acknowledgement is lost", async () => {
  const f = fixture(); f.state.checkpoint = { highWater: 3, cursor: 3, fence: 7 };
  let lose = true;
  const original = f.source.commitFreeze;
  f.source.commitFreeze = async (token) => { await original(token); if (lose) { lose = false; throw new Error("lost response"); } };
  await assert.rejects(() => finalizeCutover(f, { owner: "runner", now: Date.now() }), /lost response/);
  assert.equal(f.state.mode, "postgres");
  assert.equal(f.state.frozen, true);
  await resumeCutover(f, { owner: "runner", now: Date.now() });
  assert.equal(f.state.freezeCommitted, true);
  assert.equal(f.state.frozen, true);
});

test("finalize unfreezes D1 only when transition has not committed", async () => {
  const f = fixture(); f.state.checkpoint = { highWater: 3, cursor: 3, fence: 7 };
  f.target.verifyEvidence = async () => null;
  await assert.rejects(() => finalizeCutover(f, { owner: "runner", now: Date.now() }), /evidence/);
  assert.equal(f.state.mode, "d1"); assert.equal(f.state.frozen, false);
});

test("backfill rejects changed snapshot identity and lease-fence renewal", async () => {
  const changedSnapshot = fixture(); changedSnapshot.source.page = async () => ({ highWater: 4, cursor: null, rows: [row(1)], nextCursor: 1 });
  await assert.rejects(() => runBackfill(changedSnapshot, { owner: "runner", maximumPages: 1, pageSize: 1, now: Date.now() }), /checkpoint|immutable/);
  const changedFence = fixture(); changedFence.target.renewLease = async () => ({ owner: "runner", fence: 8, expiresAt: Date.now() + 60_000 });
  await assert.rejects(() => runBackfill(changedFence, { owner: "runner", maximumPages: 1, pageSize: 1, now: Date.now() }), /lease/);
  await assert.rejects(() => runBackfill(fixture(), { owner: "runner", maximumPages: 0, pageSize: 1, now: Date.now() }), /input/);
});

test("finalize requires shadow evidence bound after the final delta", async () => {
  const f = fixture(); f.state.checkpoint = { highWater: 3, cursor: 3, fence: 7 };
  f.target.shadow = async ({ highWater }) => ({ sourceChecksum: "a".repeat(64), targetChecksum: "a".repeat(64), sampleCount: highWater, mismatchCount: 0, startedAt: Date.now() - 70_000, endedAt: Date.now() - 1000 });
  f.target.verifyEvidence = async (input) => { assert.equal(input.finalHighWater, 4); return { digest: "b".repeat(64), nonce: "abcdefghijklmnopqrstuv", releaseId: "release-1" }; };
  const result = await finalizeCutover(f, { owner: "runner", now: Date.now() });
  assert.equal(result.highWater, 4);
});

test("an empty nonterminal snapshot page is rejected instead of falsely completing", async () => {
  const f = fixture();
  f.source.page = async ({ highWater, cursor }) => ({ highWater, cursor, rows: [], nextCursor: null });
  await assert.rejects(() => runBackfill(f, { owner: "runner", maximumPages: 1, pageSize: 1, now: Date.now() }), /terminal/);
});

test("unfreeze cleanup failure preserves the primary cutover error", async () => {
  const f = fixture(); f.state.checkpoint = { highWater: 3, cursor: 3, fence: 7 };
  f.target.verifyEvidence = async () => null;
  f.source.unfreeze = async () => { throw new Error("cleanup-private"); };
  await assert.rejects(() => finalizeCutover(f, { owner: "runner", now: Date.now() }), (error) => error.message.includes("release evidence") && !error.message.includes("cleanup-private"));
});

test("lost freeze and final-delta responses recover by durable operation identity", async () => {
  const f = fixture(); f.state.checkpoint = { highWater: 3, cursor: 3, fence: 7 };
  const freeze = f.source.freeze; let loseFreeze = true;
  f.source.freeze = async (input) => { const result = await freeze(input); if (loseFreeze) { loseFreeze = false; throw new Error("lost freeze"); } return result; };
  assert.equal((await finalizeCutover(f, { owner: "runner", now: Date.now() })).mode, "postgres");
  assert.equal(f.state.frozen, true);
  f.state.mode = "d1"; f.state.transition = null; f.state.transitioned = false; f.state.freezeCommitted = false;
  f.source.freeze = freeze;
  const delta = f.target.applyFinalDelta; let loseDelta = true;
  f.target.applyFinalDelta = async (input) => { const result = await delta(input); if (loseDelta) { loseDelta = false; throw new Error("lost delta"); } return result; };
  const result = await finalizeCutover(f, { owner: "runner", now: Date.now() });
  assert.equal(result.mode, "postgres");
});

test("lost transition never unfreezes from a stale mode read and resumes from manifest", async () => {
  const f = fixture(); f.state.checkpoint = { highWater: 3, cursor: 3, fence: 7 };
  const transition = f.target.transitionAtomically;
  f.target.transitionAtomically = async (input) => { await transition(input); throw new Error("lost transition"); };
  f.target.mode = async () => "d1";
  await assert.rejects(() => finalizeCutover(f, { owner: "runner", now: Date.now() }), /lost transition/);
  assert.equal(f.state.frozen, true);
  await resumeCutover(f, { owner: "runner", now: Date.now() });
  assert.equal(f.state.freezeCommitted, true);
});

test("snapshot initialization exact-binds the acquired immutable high-water", async () => {
  const f = fixture(); f.target.initializeSnapshot = async ({ lease }) => (f.state.checkpoint = { highWater: 4, cursor: null, fence: lease.fence });
  await assert.rejects(() => runBackfill(f, { owner: "runner", now: Date.now() }), /snapshot initialization/);
});

test("empty snapshot completes with a zero-sample checksum shadow", async () => {
  const f = fixture(); f.state.snapshot.highWater = 0;
  f.source.freeze = async ({ operationId }) => (f.state.freeze = { operationId, token: "freeze-empty", highWater: 0 });
  f.target.applyFinalDelta = async ({ operationId, freezeToken }) => ({ operationId, freezeToken, fromHighWater: 0, highWater: 0 });
  f.target.shadow = async () => ({ sourceChecksum: "e".repeat(64), targetChecksum: "e".repeat(64), sampleCount: 0, mismatchCount: 0, startedAt: Date.now() - 70_000, endedAt: Date.now() - 1000 });
  assert.equal((await runBackfill(f, { owner: "runner", now: Date.now() })).complete, true);
  assert.equal((await finalizeCutover(f, { owner: "runner", now: Date.now() })).mode, "postgres");
});
