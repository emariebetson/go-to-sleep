import { canonicalCutoverChecksum, validatePage, type CutoverRow, type SnapshotPage } from "./postgres-cutover-engine";

type Lease = { owner: string; fence: number; expiresAt: number };
type Capture = { captureId: string; fence: number; drainToken: string; status: "drained"; highWater: number; cursor: number | null; priorManifestChecksum: string };
type Manifest = { captureId: string; operationId: string; fence: number; previousCursor: number | null; cursor: number | null; highWater: number; previousManifestChecksum: string; manifestChecksum: string; previousRowCount: number; rowCount: number };
type Transition = { operationId: string; captureId: string; drainToken: string; fence: number; highWater: number; manifestChecksum: string; rowCount: number };
type Target = {
  now(): Promise<number>; acquireRollbackLease(input: { owner: string; now: number }): Promise<Lease>; renewRollbackLease(lease: Lease): Promise<Lease>;
  beginRollback(input: { captureId: string; fence: number }): Promise<Capture>; loadRollbackCapture(): Promise<Capture | null>;
  refenceRollback(input: { captureId: string; previousFence: number; fence: number }): Promise<{ capture: Capture; manifest: Manifest | null }>;
  rollbackPage(input: { highWater: number; cursor: number | null; limit: number; fence: number; drainToken: string }): Promise<SnapshotPage>;
  recordRollbackManifest(input: Manifest): Promise<Manifest>; loadRollbackManifest(captureId: string): Promise<Manifest | null>; verifyRollbackManifest(input: { capture: Capture; manifest: Manifest }): Promise<boolean>;
  transitionRollbackAtomically(input: Transition): Promise<Transition>; loadRollbackTransition(): Promise<Transition | null>;
};
type Source = {
  applyRollbackPage(input: Manifest & { nextCursor: number | null; rows: CutoverRow[]; drainToken: string }): Promise<Manifest>;
  loadAppliedRollback(operationId: string): Promise<Manifest | null>; mode(): Promise<"d1" | "postgres">;
};
type Adapters = { source: Source; target: Target };
const HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_.:@/-]{3,200}$/;

function options(value: { owner: string; now: number; maximumPages?: number; pageSize?: number }) { const maximumPages = value.maximumPages ?? 100, pageSize = value.pageSize ?? 100; if (!ID.test(value.owner) || !Number.isSafeInteger(value.now) || value.now <= 0 || !Number.isSafeInteger(maximumPages) || maximumPages < 1 || maximumPages > 1000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error("rollback input invalid"); return { maximumPages, pageSize }; }
function assertLease(value: Lease, owner: string, now: number, fence?: number) { if (value.owner !== owner || !Number.isSafeInteger(value.fence) || value.fence < 1 || (fence !== undefined && value.fence !== fence) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) throw new Error("rollback lease invalid"); }
function validCapture(value: Capture | null) { return !!value && ID.test(value.captureId) && Number.isSafeInteger(value.fence) && value.fence > 0 && ID.test(value.drainToken) && value.status === "drained" && Number.isSafeInteger(value.highWater) && value.highWater >= 0 && (value.cursor === null || (Number.isSafeInteger(value.cursor) && value.cursor >= 0 && value.cursor <= value.highWater)) && HASH.test(value.priorManifestChecksum); }
function exactManifest(value: Manifest | null, expected: Manifest) { return !!value && Object.keys(expected).every((key) => value[key as keyof Manifest] === expected[key as keyof Manifest]); }
function exactTransition(value: Transition | null, expected: Transition) { return !!value && Object.keys(expected).every((key) => value[key as keyof Transition] === expected[key as keyof Transition]); }
async function manifestValid(adapters: Adapters, capture: Capture, current: Manifest) { const cursor = current.cursor; return cursor !== null && current.captureId === capture.captureId && current.fence === capture.fence && current.highWater === capture.highWater && Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= capture.highWater && (current.previousCursor === null || (Number.isSafeInteger(current.previousCursor) && current.previousCursor >= 0 && current.previousCursor < cursor && current.previousCursor <= capture.highWater)) && current.operationId === `rollback-page:${capture.captureId}:${current.previousCursor ?? 0}:${cursor}` && HASH.test(current.previousManifestChecksum) && HASH.test(current.manifestChecksum) && Number.isSafeInteger(current.previousRowCount) && current.previousRowCount >= 0 && Number.isSafeInteger(current.rowCount) && current.rowCount > current.previousRowCount && await adapters.target.verifyRollbackManifest({ capture, manifest: current }); }
async function checksum(previous: string, page: SnapshotPage, rowCount: number) { if (!HASH.test(previous) || !Number.isSafeInteger(rowCount) || rowCount < 0) throw new Error("rollback manifest invalid"); const pageChecksum = await canonicalCutoverChecksum(page.rows); const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["rollback-manifest-v1", previous, pageChecksum, page.highWater, page.cursor, page.nextCursor, rowCount]))); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

export async function runRollback(adapters: Adapters, input: { owner: string; now: number; maximumPages?: number; pageSize?: number }) {
  const { maximumPages, pageSize } = options(input);
  const existingTransition = await adapters.target.loadRollbackTransition(); if (existingTransition) { const loaded = await adapters.target.loadRollbackCapture(); if (!validCapture(loaded)) throw new Error("rollback transition invalid"); const capture = loaded as Capture, tail = await adapters.target.loadRollbackManifest(capture.captureId); const empty = capture.highWater === 0; if ((!empty && (!tail || tail.cursor !== capture.highWater || !await manifestValid(adapters, capture, tail))) || (empty && tail !== null)) throw new Error("rollback transition invalid"); const expectedChecksum = tail?.manifestChecksum ?? capture.priorManifestChecksum, expectedCount = tail?.rowCount ?? 0; if (existingTransition.operationId !== `rollback-transition:${capture.captureId}` || existingTransition.captureId !== capture.captureId || existingTransition.drainToken !== capture.drainToken || existingTransition.fence !== capture.fence || existingTransition.highWater !== capture.highWater || existingTransition.manifestChecksum !== expectedChecksum || existingTransition.rowCount !== expectedCount || !HASH.test(existingTransition.manifestChecksum) || !Number.isSafeInteger(existingTransition.rowCount) || existingTransition.rowCount < 0 || (empty && (existingTransition.manifestChecksum !== capture.priorManifestChecksum || existingTransition.rowCount !== 0))) throw new Error("rollback transition invalid"); return { complete: true, mode: "d1" as const, highWater: existingTransition.highWater, manifestChecksum: existingTransition.manifestChecksum, rowCount: existingTransition.rowCount }; }
  if (await adapters.source.mode() === "d1") throw new Error("rollback transition missing");
  let lease = await adapters.target.acquireRollbackLease({ owner: input.owner, now: await adapters.target.now() }); assertLease(lease, input.owner, await adapters.target.now());
  let capture = await adapters.target.loadRollbackCapture();
  if (!capture) { const captureId = "rollback-main"; try { capture = await adapters.target.beginRollback({ captureId, fence: lease.fence }); } catch (error) { capture = await adapters.target.loadRollbackCapture(); if (!capture) throw error; } }
  if (!validCapture(capture)) throw new Error("rollback capture invalid");
  let current: Manifest | null;
  if (capture.fence !== lease.fence) { const before = capture, rebound = await adapters.target.refenceRollback({ captureId: capture.captureId, previousFence: capture.fence, fence: lease.fence }); capture = rebound.capture; current = rebound.manifest; if (!validCapture(capture) || capture.fence !== lease.fence || capture.captureId !== before.captureId || capture.drainToken !== before.drainToken || capture.status !== before.status || capture.highWater !== before.highWater || capture.cursor !== before.cursor || capture.priorManifestChecksum !== before.priorManifestChecksum || (current && current.fence !== lease.fence)) throw new Error("rollback capture refence invalid"); }
  else current = await adapters.target.loadRollbackManifest(capture.captureId);
  if (current && !await manifestValid(adapters, capture, current)) throw new Error("rollback manifest invalid");
  let cursor = current?.cursor ?? capture.cursor, manifestChecksum = current?.manifestChecksum ?? capture.priorManifestChecksum, rowCount = current?.rowCount ?? 0;
  for (let pages = 1; pages <= maximumPages; pages += 1) {
    lease = await adapters.target.renewRollbackLease(lease); assertLease(lease, input.owner, await adapters.target.now(), capture.fence);
    const page = await adapters.target.rollbackPage({ highWater: capture.highWater, cursor, limit: pageSize, fence: lease.fence, drainToken: capture.drainToken }); validatePage(page, pageSize, { highWater: capture.highWater, cursor });
    if (!page.rows.length) {
      if (!(capture.highWater === 0 && cursor === null) && cursor !== capture.highWater) throw new Error("rollback terminal cursor invalid");
      lease = await adapters.target.renewRollbackLease(lease); assertLease(lease, input.owner, await adapters.target.now(), capture.fence);
      const expected: Transition = { operationId: `rollback-transition:${capture.captureId}`, captureId: capture.captureId, drainToken: capture.drainToken, fence: capture.fence, highWater: capture.highWater, manifestChecksum, rowCount };
      let transition; try { transition = await adapters.target.transitionRollbackAtomically(expected); } catch (error) { transition = await adapters.target.loadRollbackTransition(); if (!transition) throw error; throw error; }
      if (!exactTransition(transition, expected)) throw new Error("rollback transition invalid"); return { complete: true, mode: "d1" as const, highWater: capture.highWater, cursor, pages, manifestChecksum, rowCount };
    }
    const nextCount = rowCount + page.rows.length; if (!Number.isSafeInteger(nextCount)) throw new Error("rollback row count invalid"); const nextChecksum = await checksum(manifestChecksum, page, nextCount), operationId = `rollback-page:${capture.captureId}:${page.cursor ?? 0}:${page.nextCursor ?? 0}`;
    const expected: Manifest = { captureId: capture.captureId, operationId, fence: capture.fence, previousCursor: cursor, cursor: page.nextCursor, highWater: capture.highWater, previousManifestChecksum: manifestChecksum, manifestChecksum: nextChecksum, previousRowCount: rowCount, rowCount: nextCount };
    let applied; try { applied = await adapters.source.applyRollbackPage({ ...expected, nextCursor: page.nextCursor, rows: page.rows, drainToken: capture.drainToken }); } catch (error) { applied = await adapters.source.loadAppliedRollback(operationId); if (!applied) throw error; }
    if (!exactManifest(applied, expected)) throw new Error("rollback apply manifest invalid");
    lease = await adapters.target.renewRollbackLease(lease); assertLease(lease, input.owner, await adapters.target.now(), capture.fence);
    const recorded = await adapters.target.recordRollbackManifest(expected); if (!exactManifest(recorded, expected)) throw new Error("rollback manifest invalid");
    cursor = page.nextCursor; manifestChecksum = nextChecksum; rowCount = nextCount; current = recorded;
  }
  return { complete: false, mode: "postgres" as const, highWater: capture.highWater, cursor, pages: maximumPages, manifestChecksum, rowCount };
}
