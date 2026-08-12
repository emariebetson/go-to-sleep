import assert from "node:assert/strict";
import test from "node:test";
import { canonicalCutoverChecksum, validatePage, applyDelta, executeBackfillPage } from "../lib/postgres-cutover-engine.ts";

const row = (tenant, table, id, sequence, payload = { value: id }) => ({ tenant, table, id, sequence, payload, deleted: false });

test("typed canonical checksum is tenant-aware, deterministic, and rejects unsafe values", async () => {
  const a = await canonicalCutoverChecksum([row("h1", "child", "1", 1, { n: 1, enabled: true })]);
  assert.equal(a, await canonicalCutoverChecksum([row("h1", "child", "1", 1, { enabled: true, n: 1 })]));
  assert.notEqual(a, await canonicalCutoverChecksum([row("h2", "child", "1", 1, { n: 1, enabled: true })]));
  await assert.rejects(() => canonicalCutoverChecksum([row("h1", "child", "1", 1, { n: Number.NaN })]), /unsafe/);
  await assert.rejects(() => canonicalCutoverChecksum([row("h1", "child", "1", 1, { n: -0 })]), /unsafe/);
  await assert.rejects(() => canonicalCutoverChecksum([row("h1\0evil", "child", "1", 1)]), /identifier/);
  await assert.rejects(() => canonicalCutoverChecksum([row("h1", "child", "1", 1, Object.create({ polluted: true }))]), /plain object/);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(() => canonicalCutoverChecksum([row("h1", "child", "1", 1, cyclic)]), /circular/);
  let deep = {}; for (let i = 0; i < 34; i += 1) deep = { child: deep };
  await assert.rejects(() => canonicalCutoverChecksum([row("h1", "child", "1", 1, deep)]), /complexity/);
  await assert.rejects(() => canonicalCutoverChecksum([row("h1", "child", "1", 1, { data: "x".repeat(256 * 1024) })]), /size/);
});

test("snapshot pages are strictly sorted, bounded, monotonic, and cursor-consistent", () => {
  assert.deepEqual(validatePage({ highWater: 10, cursor: null, rows: [row("h1", "a", "1", 1), row("h1", "a", "2", 2)], nextCursor: 2 }, 100).nextCursor, 2);
  assert.throws(() => validatePage({ highWater: 10, cursor: 2, rows: [row("h1", "a", "1", 2)], nextCursor: 2 }, 100), /monotonic/);
  assert.throws(() => validatePage({ highWater: -1, cursor: null, rows: [], nextCursor: null }, 100), /snapshot/);
  assert.throws(() => validatePage({ highWater: 11, cursor: 2, rows: [], nextCursor: null }, 100, { highWater: 10, cursor: 2 }), /immutable/);
  assert.throws(() => validatePage({ highWater: 10, cursor: null, rows: Array.from({ length: 101 }, (_, i) => row("h", "a", String(i), i + 1)), nextCursor: 101 }, 100), /bounded/);
});

test("backfill transaction rejects stale fencing tokens and advances target with checkpoint atomically", async () => {
  const calls = [];
  const target = { async transaction(fn) { calls.push("begin"); await fn({ assertLease: async () => calls.push("lease"), stage: async () => calls.push("stage"), tombstone: async () => calls.push("tombstone"), checkpoint: async () => calls.push("checkpoint") }); calls.push("commit"); } };
  await executeBackfillPage(target, { owner: "runner", fence: 7, expiresAt: Date.now() + 1000 }, { expectedOwner: "runner", expectedFence: 7, expectedHighWater: 10, expectedCursor: null, page: { highWater: 10, cursor: null, rows: [row("h", "a", "1", 1), { ...row("h", "a", "2", 2), deleted: true }], nextCursor: 2 } });
  assert.deepEqual(calls, ["begin", "lease", "stage", "tombstone", "checkpoint", "commit"]);
  await assert.rejects(() => executeBackfillPage(target, { owner: "runner", fence: 8, expiresAt: Date.now() + 1000 }, { expectedOwner: "runner", expectedFence: 7, expectedHighWater: 10, expectedCursor: null, page: { highWater: 10, cursor: null, rows: [], nextCursor: null } }), /stale fence/);
});

test("deltas require contiguous monotonic sequence and preserve tombstones", () => {
  const result = applyDelta(4, [{ ...row("h", "a", "1", 5), deleted: true }, row("h", "a", "2", 6)]);
  assert.equal(result.highWater, 6); assert.equal(result.rows[0].deleted, true);
  assert.throws(() => applyDelta(4, [row("h", "a", "1", 6)]), /gap/);
  assert.throws(() => applyDelta(4, [row("h", "a", "1", 5), row("h", "a", "1", 5)]), /duplicate/);
});
