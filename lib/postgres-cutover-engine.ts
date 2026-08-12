export type CutoverRow = { tenant: string; table: string; id: string; sequence: number; payload: unknown; deleted: boolean };
export type SnapshotPage = { highWater: number; cursor: number | null; rows: CutoverRow[]; nextCursor: number | null };
const encoder = new TextEncoder();
const maximumPayloadBytes = 256 * 1024, maximumPageBytes = 4 * 1024 * 1024, maximumDepth = 32, maximumNodes = 10000;

function safe(value: unknown, state = { nodes: 0, seen: new WeakSet<object>() }, depth = 0): unknown {
  state.nodes += 1; if (depth > maximumDepth || state.nodes > maximumNodes) throw new Error("unsafe payload complexity");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("unsafe numeric value"); return ["number", String(value)]; }
  if (Array.isArray(value)) { if (state.seen.has(value)) throw new Error("unsafe circular payload"); state.seen.add(value); const out = value.map((v) => safe(v, state, depth + 1)); state.seen.delete(value); return out; }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("payload must be a plain object");
    if (state.seen.has(value)) throw new Error("unsafe circular payload"); state.seen.add(value);
    const out = Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, safe(v, state, depth + 1)])); state.seen.delete(value); return out;
  }
  throw new Error("unsafe canonical value");
}
function validateRow(value: CutoverRow) {
  if (![value.tenant, value.table, value.id].every((v) => typeof v === "string" && v.length > 0 && !v.includes("\0")) || !Number.isSafeInteger(value.sequence) || value.sequence <= 0 || typeof value.deleted !== "boolean") throw new Error("unsafe cutover identifier or row");
  const canonical = safe(value.payload); if (encoder.encode(JSON.stringify(canonical)).byteLength > maximumPayloadBytes) throw new Error("unsafe payload size"); return value;
}

export async function canonicalCutoverChecksum(rows: CutoverRow[]) {
  const keys = new Set<string>();
  const canonical = [...rows].map((value) => {
    validateRow(value);
    const key = `${value.tenant}\0${value.table}\0${value.id}`; if (keys.has(key)) throw new Error("duplicate cutover key"); keys.add(key);
    return ["row", value.tenant, value.table, value.id, value.sequence, value.deleted, safe(value.payload)];
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(canonical)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validatePage(page: SnapshotPage, limit: number, expected?: { highWater: number; cursor: number | null }) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000 || !Number.isSafeInteger(page.highWater) || page.highWater < 0 || (page.cursor !== null && (!Number.isSafeInteger(page.cursor) || page.cursor < 0)) || (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < 0)) || page.rows.length > limit) throw new Error("snapshot page is not bounded");
  if (expected && (page.highWater !== expected.highWater || page.cursor !== expected.cursor)) throw new Error("immutable snapshot checkpoint mismatch");
  if (encoder.encode(JSON.stringify(page.rows)).byteLength > maximumPageBytes) throw new Error("snapshot page bytes are not bounded");
  let prior = page.cursor ?? 0;
  for (const row of page.rows) { validateRow(row); if (row.sequence <= prior || row.sequence > page.highWater) throw new Error("snapshot sequence is not monotonic"); prior = row.sequence; }
  if (page.rows.length && page.nextCursor !== prior) throw new Error("snapshot cursor is inconsistent");
  if (!page.rows.length && page.nextCursor !== null) throw new Error("empty snapshot cursor is inconsistent");
  return page;
}

export function applyDelta(highWater: number, rows: CutoverRow[]) {
  if (!Number.isSafeInteger(highWater) || highWater < 0) throw new Error("delta high-water is invalid");
  const keys = new Set<string>(); let expected = highWater + 1;
  for (const row of rows) {
    validateRow(row);
    const key = `${row.tenant}\0${row.table}\0${row.id}\0${row.sequence}`; if (keys.has(key)) throw new Error("duplicate delta"); keys.add(key); expected += 1;
    if (row.sequence !== expected - 1) throw new Error(row.sequence > expected - 1 ? "delta gap" : "delta out of order");
  }
  return { highWater: expected - 1, rows };
}

type Target = { transaction(operation: (tx: { assertLease(value: { owner: string; fence: number; expiresAfter: number; highWater: number; cursor: number | null }): Promise<void>; stage(rows: CutoverRow[], fence: number): Promise<void>; tombstone(rows: CutoverRow[], fence: number): Promise<void>; checkpoint(value: { cursor: number | null; highWater: number; fence: number }): Promise<void> }) => Promise<void>): Promise<void> };
export async function executeBackfillPage(target: Target, lease: { owner: string; fence: number; expiresAt: number }, input: { expectedOwner: string; expectedFence: number; expectedHighWater: number; expectedCursor: number | null; page: SnapshotPage }) {
  if (lease.owner !== input.expectedOwner || lease.fence !== input.expectedFence || lease.expiresAt <= Date.now()) throw new Error("stale fence or lease");
  validatePage(input.page, 1000, { highWater: input.expectedHighWater, cursor: input.expectedCursor });
  await target.transaction(async (tx) => {
    await tx.assertLease({ owner: input.expectedOwner, fence: input.expectedFence, expiresAfter: Date.now(), highWater: input.expectedHighWater, cursor: input.expectedCursor });
    const live = input.page.rows.filter((row) => !row.deleted), deleted = input.page.rows.filter((row) => row.deleted);
    if (live.length) await tx.stage(live, lease.fence); if (deleted.length) await tx.tombstone(deleted, lease.fence);
    await tx.checkpoint({ cursor: input.page.nextCursor, highWater: input.page.highWater, fence: lease.fence });
  });
}

function hex(bytes: ArrayBuffer) { return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join(""); }
export async function verifyCutoverEvidence(envelope: { payload: Record<string, unknown>; signature: string }, expected: Record<string, unknown> & { secret: string; now: number; consumeNonce(nonce: string): Promise<boolean> }) {
  const { secret, now, consumeNonce, ...fields } = expected;
  if (encoder.encode(secret).byteLength < 32 || !Number.isSafeInteger(now) || !Number.isSafeInteger(envelope.payload.issuedAt) || Math.abs(now - Number(envelope.payload.issuedAt)) > 300_000) throw new Error("evidence is not fresh or secret is unsafe");
  if (envelope.payload.signer !== fields.signer || envelope.payload.keyId !== fields.keyId) throw new Error("evidence signer is not trusted");
  if (JSON.stringify(envelope.payload) !== JSON.stringify(fields)) throw new Error("evidence does not match cutover");
  if (typeof envelope.payload.nonce !== "string" || !/^[A-Za-z0-9_-]{12,128}$/.test(envelope.payload.nonce) || !/^[a-f0-9]{64}$/.test(envelope.signature)) throw new Error("evidence signature or nonce format is invalid");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(envelope.payload))));
  const expectedBytes = Uint8Array.from(signature.match(/../g) || [], (v) => parseInt(v, 16)), actualBytes = Uint8Array.from(envelope.signature.match(/../g) || [], (v) => parseInt(v, 16));
  let difference = expectedBytes.length ^ actualBytes.length; for (let i = 0; i < expectedBytes.length; i += 1) difference |= expectedBytes[i] ^ (actualBytes[i] || 0);
  if (difference !== 0) throw new Error("evidence signature is invalid");
  if (!await consumeNonce(envelope.payload.nonce)) throw new Error("evidence nonce is invalid or replayed");
  return true;
}
