import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGoogleStorageGenerationZeroStore, runPrivateTesterEvidence } from "../scripts/run-private-tester-evidence.ts";
import { composePrivateTesterDeploymentManifest, privateTesterDeploymentManifestSignedBytes } from "../lib/private-tester-deployment-manifest.ts";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const now = Date.parse("2026-08-19T12:00:00.000Z");
const projectId = "appgprj_6a79f8a66eb4819198bb42a2b26addea";
const releaseId = "rel_20260819_private_01";
const deploymentId = "appgdep_12345678";
const buildId = "11111111-1111-4111-8111-111111111111";
const catalogHash = "c".repeat(64);
const schemaDigest = "d".repeat(64);
const versionId = `${projectId}~appgver_live`;
const rollbackVersion = `${projectId}~appgver_rollback`;
const principal = "ci://github/nearyou/private-tester-deployment";
const keyId = "private-tester-deployment";
const rayIds = ["1111111111111111-ORD", "2222222222222222-ORD", "3333333333333333-ORD", "4444444444444444-ORD"];
const signing = await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const fingerprint = Buffer.from(await crypto.subtle.digest("SHA-256", await crypto.subtle.exportKey("spki", signing.publicKey))).toString("hex");

async function artifactSet(overrides = {}) {
  const appliedMigrations = [{ sequence: 1, name: "0000_foundation.sql", appliedAt: "2026-08-19 00:00:00" }];
  const observedMigrationDigest = sha(JSON.stringify(appliedMigrations));
  const resources = [{ provider: "sites-managed", binding: "AUDIO", kind: "r2", physicalId: "unknown-managed", archiveSha256: "f".repeat(64), deploymentId, buildId }, { provider: "sites-managed", binding: "DB", kind: "d1", physicalId: "unknown-managed", buildId, schemaDigest, schemaObjectCount: 501, migrationDigest: observedMigrationDigest, migrationCount: 27 }];
  const claims = composePrivateTesterDeploymentManifest({ schemaVersion: 3, principal, keyId, keyVersion: 7, releaseId, projectId, live: { version: versionId, commitSha: "a".repeat(40) }, rollback: { version: rollbackVersion, commitSha: "b".repeat(40) }, resources }, () => now, () => "abcdefghijklmnopqrstuv");
  const signature = Buffer.from(await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, signing.privateKey, new TextEncoder().encode(privateTesterDeploymentManifestSignedBytes(claims)))).toString("base64url");
  const manifest = { claims, signature };
  const release = { releaseId, commitSha: "a".repeat(40), sitesVersion: versionId, startsAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now - 60_000 + 7 * 86_400_000).toISOString(), products: ["nearfamily", "nearstory"] };
  const buildReceipt = { version: 1, projectId, versionId, deploymentId, commitSha: "a".repeat(40), archiveSha256: "f".repeat(64), runtimeSha256: "1".repeat(64), buildId, providerScriptName: "site---6a79f8a66eb4819198bb42a2b26addea", providerScriptVersion: "22222222-2222-4222-8222-222222222222", observedAt: now };
  const observations = { d1Ledger: { provider: "sites-runtime", identity: "service:109876543210987654321", observedAt: now, rayId: rayIds[0] }, d1Schema: { provider: "sites-runtime", identity: "service:109876543210987654321", observedAt: now, rayId: rayIds[1] }, postgresMigrations: { provider: "cloud-sql", identity: "database:nearyou-pt-baseline@nearnight.iam", observedAt: now }, postgresCatalog: { provider: "cloud-sql", identity: "database:nearyou-pt-baseline@nearnight.iam", observedAt: now }, sitesResourceReceipt: { provider: "openai-sites-control-plane", identity: `project:${projectId}`, observedAt: now }, dns: { provider: "google", identity: "service:109876543210987654321", observedAt: now }, oauth: { provider: "sites-runtime", identity: "service:109876543210987654321", observedAt: now, rayId: rayIds[3] }, secretManager: { provider: "google", identity: "service:109876543210987654321", observedAt: now }, gates: { provider: "sites-runtime", identity: "service:109876543210987654321", observedAt: now, rayId: rayIds[2] } };
  const review = { version: 1, reviewRequired: true, capturedAt: now, release, sites: { projectId, current: { version: versionId, commitSha: "a".repeat(40) }, rollback: { version: rollbackVersion, commitSha: "b".repeat(40) }, resources, deployment: { version: 1, provider: "openai-sites-control-plane", projectId, deploymentId, versionId, commitSha: "a".repeat(40), deployedAt: new Date(now - 60_000).toISOString() }, buildReceipt }, d1: { appliedMigrations, appliedLedgerHash: observedMigrationDigest, reviewedSourceHash: "2".repeat(64), schemaHash: schemaDigest, schemaObjectCount: 6, sourceSchemaDefinitionHash: "3".repeat(64), sourceSchemaObjectCount: 1, providerInternalSchemaHash: "4".repeat(64), providerInternalSchemaObjectCount: 5 }, postgres: { migrationsHash: "5".repeat(64), catalogHash }, dns: { records: [{ name: "nearyoustill.com", recordId: "dns-1", type: "A" }] }, oauth: { issuer: "https://accounts.google.com", audience: "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com", clientId: "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com", providerAcceptedRedirectUri: "https://nearyoustill.com/api/auth/callback/google", proof: "interaction_required" }, bindings: { bindings: resources }, secretVersions: ["nearyou-prod-app", "nearyou-prod-legacy", "nearyou-prod-pad", "nearyou-prod-migration-admin"].map((secret) => `projects/nearnight/secrets/${secret}/versions/1`), gates: { nearfamily: false, nearstory: false, scheduler: false }, observations };
  const reviewRaw = `${JSON.stringify(review)}\n`;
  const provider = { version: 1, provider: "sites-worker-logs", candidateSha256: sha(reviewRaw), scriptName: buildReceipt.providerScriptName, scriptVersionId: buildReceipt.providerScriptVersion, capturedAt: now, observations: ["d1Ledger", "d1Schema", "gates", "oauth"].map((kind, index) => ({ kind, rayId: rayIds[index], scriptVersionId: buildReceipt.providerScriptVersion, observedAt: now })) };
  const promoted = { ...review, reviewRequired: false, sites: { ...review.sites, logReceiptSha256: sha(`${JSON.stringify(provider)}\n`) } };
  return {
    signedManifest: `${JSON.stringify(manifest)}\n`,
    reviewBaseline: reviewRaw,
    providerLogReceipt: `${JSON.stringify(provider)}\n`,
    promotedBaseline: `${JSON.stringify(promoted)}\n`,
    ...overrides,
  };
}

function memoryStore(options = {}) {
  const values = new Map(), writes = [];
  let loseNext = options.loseNext ?? false;
  return {
    writes,
    values,
    async get(key) { return values.get(key) ?? null; },
    async putIfAbsent(key, raw) {
      writes.push({ key, raw, ifGenerationMatch: 0 });
      const existed = values.has(key);
      if (!existed) values.set(key, raw);
      if (loseNext) { loseNext = false; throw new Error("response lost after commit"); }
      return existed ? "exists" : "created";
    },
  };
}

function dependencies(store, clock = () => now) {
  return { store, now: clock, manifestTrust: [{ principal, keyId, version: 7, fingerprint, status: "active", validFrom: now - 60_000, validUntil: now + 60_000, revokedAt: null, usage: "release-evidence" }], lookupManifestKey: async () => ({ principal, keyId, version: 7, fingerprint, key: signing.publicKey }) };
}

function input(artifacts) {
  return { operationId: "pt-evidence-20260819-0001", startedAt: now, artifactPrefix: "private-tester-evidence", artifacts };
}

test("first run publishes a complete, review-required immutable evidence set", async () => {
  const store = memoryStore();
  const result = await runPrivateTesterEvidence(input(await artifactSet()), dependencies(store));

  assert.equal(result.releaseId, releaseId);
  assert.equal(result.deploymentId, deploymentId);
  assert.equal(result.buildId, buildId);
  assert.equal(result.artifacts.length, 5);
  assert.ok(result.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
  assert.ok(store.writes.every((write) => write.ifGenerationMatch === 0));
  assert.deepEqual(store.writes.map((write) => write.key), [
    "private-tester-evidence/pt-evidence-20260819-0001/signed-manifest.json",
    "private-tester-evidence/pt-evidence-20260819-0001/review-baseline.json",
    "private-tester-evidence/pt-evidence-20260819-0001/provider-log-receipt.json",
    "private-tester-evidence/pt-evidence-20260819-0001/promoted-baseline.json",
    "private-tester-evidence/pt-evidence-20260819-0001/evidence-index.json",
  ]);
});

test("a lost write response converges by reading and hashing the committed bytes", async () => {
  const store = memoryStore({ loseNext: true }), artifacts = await artifactSet();
  const first = await runPrivateTesterEvidence(input(artifacts), dependencies(store));
  const second = await runPrivateTesterEvidence(input(artifacts), dependencies(store));

  assert.deepEqual(second, first);
  assert.equal(store.values.size, 5);
});

test("an immutable operation ID and start time make retries byte-identical", async () => {
  const store = memoryStore(), artifacts = await artifactSet();
  const first = await runPrivateTesterEvidence(input(artifacts), dependencies(store));
  const second = await runPrivateTesterEvidence(input(artifacts), dependencies(store, () => now + 60 * 60_000));

  assert.deepEqual(second, first);
  await assert.rejects(() => runPrivateTesterEvidence({ ...input(artifacts), startedAt: now + 1 }, dependencies(store)), /immutable/);
});

test("concurrent runners converge only when every conflicting raw SHA matches", async () => {
  const store = memoryStore(), artifacts = await artifactSet();
  const [left, right] = await Promise.all([
    runPrivateTesterEvidence(input(artifacts), dependencies(store)),
    runPrivateTesterEvidence(input(artifacts), dependencies(store)),
  ]);

  assert.deepEqual(left, right);
  const malformed = await artifactSet({ promotedBaseline: `${JSON.stringify({ bad: true })}\n` });
  await assert.rejects(() => runPrivateTesterEvidence(input(malformed), dependencies(store)), /artifact invalid|conflict/);
});

test("stale observations and partial artifact sets fail closed without publishing an index", async () => {
  const stale = await artifactSet();
  stale.reviewBaseline = stale.reviewBaseline.replace(`"capturedAt":${now}`, `"capturedAt":${now - 300_001}`);
  const staleStore = memoryStore();
  await assert.rejects(() => runPrivateTesterEvidence(input(stale), dependencies(staleStore)), /stale|artifact invalid/);
  assert.equal(staleStore.values.size, 0);

  const partialStore = memoryStore();
  const seed = input(await artifactSet());
  partialStore.values.set("private-tester-evidence/pt-evidence-20260819-0001/signed-manifest.json", seed.artifacts.signedManifest);
  partialStore.values.set("private-tester-evidence/pt-evidence-20260819-0001/review-baseline.json", seed.artifacts.reviewBaseline);
  const completed = await runPrivateTesterEvidence(seed, dependencies(partialStore));
  assert.equal(completed.artifacts.length, 5);
  assert.equal(partialStore.values.size, 5);
});

test("rejects a fake KMS signature and receipt schema extras before writing", async () => {
  const fake = await artifactSet();
  fake.signedManifest = fake.signedManifest.replace(/"signature":"[^"]+"/, '"signature":"fake"');
  const fakeStore = memoryStore();
  await assert.rejects(() => runPrivateTesterEvidence(input(fake), dependencies(fakeStore)), /signature|manifest/);
  assert.equal(fakeStore.values.size, 0);

  const extra = await artifactSet(), extraReview = JSON.parse(extra.reviewBaseline);
  extraReview.unexpected = true;
  extra.reviewBaseline = `${JSON.stringify(extraReview)}\n`;
  await assert.rejects(() => runPrivateTesterEvidence(input(extra), dependencies(memoryStore())), /invalid|inconsistent/);
});

test("rejects a baseline whose saved or rollback Sites version differs from the signed manifest", async () => {
  const artifacts = await artifactSet(), review = JSON.parse(artifacts.reviewBaseline);
  review.sites.rollback.version = `${projectId}~appgver_other`;
  artifacts.reviewBaseline = `${JSON.stringify(review)}\n`;
  const provider = JSON.parse(artifacts.providerLogReceipt);
  provider.candidateSha256 = sha(artifacts.reviewBaseline);
  artifacts.providerLogReceipt = `${JSON.stringify(provider)}\n`;
  const promoted = JSON.parse(artifacts.promotedBaseline);
  promoted.sites.rollback.version = review.sites.rollback.version;
  promoted.sites.logReceiptSha256 = sha(artifacts.providerLogReceipt);
  artifacts.promotedBaseline = `${JSON.stringify(promoted)}\n`;
  await assert.rejects(() => runPrivateTesterEvidence(input(artifacts), dependencies(memoryStore())), /inconsistent/);
});

test("the disposable Cloud Build path invokes the runner behind a digest-pinned IAM proxy", () => {
  const build = readFileSync(new URL("../infra/production/private-tester-evidence.disposable.cloudbuild.yaml", import.meta.url), "utf8");
  assert.match(build, /CLOUD_SQL_AUTH_PROXY_IMAGE/);
  assert.match(build, /cloud-sql-connectors\/cloud-sql-proxy@sha256:\[a-f0-9\]\{64\}/);
  assert.match(build, /--auto-iam-authn/);
  assert.match(build, /nearyou-pt-baseline@nearnight\.iam/);
  assert.match(build, /node --import tsx scripts\/run-private-tester-evidence\.ts/);
  assert.match(build, /test "\$\{PROJECT_ID\}" = "nearyou-private-tester-disposable"/);
  assert.match(build, /PRIVATE_TESTER_EVIDENCE_BUCKET="nearyou-private-tester-evidence-disposable"/);
  assert.doesNotMatch(build, /_DISPOSABLE_EVIDENCE_PROJECT|_PRIVATE_TESTER_EVIDENCE_BUCKET/);
  assert.doesNotMatch(build, /POSTGRES_PASSWORD|postgres:\/\/[^\n]*:[^\n]*@/);
});

test("the object-store adapter uses generation zero and fetches raw bytes on a collision", async () => {
  const requests = [];
  const store = createGoogleStorageGenerationZeroStore({
    bucket: "private-tester-evidence-prod",
    accessToken: async () => "token_abcdefghijklmnopqrstuvwxyz",
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (init.method === "POST") return new Response(JSON.stringify({ error: { code: 412 } }), { status: 412 });
      return new Response("exact stored bytes\n", { status: 200 });
    },
  });

  assert.equal(await store.putIfAbsent("private-tester-evidence/op/file.json", "new bytes\n"), "exists");
  assert.equal(await store.get("private-tester-evidence/op/file.json"), "exact stored bytes\n");
  assert.match(requests[0].url, /upload\/storage\/v1\/b\/private-tester-evidence-prod\/o\?uploadType=media&ifGenerationMatch=0&name=/);
  assert.equal(requests[0].init.headers.authorization, "Bearer token_abcdefghijklmnopqrstuvwxyz");
  assert.equal(requests[1].init.method, "GET");
  assert.match(requests[1].url, /alt=media/);
});
