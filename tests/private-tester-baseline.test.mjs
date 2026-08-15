import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capturePrivateTesterBaseline, createAuthenticatedProductionReaders } from "../scripts/capture-private-tester-baseline.ts";
import { verifyPrivateTesterD1SourceBaseline } from "../scripts/private-tester-d1-source.ts";

const now = Date.parse("2026-08-14T18:00:00.000Z");
const identity = "principal://near-prod/private-tester-reader";
const googleClientId = "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com";
const workerRuntime = Object.freeze({ id: "11111111-1111-4111-8111-111111111111", commitSha: "a".repeat(40), deployedAt: "2026-08-14T17:59:00.000Z" });
const release = () => ({ releaseId: "rel_20260814_private_01", commitSha: "a".repeat(40), sitesVersion: "appgprj_example~appgver_example", startsAt: "2026-08-14T18:00:00.000Z", expiresAt: "2026-08-21T18:00:00.000Z", products: ["nearfamily", "nearstory"] });
const ledger = Object.freeze([{ id: "0015_platform_release_foundation", checksum: "b".repeat(64) }, { id: "0016_existing_head", checksum: "c".repeat(64) }]);
const reviewedSourceHash = createHash("sha256").update(JSON.stringify([{ name: "0000_nearnight_foundation.sql", checksum: "a".repeat(64) }, ...ledger.map(({ id, checksum }) => ({ name: `${id}.sql`, checksum }))])).digest("hex");
const appliedMigrations = Object.freeze([
  { sequence: 1, name: "0015_platform_release_foundation.sql", appliedAt: "2026-08-14 17:50:00" },
  { sequence: 2, name: "0016_existing_head.sql", appliedAt: "2026-08-14 17:51:00" },
]);
const schemaObjects = Object.freeze([
  { type: "index", name: "accounts_email_idx", tableName: "accounts", rootPage: 3, sql: "CREATE INDEX accounts_email_idx ON accounts(email)" },
  { type: "index", name: "sqlite_autoindex_accounts_1", tableName: "accounts", rootPage: 4, sql: null },
  { type: "index", name: "sqlite_autoindex_d1_migrations_1", tableName: "d1_migrations", rootPage: 7, sql: null },
  { type: "table", name: "_cf_METADATA", tableName: "_cf_METADATA", rootPage: 5, sql: "CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY,value BLOB)" },
  { type: "table", name: "accounts", tableName: "accounts", rootPage: 2, sql: "CREATE TABLE accounts(id TEXT PRIMARY KEY,email TEXT)" },
  { type: "table", name: "d1_migrations", tableName: "d1_migrations", rootPage: 6, sql: "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT UNIQUE,applied_at TIMESTAMP)" },
  { type: "table", name: "sqlite_sequence", tableName: "sqlite_sequence", rootPage: 8, sql: "CREATE TABLE sqlite_sequence(name,seq)" },
  { type: "table", name: "sqlite_stat1", tableName: "sqlite_stat1", rootPage: 9, sql: "CREATE TABLE sqlite_stat1(tbl,idx,stat)" },
  { type: "trigger", name: "accounts_touch", tableName: "accounts", rootPage: 0, sql: "CREATE TRIGGER accounts_touch AFTER UPDATE ON accounts BEGIN SELECT 1; END" },
  { type: "view", name: "account_ids", tableName: "account_ids", rootPage: 0, sql: "CREATE VIEW account_ids AS SELECT id FROM accounts" },
]);
const providerInternalTables = new Set(["_cf_METADATA", "d1_migrations", "sqlite_sequence", "sqlite_stat1"]);
const sourceSchemaObjects = schemaObjects.filter(({ tableName }) => !providerInternalTables.has(tableName));
const schemaDefinitionHash = createHash("sha256").update(JSON.stringify(sourceSchemaObjects.map(({ rootPage, ...object }) => { void rootPage; return object; }))).digest("hex");
const controlPlane = () => ({
  projectId: "appgprj_example",
  current: { version: "appgprj_example~appgver_example", commitSha: "a".repeat(40) },
  rollback: { version: "appgprj_example~appgver_rollback", commitSha: "f".repeat(40) },
  resources: [
    { binding: "AUDIO", kind: "r2", resourceId: "r2/buckets/nearyou-audio-production" },
    { binding: "DB", kind: "d1", resourceId: "d1/databases/22222222-2222-4222-8222-222222222222" },
  ],
});
const observed = (body, overrides = {}) => ({ provider: "test-reader", observedAt: now, identity, body, ...overrides });
const runtimeObserved = (body, overrides = {}) => observed(body, { provider: "sites-runtime", workerRuntime, ...overrides });
const readers = (overrides = {}) => ({
  controlPlane: { read: async () => observed(controlPlane(), { provider: "sites-control-plane" }) },
  d1: { readLedger: async () => runtimeObserved({ appliedMigrations }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: schemaObjects }) },
  postgres: { readMigrations: async () => observed({ ledger }), readCatalog: async () => observed({ schema: "nearyou", relations: [{ name: "household_members", kind: "table", checksum: "f".repeat(64) }] }) },
  dns: { readIdentifiers: async () => observed({ records: [{ name: "nearyoustill.com", recordId: "dns-record-01", type: "A" }] }) },
  oauth: { readIdentifiers: async () => runtimeObserved({ issuer: "https://accounts.google.com", audience: googleClientId, clientId: googleClientId, providerAcceptedRedirectUri: "https://nearyoustill.com/api/auth/callback/google", proof: "interaction_required" }) },
  secretManager: { listVersions: async () => observed({ versions: ["projects/near-prod/secrets/nearstory-api/versions/12", "projects/near-prod/secrets/oauth-client/versions/3"] }) },
  gates: { read: async () => runtimeObserved({ nearfamily: false, nearstory: false, scheduler: false }) },
  ...overrides,
});
async function input(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "private-tester-baseline-"));
  return { release: release(), expectedD1Ledger: ledger, expectedD1SourceHash: reviewedSourceHash, expectedD1SchemaDefinitionHash: schemaDefinitionHash, expectedD1SchemaObjectCount: sourceSchemaObjects.length, outputPath: join(dir, "baseline.json"), now: () => now, readers: readers(), ...overrides };
}
function productionEnvironment() {
  const instance = "nearnight:us-central1:nearyou-production";
  const artifact = readFileSync(new URL("../infra/production/cloud-sql-auth-proxy.args", import.meta.url), "utf8").replace("${CLOUD_SQL_INSTANCE_CONNECTION_NAME}", instance);
  return { PRIVATE_TESTER_GCP_PROJECT: "near-prod", PRIVATE_TESTER_DNS_ZONE: "near-zone", PRIVATE_TESTER_READER_SUBJECT: "109876543210987654321", READINESS_CONTROL_DATABASE_URL: "postgresql://nearyou-readiness-ctl%40nearnight.iam.gserviceaccount.com@127.0.0.1:5432/nearyou?sslmode=disable", CLOUD_SQL_IAM_CONNECTOR: "cloud-sql-auth-proxy", CLOUD_SQL_INSTANCE_CONNECTION_NAME: instance, CLOUD_SQL_PROXY_ARGS_CHECKSUM: createHash("sha256").update(artifact).digest("hex"), NEARYOU_READINESS_DATABASE_USER: "nearyou-readiness-ctl@nearnight.iam.gserviceaccount.com" };
}

test("mechanically regenerates the reviewed 0000-0016 D1 source schema manifest", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../infra/production/private-tester-d1-schema-baseline.json", import.meta.url), "utf8"));
  const verified = await verifyPrivateTesterD1SourceBaseline();
  assert.equal(verified.sources.length, 17);
  assert.equal(verified.sources[0].id, "0000_nearnight_foundation");
  assert.equal(verified.sources[16].id, "0016_marketing_waitlist");
  assert.equal(verified.sourceHash, manifest.migration_sources_sha256);
  assert.equal(verified.schemaObjectCount, manifest.sqlite_schema_source_object_count);
  assert.equal(verified.schemaDefinitionHash, manifest.sqlite_schema_source_definitions_sha256);
  assert.deepEqual(verified.providerInternalTableNames, manifest.provider_internal_table_names);

  for (const patch of [
    { migration_range: "0001-0016" },
    { wrangler_version: "4.91.0" },
    { sqlite_schema_source_object_count: 670 },
    { unexpected: true },
  ]) await assert.rejects(() => verifyPrivateTesterD1SourceBaseline({ manifest: { ...manifest, ...patch } }), /source baseline invalid/);
});

test("captures provider-bound Sites resources and exact live D1 state without claiming OAuth origins", async () => {
  const options = await input();
  const baseline = await capturePrivateTesterBaseline(options);
  const written = JSON.parse(await readFile(options.outputPath, "utf8"));
  assert.deepEqual(written, baseline);
  assert.deepEqual(baseline.sites.current, controlPlane().current);
  assert.deepEqual(baseline.sites.rollback, controlPlane().rollback);
  assert.deepEqual(baseline.sites.resources, controlPlane().resources);
  assert.deepEqual(baseline.sites.workerRuntime, workerRuntime);
  assert.deepEqual(baseline.d1.appliedMigrations, appliedMigrations);
  assert.match(baseline.d1.appliedLedgerHash, /^[a-f0-9]{64}$/);
  assert.match(baseline.d1.schemaHash, /^[a-f0-9]{64}$/);
  assert.equal(baseline.d1.reviewedSourceHash, reviewedSourceHash);
  assert.equal(baseline.d1.schemaObjectCount, schemaObjects.length);
  assert.equal(baseline.d1.sourceSchemaDefinitionHash, schemaDefinitionHash);
  assert.equal(baseline.d1.sourceSchemaObjectCount, sourceSchemaObjects.length);
  assert.equal(baseline.d1.providerInternalSchemaObjectCount, schemaObjects.length - sourceSchemaObjects.length);
  assert.match(baseline.d1.providerInternalSchemaHash, /^[a-f0-9]{64}$/);
  assert.equal(baseline.oauth.providerAcceptedRedirectUri, "https://nearyoustill.com/api/auth/callback/google");
  assert.equal(Object.hasOwn(baseline.oauth, "authorizedOrigins"), false);
});

test("rejects self-asserted Sites versions and binding labels without provider resource identities", async () => {
  const cases = [
    { ...controlPlane(), current: { ...controlPlane().current, version: "appgprj_example~appgver_other" } },
    { ...controlPlane(), current: { ...controlPlane().current, commitSha: "e".repeat(40) } },
    { ...controlPlane(), rollback: { ...controlPlane().current } },
    { ...controlPlane(), resources: [{ binding: "AUDIO", kind: "r2", resourceId: "AUDIO" }, controlPlane().resources[1]] },
    { ...controlPlane(), resources: [controlPlane().resources[0], { binding: "DB", kind: "d1", resourceId: "sites:d1:DB" }] },
  ];
  for (const body of cases) {
    const options = await input({ readers: readers({ controlPlane: { read: async () => observed(body, { provider: "sites-control-plane" }) } }) });
    await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
    assert.equal(await readFile(options.outputPath).catch(() => ""), "");
  }
});

test("production readers fail closed when no authenticated Sites control-plane API can supply current deployment and resource IDs", async () => {
  const production = createAuthenticatedProductionReaders(productionEnvironment(), { now: () => now, fetch: async () => { throw new Error("must not synthesize control-plane truth"); } }, release());
  await assert.rejects(() => production.controlPlane.read(), /control-plane unavailable/);
});

test("pins the runtime gateway audience and rejects a response with the wrong authenticated subject", async () => {
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push([String(url), init]);
    if (String(url).includes("metadata.google.internal")) return new Response("a.b.c", { status: 200 });
    return new Response(JSON.stringify({ issuer: "https://accounts.google.com", audience: "https://nearyoustill.com", subject: "999999999999999999999", principal: "service:999999999999999999999", observedAt: now, release: release(), workerRuntime, body: { appliedMigrations } }), { status: 200 });
  };
  const production = createAuthenticatedProductionReaders(productionEnvironment(), { fetch, now: () => now }, release());
  await assert.rejects(() => production.d1.readLedger(), /reader unavailable/);
  assert.equal(seen[1][0], "https://nearyoustill.com/api/internal/private-tester-baseline/d1-ledger");
  assert.match(String(seen[1][1].headers.authorization), /^Bearer a\.b\.c$/);
  assert.match(seen[0][0], /audience=https%3A%2F%2Fnearyoustill\.com/);
  assert.match(seen[0][0], /format=standard/);
});

test("accepts the bounded complete sqlite_schema gateway response above the former 256 KiB cap", async () => {
  const objects = Array.from({ length: 676 }, (_, index) => ({
    type: "table",
    name: `table_${String(index).padStart(3, "0")}`,
    tableName: `table_${String(index).padStart(3, "0")}`,
    rootPage: index + 2,
    sql: `CREATE TABLE table_${String(index).padStart(3, "0")}(value TEXT CHECK(value <> '${"x".repeat(420)}'))`,
  }));
  const payload = JSON.stringify({ issuer: "https://accounts.google.com", audience: "https://nearyoustill.com", subject: "109876543210987654321", principal: "service:109876543210987654321", observedAt: now, release: release(), workerRuntime, body: { schema: "sqlite_schema", objects } });
  assert.ok(payload.length > 262_144);
  assert.ok(payload.length < 1_048_576);
  const fetch = async (url) => String(url).includes("metadata.google.internal")
    ? new Response("a.b.c", { status: 200 })
    : new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
  const value = await createAuthenticatedProductionReaders(productionEnvironment(), { fetch, now: () => now }, release()).d1.readSchema();
  assert.equal(value.body.objects.length, 676);
});

test("rejects altered live migration fields or any schema object drift from reviewed source", async () => {
  const cases = [
    { d1: { readLedger: async () => runtimeObserved({ appliedMigrations: [{ ...appliedMigrations[0], sequence: 7 }, appliedMigrations[1]] }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: schemaObjects }) } },
    { d1: { readLedger: async () => runtimeObserved({ appliedMigrations: [{ ...appliedMigrations[0], appliedAt: "" }, appliedMigrations[1]] }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: schemaObjects }) } },
    { d1: { readLedger: async () => runtimeObserved({ appliedMigrations }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: schemaObjects.filter((object) => object.type !== "trigger") }) } },
    { d1: { readLedger: async () => runtimeObserved({ appliedMigrations }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: schemaObjects.map((object) => object.type === "index" ? { ...object, sql: `${object.sql} DESC` } : object) }) } },
  ];
  for (const patch of cases) {
    const options = await input({ readers: readers(patch) });
    await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
  }
});

test("rejects synthesized origins and any nonexact OAuth redirect-proof contract", async () => {
  const valid = { issuer: "https://accounts.google.com", audience: googleClientId, clientId: googleClientId, providerAcceptedRedirectUri: "https://nearyoustill.com/api/auth/callback/google", proof: "interaction_required" };
  const cases = [
    { ...valid, authorizedOrigins: ["https://nearyoustill.com"] },
    { ...valid, issuer: "https://issuer.example" },
    { ...valid, providerAcceptedRedirectUri: "https://attacker.example/api/auth/callback/google" },
    { ...valid, providerAcceptedRedirectUri: "https://nearyoustill.com/api/auth/callback/wrong" },
    { ...valid, proof: "access_denied" },
    { ...valid, code: "forbidden" },
  ];
  for (const body of cases) {
    const options = await input({ readers: readers({ oauth: { readIdentifiers: async () => runtimeObserved(body) } }) });
    await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
  }
});

test("uses a post-read capture time and rejects observation windows stale or future relative to it", async () => {
  let clock = now;
  const fresh = await input({ now: () => clock, readers: readers({ gates: { read: async () => { clock = now + 120_000; return runtimeObserved({ nearfamily: false, nearstory: false, scheduler: false }, { observedAt: clock }); } } }) });
  assert.equal((await capturePrivateTesterBaseline(fresh)).capturedAt, now + 120_000);

  for (const { finalTime, observedAt } of [{ finalTime: now + 300_000, observedAt: now - 1 }, { finalTime: now, observedAt: now + 30_001 }]) {
    const clock = [now, finalTime];
    const freshRuntime = { ...workerRuntime, deployedAt: new Date(finalTime - 60_000).toISOString() };
    const atFinal = (body, overrides = {}) => observed(body, { observedAt: finalTime, ...overrides });
    const atFinalRuntime = (body) => atFinal(body, { provider: "sites-runtime", workerRuntime: freshRuntime });
    const options = await input({ now: () => clock.shift() ?? finalTime, readers: readers({
      controlPlane: { read: async () => observed(controlPlane(), { provider: "sites-control-plane", observedAt }) },
      d1: { readLedger: async () => atFinalRuntime({ appliedMigrations }), readSchema: async () => atFinalRuntime({ schema: "sqlite_schema", objects: schemaObjects }) },
      postgres: { readMigrations: async () => atFinal({ ledger }), readCatalog: async () => atFinal({ schema: "nearyou", relations: [{ name: "household_members", kind: "table", checksum: "f".repeat(64) }] }) },
      dns: { readIdentifiers: async () => atFinal({ records: [{ name: "nearyoustill.com", recordId: "dns-record-01", type: "A" }] }) },
      oauth: { readIdentifiers: async () => atFinalRuntime({ issuer: "https://accounts.google.com", audience: googleClientId, clientId: googleClientId, providerAcceptedRedirectUri: "https://nearyoustill.com/api/auth/callback/google", proof: "interaction_required" }) },
      secretManager: { listVersions: async () => atFinal({ versions: ["projects/near-prod/secrets/nearstory-api/versions/12"] }) },
      gates: { read: async () => atFinalRuntime({ nearfamily: false, nearstory: false, scheduler: false }) },
    }) });
    await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
  }
});

test("rejects aliases, enabled gates, missing observations, and nonexact reviewed D1 ledgers", async () => {
  const cases = [
    { secretManager: { listVersions: async () => observed({ versions: ["projects/near-prod/secrets/nearstory-api/versions/latest"] }) } },
    { gates: { read: async () => runtimeObserved({ nearfamily: true, nearstory: false, scheduler: false }) } },
    { dns: { readIdentifiers: async () => ({ records: [] }) } },
    { d1: { readLedger: async () => runtimeObserved({ appliedMigrations: appliedMigrations.slice(0, 1) }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: schemaObjects }) } },
  ];
  for (const patch of cases) {
    const options = await input({ readers: readers(patch) });
    await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
  }
});

test("rejects sparse, accessor-backed, and secret-bearing evidence without creating an artifact", async () => {
  const sparse = [];
  sparse[1] = appliedMigrations[1];
  const accessor = [...appliedMigrations];
  Object.defineProperty(accessor, "0", { enumerable: true, get: () => appliedMigrations[0] });
  for (const value of [sparse, accessor]) {
    const options = await input({ readers: readers({ d1: { readLedger: async () => runtimeObserved({ appliedMigrations: value }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: schemaObjects }) } }) });
    await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
    assert.equal(await readFile(options.outputPath).catch(() => ""), "");
  }
  const secret = await input({ readers: readers({ dns: { readIdentifiers: async () => observed({ records: [{ name: "nearyoustill.com", recordId: "dns-record-01", type: "A", clientSecret: "do-not-serialize" }] }) } }) });
  await assert.rejects(() => capturePrivateTesterBaseline(secret), /baseline invalid/);
  assert.equal(await readFile(secret.outputPath).catch(() => ""), "");
});

test("enumerates only explicit reviewed secret parents with complete bounded pagination", async () => {
  const providerUrls = [];
  const fetch = async (inputUrl) => {
    const url = String(inputUrl);
    if (url.includes("metadata.google.internal") && url.endsWith("/token")) return new Response(JSON.stringify({ access_token: "x".repeat(24), expires_in: 300 }), { status: 200 });
    providerUrls.push(url);
    const parent = /\/secrets\/([^/]+)\/versions/.exec(url)?.[1];
    const page = new URL(url).searchParams.get("pageToken");
    const body = parent === "nearyou-prod-app" && !page ? { versions: [{ name: "projects/near-prod/secrets/nearyou-prod-app/versions/7", state: "ENABLED" }], nextPageToken: "next_app" } : { versions: [{ name: `projects/near-prod/secrets/${parent}/versions/${page ? 8 : 3}`, state: "ENABLED" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const value = await createAuthenticatedProductionReaders(productionEnvironment(), { fetch, now: () => now }, release()).secretManager.listVersions();
  assert.equal(value.body.versions.length, 5);
  assert.equal(value.observedAt, now);
  assert.deepEqual(new Set(providerUrls.map((url) => /\/secrets\/([^/]+)\/versions/.exec(url)?.[1])), new Set(["nearyou-prod-app", "nearyou-prod-legacy", "nearyou-prod-pad", "nearyou-prod-migration-admin"]));
  assert.equal(providerUrls.some((url) => url.includes("/secrets/-/versions")), false);
  assert.equal(providerUrls.filter((url) => url.includes("nearyou-prod-app")).length, 2);
});

test("reads every DNS page and retains exact safe NS and SOA projections", async () => {
  const pages = [];
  const fetch = async (inputUrl) => {
    const url = String(inputUrl);
    if (url.includes("metadata.google.internal") && url.endsWith("/token")) return new Response(JSON.stringify({ access_token: "x".repeat(24), expires_in: 300 }), { status: 200 });
    pages.push(url);
    const token = new URL(url).searchParams.get("pageToken");
    return new Response(JSON.stringify(token ? { rrsets: [{ name: "www.nearyoustill.com.", type: "CNAME", ttl: 300, rrdatas: ["custom-domains.chatgpt.site."] }] } : { rrsets: [{ name: "nearyoustill.com.", type: "NS", ttl: 300, rrdatas: ["curitiba.ns.porkbun.com."] }, { name: "nearyoustill.com.", type: "SOA", ttl: 300, rrdatas: ["curitiba.ns.porkbun.com. dns.cloudflare.com. 1 10800 3600 604800 300"] }], nextPageToken: "dns_page_2" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const value = await createAuthenticatedProductionReaders(productionEnvironment(), { fetch, now: () => now }, release()).dns.readIdentifiers();
  assert.deepEqual(value.body.records.map((record) => record.type), ["NS", "SOA", "CNAME"]);
  assert.equal(pages.length, 2);
  assert.match(pages[0], /maxResults=1000/);
  assert.match(pages[1], /pageToken=dns_page_2/);
  assert.deepEqual(Object.keys(value.body.records[0]).sort(), ["name", "recordId", "type"]);
});

test("rejects an output path that already exists", async () => {
  const options = await input();
  await writeFile(options.outputPath, "existing evidence\n");
  await assert.rejects(() => capturePrivateTesterBaseline(options), /EEXIST|baseline invalid/);
});
