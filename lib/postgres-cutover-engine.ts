export type CutoverRow = { tenant: string; table: string; id: string; sequence: number; payload: unknown; deleted: boolean };
export type SnapshotPage = { highWater: number; cursor: number | null; rows: CutoverRow[]; nextCursor: number | null };
const encoder = new TextEncoder();
const maximumPayloadBytes = 256 * 1024, maximumPageBytes = 4 * 1024 * 1024, maximumDepth = 32, maximumNodes = 10000;
function validPostgresText(value: string) {
  if (value.includes("\0")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(index + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; index += 1; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function safe(value: unknown, state = { nodes: 0, seen: new WeakSet<object>() }, depth = 0): unknown {
  state.nodes += 1; if (depth > maximumDepth || state.nodes > maximumNodes) throw new Error("unsafe payload complexity");
  if (value === null) return ["null"];
  if (typeof value === "string") { if (!validPostgresText(value)) throw new Error("unsafe PostgreSQL text"); return ["string", value]; }
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") { if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("unsafe numeric value"); return ["number", String(value)]; }
  if (Array.isArray(value)) { if (state.seen.has(value)) throw new Error("unsafe circular payload"); state.seen.add(value); const out = ["array", value.map((v) => safe(v, state, depth + 1))]; state.seen.delete(value); return out; }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("payload must be a plain object");
    if (state.seen.has(value)) throw new Error("unsafe circular payload"); state.seen.add(value);
    const entries=Object.entries(value as Record<string, unknown>); if(entries.some(([key])=>!validPostgresText(key)))throw new Error("unsafe PostgreSQL text"); state.nodes+=entries.length; if(state.nodes>maximumNodes)throw new Error("unsafe payload complexity");
    const out = ["object", entries.sort(([a], [b]) => compareUtf8(a,b)).map(([k, v]) => [k, safe(v, state, depth + 1)])]; state.seen.delete(value); return out;
  }
  throw new Error("unsafe canonical value");
}
function validateRow(value: CutoverRow) {
  if (![value.tenant, value.table, value.id].every((v) => typeof v === "string" && validPostgresText(v) && encoder.encode(v).byteLength>0 && encoder.encode(v).byteLength<=200) || !Number.isSafeInteger(value.sequence) || value.sequence <= 0 || typeof value.deleted !== "boolean") throw new Error("unsafe cutover identifier or row");
  const canonical = safe(value.payload); if (encoder.encode(JSON.stringify(canonical)).byteLength > maximumPayloadBytes) throw new Error("unsafe payload size"); return value;
}

export function canonicalCutoverBytes(rows: CutoverRow[]) {
  const keys = new Set<string>();
  const canonical = rows.map((value) => {
    validateRow(value);
    const key = `${value.tenant}\0${value.table}\0${value.id}`; if (keys.has(key)) throw new Error("duplicate cutover key"); keys.add(key);
    return ["row", value.tenant, value.table, value.id, value.sequence, value.deleted, safe(value.payload)];
  });
  return encoder.encode(JSON.stringify(canonical));
}

export async function canonicalCutoverChecksum(rows: CutoverRow[]) {
  const digest = await crypto.subtle.digest("SHA-256", canonicalCutoverBytes(rows));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function canonicalCutoverRowTransport(row:CutoverRow){const bytes=canonicalCutoverBytes([row]);const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");let binary="";for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return{canonicalBase64:btoa(binary),digest,key:[row.tenant,row.table,row.id] as const,deleted:row.deleted};}
export async function canonicalCutoverStateDigest(rows:Array<{digest:string;key:readonly[string,string,string];deleted:boolean}>){const seen=new Set<string>();for(const row of rows){const key=row.key.join("\0");if(seen.has(key))throw new Error("duplicate cutover state key");seen.add(key);}const live=rows.filter(r=>!r.deleted).sort((a,b)=>compareUtf8(a.key.join("\0"),b.key.join("\0")));if(live.some(r=>!/^[a-f0-9]{64}$/.test(r.digest)))throw new Error("row digest invalid");const bytes=new Uint8Array(live.length*32);live.forEach((r,i)=>{for(let j=0;j<32;j++)bytes[i*32+j]=Number.parseInt(r.digest.slice(j*2,j*2+2),16)});const checksum=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");return{checksum,rowCount:live.length};}
export async function canonicalCutoverStateChecksum(rows: CutoverRow[]) { return (await canonicalCutoverStateDigest(await Promise.all(rows.map(canonicalCutoverRowTransport)))).checksum; }

export function validatePage(page: SnapshotPage, limit: number, expected?: { highWater: number; cursor: number | null }) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000 || !Number.isSafeInteger(page.highWater) || page.highWater < 0 || (page.cursor !== null && (!Number.isSafeInteger(page.cursor) || page.cursor < 0)) || (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < 0)) || page.rows.length > limit) throw new Error("snapshot page is not bounded");
  if (expected && (page.highWater !== expected.highWater || page.cursor !== expected.cursor)) throw new Error("immutable snapshot checkpoint mismatch");
  if (encoder.encode(JSON.stringify(page.rows)).byteLength > maximumPageBytes) throw new Error("snapshot page bytes are not bounded");
  let prior = page.cursor ?? 0;
  for (const row of page.rows) { validateRow(row); if (row.sequence !== prior + 1 || row.sequence > page.highWater) throw new Error("snapshot sequence is not contiguous"); prior = row.sequence; }
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
export async function executeBackfillPage(target: Target, lease: { owner: string; fence: number; expiresAt: number }, input: { trustedNow: number; expectedOwner: string; expectedFence: number; expectedHighWater: number; expectedCursor: number | null; page: SnapshotPage }) {
  if (!Number.isSafeInteger(input.trustedNow) || input.trustedNow <= 0 || lease.owner !== input.expectedOwner || lease.fence !== input.expectedFence || lease.expiresAt <= input.trustedNow) throw new Error("stale fence or lease");
  validatePage(input.page, 1000, { highWater: input.expectedHighWater, cursor: input.expectedCursor });
  await target.transaction(async (tx) => {
    await tx.assertLease({ owner: input.expectedOwner, fence: input.expectedFence, expiresAfter: input.trustedNow, highWater: input.expectedHighWater, cursor: input.expectedCursor });
    const live = input.page.rows.filter((row) => !row.deleted), deleted = input.page.rows.filter((row) => row.deleted);
    if (live.length) await tx.stage(live, lease.fence); if (deleted.length) await tx.tombstone(deleted, lease.fence);
    await tx.checkpoint({ cursor: input.page.nextCursor, highWater: input.page.highWater, fence: lease.fence });
  });
}
function compareUtf8(a: string, b: string) { const left=encoder.encode(a),right=encoder.encode(b),limit=Math.min(left.length,right.length); for(let i=0;i<limit;i+=1){if(left[i]!==right[i]) return left[i]-right[i];} return left.length-right.length; }
