import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPrivateTesterBaselineRuntime } from "../lib/private-tester-baseline-gateway.ts";
import { completeEvidence, readEvidencePage } from "../lib/private-tester-sites-evidence.ts";
import { privateTesterDeploymentManifestSignedBytes } from "../lib/private-tester-deployment-manifest.ts";
import { capturePrivateTesterBaseline, createAuthenticatedProductionReaders } from "../scripts/capture-private-tester-baseline.ts";
import { verifyPrivateTesterD1SourceBaseline } from "../scripts/private-tester-d1-source.ts";

const now = Date.parse("2026-08-14T18:00:00.000Z");
const identity = "service:109876543210987654321";
const postgresIdentity = "database:nearyou-pt-baseline@nearnight.iam";
const signerPrincipal = "ci://github/nearyou/private-tester-deployment";
const signerKeyId = "private-tester-deployment";
const projectId = `appgprj_${"a".repeat(32)}`;
const googleClientId = "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com";
const workerRuntime = Object.freeze({ id: "11111111-1111-4111-8111-111111111111", commitSha: "a".repeat(40), deployedAt: "2026-08-14T17:59:00.000Z" });
const execFile = promisify(execFileCallback);
async function archiveFor(buildId) { const root = await mkdtemp(join(tmpdir(), "private-tester-archive-")), archive = join(root, "site.tar.gz"); try { await mkdir(join(root, "dist/server"), { recursive: true }); await writeFile(join(root, "dist/server/BUILD_ID"), buildId); await writeFile(join(root, "dist/server/index.js"), `const runtime={buildId:${JSON.stringify(buildId)},deploymentVersion:${JSON.stringify(buildId)}};`); await execFile("tar", ["-czf", archive, "-C", root, "dist"]); return await readFile(archive); } finally { await rm(root, { recursive: true, force: true }); } }
const archiveBytes = await archiveFor(workerRuntime.id);
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
const workerDeployment = Object.freeze({ scriptName: `site---${projectId.slice(8)}`, deploymentId: "11111111-1111-4111-8111-111111111111", versionId: "22222222-2222-4222-8222-222222222222", percentage: 100 });
const release = () => ({ releaseId: "rel_20260814_private_01", commitSha: "a".repeat(40), sitesVersion: `${projectId}~appgver_example`, startsAt: "2026-08-14T18:00:00.000Z", expiresAt: "2026-08-21T18:00:00.000Z", products: ["nearfamily", "nearstory"] });
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
  { type: "table", name: "_cf_METADATA", tableName: "_cf_METADATA", rootPage: 5, sql: "CREATE TABLE _cf_METADATA (\n        key INTEGER PRIMARY KEY,\n        value BLOB\n      )" },
  { type: "table", name: "accounts", tableName: "accounts", rootPage: 2, sql: "CREATE TABLE accounts(id TEXT PRIMARY KEY,email TEXT)" },
  { type: "table", name: "d1_migrations", tableName: "d1_migrations", rootPage: 6, sql: "CREATE TABLE d1_migrations(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n)" },
  { type: "table", name: "sqlite_sequence", tableName: "sqlite_sequence", rootPage: 8, sql: "CREATE TABLE sqlite_sequence(name,seq)" },
  { type: "table", name: "sqlite_stat1", tableName: "sqlite_stat1", rootPage: 9, sql: "CREATE TABLE sqlite_stat1(tbl,idx,stat)" },
  { type: "trigger", name: "accounts_touch", tableName: "accounts", rootPage: 0, sql: "CREATE TRIGGER accounts_touch AFTER UPDATE ON accounts BEGIN SELECT 1; END" },
  { type: "view", name: "account_ids", tableName: "account_ids", rootPage: 0, sql: "CREATE VIEW account_ids AS SELECT id FROM accounts" },
]);
const providerInternalIdentities = new Set(["index\u0000sqlite_autoindex_d1_migrations_1\u0000d1_migrations", "table\u0000_cf_METADATA\u0000_cf_METADATA", "table\u0000d1_migrations\u0000d1_migrations", "table\u0000sqlite_sequence\u0000sqlite_sequence", "table\u0000sqlite_stat1\u0000sqlite_stat1"]);
const sourceSchemaObjects = schemaObjects.filter(({ type, name, tableName }) => !providerInternalIdentities.has(`${type}\u0000${name}\u0000${tableName}`));
const schemaDefinitionHash = createHash("sha256").update(JSON.stringify(sourceSchemaObjects.map(({ rootPage, ...object }) => { void rootPage; return object; }))).digest("hex");
const managedTables = Object.freeze(["accounts", "d1_migrations"]);
const managedTableHash = createHash("sha256").update(JSON.stringify(managedTables)).digest("hex");
const evidenceRows = (kind, count) => Array.from({ length: count }, (_, index) => ({ identity: `${kind}\u0000${String(index).padStart(3, "0")}`, sha256: createHash("sha256").update(`${kind}:${index}`).digest("hex") }));
const schemaRowsForEvidence = evidenceRows("schema", 10);
const ledgerRowsForEvidence = evidenceRows("ledger", 17);
const schemaEvidencePage = await readEvidencePage({ kind: "d1-schema", buildId: workerRuntime.id, cursor: null, readAfter: async () => schemaRowsForEvidence });
const ledgerEvidencePage = await readEvidencePage({ kind: "d1-ledger", buildId: workerRuntime.id, cursor: null, readAfter: async () => ledgerRowsForEvidence });
const schemaCompletion = completeEvidence("d1-schema", [schemaEvidencePage]);
const ledgerCompletion = completeEvidence("d1-ledger", [ledgerEvidencePage]);
const deploymentOperation = () => ({
  schemaVersion: 3,
  principal: signerPrincipal,
  keyId: signerKeyId,
  keyVersion: 7,
  releaseId: release().releaseId,
  projectId,
  live: { version: `${projectId}~appgver_example`, commitSha: "a".repeat(40) },
  rollback: { version: `${projectId}~appgver_rollback`, commitSha: "f".repeat(40) },
  resources: [
    { provider: "sites-managed", binding: "AUDIO", kind: "r2", physicalId: "unknown-managed", archiveSha256, deploymentId: "appgdep_12345678", buildId: workerRuntime.id },
    { provider: "sites-managed", binding: "DB", kind: "d1", physicalId: "unknown-managed", buildId: workerRuntime.id, schemaDigest: schemaCompletion.orderedDigest, schemaObjectCount: 10, migrationDigest: ledgerCompletion.orderedDigest, migrationCount: 17 },
  ],
});
const sitesResourceReceipt = () => {
  const hostingMetadata = { project_id: projectId, d1: "DB", r2: "AUDIO" };
  return { schema_version: 2, provider: "openai-sites-control-plane", captured_at: now, version: { id: release().sitesVersion, project_id: projectId, version_number: 7, source: { commit_sha: release().commitSha }, archive_storage: { archive_format: "tar", sediment_file_id: "sediment_12345678", content_hash: `sha256:${archiveSha256}`, size_bytes: 1234, file_count: 42 } }, deployment: { id: "appgdep_12345678", project_id: projectId, version_id: release().sitesVersion, type: "publish", status: "succeeded", url: "https://nearnight.ebetson.chatgpt.site", provider_deployment_id: "provider_12345678", env_set_revision: 3, updated_at: workerRuntime.deployedAt }, hosting_metadata: hostingMetadata, hosting_metadata_sha256: createHash("sha256").update(JSON.stringify(hostingMetadata)).digest("hex") };
};
const observed = (body, overrides = {}) => ({ provider: "test-reader", observedAt: now, identity, body, ...overrides });
const runtimeObserved = (body, overrides = {}) => {const key=Object.hasOwn(body,"appliedMigrations")?"1111111111111111-ORD":Object.hasOwn(body,"schema")?"2222222222222222-ORD":Object.hasOwn(body,"nearfamily")?"3333333333333333-ORD":"4444444444444444-ORD";return observed(body,{provider:"sites-runtime",rayId:key,...overrides})};
const postgresObserved = (body, overrides = {}) => observed(body, { provider: "cloud-sql", identity: postgresIdentity, ...overrides });
const readers = (overrides = {}) => {
  const base = {
  d1: { readLedger: async () => runtimeObserved({ appliedMigrations }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: schemaObjects }), readLedgerPage: async (cursor) => { if (cursor !== null) throw new Error("unexpected cursor"); return ledgerEvidencePage; }, readSchemaPage: async (cursor) => { if (cursor !== null) throw new Error("unexpected cursor"); return schemaEvidencePage; } },
  runtime: (() => { let calls = 0; const html = `{\\"deploymentVersion\\":\\"${workerRuntime.id}\\"}`; return { readHtml: async () => runtimeObserved({ html }, { rayId: calls++ === 0 ? "5555555555555555-ORD" : "6666666666666666-ORD" }) }; })(),
  postgres: { readMigrations: async () => postgresObserved({ ledger }), readCatalog: async () => postgresObserved({ schema: "nearyou", relations: [{ name: "household_members", kind: "table", checksum: "f".repeat(64) }] }) },
  dns: { readIdentifiers: async () => observed({ records: [{ name: "nearyoustill.com", recordId: "dns-record-01", type: "A" }] },{provider:"google"}) },
  oauth: { readIdentifiers: async () => runtimeObserved({ issuer: "https://accounts.google.com", audience: googleClientId, clientId: googleClientId, providerAcceptedRedirectUri: "https://nearyoustill.com/api/auth/callback/google", proof: "interaction_required" }) },
  secretManager: { listVersions: async () => observed({ versions: ["nearyou-prod-app","nearyou-prod-legacy","nearyou-prod-pad","nearyou-prod-migration-admin"].map(secret=>`projects/nearnight/secrets/${secret}/versions/1`) },{provider:"google"}) },
  gates: { read: async () => runtimeObserved({ nearfamily: false, nearstory: false, scheduler: false }) },
  };
  return { ...base, ...overrides, d1: { ...base.d1, ...(overrides.d1 ?? {}) }, runtime: { ...base.runtime, ...(overrides.runtime ?? {}) } };
};
const deploymentPair = await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const deploymentFingerprint = Buffer.from(await crypto.subtle.digest("SHA-256", await crypto.subtle.exportKey("spki", deploymentPair.publicKey))).toString("hex");
let deploymentNonce = 0;
async function deployment(overrides = {}) {
  deploymentNonce += 1;
  const base = { ...deploymentOperation(), notBefore: now, issuedAt: now, expiresAt: now + 15 * 60_000, nonce: String(deploymentNonce).padStart(22, "a") };
  const claims = overrides.claims ? overrides.claims(base) : base;
  const signature = Buffer.from(await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, deploymentPair.privateKey, new TextEncoder().encode(privateTesterDeploymentManifestSignedBytes(claims)))).toString("base64url");
  const record = { principal: signerPrincipal, keyId: signerKeyId, version: 7, fingerprint: deploymentFingerprint, key: deploymentPair.publicKey };
  const trust = [{ principal: signerPrincipal, keyId: signerKeyId, version: 7, fingerprint: deploymentFingerprint, status: "active", validFrom: now - 60_000, validUntil: now + 60 * 60_000, revokedAt: null, usage: "release-evidence" }];
  return { envelope: overrides.envelope ? overrides.envelope({ claims, signature }) : { claims, signature }, verification: { trust, lookupKey: async () => record, nonceStore: overrides.nonceStore ?? { consumeDeploymentManifestNonce: async () => true } } };
}
async function input(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "private-tester-baseline-"));
  const signed = overrides.deployment ?? await deployment();
  const { deployment: _deployment, ...rest } = overrides;
  void _deployment;
  const sitesDeploymentReceipt = { version: 1, provider: "openai-sites-control-plane", projectId, deploymentId: "appgdep_12345678", versionId: release().sitesVersion, commitSha: release().commitSha, deployedAt: workerRuntime.deployedAt };
  const expectedSitesDeploymentReceiptHash = createHash("sha256").update(JSON.stringify(sitesDeploymentReceipt)).digest("hex");
  const sitesResourceReceiptRaw = `${JSON.stringify(sitesResourceReceipt())}\n`;
  const expectedSitesResourceReceiptHash = createHash("sha256").update(sitesResourceReceiptRaw).digest("hex");
  const sitesProviderLogRaw = JSON.stringify({ version: 1, provider: "sites-worker-logs", scriptName: workerDeployment.scriptName, scriptVersionId: workerDeployment.versionId, observedAt: now, rays: ["1111111111111111-ORD", "2222222222222222-ORD", "3333333333333333-ORD", "4444444444444444-ORD", "5555555555555555-ORD", "6666666666666666-ORD"] });
  return { release: release(), deploymentManifest: signed.envelope, deploymentVerification: signed.verification, sitesDeploymentReceipt, expectedSitesDeploymentReceiptHash, sitesResourceReceiptRaw, expectedSitesResourceReceiptHash, sitesArchiveBytes: archiveBytes, sitesProviderLogRaw, expectedSitesProviderLogSha256: createHash("sha256").update(sitesProviderLogRaw).digest("hex"), expectedD1Ledger: ledger, expectedD1SourceHash: reviewedSourceHash, expectedD1SchemaDefinitionHash: schemaDefinitionHash, expectedD1SchemaObjectCount: sourceSchemaObjects.length, outputPath: join(dir, "baseline.json"), now: () => now, readers: readers(), ...rest };
}
function productionEnvironment() {
  const instance = "nearnight:us-central1:nearyou-production";
  const artifact = readFileSync(new URL("../infra/production/cloud-sql-auth-proxy.args", import.meta.url), "utf8").replace("${CLOUD_SQL_INSTANCE_CONNECTION_NAME}", instance);
  return { PRIVATE_TESTER_GCP_PROJECT: "nearnight", PRIVATE_TESTER_DNS_ZONE: "near-zone", PRIVATE_TESTER_READER_SUBJECT: "109876543210987654321", PRIVATE_TESTER_BASELINE_DATABASE_URL: "postgresql://nearyou-pt-baseline%40nearnight.iam@127.0.0.1:5432/nearyou?sslmode=disable", CLOUD_SQL_IAM_CONNECTOR: "cloud-sql-auth-proxy", CLOUD_SQL_INSTANCE_CONNECTION_NAME: instance, CLOUD_SQL_PROXY_ARGS_CHECKSUM: createHash("sha256").update(artifact).digest("hex"), NEARYOU_PRIVATE_TESTER_BASELINE_DATABASE_USER: "nearyou-pt-baseline@nearnight.iam" };
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
  assert.deepEqual(verified.providerInternalSchemaObjects.map(({ type, name, tableName }) => ({ type, name, table_name: tableName })), manifest.provider_internal_schema_objects);

  const manifestRelease = { ...release(), sitesVersion: "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_example" };
  const manifestLedgerRows = verified.sources.slice(1).map(({ id }, index) => ({ id: index + 1, name: `${id}.sql`, applied_at: `2026-08-14 17:${String(index).padStart(2, "0")}:00` }));
  const manifestSchemaRows = verified.completeSchemaObjects.map(({ type, name, tableName, rootPage, sql }) => ({ type, name, tbl_name: tableName, rootpage: rootPage, sql }));
  const DB = { prepare: (sql) => ({ all: async () => ({ results: sql.includes("d1_migrations") && !sql.includes("sqlite_schema") ? manifestLedgerRows : manifestSchemaRows }) }) };
  const runtime = createPrivateTesterBaselineRuntime({ DB, VERSION_METADATA: { id: workerRuntime.id, tag: workerRuntime.commitSha, timestamp: workerRuntime.deployedAt }, PRIVATE_TESTER_BASELINE_RELEASE_JSON: JSON.stringify(manifestRelease), GOOGLE_CLIENT_ID: googleClientId, BETTER_AUTH_URL: "https://nearyoustill.com", PUBLIC_APP_URL: "https://nearyoustill.com", NEARYOU_ENABLE_STORY: "false", NEARYOU_ENABLE_LEGACY_ARCHIVE: "false", PRIVATE_TESTER_SCHEDULER_ENABLED: "false" }, { now: () => now, fetch, expectedD1SchemaDefinitionHash: verified.schemaDefinitionHash, expectedD1SchemaObjectCount: verified.schemaObjectCount });
  assert.equal((await runtime.read("d1-schema")).objects.length, verified.completeSchemaObjects.length);

  for (const patch of [
    { migration_range: "0001-0016" },
    { wrangler_version: "4.91.0" },
    { sqlite_schema_source_object_count: 670 },
    { unexpected: true },
  ]) await assert.rejects(() => verifyPrivateTesterD1SourceBaseline({ manifest: { ...manifest, ...patch } }), /source baseline invalid/);
});

test("a valid signed one-time deployment manifest unblocks exact live baseline capture", async () => {
  const options = await input();
  const baseline = await capturePrivateTesterBaseline(options);
  const written = JSON.parse(await readFile(options.outputPath, "utf8"));
  assert.deepEqual(written, baseline);
  assert.deepEqual(baseline.sites.current, deploymentOperation().live);
  assert.deepEqual(baseline.sites.rollback, deploymentOperation().rollback);
  assert.deepEqual(baseline.sites.resources, deploymentOperation().resources);
  assert.deepEqual(baseline.sites.deployment, options.sitesDeploymentReceipt);
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
  assert.equal(baseline.observations.postgresCatalog.identity, postgresIdentity);
  assert.equal(baseline.observations.sitesResourceReceipt.identity, `project:${projectId}`);
});

test("derives the build receipt from exact archive bytes and bracketed runtime evidence", async () => {
  const options = await input();
  const runtimeHtml = `{\\"deploymentVersion\\":\\"${workerRuntime.id}\\"}`;
  options.sitesArchiveBytes = archiveBytes;
  let runtimeReads = 0;
  options.readers = readers({
    runtime: {
      readHtml: async () => runtimeObserved({ html: runtimeHtml }, { rayId: runtimeReads++ === 0 ? "5555555555555555-ORD" : "6666666666666666-ORD" }),
    },
  });
  const baseline = await capturePrivateTesterBaseline(options);
  assert.equal(baseline.sites.buildReceipt.buildId, workerRuntime.id);
  assert.equal(baseline.sites.buildReceipt.archiveSha256, createHash("sha256").update(options.sitesArchiveBytes).digest("hex"));
});

test("rejects arbitrary bytes in place of a Sites archive", async () => {
  const options = await input();
  options.sitesArchiveBytes = Buffer.from("not a tar archive");
  await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
});

test("rejects an archive BUILD_ID that differs from Task 1 runtime evidence", async () => {
  const options = await input();
  options.sitesArchiveBytes = await archiveFor("33333333-3333-4333-8333-333333333333");
  await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
});

test("rejects a deployment swap during the capture bracket", async () => {
  const options = await input();
  let runtimeReads = 0;
  options.readers = readers({
    runtime: {
      readHtml: async () => runtimeObserved({ html: `{"deploymentVersion":"${runtimeReads++ === 0 ? workerRuntime.id : "33333333-3333-4333-8333-333333333333"}"}` }, { rayId: runtimeReads === 1 ? "5555555555555555-ORD" : "6666666666666666-ORD" }),
    },
  });
  await assert.rejects(() => capturePrivateTesterBaseline(options), /runtime build changed/);
});

test("requires an independently hashed exact Sites deployment receipt", async () => {
  const substituted = await input();
  substituted.sitesDeploymentReceipt = { ...substituted.sitesDeploymentReceipt, deploymentId: "appgdep_substituted" };
  await assert.rejects(() => capturePrivateTesterBaseline(substituted), /baseline invalid/);

  const selfConsistent = await input();
  selfConsistent.sitesDeploymentReceipt = { ...selfConsistent.sitesDeploymentReceipt, versionId: `${projectId}~appgver_attacker`, commitSha: "e".repeat(40) };
  selfConsistent.expectedSitesDeploymentReceiptHash = createHash("sha256").update(JSON.stringify(selfConsistent.sitesDeploymentReceipt)).digest("hex");
  await assert.rejects(() => capturePrivateTesterBaseline(selfConsistent), /baseline invalid/);

  const extra = await input();
  extra.sitesDeploymentReceipt = { ...extra.sitesDeploymentReceipt, workerVersion: "caller" };
  extra.expectedSitesDeploymentReceiptHash = createHash("sha256").update(JSON.stringify(extra.sitesDeploymentReceipt)).digest("hex");
  await assert.rejects(() => capturePrivateTesterBaseline(extra), /baseline invalid/);
});


test("unsigned and self-asserted Sites responses cannot replace manifest verification", async () => {
  const forged = await deployment({ envelope: ({ claims }) => ({ claims, signature: "A".repeat(512) }) });
  const unsigned = await input({ deployment: forged });
  await assert.rejects(() => capturePrivateTesterBaseline(unsigned), /signature/);
  assert.equal(await readFile(unsigned.outputPath).catch(() => ""), "");

  const selfAsserted = await input({ readers: readers({ controlPlane: { read: async () => observed({ projectId, current: deploymentOperation().live, rollback: deploymentOperation().rollback, resources: deploymentOperation().resources }, { provider: "sites-control-plane" }) } }) });
  await assert.rejects(() => capturePrivateTesterBaseline(selfAsserted), /baseline invalid/);
  assert.equal(await readFile(selfAsserted.outputPath).catch(() => ""), "");
});

test("production readers do not require direct Cloudflare physical-resource inventory", () => {
  const production = createAuthenticatedProductionReaders(productionEnvironment(), { now: () => now, fetch }, release());
  assert.equal(Object.hasOwn(production, "providerInventory"), false);
  const source = readFileSync(new URL("../scripts/capture-private-tester-baseline.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /CLOUDFLARE_API_TOKEN|cloudflareInventoryReader/);
});

test("production reader does not call the unavailable managed-Sites Worker deployments API",()=>{const source=readFileSync(new URL("../scripts/capture-private-tester-baseline.ts",import.meta.url),"utf8");assert.doesNotMatch(source,/workers\/scripts\/\$\{SITES_WORKER_SCRIPT\}\/deployments|sitesDeployment\.read/)});

test("production CLI requires separate exact Sites deployment and logical-resource receipts", () => {
  const source = readFileSync(new URL("../scripts/capture-private-tester-baseline.ts", import.meta.url), "utf8");
  assert.match(source, /receiptPath/);
  assert.match(source, /SITES_DEPLOYMENT_RECEIPT_SHA256/);
  assert.match(source, /sitesDeploymentReceipt, expectedSitesDeploymentReceiptHash/);
  assert.match(source, /SITES_RESOURCE_RECEIPT_SHA256/);
  assert.match(source, /sitesResourceReceiptRaw\s*,\s*expectedSitesResourceReceiptHash/);
  assert.match(source, /SITES_PROVIDER_LOG_SHA256/);
  assert.match(source, /sitesArchiveBytes\s*,\s*sitesProviderLogRaw\s*,\s*expectedSitesProviderLogSha256/);
  assert.match(source, /readSchemaPage/);
  assert.match(source, /readLedgerPage/);
  assert.doesNotMatch(source, /sitesEvidence/);
  assert.doesNotMatch(source, /cloudflare-workers-version-key/);
});

test("production PostgreSQL reads and nonce consumption use only the mapped baseline verifier connection", async () => {
  const source = readFileSync(new URL("../scripts/capture-private-tester-baseline.ts", import.meta.url), "utf8");
  assert.match(source, /PRIVATE_TESTER_BASELINE_DATABASE_URL/);
  assert.match(source, /NEARYOU_PRIVATE_TESTER_BASELINE_DATABASE_USER/);
  assert.match(source, /\^nearyou-pt-baseline@nearnight\\\.iam\$/);
  assert.doesNotMatch(source, /nearyou-pt-baseline@nearnight\\\.iam\\\.gserviceaccount/);
  assert.match(source, /assert_private_tester_baseline_verifier\(\)/);
  assert.doesNotMatch(source, /EXISTS\(SELECT 1 FROM nearyou\.private_tester_baseline_verifier_identities/);
  assert.doesNotMatch(source, /READINESS_CONTROL_DATABASE_URL|NEARYOU_READINESS_DATABASE_USER/);
});

test("rejects signed deployment facts that disagree with release, Sites resource receipt, or PostgreSQL identity", async () => {
  const cases = [
    await input({ deployment: await deployment({ claims: (value) => ({ ...value, releaseId: "rel_20260814_private_02" }) }) }),
    await input({ deployment: await deployment({ claims: (value) => ({ ...value, live: { ...value.live, version: `${projectId}~appgver_other` } }) }) }),
    await input({ deployment: await deployment({ claims: (value) => ({ ...value, live: { ...value.live, commitSha: "e".repeat(40) } }) }) }),
    await input({ sitesDeploymentReceipt: { version: 1, provider: "openai-sites-control-plane", projectId, deploymentId: "appgdep_12345678", versionId: release().sitesVersion, commitSha: "e".repeat(40), deployedAt: workerRuntime.deployedAt } }),
    await input({ deployment: await deployment({ claims: (value) => ({ ...value, resources: [value.resources[0], { ...value.resources[1], schemaDigest: "0".repeat(64) }] }) }) }),
    await input({ readers: readers({ postgres: { readMigrations: async () => postgresObserved({ ledger }, { identity: "database:attacker@nearnight.iam.gserviceaccount.com" }), readCatalog: async () => postgresObserved({ schema: "nearyou", relations: [{ name: "household_members", kind: "table", checksum: "f".repeat(64) }] }) } }) }),
  ];
  for (const [caseIndex, options] of cases.entries()) {
    await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/, `case ${caseIndex}`);
    assert.equal(await readFile(options.outputPath).catch(() => ""), "");
  }
});

test("rejects a self-consistently rehashed Sites receipt that disagrees with the signed manifest", async () => {
  const receipt = sitesResourceReceipt();
  receipt.hosting_metadata.r2 = "ROGUE";
  const sitesResourceReceiptRaw = `${JSON.stringify(receipt)}\n`;
  const options = await input({ sitesResourceReceiptRaw, expectedSitesResourceReceiptHash: createHash("sha256").update(sitesResourceReceiptRaw).digest("hex") });
  await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
  assert.equal(await readFile(options.outputPath).catch(() => ""), "");
});

test("rejects rollback tamper, stale manifests, replay, and committed-lost nonce responses without an artifact", async () => {
  const signed = await deployment();
  const rollbackTamper = await input({ deployment: { ...signed, envelope: { ...signed.envelope, claims: { ...signed.envelope.claims, rollback: { ...signed.envelope.claims.rollback, commitSha: "d".repeat(40) } } } } });
  await assert.rejects(() => capturePrivateTesterBaseline(rollbackTamper), /signature/);
  assert.equal(await readFile(rollbackTamper.outputPath).catch(() => ""), "");

  const stale = await input({ deployment: await deployment({ claims: (value) => ({ ...value, notBefore: now - 300_001, issuedAt: now - 300_001, expiresAt: now + 1 }) }) });
  await assert.rejects(() => capturePrivateTesterBaseline(stale), /deployment manifest invalid/);
  assert.equal(await readFile(stale.outputPath).catch(() => ""), "");

  const consumed = new Set();
  const replayed = await deployment({ nonceStore: { consumeDeploymentManifestNonce: async ({ nonce }) => !consumed.has(nonce) && Boolean(consumed.add(nonce)) } });
  const first = await input({ deployment: replayed });
  await capturePrivateTesterBaseline(first);
  const replay = await input({ deployment: replayed });
  await assert.rejects(() => capturePrivateTesterBaseline(replay), /replay rejected/);
  assert.equal(await readFile(replay.outputPath).catch(() => ""), "");

  let committed = false;
  const lost = await deployment({ nonceStore: { consumeDeploymentManifestNonce: async () => { if (!committed) { committed = true; throw new Error("lost response"); } return false; } } });
  const ambiguous = await input({ deployment: lost });
  await assert.rejects(() => capturePrivateTesterBaseline(ambiguous), /nonce store failed/);
  assert.equal(await readFile(ambiguous.outputPath).catch(() => ""), "");
  const retried = await input({ deployment: lost });
  await assert.rejects(() => capturePrivateTesterBaseline(retried), /replay rejected/);
  assert.equal(await readFile(retried.outputPath).catch(() => ""), "");
});

test("pins the runtime gateway audience and rejects a response with the wrong authenticated subject", async () => {
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push([String(url), init]);
    if (String(url).includes("metadata.google.internal")) return new Response("a.b.c", { status: 200 });
    return new Response(JSON.stringify({ issuer: "https://accounts.google.com", audience: "https://nearyoustill.com", subject: "999999999999999999999", principal: "service:999999999999999999999", observedAt: now, release: release(), body: { appliedMigrations } }), { status: 200 });
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
  const payload = JSON.stringify({ issuer: "https://accounts.google.com", audience: "https://nearyoustill.com", subject: "109876543210987654321", principal: "service:109876543210987654321", observedAt: now, release: release(), body: { schema: "sqlite_schema", objects } });
  assert.ok(payload.length > 262_144);
  assert.ok(payload.length < 1_048_576);
  const fetch = async (url) => String(url).includes("metadata.google.internal")
    ? new Response("a.b.c", { status: 200 })
    : new Response(payload, { status: 200, headers: { "content-type": "application/json", "cf-ray":"1111111111111111-ORD" } });
  const value = await createAuthenticatedProductionReaders(productionEnvironment(), { fetch, now: () => now }, release()).d1.readSchema();
  assert.equal(value.body.objects.length, 676);
});

test("rejects altered live migration fields or any schema object drift from reviewed source", async () => {
  const cases = [
    { d1: { readLedger: async () => runtimeObserved({ appliedMigrations: [{ ...appliedMigrations[0], sequence: 7 }, appliedMigrations[1]] }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: schemaObjects }) } },
    { d1: { readLedger: async () => runtimeObserved({ appliedMigrations: [{ ...appliedMigrations[0], appliedAt: "" }, appliedMigrations[1]] }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: schemaObjects }) } },
    { d1: { readLedger: async () => runtimeObserved({ appliedMigrations }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: schemaObjects.filter((object) => object.type !== "trigger") }) } },
    { d1: { readLedger: async () => runtimeObserved({ appliedMigrations }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: schemaObjects.map((object) => object.type === "index" ? { ...object, sql: `${object.sql} DESC` } : object) }) } },
    { d1: { readLedger: async () => runtimeObserved({ appliedMigrations }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: [schemaObjects[0], { type: "index", name: "d1_migrations_rogue_idx", tableName: "d1_migrations", rootPage: 10, sql: "CREATE INDEX d1_migrations_rogue_idx ON d1_migrations(name)" }, ...schemaObjects.slice(1)] }) } },
    { d1: { readLedger: async () => runtimeObserved({ appliedMigrations }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects: [...schemaObjects.slice(0, 9), { type: "trigger", name: "d1_migrations_rogue", tableName: "d1_migrations", rootPage: 0, sql: "CREATE TRIGGER d1_migrations_rogue AFTER INSERT ON d1_migrations BEGIN SELECT 1; END" }, ...schemaObjects.slice(9)] }) } },
  ];
  for (const patch of cases) {
    const options = await input({ readers: readers(patch) });
    await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
  }
});

test("rejects every D1 provider-internal object set mismatch before capturing evidence", async () => {
  const remove = (name) => schemaObjects.filter((object) => object.name !== name);
  const replace = (name, patch) => schemaObjects.map((object) => object.name === name ? { ...object, ...patch } : object);
  const providerNames = ["sqlite_autoindex_d1_migrations_1", "_cf_METADATA", "d1_migrations", "sqlite_sequence", "sqlite_stat1"];
  const cases = [
    ...providerNames.map(remove),
    ...providerNames.map((name) => [...schemaObjects, ...schemaObjects.filter((object) => object.name === name)]),
    replace("sqlite_stat1", { name: "sqlite_stat2" }),
    replace("d1_migrations", { type: "view" }),
    replace("sqlite_sequence", { tableName: "d1_migrations" }),
    replace("sqlite_autoindex_d1_migrations_1", { sql: "CREATE INDEX sqlite_autoindex_d1_migrations_1 ON d1_migrations(name)" }),
    replace("sqlite_autoindex_d1_migrations_1", { sql: "null" }),
    [...schemaObjects, { type: "index", name: "d1_migrations_rogue_idx", tableName: "d1_migrations", rootPage: 10, sql: "CREATE INDEX d1_migrations_rogue_idx ON d1_migrations(name)" }],
  ];
  for (const objects of cases) {
    const options = await input({ readers: readers({ d1: { readLedger: async () => runtimeObserved({ appliedMigrations }), readSchema: async () => runtimeObserved({ schema: "sqlite_schema", objects }) } }) });
    await assert.rejects(() => capturePrivateTesterBaseline(options), /baseline invalid/);
    assert.equal(await readFile(options.outputPath).catch(() => ""), "");
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
    const atFinal = (body, overrides = {}) => observed(body, { observedAt: finalTime, ...overrides });
    const atFinalRuntime = (body) => atFinal(body, { provider: "sites-runtime" });
    const options = await input({ now: () => clock.shift() ?? finalTime, readers: readers({
      d1: { readLedger: async () => atFinalRuntime({ appliedMigrations }), readSchema: async () => atFinalRuntime({ schema: "sqlite_schema", objects: schemaObjects }) },
      postgres: { readMigrations: async () => atFinal({ ledger }, { provider: "cloud-sql", identity: postgresIdentity }), readCatalog: async () => atFinal({ schema: "nearyou", relations: [{ name: "household_members", kind: "table", checksum: "f".repeat(64) }] }, { provider: "cloud-sql", identity: postgresIdentity }) },
      dns: { readIdentifiers: async () => atFinal({ records: [{ name: "nearyoustill.com", recordId: "dns-record-01", type: "A" }] }, { provider: "google", observedAt }) },
      oauth: { readIdentifiers: async () => atFinalRuntime({ issuer: "https://accounts.google.com", audience: googleClientId, clientId: googleClientId, providerAcceptedRedirectUri: "https://nearyoustill.com/api/auth/callback/google", proof: "interaction_required" }) },
      secretManager: { listVersions: async () => atFinal({ versions: ["projects/near-prod/secrets/nearstory-api/versions/12"] },{provider:"google"}) },
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
