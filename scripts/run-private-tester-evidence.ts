import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

type RawArtifacts = {
  signedManifest: string;
  reviewBaseline: string;
  providerLogReceipt: string;
  promotedBaseline: string;
};
type ArtifactReference = { kind: string; key: string; sha256: string };
type EvidenceIndex = {
  version: 1;
  operationId: string;
  startedAt: number;
  releaseId: string;
  deploymentId: string;
  buildId: string;
  schemaDigest: string;
  migrationDigest: string;
  postgresCatalogHash: string;
  darkGatesSha256: string;
  artifacts: ArtifactReference[];
};

export type GenerationZeroStore = {
  get(key: string): Promise<string | null>;
  putIfAbsent(key: string, raw: string): Promise<unknown>;
};

const HASH = /^[a-f0-9]{64}$/;
const OPERATION = /^[a-z][a-z0-9-]{7,127}$/;
const RELEASE = /^rel_[A-Za-z0-9_-]{8,100}$/;
const DEPLOYMENT = /^appgdep_[A-Za-z0-9_-]{8,152}$/;
const BUILD = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ARTIFACT_BYTES = 4_000_000;
const MAX_AGE_MS = 5 * 60_000;

function invalid(message = "private tester evidence artifact invalid"): never { throw new Error(message); }
function digest(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function text(value: unknown, expression: RegExp): value is string { return typeof value === "string" && expression.test(value); }
function objectAt(value: unknown, ...keys: string[]): Record<string, unknown> {
  let current: unknown = value;
  for (const key of keys) { if (!record(current)) invalid(); current = current[key]; }
  if (!record(current)) invalid();
  return current;
}
function readRaw(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length < 2 || Buffer.byteLength(raw) > MAX_ARTIFACT_BYTES || !raw.endsWith("\n")) invalid();
  try { const value = JSON.parse(raw); if (!record(value)) invalid(); return value; } catch { invalid(); }
}
function gateDigest(value: unknown): string {
  if (!record(value) || value.nearfamily !== false || value.nearstory !== false || value.scheduler !== false || Object.keys(value).length !== 3) invalid();
  return digest(JSON.stringify({ nearfamily: false, nearstory: false, scheduler: false }));
}

type Facts = { releaseId: string; deploymentId: string; buildId: string; schemaDigest: string; migrationDigest: string; postgresCatalogHash: string; darkGatesSha256: string };
function factsFromArtifacts(artifacts: RawArtifacts, startedAt: number): Facts {
  const manifest = readRaw(artifacts.signedManifest), claims = objectAt(manifest, "claims");
  if (claims.schemaVersion !== 3 || !text(claims.releaseId, RELEASE) || !text(claims.projectId, /^appgprj_[a-z0-9]{32}$/) || !record(claims.live) || !record(claims.rollback) || !Array.isArray(claims.resources) || claims.resources.length !== 2) invalid();
  const audio = claims.resources[0], database = claims.resources[1];
  if (!record(audio) || !record(database) || audio.binding !== "AUDIO" || audio.kind !== "r2" || audio.provider !== "sites-managed" || audio.physicalId !== "unknown-managed" || !text(audio.deploymentId, DEPLOYMENT) || !text(audio.buildId, BUILD) || database.binding !== "DB" || database.kind !== "d1" || database.provider !== "sites-managed" || database.physicalId !== "unknown-managed" || database.buildId !== audio.buildId || !text(database.schemaDigest, HASH) || !text(database.migrationDigest, HASH)) invalid();

  const review = readRaw(artifacts.reviewBaseline), reviewRelease = objectAt(review, "release"), reviewSites = objectAt(review, "sites"), deployment = objectAt(reviewSites, "deployment"), receipt = objectAt(reviewSites, "buildReceipt"), reviewD1 = objectAt(review, "d1"), reviewPostgres = objectAt(review, "postgres");
  if (review.version !== 1 || review.reviewRequired !== true || !Number.isSafeInteger(review.capturedAt) || Number(review.capturedAt) < startedAt - MAX_AGE_MS || Number(review.capturedAt) > startedAt || reviewRelease.releaseId !== claims.releaseId || deployment.deploymentId !== audio.deploymentId || receipt.buildId !== audio.buildId || reviewD1.schemaHash !== database.schemaDigest || reviewD1.appliedLedgerHash !== database.migrationDigest || !text(reviewPostgres.catalogHash, HASH)) invalid("private tester evidence stale or inconsistent");
  const gates = gateDigest(review.gates);

  const provider = readRaw(artifacts.providerLogReceipt);
  if (provider.version !== 1 || provider.provider !== "sites-worker-logs" || provider.candidateSha256 !== digest(artifacts.reviewBaseline) || !Number.isSafeInteger(provider.capturedAt) || Number(provider.capturedAt) < Number(review.capturedAt) || Number(provider.capturedAt) > startedAt || !Array.isArray(provider.observations)) invalid("private tester evidence stale or inconsistent");

  const promoted = readRaw(artifacts.promotedBaseline), promotedRelease = objectAt(promoted, "release"), promotedSites = objectAt(promoted, "sites"), promotedDeployment = objectAt(promotedSites, "deployment"), promotedReceipt = objectAt(promotedSites, "buildReceipt"), promotedD1 = objectAt(promoted, "d1"), promotedPostgres = objectAt(promoted, "postgres");
  if (promoted.version !== 1 || promoted.reviewRequired !== false || promotedRelease.releaseId !== reviewRelease.releaseId || promotedDeployment.deploymentId !== deployment.deploymentId || promotedReceipt.buildId !== receipt.buildId || promotedD1.schemaHash !== reviewD1.schemaHash || promotedD1.appliedLedgerHash !== reviewD1.appliedLedgerHash || promotedPostgres.catalogHash !== reviewPostgres.catalogHash || promotedSites.logReceiptSha256 !== digest(artifacts.providerLogReceipt) || gateDigest(promoted.gates) !== gates) invalid("private tester evidence stale or inconsistent");
  return { releaseId: claims.releaseId, deploymentId: audio.deploymentId, buildId: audio.buildId, schemaDigest: database.schemaDigest, migrationDigest: database.migrationDigest, postgresCatalogHash: reviewPostgres.catalogHash, darkGatesSha256: gates };
}

async function converge(store: GenerationZeroStore, key: string, raw: string): Promise<void> {
  const expected = digest(raw);
  const existing = await store.get(key);
  if (existing !== null) { if (digest(existing) !== expected) invalid("private tester evidence immutable conflict"); return; }
  try { await store.putIfAbsent(key, raw); }
  catch (error) {
    const committed = await store.get(key);
    if (committed !== null && digest(committed) === expected) return;
    throw error;
  }
  const committed = await store.get(key);
  if (committed === null || digest(committed) !== expected) invalid("private tester evidence immutable conflict");
}

function storageKey(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9._/-]{0,1023}$/.test(value) && !value.includes("//") && !value.split("/").includes(".."); }
async function responseText(response: Response): Promise<string> {
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_ARTIFACT_BYTES) invalid("private tester evidence storage response invalid");
  return raw;
}

export function createGoogleStorageGenerationZeroStore(input: { bucket: string; accessToken(): Promise<string>; fetch?: typeof fetch }): GenerationZeroStore {
  if (!record(input) || !text(input.bucket, /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/) || typeof input.accessToken !== "function") invalid("private tester evidence storage configuration invalid");
  const request = input.fetch ?? fetch;
  const auth = async (): Promise<string> => {
    const token = await input.accessToken();
    if (!text(token, /^[A-Za-z0-9._~-]{20,4096}$/)) invalid("private tester evidence storage identity unavailable");
    return token;
  };
  const objectUrl = (key: string, media = false): string => `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(input.bucket)}/o/${encodeURIComponent(key)}${media ? "?alt=media" : ""}`;
  return {
    async get(key) {
      if (!storageKey(key)) invalid("private tester evidence storage key invalid");
      let response: Response;
      try { response = await request(objectUrl(key, true), { method: "GET", headers: { authorization: `Bearer ${await auth()}` }, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
      catch { throw new Error("private tester evidence storage unavailable"); }
      if (response.status === 404) return null;
      const raw = await responseText(response);
      if (!response.ok) throw new Error("private tester evidence storage unavailable");
      return raw;
    },
    async putIfAbsent(key, raw) {
      if (!storageKey(key) || typeof raw !== "string" || Buffer.byteLength(raw) < 1 || Buffer.byteLength(raw) > MAX_ARTIFACT_BYTES) invalid("private tester evidence storage input invalid");
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(input.bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(key)}`;
      let response: Response;
      try { response = await request(url, { method: "POST", headers: { authorization: `Bearer ${await auth()}`, "content-type": "application/json; charset=utf-8" }, body: raw, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
      catch { throw new Error("private tester evidence storage unavailable"); }
      if (response.status === 409 || response.status === 412) { await responseText(response); return "exists"; }
      await responseText(response);
      if (!response.ok) throw new Error("private tester evidence storage unavailable");
      return "created";
    },
  };
}

export async function runPrivateTesterEvidence(input: { operationId: string; startedAt: number; artifactPrefix: string; artifacts: RawArtifacts }, dependencies: { store: GenerationZeroStore; now?: () => number }): Promise<EvidenceIndex & { artifacts: ArtifactReference[] }> {
  if (!record(input) || !text(input.operationId, OPERATION) || !Number.isSafeInteger(input.startedAt) || !text(input.artifactPrefix, /^[a-z][a-z0-9-]{2,127}$/) || !record(input.artifacts) || !dependencies || !dependencies.store || typeof dependencies.store.get !== "function" || typeof dependencies.store.putIfAbsent !== "function") invalid();
  const now = (dependencies.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || input.startedAt > now || now - input.startedAt > MAX_AGE_MS) invalid("private tester evidence immutable operation invalid");
  const artifacts = input.artifacts as RawArtifacts;
  const facts = factsFromArtifacts(artifacts, input.startedAt), prefix = `${input.artifactPrefix}/${input.operationId}`;
  const sources: Array<[string, string, string]> = [
    ["signed-manifest", `${prefix}/signed-manifest.json`, artifacts.signedManifest],
    ["review-baseline", `${prefix}/review-baseline.json`, artifacts.reviewBaseline],
    ["provider-log-receipt", `${prefix}/provider-log-receipt.json`, artifacts.providerLogReceipt],
    ["promoted-baseline", `${prefix}/promoted-baseline.json`, artifacts.promotedBaseline],
  ];
  for (const [, key, raw] of sources) await converge(dependencies.store, key, raw);
  const sourceReferences = sources.map(([kind, key, raw]) => ({ kind, key, sha256: digest(raw) }));
  const index: EvidenceIndex = { version: 1, operationId: input.operationId, startedAt: input.startedAt, ...facts, artifacts: sourceReferences };
  const indexRaw = `${JSON.stringify(index)}\n`, indexKey = `${prefix}/evidence-index.json`;
  await converge(dependencies.store, indexKey, indexRaw);
  return { ...index, artifacts: [...sourceReferences, { kind: "evidence-index", key: indexKey, sha256: digest(indexRaw) }] };
}

async function readLocalArtifact(path: string, maxBytes = MAX_ARTIFACT_BYTES): Promise<string> {
  if (typeof path !== "string" || path.length < 1 || path.length > 4_096) invalid("private tester evidence input invalid");
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = await handle.stat(); if (!stat.isFile() || stat.size < 2 || stat.size > maxBytes) invalid("private tester evidence input invalid"); const raw = await handle.readFile("utf8"); if (Buffer.byteLength(raw) !== stat.size) invalid("private tester evidence input invalid"); return raw; }
  catch { invalid("private tester evidence input invalid"); }
  finally { await handle?.close(); }
  return invalid("private tester evidence input invalid");
}
async function metadataAccessToken(fetcher: typeof fetch): Promise<string> {
  let response: Response;
  try { response = await fetcher("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "metadata-flavor": "Google" }, redirect: "error", signal: AbortSignal.timeout(5_000) }); }
  catch { throw new Error("private tester evidence metadata identity unavailable"); }
  const raw = await responseText(response);
  try { const value = JSON.parse(raw) as { access_token?: unknown; expires_in?: unknown }; if (!response.ok || !text(value.access_token, /^[A-Za-z0-9._~-]{20,4096}$/) || !Number.isSafeInteger(value.expires_in) || Number(value.expires_in) < 60 || Number(value.expires_in) > 3_600) throw new Error(); return value.access_token; }
  catch { throw new Error("private tester evidence metadata identity unavailable"); }
}
async function main(): Promise<void> {
  const [operationPath, signedManifestPath, reviewBaselinePath, providerLogReceiptPath, promotedBaselinePath] = process.argv.slice(2);
  if (process.argv.slice(2).length !== 5) invalid("private tester evidence configuration missing");
  const bucket = process.env.PRIVATE_TESTER_EVIDENCE_BUCKET ?? "";
  const [operationRaw, signedManifest, reviewBaseline, providerLogReceipt, promotedBaseline] = await Promise.all([readLocalArtifact(operationPath, 16_384), readLocalArtifact(signedManifestPath), readLocalArtifact(reviewBaselinePath), readLocalArtifact(providerLogReceiptPath), readLocalArtifact(promotedBaselinePath)]);
  let operation: unknown;
  try { operation = JSON.parse(operationRaw); } catch { invalid("private tester evidence input invalid"); }
  let token: string | undefined;
  const store = createGoogleStorageGenerationZeroStore({ bucket, accessToken: async () => token ??= await metadataAccessToken(fetch) });
  const index = await runPrivateTesterEvidence({ ...(operation as Record<string, unknown>), artifacts: { signedManifest, reviewBaseline, providerLogReceipt, promotedBaseline } } as { operationId: string; startedAt: number; artifactPrefix: string; artifacts: RawArtifacts }, { store });
  process.stdout.write(`${JSON.stringify(index)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => { process.stderr.write("private tester evidence failed\n"); process.exitCode = 1; });
