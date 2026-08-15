import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capturePrivateTesterBaseline } from "../scripts/capture-private-tester-baseline.ts";

const now = Date.parse("2026-08-14T18:00:00.000Z");
const release = () => ({
  releaseId: "rel_20260814_private_01", commitSha: "a".repeat(40), sitesVersion: "appgprj_example~appgver_example",
  startsAt: "2026-08-14T18:00:00.000Z", expiresAt: "2026-08-21T18:00:00.000Z", products: ["nearfamily", "nearstory"],
});
const ledger = [{ id: "0015_platform_release_foundation", checksum: "b".repeat(64) }, { id: "0016_existing_head", checksum: "c".repeat(64) }];
const readers = (overrides = {}) => ({
  sites: { readVersion: async () => ({ version: "appgprj_example~appgver_example" }), readRollbackVersion: async () => ({ version: "appgprj_example~appgver_rollback" }) },
  d1: { readLedger: async () => ledger, readSchema: async () => ({ tables: ["accounts", "families"] }) },
  postgres: { readMigrations: async () => ledger, readCatalog: async () => ({ schema: "nearyou", version: "16" }) },
  dns: { readIdentifiers: async () => [{ name: "nearyoustill.com", recordId: "dns-record-01" }] },
  oauth: { readIdentifiers: async () => ({ issuer: "https://accounts.google.com", audience: "nearyou-production", clientId: "oauth-client-01" }) },
  bindings: { read: async () => ({ D1: "site-creator-d1", READINESS_PG: "readiness-pg" }) },
  secretManager: { listVersions: async () => ["projects/near-prod/secrets/nearstory-api/versions/12", "projects/near-prod/secrets/oauth-client/versions/3"] },
  gates: { read: async () => ({ nearfamily: false, nearstory: false, scheduler: false }) }, ...overrides,
});
async function input(overrides = {}) { const dir = await mkdtemp(join(tmpdir(), "private-tester-baseline-")); return { release: release(), expectedD1Ledger: ledger, outputPath: join(dir, "baseline.json"), nowMs: now, readers: readers(), ...overrides }; }

test("captures a canonical, immutable baseline without secret values", async () => {
  const options = await input(); const baseline = await capturePrivateTesterBaseline(options); const written = JSON.parse(await readFile(options.outputPath, "utf8"));
  assert.deepEqual(written, baseline); assert.equal(baseline.sites.version, "appgprj_example~appgver_example"); assert.equal(baseline.sites.rollbackVersion, "appgprj_example~appgver_rollback");
  assert.match(baseline.d1.ledgerHash, /^[a-f0-9]{64}$/); assert.match(baseline.postgres.catalogHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(baseline.secretVersions, ["projects/near-prod/secrets/nearstory-api/versions/12", "projects/near-prod/secrets/oauth-client/versions/3"]); assert.equal(JSON.stringify(baseline).includes("do-not-print-this"), false);
});
test("rejects a missing rollback Sites version", async () => {
  const options = await input({ readers: readers({ sites: { readVersion: async () => ({ version: "appgprj_example~appgver_example" }), readRollbackVersion: async () => ({}) } }) });
  await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
});
test("rejects secret aliases instead of exact numeric Secret Manager versions", async () => {
  const options = await input({ readers: readers({ secretManager: { listVersions: async () => ["projects/near-prod/secrets/nearstory-api/versions/latest"] } }) }); await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
});
test("rejects enabled product or scheduler gates", async () => {
  for (const gates of [{ nearfamily: true, nearstory: false, scheduler: false }, { nearfamily: false, nearstory: true, scheduler: false }, { nearfamily: false, nearstory: false, scheduler: true }]) { const options = await input({ readers: readers({ gates: { read: async () => gates } }) }); await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/); }
});
test("rejects D1 ledgers beyond or below the observed baseline", async () => {
  for (const observed of [ledger.slice(0, 1), [...ledger, { id: "0017_unreviewed", checksum: "d".repeat(64) }]]) { const options = await input({ readers: readers({ d1: { readLedger: async () => observed, readSchema: async () => ({ tables: ["accounts", "families"] }) } }) }); await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/); }
});
test("rejects an output path that already exists", async () => {
  const options = await input(); await writeFile(options.outputPath, "existing evidence\n"); await assert.rejects(() => capturePrivateTesterBaseline(options), /EEXIST|baseline invalid/);
});
test("rejects descriptor-hostile evidence instead of invoking accessors", async () => {
  const hostile = {}; Object.defineProperty(hostile, "version", { enumerable: true, get: () => "appgprj_example~appgver_example" });
  const options = await input({ readers: readers({ sites: { readVersion: async () => hostile, readRollbackVersion: async () => ({ version: "appgprj_example~appgver_rollback" }) } }) }); await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
});
