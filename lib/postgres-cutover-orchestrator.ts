import { executeBackfillPage, validatePage, type SnapshotPage } from "./postgres-cutover-engine";

type Lease = { owner: string; fence: number; expiresAt: number };
type Checkpoint = { highWater: number; cursor: number | null; fence: number };
type Source = {
  acquireSnapshot(): Promise<{ highWater: number; cursor: number | null }>;
  page(input: { highWater: number; cursor: number | null; limit: number }): Promise<SnapshotPage>;
  freeze(input: { expectedHighWater: number; operationId: string }): Promise<{ operationId: string; token: string; highWater: number }>;
  loadFreeze(operationId: string): Promise<{ operationId: string; token: string; highWater: number } | null>;
  unfreeze(token: string): Promise<void>;
  commitFreeze(token: string): Promise<void>;
};
type Target = {
  now(): Promise<number>;
  acquireLease(input: { owner: string; now: number }): Promise<Lease>;
  renewLease(lease: Lease): Promise<Lease>;
  initializeSnapshot(input: { snapshot: { highWater: number; cursor: null }; lease: Lease }): Promise<Checkpoint>;
  loadCheckpoint(): Promise<Checkpoint | null>;
  transaction: Parameters<typeof executeBackfillPage>[0]["transaction"];
  applyFinalDelta(input: { operationId: string; freezeToken: string; fromHighWater: number; toHighWater: number; fence: number }): Promise<{ operationId: string; freezeToken: string; fromHighWater: number; highWater: number }>;
  loadFinalDelta(operationId: string): Promise<{ operationId: string; freezeToken: string; fromHighWater: number; highWater: number } | null>;
  shadow(input: { highWater: number; fence: number; heartbeat(): Promise<void> }): Promise<{ sourceChecksum: string; targetChecksum: string; sampleCount: number; mismatchCount: number; startedAt: number; endedAt: number }>;
  verifyEvidence(input: { freezeHighWater: number; finalHighWater: number; fence: number; shadow: Awaited<ReturnType<Target["shadow"]>> }): Promise<{ digest: string; nonce: string; releaseId: string } | null>;
  transitionAtomically(input: { operationId: string; freezeToken: string; highWater: number; fence: number; evidenceDigest: string; evidenceNonce: string; releaseId: string }): Promise<{ operationId: string; freezeToken: string; highWater: number; fence: number; evidenceDigest: string }>;
  mode(): Promise<"d1" | "postgres">;
  loadTransition(): Promise<{ operationId: string; freezeToken: string; highWater: number; fence: number; evidenceDigest: string } | null>;
};
type Adapters = { source: Source; target: Target };
type FinalizeResult = { complete: true; mode: "postgres"; highWater?: number };

function inputs(value: { owner: string; now: number; maximumPages?: number; pageSize?: number }) {
  const maximumPages = value.maximumPages ?? 100, pageSize = value.pageSize ?? 100;
  if (!/^[A-Za-z0-9_.:@/-]{3,200}$/.test(value.owner) || !Number.isSafeInteger(value.now) || value.now <= 0 || !Number.isSafeInteger(maximumPages) || maximumPages < 1 || maximumPages > 1000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error("cutover input invalid");
  return { maximumPages, pageSize };
}
function assertLease(lease: Lease, owner: string, now: number, fence?: number) {
  if (lease.owner !== owner || !Number.isSafeInteger(lease.fence) || lease.fence < 1 || (fence !== undefined && lease.fence !== fence) || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= now) throw new Error("cutover lease invalid");
}

export async function runBackfill(adapters: Adapters, input: { owner: string; now: number; maximumPages?: number; pageSize?: number }) {
  const { maximumPages, pageSize } = inputs(input);
  const now = await adapters.target.now(); if (!Number.isSafeInteger(now) || now <= 0) throw new Error("trusted clock invalid");
  let lease = await adapters.target.acquireLease({ owner: input.owner, now }); assertLease(lease, input.owner, now);
  let checkpoint = await adapters.target.loadCheckpoint(); let acquiredHighWater: number | undefined;
  if (!checkpoint) { const snapshot = await adapters.source.acquireSnapshot(); if (snapshot.cursor !== null) throw new Error("new snapshot cursor invalid"); acquiredHighWater = snapshot.highWater; checkpoint = await adapters.target.initializeSnapshot({ snapshot: { highWater: snapshot.highWater, cursor: null }, lease }); }
  if (!Number.isSafeInteger(checkpoint.highWater) || checkpoint.highWater < 0 || checkpoint.fence !== lease.fence) throw new Error("cutover checkpoint invalid");
  if (acquiredHighWater !== undefined) {
    const durable = await adapters.target.loadCheckpoint();
    if (checkpoint.highWater !== acquiredHighWater || checkpoint.cursor !== null || !durable || durable.highWater !== acquiredHighWater || durable.cursor !== null || durable.fence !== lease.fence) throw new Error("snapshot initialization invalid");
  }
  let cursor = checkpoint.cursor;
  for (let pages = 1; pages <= maximumPages; pages += 1) {
    lease = await adapters.target.renewLease(lease); assertLease(lease, input.owner, await adapters.target.now(), checkpoint.fence);
    const page = await adapters.source.page({ highWater: checkpoint.highWater, cursor, limit: pageSize });
    validatePage(page, pageSize, { highWater: checkpoint.highWater, cursor });
    if (page.rows.length === 0) { if (!(checkpoint.highWater === 0 && cursor === null) && cursor !== checkpoint.highWater) throw new Error("snapshot terminal cursor invalid"); return { complete: true, highWater: checkpoint.highWater, cursor, pages }; }
    await executeBackfillPage({ transaction: adapters.target.transaction }, lease, { trustedNow: await adapters.target.now(), expectedOwner: input.owner, expectedFence: checkpoint.fence, expectedHighWater: checkpoint.highWater, expectedCursor: cursor, page });
    cursor = page.nextCursor;
  }
  return { complete: false, highWater: checkpoint.highWater, cursor, pages: maximumPages };
}

export async function finalizeCutover(adapters: Adapters, input: { owner: string; now: number }): Promise<FinalizeResult> {
  inputs(input);
  const existingTransition = await adapters.target.loadTransition();
  if (existingTransition) return resumeCutover(adapters, input);
  if (await adapters.target.mode() === "postgres") return resumeCutover(adapters, input);
  let freeze: { operationId: string; token: string; highWater: number } | undefined; let transitionAttempted = false;
  try {
    const checkpoint = await adapters.target.loadCheckpoint(); if (!checkpoint || !((checkpoint.highWater === 0 && checkpoint.cursor === null) || checkpoint.cursor === checkpoint.highWater)) throw new Error("backfill incomplete");
    const now = await adapters.target.now(); let lease = await adapters.target.acquireLease({ owner: input.owner, now }); assertLease(lease, input.owner, now, checkpoint.fence);
    const freezeOperation = `freeze:${checkpoint.fence}:${checkpoint.highWater}`;
    try { freeze = await adapters.source.freeze({ expectedHighWater: checkpoint.highWater, operationId: freezeOperation }); } catch (error) { freeze = await adapters.source.loadFreeze(freezeOperation) ?? undefined; if (!freeze) throw error; }
    if (freeze.operationId !== freezeOperation || freeze.highWater < checkpoint.highWater || !Number.isSafeInteger(freeze.highWater) || !/^[A-Za-z0-9_.:@/-]{3,200}$/.test(freeze.token)) throw new Error("freeze mismatch");
    lease = await adapters.target.renewLease(lease); assertLease(lease, input.owner, await adapters.target.now(), checkpoint.fence);
    const deltaOperation = `delta:${checkpoint.fence}:${checkpoint.highWater}:${freeze.highWater}`;
    let delta; try { delta = await adapters.target.applyFinalDelta({ operationId: deltaOperation, freezeToken: freeze.token, fromHighWater: checkpoint.highWater, toHighWater: freeze.highWater, fence: lease.fence }); } catch (error) { delta = await adapters.target.loadFinalDelta(deltaOperation); if (!delta) throw error; }
    if (delta.operationId !== deltaOperation || delta.freezeToken !== freeze.token || delta.fromHighWater !== checkpoint.highWater || delta.highWater !== freeze.highWater) throw new Error("final delta mismatch");
    lease = await adapters.target.renewLease(lease); assertLease(lease, input.owner, await adapters.target.now(), checkpoint.fence);
    const shadow = await adapters.target.shadow({ highWater: delta.highWater, fence: lease.fence, heartbeat: async () => { lease = await adapters.target.renewLease(lease); assertLease(lease, input.owner, await adapters.target.now(), checkpoint.fence); } }); const current = await adapters.target.now();
    if (!/^[a-f0-9]{64}$/.test(shadow.sourceChecksum) || shadow.sourceChecksum !== shadow.targetChecksum || shadow.mismatchCount !== 0 || !Number.isSafeInteger(shadow.sampleCount) || shadow.sampleCount < 0 || (delta.highWater > 0 && shadow.sampleCount < 1) || !Number.isSafeInteger(shadow.startedAt) || !Number.isSafeInteger(shadow.endedAt) || shadow.startedAt > shadow.endedAt || shadow.endedAt - shadow.startedAt < 60_000 || shadow.endedAt > current || current - shadow.endedAt > 60_000) throw new Error("shadow invalid");
    const evidence = await adapters.target.verifyEvidence({ freezeHighWater: freeze.highWater, finalHighWater: delta.highWater, fence: lease.fence, shadow });
    if (!evidence || !/^[a-f0-9]{64}$/.test(evidence.digest) || !/^[A-Za-z0-9_-]{22,128}$/.test(evidence.nonce) || !/^[A-Za-z0-9_.:@/-]{3,200}$/.test(evidence.releaseId)) throw new Error("release evidence invalid");
    lease = await adapters.target.renewLease(lease); assertLease(lease, input.owner, await adapters.target.now(), checkpoint.fence);
    const transitionOperation = `transition:${lease.fence}:${delta.highWater}`; transitionAttempted = true;
    const transition = await adapters.target.transitionAtomically({ operationId: transitionOperation, freezeToken: freeze.token, highWater: delta.highWater, fence: lease.fence, evidenceDigest: evidence.digest, evidenceNonce: evidence.nonce, releaseId: evidence.releaseId });
    if (transition.operationId !== transitionOperation || transition.freezeToken !== freeze.token || transition.highWater !== delta.highWater || transition.fence !== lease.fence || transition.evidenceDigest !== evidence.digest) throw new Error("transition manifest invalid");
    await adapters.source.commitFreeze(freeze.token);
    return { complete: true, mode: "postgres" as const, highWater: delta.highWater };
  } catch (error) {
    if (transitionAttempted) { const manifest = await adapters.target.loadTransition(); if (manifest) throw error; throw new Error("cutover transition outcome unknown", { cause: error }); }
    let mode: "d1" | "postgres"; try { mode = await adapters.target.mode(); } catch { throw new Error("cutover recovery mode unavailable", { cause: error }); }
    if (mode === "d1" && freeze) { try { await adapters.source.unfreeze(freeze.token); } catch { /* preserve primary failure */ } }
    throw error;
  }
}

export async function resumeCutover(adapters: Adapters, input: { owner: string; now: number }): Promise<FinalizeResult> {
  inputs(input);
  const transition = await adapters.target.loadTransition();
  if (!transition) { if (await adapters.target.mode() !== "postgres") return finalizeCutover(adapters, input); throw new Error("durable transition missing"); }
  if (!/^[A-Za-z0-9_.:@/-]{3,200}$/.test(transition.operationId) || !/^[A-Za-z0-9_.:@/-]{3,200}$/.test(transition.freezeToken) || !Number.isSafeInteger(transition.highWater) || transition.highWater < 0 || !Number.isSafeInteger(transition.fence) || transition.fence < 1 || !/^[a-f0-9]{64}$/.test(transition.evidenceDigest)) throw new Error("durable transition missing");
  await adapters.source.commitFreeze(transition.freezeToken);
  return { complete: true, mode: "postgres" as const };
}
