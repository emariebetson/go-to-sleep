import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capturePrivateTesterBaseline, createAuthenticatedProductionReaders } from "../scripts/capture-private-tester-baseline.ts";

const now = Date.parse("2026-08-14T18:00:00.000Z");
const identity = "principal://near-prod/private-tester-reader";
const release = () => ({ releaseId: "rel_20260814_private_01", commitSha: "a".repeat(40), sitesVersion: "appgprj_example~appgver_example", startsAt: "2026-08-14T18:00:00.000Z", expiresAt: "2026-08-21T18:00:00.000Z", products: ["nearfamily", "nearstory"] });
const ledger = [{ id: "0015_platform_release_foundation", checksum: "b".repeat(64) }, { id: "0016_existing_head", checksum: "c".repeat(64) }];
const observed = (body, overrides = {}) => ({ provider: "test-reader", observedAt: now, identity, body, ...overrides });
const readers = (overrides = {}) => ({
  sites: { readVersion: async () => observed({ version: "appgprj_example~appgver_example" }), readRollbackVersion: async () => observed({ version: "appgprj_example~appgver_rollback" }) },
  d1: { readLedger: async () => observed({ ledger }), readSchema: async () => observed({ schema: "site_creator", tables: [{ name: "accounts", sqlHash: "d".repeat(64) }, { name: "families", sqlHash: "e".repeat(64) }] }) },
  postgres: { readMigrations: async () => observed({ ledger }), readCatalog: async () => observed({ schema: "nearyou", relations: [{ name: "household_members", kind: "table", checksum: "f".repeat(64) }] }) },
  dns: { readIdentifiers: async () => observed({ records: [{ name: "nearyoustill.com", recordId: "dns-record-01", type: "A" }] }) },
  oauth: { readIdentifiers: async () => observed({ issuer: "https://accounts.google.com", audience: "nearyou-production", clientId: "oauth-client-01" }) },
  bindings: { read: async () => observed({ bindings: [{ name: "D1", resource: "site-creator-d1" }, { name: "READINESS_PG", resource: "readiness-pg" }] }) },
  secretManager: { listVersions: async () => observed({ versions: ["projects/near-prod/secrets/nearstory-api/versions/12", "projects/near-prod/secrets/oauth-client/versions/3"] }) },
  gates: { read: async () => observed({ nearfamily: false, nearstory: false, scheduler: false }) }, ...overrides,
});
async function input(overrides = {}) { const dir = await mkdtemp(join(tmpdir(), "private-tester-baseline-")); return { release: release(), expectedD1Ledger: ledger, outputPath: join(dir, "baseline.json"), nowMs: now, readers: readers(), ...overrides }; }

test("captures canonical observed evidence without serializing a rejected secret sentinel", async () => {
  const options = await input(); const baseline = await capturePrivateTesterBaseline(options); const written = JSON.parse(await readFile(options.outputPath, "utf8"));
  assert.deepEqual(written, baseline); assert.equal(baseline.sites.version, "appgprj_example~appgver_example"); assert.equal(baseline.sites.rollbackVersion, "appgprj_example~appgver_rollback"); assert.match(baseline.d1.ledgerHash, /^[a-f0-9]{64}$/); assert.match(baseline.postgres.catalogHash, /^[a-f0-9]{64}$/); assert.equal(baseline.observations.dns.identity, identity);
  const sentinel = "do-not-print-this-secret"; const rejected = await input({ readers: readers({ dns: { readIdentifiers: async () => observed({ records: [{ name: "nearyoustill.com", recordId: "dns-record-01", type: "A", clientSecret: sentinel }] }) } }) });
  await assert.rejects(() => capturePrivateTesterBaseline(rejected), /baseline invalid/); assert.equal(await readFile(rejected.outputPath).catch(() => ""), "");
});
test("rejects missing rollback, identical rollback, and a Sites version not bound to the release", async () => {
  for (const sites of [
    { readVersion: async () => observed({ version: "appgprj_example~appgver_example" }), readRollbackVersion: async () => observed({}) },
    { readVersion: async () => observed({ version: "appgprj_example~appgver_example" }), readRollbackVersion: async () => observed({ version: "appgprj_example~appgver_example" }) },
    { readVersion: async () => observed({ version: "appgprj_example~appgver_other" }), readRollbackVersion: async () => observed({ version: "appgprj_example~appgver_rollback" }) },
  ]) { const options = await input({ readers: readers({ sites }) }); await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/); }
});
test("rejects aliases, enabled gates, stale observations, and nonexact D1 ledgers", async () => {
  const cases = [
    { secretManager: { listVersions: async () => observed({ versions: ["projects/near-prod/secrets/nearstory-api/versions/latest"] }) } },
    { gates: { read: async () => observed({ nearfamily: true, nearstory: false, scheduler: false }) } },
    { dns: { readIdentifiers: async () => observed({ records: [{ name: "nearyoustill.com", recordId: "dns-record-01", type: "A" }] }, { observedAt: now - 300_001 }) } },
    { d1: { readLedger: async () => observed({ ledger: ledger.slice(0, 1) }), readSchema: async () => observed({ schema: "site_creator", tables: [{ name: "accounts", sqlHash: "d".repeat(64) }] }) } },
    { d1: { readLedger: async () => observed({ ledger: [...ledger, { id: "0017_unreviewed", checksum: "d".repeat(64) }] }), readSchema: async () => observed({ schema: "site_creator", tables: [{ name: "accounts", sqlHash: "d".repeat(64) }] }) } },
  ];
  for (const patch of cases) { const options = await input({ readers: readers(patch) }); await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/); }
});
test("rejects empty, arbitrary, accessor, sparse, and exotic array evidence", async () => {
  const sparse = []; sparse[1] = { id: "0016_existing_head", checksum: "c".repeat(64) };
  const accessor = [{ id: "0015_platform_release_foundation", checksum: "b".repeat(64) }]; Object.defineProperty(accessor, "0", { enumerable: true, get: () => ledger[0] });
  const exotic = [...ledger]; Object.setPrototypeOf(exotic, null);
  const symbol = [...ledger]; symbol[Symbol("hidden")] = true;
  for (const value of [[], { ledger }, sparse, accessor, exotic, symbol]) { const options = await input({ readers: readers({ d1: { readLedger: async () => observed({ ledger: value }), readSchema: async () => observed({ schema: "site_creator", tables: [{ name: "accounts", sqlHash: "d".repeat(64) }] }) } }) }); await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/); }
});
test("pins the gateway audience and rejects a response with the wrong identity", async () => {
  const artifact = readFileSync(new URL("../infra/production/cloud-sql-auth-proxy.args", import.meta.url), "utf8"), checksum = createHash("sha256").update(artifact).digest("hex");
  const environment = { PRIVATE_TESTER_GCP_PROJECT: "near-prod", PRIVATE_TESTER_DNS_ZONE: "near-zone", PRIVATE_TESTER_OAUTH_PROVIDER: "google", PRIVATE_TESTER_READER_IDENTITY: identity, READINESS_CONTROL_DATABASE_URL: "postgresql://reader@127.0.0.1:5432/nearyou?sslmode=disable", CLOUD_SQL_IAM_CONNECTOR: "cloud-sql-auth-proxy", CLOUD_SQL_INSTANCE_CONNECTION_NAME: "near-prod:us-central1:nearyou", CLOUD_SQL_PROXY_ARGS_CHECKSUM: checksum, NEARYOU_READINESS_DATABASE_USER: "reader" };
  const seen = []; const fetch = async (url, init = {}) => { seen.push([String(url), init]); if (String(url).includes("metadata.google.internal")) return new Response("a.b.c", { status: 200 }); return new Response(JSON.stringify({ identity: "principal://wrong/reader", audience: "https://private-tester-read.nearyoustill.com", observedAt: now, body: { version: "appgprj_example~appgver_example" } }), { status: 200 }); };
  const read = createAuthenticatedProductionReaders(environment, { fetch, now: () => now }); await assert.rejects(() => read.sites.readVersion(), /reader unavailable/);
  assert.equal(seen[1][0], "https://private-tester-read.nearyoustill.com/private-tester-baseline/sites-version"); assert.match(String(seen[1][1].headers.authorization), /^Bearer a\.b\.c$/);
});
test("rejects missing observations and nonempty schema records that are malformed or incomplete", async () => {
  const cases = [
    { oauth: { readIdentifiers: async () => ({ issuer: "https://accounts.google.com", audience: "nearyou-production", clientId: "oauth-client-01" }) } },
    { d1: { readLedger: async () => observed({ ledger }), readSchema: async () => observed({ schema: "site_creator", tables: [] }) } },
    { postgres: { readMigrations: async () => observed({ ledger }), readCatalog: async () => observed({ schema: "nearyou", relations: [] }) } },
    { dns: { readIdentifiers: async () => observed({ records: [] }) } },
    { bindings: { read: async () => observed({ bindings: [] }) } },
    { oauth: { readIdentifiers: async () => observed({ issuer: "https://accounts.google.com", audience: "nearyou-production", clientId: "oauth-client-01", unexpected: true }) } },
  ];
  for (const patch of cases) { const options = await input({ readers: readers(patch) }); await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/); }
});
test("rejects an output path that already exists", async () => { const options = await input(); await writeFile(options.outputPath, "existing evidence\n"); await assert.rejects(() => capturePrivateTesterBaseline(options), /EEXIST|baseline invalid/); });
