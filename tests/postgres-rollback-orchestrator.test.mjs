import assert from "node:assert/strict";
import test from "node:test";
import { runRollback } from "../lib/postgres-rollback-orchestrator.ts";

const row = (sequence, deleted = false) => ({ tenant: "h1", table: "children", id: String(sequence), sequence, payload: deleted ? null : { sequence }, deleted });

function fixture() {
  const state = { mode: "postgres", lease: { owner: "runner", fence: 9, expiresAt: Date.now() + 60_000 }, capture: null, checkpoint: null, appliedManifests: new Map(), applied: [], transition: null, drained: false };
  return {
    state,
    target: {
      async now() { return Date.now(); },
      async acquireRollbackLease() { return { ...state.lease }; },
      async renewRollbackLease(lease) { assert.equal(lease.fence, 9); state.lease.expiresAt = Date.now() + 60_000; return { ...state.lease }; },
      async beginRollback({ captureId, fence }) { state.drained = true; state.capture ??= { captureId, fence, drainToken: "drain-1", status: "drained", highWater: 2, cursor: null, priorManifestChecksum: "0".repeat(64) }; return { ...state.capture, fence }; },
      async loadRollbackCapture() { return state.capture && { ...state.capture }; },
      async refenceRollback({ captureId, previousFence, fence }) { assert.equal(state.capture.captureId, captureId); assert.equal(state.capture.fence, previousFence); state.capture.fence = fence; if (state.checkpoint) state.checkpoint.fence = fence; return { capture: { ...state.capture }, manifest: state.checkpoint && { ...state.checkpoint } }; },
      async rollbackPage({ cursor, limit }) { const rows = cursor === null ? [row(1)] : cursor === 1 ? [row(2, true)] : []; return { highWater: 2, cursor, rows: rows.slice(0, limit), nextCursor: rows.length ? rows.at(-1).sequence : null }; },
      async recordRollbackManifest(input) { state.checkpoint = { ...input }; return { ...state.checkpoint }; },
      async loadRollbackManifest() { return state.checkpoint && { ...state.checkpoint }; },
      async verifyRollbackManifest({ manifest }) { return manifest.rowCount - manifest.previousRowCount === manifest.cursor - (manifest.previousCursor ?? 0); },
      async transitionRollbackAtomically(input) { assert.equal(input.drainToken, "drain-1"); state.mode = "d1"; state.transition = { ...input }; return { ...state.transition }; },
      async loadRollbackTransition() { return state.transition && { ...state.transition }; },
    },
    source: {
      async applyRollbackPage(input) { state.applied.push(...input.rows); const manifest = { captureId: input.captureId, operationId: input.operationId, fence: input.fence, previousCursor: input.previousCursor, cursor: input.nextCursor, highWater: input.highWater, previousManifestChecksum: input.previousManifestChecksum, manifestChecksum: input.manifestChecksum, previousRowCount: input.previousRowCount, rowCount: input.rowCount }; state.appliedManifests.set(input.operationId, manifest); return { ...manifest }; },
      async loadAppliedRollback(operationId) { const m = state.appliedManifests.get(operationId); return m && { ...m }; },
      async mode() { return state.mode; },
    },
  };
}

test("rollback captures bounded postgres-only pages and replays tombstones before switching", async () => {
  const f = fixture();
  const first = await runRollback(f, { owner: "runner", maximumPages: 1, pageSize: 1, now: Date.now() });
  assert.equal(first.complete, false); assert.equal(f.state.mode, "postgres"); assert.equal(f.state.applied.length, 1);
  const second = await runRollback(f, { owner: "runner", maximumPages: 3, pageSize: 1, now: Date.now() });
  assert.equal(second.complete, true); assert.equal(f.state.mode, "d1"); assert.equal(f.state.applied[1].deleted, true);
});

test("rollback recovers lost apply and transition responses by durable manifests", async () => {
  const f = fixture();
  const apply = f.source.applyRollbackPage; let loseApply = true;
  f.source.applyRollbackPage = async (input) => { const result = await apply(input); f.state.checkpoint = { ...result }; if (loseApply) { loseApply = false; throw new Error("lost apply"); } return result; };
  assert.equal((await runRollback(f, { owner: "runner", maximumPages: 3, pageSize: 1, now: Date.now() })).complete, true);
  const transition = f.target.transitionRollbackAtomically; f.state.mode = "postgres"; f.state.transition = null;
  f.target.transitionRollbackAtomically = async (input) => { await transition(input); throw new Error("lost transition"); };
  await assert.rejects(() => runRollback(f, { owner: "runner", maximumPages: 1, pageSize: 1, now: Date.now() }), /lost transition/);
  assert.equal(f.state.mode, "d1");
  assert.equal((await runRollback(f, { owner: "runner", maximumPages: 1, pageSize: 1, now: Date.now() })).complete, true);
});

test("rollback resumes one capture across a new runner fence and rejects foreign checkpoints", async () => {
  const f = fixture(); await runRollback(f, { owner: "runner", maximumPages: 1, pageSize: 1, now: Date.now() });
  f.state.lease.fence = 10; f.target.renewRollbackLease = async () => ({ ...f.state.lease, expiresAt: Date.now() + 60_000 });
  const resumed = await runRollback(f, { owner: "runner", maximumPages: 3, pageSize: 1, now: Date.now() }); assert.equal(resumed.complete, true);
  const corrupt = fixture(); corrupt.state.checkpoint = { captureId: "foreign", operationId: "x", fence: 9, cursor: 1, highWater: 2, previousManifestChecksum: "0".repeat(64), manifestChecksum: "a".repeat(64), rowCount: 1 };
  await assert.rejects(() => runRollback(corrupt, { owner: "runner", now: Date.now() }), /manifest/);
});

test("rollback returns authoritative completed transition before reading stale source mode", async () => {
  const f = fixture(); f.state.capture = { captureId: "rollback-main", fence: 9, drainToken: "drain-1", status: "drained", highWater: 0, cursor: null, priorManifestChecksum: "0".repeat(64) };
  f.state.transition = { operationId: "rollback-transition:rollback-main", captureId: "rollback-main", drainToken: "drain-1", fence: 9, highWater: 0, manifestChecksum: "0".repeat(64), rowCount: 0 };
  f.source.mode = async () => "postgres";
  assert.equal((await runRollback(f, { owner: "runner", now: Date.now() })).complete, true);
});

test("rollback rejects same-capture forged manifest tails and unrelated transitions", async () => {
  const forged = fixture(); forged.state.capture = { captureId: "rollback-main", fence: 9, drainToken: "drain-1", status: "drained", highWater: 2, cursor: null, priorManifestChecksum: "0".repeat(64) };
  forged.state.checkpoint = { captureId: "rollback-main", operationId: "rollback-page:rollback-main:0:2", fence: 9, previousCursor: null, cursor: 2, highWater: 2, previousManifestChecksum: "0".repeat(64), manifestChecksum: "a".repeat(64), previousRowCount: 0, rowCount: 99 };
  await assert.rejects(() => runRollback(forged, { owner: "runner", now: Date.now() }), /manifest/);
  const unrelated = fixture(); unrelated.state.capture = { captureId: "rollback-main", fence: 9, drainToken: "drain-1", status: "drained", highWater: 2, cursor: null, priorManifestChecksum: "0".repeat(64) };
  unrelated.state.transition = { operationId: "rollback-transition:other", captureId: "other", drainToken: "drain-1", fence: 9, highWater: 2, manifestChecksum: "0".repeat(64), rowCount: 0 };
  await assert.rejects(() => runRollback(unrelated, { owner: "runner", now: Date.now() }), /transition/);
  const forgedTransition = fixture(); forgedTransition.state.capture = { captureId: "rollback-main", fence: 9, drainToken: "drain-1", status: "drained", highWater: 2, cursor: null, priorManifestChecksum: "0".repeat(64) };
  forgedTransition.state.checkpoint = { captureId: "rollback-main", operationId: "rollback-page:rollback-main:0:2", fence: 9, previousCursor: null, cursor: 2, highWater: 2, previousManifestChecksum: "0".repeat(64), manifestChecksum: "a".repeat(64), previousRowCount: 0, rowCount: 2 };
  forgedTransition.state.transition = { operationId: "rollback-transition:rollback-main", captureId: "rollback-main", drainToken: "drain-1", fence: 9, highWater: 2, manifestChecksum: "b".repeat(64), rowCount: 2 };
  await assert.rejects(() => runRollback(forgedTransition, { owner: "runner", now: Date.now() }), /transition/);
  const missingTail = fixture(); missingTail.state.capture = { captureId: "rollback-main", fence: 9, drainToken: "drain-1", status: "drained", highWater: 2, cursor: null, priorManifestChecksum: "0".repeat(64) }; missingTail.state.transition = { operationId: "rollback-transition:rollback-main", captureId: "rollback-main", drainToken: "drain-1", fence: 9, highWater: 2, manifestChecksum: "0".repeat(64), rowCount: 0 };
  await assert.rejects(() => runRollback(missingTail, { owner: "runner", now: Date.now() }), /transition/);
  const colluding = fixture(); colluding.state.capture = { captureId: "rollback-main", fence: 9, drainToken: "drain-1", status: "drained", highWater: 2, cursor: null, priorManifestChecksum: "0".repeat(64) }; colluding.state.checkpoint = { captureId: "rollback-main", operationId: "rollback-page:rollback-main:0:2", fence: 9, previousCursor: null, cursor: 2, highWater: 2, previousManifestChecksum: "0".repeat(64), manifestChecksum: "c".repeat(64), previousRowCount: 0, rowCount: 99 }; colluding.state.transition = { operationId: "rollback-transition:rollback-main", captureId: "rollback-main", drainToken: "drain-1", fence: 9, highWater: 2, manifestChecksum: "c".repeat(64), rowCount: 99 };
  await assert.rejects(() => runRollback(colluding, { owner: "runner", now: Date.now() }), /transition/);
});

test("rollback refence preserves every immutable capture field", async () => {
  const f = fixture(); await runRollback(f, { owner: "runner", maximumPages: 1, pageSize: 1, now: Date.now() }); f.state.lease.fence = 10;
  f.target.refenceRollback = async () => ({ capture: { ...f.state.capture, fence: 10, highWater: 3 }, manifest: f.state.checkpoint && { ...f.state.checkpoint, fence: 10 } });
  await assert.rejects(() => runRollback(f, { owner: "runner", now: Date.now() }), /refence/);
});

test("rollback rejects manifest-chain, count, fence, and cursor mismatches", async () => {
  const f = fixture(); f.target.recordRollbackManifest = async (input) => ({ ...input, rowCount: input.rowCount + 1 });
  await assert.rejects(() => runRollback(f, { owner: "runner", maximumPages: 1, pageSize: 1, now: Date.now() }), /manifest/);
  const stale = fixture(); stale.target.renewRollbackLease = async () => ({ owner: "runner", fence: 10, expiresAt: Date.now() + 60_000 });
  await assert.rejects(() => runRollback(stale, { owner: "runner", maximumPages: 1, pageSize: 1, now: Date.now() }), /lease/);
});
