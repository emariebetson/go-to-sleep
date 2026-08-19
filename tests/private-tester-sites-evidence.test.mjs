import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { completeEvidence, createD1LedgerEvidenceReader, createD1SchemaEvidenceReader, readEvidencePage } from "../lib/private-tester-sites-evidence.ts";
import { createPrivateTesterBaselineGateway, createPrivateTesterBaselineRuntime } from "../lib/private-tester-baseline-gateway.ts";

const buildId = "12345678-1234-4123-8123-123456789abc";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const rows = (count) => Array.from({ length: count }, (_, index) => ({
  identity: `table\u0000object_${String(index).padStart(5, "0")}\u0000object_${String(index).padStart(5, "0")}`,
  sha256: hash(`definition-${index}`),
}));

async function collect(allRows, overrides = {}) {
  const pages = [];
  let cursor = null;
  do {
    const page = await readEvidencePage({
      kind: "d1-schema",
      buildId,
      cursor,
      readAfter: async (identity, limit) => allRows.filter((row) => identity === null || row.identity > identity).slice(0, limit),
      ...overrides,
    });
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return pages;
}

for (const count of [51, 500, 5_001]) test(`paginates ${count} canonical objects without truncation, duplication, or omission`, async () => {
  const expected = rows(count);
  const pages = await collect(expected);
  assert.equal(pages.every((page) => page.rows.length <= 200), true);
  assert.deepEqual(pages.flatMap((page) => page.rows), expected);
  const completion = completeEvidence("d1-schema", pages);
  assert.equal(completion.count, count);
  assert.equal(completion.pageCount, Math.ceil(count / 200));
  assert.match(completion.orderedDigest, /^[a-f0-9]{64}$/);
});

test("rejects reordered, repeated, missing, substituted, oversized, and mixed-build pages", async () => {
  const pages = await collect(rows(500));
  for (const mutated of [
    [pages[1], pages[0], pages[2]],
    [pages[0], pages[0], pages[2]],
    [pages[0], pages[2]],
    [pages[0], { ...pages[1], kind: "d1-ledger" }, pages[2]],
    [pages[0], { ...pages[1], buildId: "87654321-4321-4321-8321-cba987654321" }, pages[2]],
    [{ ...pages[0], rows: [...pages[0].rows, ...rows(201)] }, pages[1], pages[2]],
    [{ ...pages[0], unexpected: true }, pages[1], pages[2]],
  ]) assert.throws(() => completeEvidence("d1-schema", mutated), /Sites evidence invalid/);
});

test("rejects malformed rows and cursor substitution before reading another page", async () => {
  await assert.rejects(collect([{ identity: "bad", sha256: "not-a-hash" }]), /Sites evidence invalid/);
  const [first] = await collect(rows(201));
  const substituted = first.nextCursor.slice(0, -1) + (first.nextCursor.endsWith("A") ? "B" : "A");
  await assert.rejects(readEvidencePage({
    kind: "d1-schema",
    buildId,
    cursor: substituted,
    readAfter: async () => [],
  }), /Sites evidence invalid/);
});

test("completion rejects a self-consistent forged cursor that skips rows", async () => {
  const source = rows(500), original = await collect(source), first = original[0];
  const core = { version: 1, kind: "d1-schema", buildId, page: 1, lastIdentity: source[349].identity, previousPageSha256: first.pageSha256 };
  const forged = Buffer.from(JSON.stringify({ ...core, checksum: hash(JSON.stringify(core)) })).toString("base64url");
  const skipped = await readEvidencePage({
    kind: "d1-schema", buildId, cursor: forged,
    readAfter: async (identity, limit) => source.filter((row) => row.identity > identity).slice(0, limit),
  });
  assert.throws(() => completeEvidence("d1-schema", [first, skipped]), /Sites evidence invalid/);
});

test("uses only fixed cursor SQL and never accepts caller-selected SQL", async () => {
  const source = Array.from({ length: 501 }, (_, index) => ({ type: "table", name: `object_${String(index).padStart(5, "0")}`, tbl_name: `object_${String(index).padStart(5, "0")}`, sql: `CREATE TABLE object_${index}(id TEXT)` }));
  const statements = [];
  const db = { prepare(sql) { statements.push(sql); let bindings = []; return { bind(...values) { bindings = values; return this; }, async all() { const after = bindings[0] ?? null; return { results: source.filter((row) => after === null || `${row.type}\u0000${row.name}\u0000${row.tbl_name}` > after).slice(0, 201) }; } }; } };
  const reader = createD1SchemaEvidenceReader(db, buildId);
  const pages = []; let cursor = null;
  do { const page = await reader(cursor); pages.push(page); cursor = page.nextCursor; } while (cursor !== null);
  assert.equal(completeEvidence("d1-schema", pages).count, 501);
  assert.equal(statements.length, 3);
  assert.equal(new Set(statements).size, 2);
  assert.equal(statements.every((sql) => sql.includes("FROM sqlite_schema") && sql.includes("LIMIT 201")), true);
});

test("gateway authenticates before accepting only the bounded pagination cursor", async () => {
  let authenticated = 0; const reads = [];
  const gateway = createPrivateTesterBaselineGateway({
    trust: { issuer: "https://accounts.google.com", audience: "https://nearyoustill.com", subject: "109876543210987654321" },
    authenticate: async () => { authenticated += 1; return { issuer: "https://accounts.google.com", audience: "https://nearyoustill.com", subject: "109876543210987654321" }; },
    load: async () => ({ release: { releaseId: "rel_20260818_private_03" }, read: async (kind, cursor) => { reads.push([kind, cursor]); return { ok: true }; } }),
    now: () => 1_787_000_000_000,
  });
  const response = await gateway(new Request("https://nearyoustill.com/api/internal/private-tester-baseline/d1-schema-page?cursor=abc_DEF-123"));
  assert.equal(response.status, 200);
  assert.deepEqual(reads, [["d1-schema-page", "abc_DEF-123"]]);
  const rejected = await gateway(new Request("https://nearyoustill.com/api/internal/private-tester-baseline/d1-schema-page?cursor=abc&sql=DROP"));
  assert.equal(rejected.status, 404);
  assert.equal(authenticated, 2);
});

test("paginates a fixed migration-ledger projection beyond provider viewer limits", async () => {
  const source = Array.from({ length: 501 }, (_, index) => ({ identity: `repair:${String(index).padStart(5, "0")}`, applied_at: index + 1, source_sha256: hash(`migration-${index}`) }));
  const db = { prepare(sql) { assert.match(sql, /WITH evidence/); let bindings = []; return { bind(...values) { bindings = values; return this; }, async all() { const after = bindings[0] ?? null; return { results: source.filter((row) => after === null || row.identity > after).slice(0, 201) }; } }; } };
  const reader = createD1LedgerEvidenceReader(db, buildId);
  const pages = []; let cursor = null;
  do { const page = await reader(cursor); pages.push(page); cursor = page.nextCursor; } while (cursor !== null);
  assert.equal(completeEvidence("d1-ledger", pages).count, 501);
});

test("delivers the packaged Vinext build ID to schema and ledger page reads", async () => {
  const prior = globalThis.__PRIVATE_TESTER_PACKAGED_BUILD_ID__;
  globalThis.__PRIVATE_TESTER_PACKAGED_BUILD_ID__ = buildId;
  const schemaRows = [{ type: "table", name: "objects", tbl_name: "objects", sql: "CREATE TABLE objects(id TEXT)" }];
  const ledgerRows = [{ identity: "repair:0001", applied_at: 1, source_sha256: hash("migration") }];
  const runtime = createPrivateTesterBaselineRuntime({
    DB: { prepare(sql) { let values = []; return { bind(...bound) { values = bound; return this; }, async all() { return { results: sql.includes("sqlite_schema") ? schemaRows.filter((row) => values[0] === undefined || `table\u0000${row.name}\u0000${row.tbl_name}` > values[0]) : ledgerRows.filter((row) => values[0] === undefined || row.identity > values[0]) }; } }; } },
    PRIVATE_TESTER_BASELINE_RELEASE_JSON: JSON.stringify({ releaseId: "rel_20260818_private_03", commitSha: "a".repeat(40), sitesVersion: "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_example", startsAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-25T00:00:00.000Z", products: ["nearfamily", "nearstory"] }),
    GOOGLE_CLIENT_ID: "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com",
    BETTER_AUTH_URL: "https://nearyoustill.com", PUBLIC_APP_URL: "https://nearyoustill.com",
    NEARYOU_ENABLE_STORY: "false", NEARYOU_ENABLE_LEGACY_ARCHIVE: "false", PRIVATE_TESTER_SCHEDULER_ENABLED: "false",
  }, { expectedD1SchemaDefinitionHash: hash("reviewed"), expectedD1SchemaObjectCount: 1 });
  try {
    for (const kind of ["d1-schema-page", "d1-ledger-page"]) {
      const page = await runtime.read(kind);
      assert.equal(page.buildId, buildId);
      assert.equal(page.nextCursor, null);
    }
  } finally {
    if (prior === undefined) delete globalThis.__PRIVATE_TESTER_PACKAGED_BUILD_ID__;
    else globalThis.__PRIVATE_TESTER_PACKAGED_BUILD_ID__ = prior;
  }
});
