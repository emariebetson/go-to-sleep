import { createHash } from "node:crypto";

const PAGE_SIZE = 200;
const HASH = /^[a-f0-9]{64}$/;
const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KINDS = new Set(["d1-schema", "d1-ledger"]);
type EvidenceRow = Readonly<{ identity: string; sha256: string }>;
type Cursor = { version: 1; kind: string; buildId: string; page: number; lastIdentity: string; previousPageSha256: string; checksum: string };
export type EvidencePage = Readonly<{
  version: 1;
  kind: string;
  buildId: string;
  page: number;
  afterIdentity: string | null;
  previousPageSha256: string | null;
  rows: readonly EvidenceRow[];
  nextCursor: string | null;
  pageSha256: string;
}>;

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown) { return JSON.stringify(value); }
function invalid(): never { throw new Error("Sites evidence invalid"); }
function exactDataKeys(value: object, keys: readonly string[]) {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && keys.includes(key) && !!descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value") && !descriptor.get && !descriptor.set;
  });
}
function validRow(value: unknown): value is EvidenceRow {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const row = value as Record<string, unknown>;
  return exactDataKeys(row, ["identity", "sha256"]) &&
    typeof row.identity === "string" && row.identity.length >= 3 && row.identity.length <= 512 &&
    Array.from(row.identity).every((character) => character === "\u0000" || /^[A-Za-z0-9_.:@/-]$/.test(character)) &&
    typeof row.sha256 === "string" && HASH.test(row.sha256);
}
function validHeader(kind: string, buildId: string) {
  if (!KINDS.has(kind) || !BUILD_ID.test(buildId)) invalid();
}
function base64url(value: string) {
  const bytes = new TextEncoder().encode(value);
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromBase64url(value: string) {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value) || value.length % 4 === 1) invalid();
  try {
    const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(raw, (character) => character.charCodeAt(0)));
    if (base64url(decoded) !== value) invalid();
    return decoded;
  } catch { invalid(); }
}
function encodeCursor(input: Omit<Cursor, "checksum">) {
  const checksum = sha256(canonical(input));
  return base64url(canonical({ ...input, checksum }));
}
function decodeCursor(value: string): Cursor {
  let parsed: unknown;
  try { parsed = JSON.parse(fromBase64url(value)); } catch { invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) invalid();
  const cursor = parsed as Record<string, unknown>;
  if (JSON.stringify(Reflect.ownKeys(cursor).sort()) !== JSON.stringify(["buildId", "checksum", "kind", "lastIdentity", "page", "previousPageSha256", "version"]) || cursor.version !== 1 || typeof cursor.kind !== "string" || typeof cursor.buildId !== "string" || !Number.isSafeInteger(cursor.page) || Number(cursor.page) < 1 || typeof cursor.lastIdentity !== "string" || typeof cursor.previousPageSha256 !== "string" || !HASH.test(cursor.previousPageSha256) || typeof cursor.checksum !== "string" || !HASH.test(cursor.checksum)) invalid();
  const core = { version: 1 as const, kind: cursor.kind, buildId: cursor.buildId, page: Number(cursor.page), lastIdentity: cursor.lastIdentity, previousPageSha256: cursor.previousPageSha256 };
  if (sha256(canonical(core)) !== cursor.checksum) invalid();
  return { ...core, checksum: cursor.checksum };
}
function pageHash(page: Pick<EvidencePage, "version" | "kind" | "buildId" | "page" | "afterIdentity" | "previousPageSha256" | "rows">) {
  return sha256(canonical({ version: page.version, kind: page.kind, buildId: page.buildId, page: page.page, afterIdentity: page.afterIdentity, previousPageSha256: page.previousPageSha256, rows: page.rows }));
}

export async function readEvidencePage(input: {
  kind: string;
  buildId: string;
  cursor: string | null;
  readAfter(identity: string | null, limit: number): Promise<unknown[]>;
}): Promise<EvidencePage> {
  validHeader(input.kind, input.buildId);
  if (typeof input.readAfter !== "function") invalid();
  const cursor = input.cursor === null ? null : decodeCursor(input.cursor);
  if (cursor && (cursor.kind !== input.kind || cursor.buildId !== input.buildId)) invalid();
  const raw = await input.readAfter(cursor?.lastIdentity ?? null, PAGE_SIZE + 1);
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > PAGE_SIZE + 1) invalid();
  const rows = raw.slice(0, PAGE_SIZE);
  let prior = cursor?.lastIdentity ?? "";
  for (const row of rows) {
    if (!validRow(row) || row.identity <= prior) invalid();
    prior = row.identity;
  }
  if (raw.length > PAGE_SIZE && (!validRow(raw[PAGE_SIZE]) || raw[PAGE_SIZE]!.identity <= prior)) invalid();
  const core = Object.freeze({
    version: 1 as const,
    kind: input.kind,
    buildId: input.buildId,
    page: cursor?.page ?? 0,
    afterIdentity: cursor?.lastIdentity ?? null,
    previousPageSha256: cursor?.previousPageSha256 ?? null,
    rows: Object.freeze(rows.map((row) => Object.freeze({ ...row as EvidenceRow }))),
  });
  const pageSha256 = pageHash(core);
  const nextCursor = raw.length > PAGE_SIZE ? encodeCursor({ version: 1, kind: input.kind, buildId: input.buildId, page: core.page + 1, lastIdentity: prior, previousPageSha256: pageSha256 }) : null;
  return Object.freeze({ ...core, nextCursor, pageSha256 });
}

export function completeEvidence(kind: string, orderedPageHashes: readonly EvidencePage[]) {
  if (!Array.isArray(orderedPageHashes) || orderedPageHashes.length < 1 || orderedPageHashes.length > 50_000) invalid();
  const buildId = orderedPageHashes[0]?.buildId;
  validHeader(kind, buildId);
  let count = 0, previous: string | null = null, priorIdentity = "";
  const hashes: string[] = [];
  for (const [index, page] of orderedPageHashes.entries()) {
    if (!page || typeof page !== "object" || Array.isArray(page) || Object.getPrototypeOf(page) !== Object.prototype || !exactDataKeys(page, ["version", "kind", "buildId", "page", "afterIdentity", "previousPageSha256", "rows", "nextCursor", "pageSha256"]) || page.version !== 1 || page.kind !== kind || page.buildId !== buildId || page.page !== index || page.afterIdentity !== (index === 0 ? null : priorIdentity) || page.previousPageSha256 !== previous || page.rows.length < 1 || page.rows.length > PAGE_SIZE || page.pageSha256 !== pageHash(page)) invalid();
    for (const row of page.rows) { if (!validRow(row) || row.identity <= priorIdentity) invalid(); priorIdentity = row.identity; }
    if (index < orderedPageHashes.length - 1) {
      if (page.rows.length !== PAGE_SIZE || page.nextCursor === null) invalid();
      const next = decodeCursor(page.nextCursor);
      if (next.kind !== kind || next.buildId !== buildId || next.page !== index + 1 || next.lastIdentity !== priorIdentity || next.previousPageSha256 !== page.pageSha256) invalid();
    } else if (page.nextCursor !== null) invalid();
    count += page.rows.length; hashes.push(page.pageSha256); previous = page.pageSha256;
  }
  return Object.freeze({ version: 1 as const, kind, buildId, count, pageCount: orderedPageHashes.length, orderedDigest: sha256(canonical(hashes)) });
}

type D1PageDatabase = {
  prepare(sql: string): {
    bind(...values: unknown[]): { all(): Promise<{ results?: unknown[] }> };
    all(): Promise<{ results?: unknown[] }>;
  };
};
const D1_SCHEMA_PAGE_FIRST = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name,tbl_name LIMIT 201";
const D1_SCHEMA_PAGE_AFTER = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') AND type||char(0)||name||char(0)||tbl_name > ? ORDER BY type,name,tbl_name LIMIT 201";

export function createD1SchemaEvidenceReader(db: D1PageDatabase, buildId: string) {
  validHeader("d1-schema", buildId);
  if (!db || typeof db.prepare !== "function") invalid();
  return (cursor: string | null) => readEvidencePage({
    kind: "d1-schema",
    buildId,
    cursor,
    readAfter: async (identity, limit) => {
      if (limit !== PAGE_SIZE + 1) invalid();
      const result = identity === null ? await db.prepare(D1_SCHEMA_PAGE_FIRST).all() : await db.prepare(D1_SCHEMA_PAGE_AFTER).bind(identity).all();
      if (!Array.isArray(result.results) || result.results.length > PAGE_SIZE + 1) invalid();
      return result.results.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
        const row = value as Record<string, unknown>;
        if (JSON.stringify(Reflect.ownKeys(row).sort()) !== JSON.stringify(["name", "sql", "tbl_name", "type"]) || !["table", "index", "trigger", "view"].includes(String(row.type)) || typeof row.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.name) || typeof row.tbl_name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.tbl_name) || (row.sql !== null && (typeof row.sql !== "string" || row.sql.length < 1 || row.sql.length > 1_048_576))) invalid();
        return { identity: `${row.type}\u0000${row.name}\u0000${row.tbl_name}`, sha256: sha256(String(row.sql ?? "")) };
      });
    },
  });
}

const D1_LEDGER_PROJECTION = `WITH evidence(identity,applied_at,source_sha256) AS (
SELECT 'provider:'||printf('%08d',id)||':'||name,applied_at,NULL FROM __appgarden_migrations
UNION ALL SELECT 'repair:'||migration_id,applied_at,source_sha256 FROM nearyou_d1_phase_a_migrations
UNION ALL SELECT 'repair:'||migration_id,applied_at,source_sha256 FROM nearyou_d1_phase_b_migrations
UNION ALL SELECT 'repair:'||migration_id,applied_at,source_sha256 FROM nearyou_d1_phase_c_migrations
UNION ALL SELECT 'repair:'||migration_id,applied_at,source_sha256 FROM nearyou_d1_forward_migrations
)`;
const D1_LEDGER_PAGE_FIRST = `${D1_LEDGER_PROJECTION} SELECT identity,applied_at,source_sha256 FROM evidence ORDER BY identity LIMIT 201`;
const D1_LEDGER_PAGE_AFTER = `${D1_LEDGER_PROJECTION} SELECT identity,applied_at,source_sha256 FROM evidence WHERE identity>? ORDER BY identity LIMIT 201`;

export function createD1LedgerEvidenceReader(db: D1PageDatabase, buildId: string) {
  validHeader("d1-ledger", buildId);
  if (!db || typeof db.prepare !== "function") invalid();
  return (cursor: string | null) => readEvidencePage({
    kind: "d1-ledger",
    buildId,
    cursor,
    readAfter: async (identity, limit) => {
      if (limit !== PAGE_SIZE + 1) invalid();
      const result = identity === null ? await db.prepare(D1_LEDGER_PAGE_FIRST).all() : await db.prepare(D1_LEDGER_PAGE_AFTER).bind(identity).all();
      if (!Array.isArray(result.results) || result.results.length > PAGE_SIZE + 1) invalid();
      return result.results.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
        const row = value as Record<string, unknown>;
        if (JSON.stringify(Reflect.ownKeys(row).sort()) !== JSON.stringify(["applied_at", "identity", "source_sha256"]) || typeof row.identity !== "string" || !/^(?:provider|repair):[A-Za-z0-9_.:-]{1,240}$/.test(row.identity) || (typeof row.applied_at !== "string" && !Number.isSafeInteger(row.applied_at)) || String(row.applied_at).length > 64 || (row.source_sha256 !== null && (typeof row.source_sha256 !== "string" || !HASH.test(row.source_sha256)))) invalid();
        return { identity: row.identity, sha256: sha256(canonical([row.applied_at, row.source_sha256])) };
      });
    },
  });
}
