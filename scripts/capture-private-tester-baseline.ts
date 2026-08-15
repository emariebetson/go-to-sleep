import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { parsePrivateTesterRelease, type PrivateTesterRelease } from "../lib/private-tester-release";
import { LIVE_CATALOG_QUERY } from "./postgres-catalog";
import { PRIVATE_TESTER_D1_PROVIDER_INTERNAL_OBJECTS, verifyPrivateTesterD1SourceBaseline } from "./private-tester-d1-source";

const HASH = /^[a-f0-9]{64}$/, VERSION = /^appgprj_[A-Za-z0-9_-]+~appgver_[A-Za-z0-9_-]+$/, ID = /^[A-Za-z][A-Za-z0-9_.:/-]{2,511}$/, NAME = /^[a-z][a-z0-9_-]{2,127}$/;
const SECRET_VERSION = /^projects\/[a-z][a-z0-9-]{2,62}\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/[1-9][0-9]*$/;
const PROVIDER_RESOURCE = /^(?:d1\/databases\/[A-Za-z0-9-]{16,128}|r2\/buckets\/[A-Za-z0-9._-]{3,255})$/;
const MAX_AGE_MS = 300_000, MAX_FUTURE_MS = 30_000;
const SITES_GATEWAY_ORIGIN = "https://nearyoustill.com";
const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_CLIENT_ID = "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com";
const GOOGLE_REDIRECT = `${SITES_GATEWAY_ORIGIN}/api/auth/callback/google`;
const MAX_READER_JSON_BYTES = 1_048_576;
const REVIEWED_SECRETS = Object.freeze(["nearyou-prod-app", "nearyou-prod-legacy", "nearyou-prod-pad", "nearyou-prod-migration-admin"]);
type RecordValue = Record<string, unknown>;
type LedgerEntry = { id: string; checksum: string };
type WorkerRuntime = { id: string; commitSha: string; deployedAt: string };
type Meta = { provider: string; identity: string; observedAt: number; workerRuntime?: WorkerRuntime };
type Observed = { provider: string; identity: string; observedAt: number; workerRuntime?: WorkerRuntime; body: unknown };
type AppliedMigration = { sequence: number; name: string; appliedAt: string };
type SchemaObject = { type: string; name: string; tableName: string; rootPage: number; sql: string | null };
type ResourceIdentity = { binding: string; kind: "d1" | "r2"; resourceId: string };
type Readers = {
  controlPlane: { read(): Promise<unknown> };
  d1: { readLedger(): Promise<unknown>; readSchema(): Promise<unknown> };
  postgres: { readMigrations(): Promise<unknown>; readCatalog(): Promise<unknown> };
  dns: { readIdentifiers(): Promise<unknown> }; oauth: { readIdentifiers(): Promise<unknown> };
  secretManager: { listVersions(): Promise<unknown> }; gates: { read(): Promise<unknown> };
};
export type PrivateTesterBaseline = {
  version: 1; capturedAt: number; release: PrivateTesterRelease;
  sites: { projectId: string; current: { version: string; commitSha: string }; rollback: { version: string; commitSha: string }; resources: ResourceIdentity[]; workerRuntime: WorkerRuntime };
  d1: { appliedMigrations: AppliedMigration[]; appliedLedgerHash: string; reviewedSourceHash: string; schemaHash: string; schemaObjectCount: number; sourceSchemaDefinitionHash: string; sourceSchemaObjectCount: number; providerInternalSchemaHash: string; providerInternalSchemaObjectCount: number };
  postgres: { migrationsHash: string; catalogHash: string };
  dns: { records: { name: string; recordId: string; type: string }[] };
  oauth: { issuer: string; audience: string; clientId: string; providerAcceptedRedirectUri: string; proof: "interaction_required" };
  bindings: { bindings: ResourceIdentity[] };
  secretVersions: string[]; gates: { nearfamily: false; nearstory: false; scheduler: false };
  observations: Record<string, Meta>;
};
export type PrivateTesterBaselineInput = { release: unknown; expectedD1Ledger: unknown; expectedD1SourceHash: unknown; expectedD1SchemaDefinitionHash: unknown; expectedD1SchemaObjectCount: unknown; outputPath: string; now(): number; readers: Readers };

function exactRecord(value: unknown, keys: readonly string[]): value is RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value); return own.length === keys.length && own.every((key) => { const d = Object.getOwnPropertyDescriptor(value, key); return typeof key === "string" && keys.includes(key) && !!d && d.enumerable && Object.hasOwn(d, "value") && !d.get && !d.set; });
}
function exactArray(value: unknown, max = 1_000): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > max) return false;
  const keys = Reflect.ownKeys(value); if (keys.length !== value.length + 1 || !keys.includes("length") || keys.some((key) => typeof key === "symbol")) return false;
  for (let index = 0; index < value.length; index += 1) { const d = Object.getOwnPropertyDescriptor(value, String(index)); if (!d || !d.enumerable || !Object.hasOwn(d, "value") || d.get || d.set) return false; }
  return true;
}
function canonical(value: unknown): string { return JSON.stringify(value); }
function hash(value: unknown): string { return createHash("sha256")["up\u0064ate"](canonical(value)).digest("hex"); }
function text(value: unknown, pattern = ID): value is string { return typeof value === "string" && pattern.test(value); }
function observation(value: unknown, nowMs: number): { meta: Meta; body: unknown } {
  const observedAt = exactRecord(value, ["provider", "identity", "observedAt", "body"]) ? value.observedAt : undefined;
  if (!exactRecord(value, ["provider", "identity", "observedAt", "body"]) || !text(value.provider, NAME) || !text(value.identity) || !Number.isSafeInteger(observedAt) || Number(observedAt) < nowMs - MAX_AGE_MS || Number(observedAt) > nowMs + MAX_FUTURE_MS) throw new Error("private tester baseline invalid");
  return { meta: { provider: value.provider, identity: value.identity, observedAt: Number(observedAt) }, body: value.body };
}
function workerRuntime(value: unknown, nowMs: number): WorkerRuntime {
  if (!exactRecord(value, ["id", "commitSha", "deployedAt"]) || !text(value.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) || typeof value.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(value.commitSha) || typeof value.deployedAt !== "string") throw new Error("private tester baseline invalid");
  const deployedAt = Date.parse(value.deployedAt);
  if (!Number.isFinite(deployedAt) || deployedAt < nowMs - MAX_AGE_MS || deployedAt > nowMs + MAX_FUTURE_MS) throw new Error("private tester baseline invalid");
  return { id: value.id, commitSha: value.commitSha, deployedAt: value.deployedAt };
}
function runtimeObservation(value: unknown, nowMs: number): { meta: Meta & { workerRuntime: WorkerRuntime }; body: unknown } {
  const observedAt = exactRecord(value, ["provider", "identity", "observedAt", "workerRuntime", "body"]) ? value.observedAt : undefined;
  if (!exactRecord(value, ["provider", "identity", "observedAt", "workerRuntime", "body"]) || !text(value.provider, NAME) || !text(value.identity) || !Number.isSafeInteger(observedAt) || Number(observedAt) < nowMs - MAX_AGE_MS || Number(observedAt) > nowMs + MAX_FUTURE_MS) throw new Error("private tester baseline invalid");
  const runtime = workerRuntime(value.workerRuntime, nowMs);
  return { meta: { provider: value.provider, identity: value.identity, observedAt: Number(observedAt), workerRuntime: runtime }, body: value.body };
}
function ledger(value: unknown): LedgerEntry[] {
  if (!exactArray(value)) throw new Error("private tester baseline invalid"); const seen = new Set<string>();
  return value.map((entry) => { if (!exactRecord(entry, ["id", "checksum"]) || !text(entry.id, /^[0-9]{4}_[a-z0-9_]{1,200}$/) || typeof entry.checksum !== "string" || !HASH.test(entry.checksum) || seen.has(entry.id)) throw new Error("private tester baseline invalid"); seen.add(entry.id); return { id: entry.id, checksum: entry.checksum }; });
}
function sitesControlPlane(value: unknown): { projectId: string; current: { version: string; commitSha: string }; rollback: { version: string; commitSha: string }; resources: ResourceIdentity[] } {
  if (!exactRecord(value, ["projectId", "current", "rollback", "resources"]) || !text(value.projectId, /^appgprj_[A-Za-z0-9_-]+$/) || !exactRecord(value.current, ["version", "commitSha"]) || !exactRecord(value.rollback, ["version", "commitSha"]) || typeof value.current.version !== "string" || !VERSION.test(value.current.version) || typeof value.rollback.version !== "string" || !VERSION.test(value.rollback.version) || !text(value.current.commitSha, /^[a-f0-9]{40}$/) || !text(value.rollback.commitSha, /^[a-f0-9]{40}$/) || value.current.version === value.rollback.version || !value.current.version.startsWith(`${value.projectId}~appgver_`) || !value.rollback.version.startsWith(`${value.projectId}~appgver_`) || !exactArray(value.resources, 2) || value.resources.length !== 2) throw new Error("private tester baseline invalid");
  const resources: ResourceIdentity[] = value.resources.map((resource) => {
    if (!exactRecord(resource, ["binding", "kind", "resourceId"]) || !text(resource.binding, /^[A-Z][A-Z0-9_]{1,127}$/) || (resource.kind !== "d1" && resource.kind !== "r2") || typeof resource.resourceId !== "string" || !PROVIDER_RESOURCE.test(resource.resourceId) || !resource.resourceId.startsWith(`${resource.kind}/`)) throw new Error("private tester baseline invalid");
    return { binding: resource.binding, kind: resource.kind as "d1" | "r2", resourceId: resource.resourceId };
  });
  if (canonical(resources.map(({ binding, kind }) => ({ binding, kind }))) !== canonical([{ binding: "AUDIO", kind: "r2" }, { binding: "DB", kind: "d1" }])) throw new Error("private tester baseline invalid");
  return { projectId: value.projectId, current: { version: value.current.version, commitSha: value.current.commitSha }, rollback: { version: value.rollback.version, commitSha: value.rollback.commitSha }, resources };
}
function d1Applied(value: unknown, expected: LedgerEntry[]): AppliedMigration[] {
  if (!exactRecord(value, ["appliedMigrations"]) || !exactArray(value.appliedMigrations) || value.appliedMigrations.length !== expected.length) throw new Error("private tester baseline invalid");
  return value.appliedMigrations.map((entry, index) => {
    if (!exactRecord(entry, ["sequence", "name", "appliedAt"]) || entry.sequence !== index + 1 || entry.name !== `${expected[index]?.id}.sql` || typeof entry.appliedAt !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?$/.test(entry.appliedAt)) throw new Error("private tester baseline invalid");
    return { sequence: entry.sequence, name: entry.name, appliedAt: entry.appliedAt };
  });
}
function d1Schema(value: unknown, expectedDefinitionHash: string, expectedObjectCount: number): { objects: SchemaObject[]; sourceObjects: SchemaObject[]; providerInternalObjects: SchemaObject[]; definitionHash: string } {
  if (!exactRecord(value, ["schema", "objects"]) || value.schema !== "sqlite_schema" || !exactArray(value.objects)) throw new Error("private tester baseline invalid");
  let previous = "";
  const objects = value.objects.map((item) => {
    if (!exactRecord(item, ["type", "name", "tableName", "rootPage", "sql"]) || !text(item.type, /^(?:table|index|trigger|view)$/) || !text(item.name, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/) || !text(item.tableName, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/) || !Number.isSafeInteger(item.rootPage) || Number(item.rootPage) < 0 || (item.sql !== null && (typeof item.sql !== "string" || item.sql.length < 1 || item.sql.length > 1_048_576))) throw new Error("private tester baseline invalid");
    const key = `${item.type}\u0000${item.name}\u0000${item.tableName}`;
    if (key <= previous) throw new Error("private tester baseline invalid");
    previous = key;
    return { type: item.type, name: item.name, tableName: item.tableName, rootPage: Number(item.rootPage), sql: item.sql };
  });
  const providerIdentities = new Set(PRIVATE_TESTER_D1_PROVIDER_INTERNAL_OBJECTS.map(({ type, name, tableName }) => `${type}\u0000${name}\u0000${tableName}`));
  const sourceObjects = objects.filter(({ type, name, tableName }) => !providerIdentities.has(`${type}\u0000${name}\u0000${tableName}`));
  const providerInternalObjects = objects.filter(({ type, name, tableName }) => providerIdentities.has(`${type}\u0000${name}\u0000${tableName}`));
  if (sourceObjects.length !== expectedObjectCount) throw new Error("private tester baseline invalid");
  const definitionHash = hash(sourceObjects.map(({ type, name, tableName, sql }) => ({ type, name, tableName, sql })));
  if (definitionHash !== expectedDefinitionHash) throw new Error("private tester baseline invalid");
  return { objects, sourceObjects, providerInternalObjects, definitionHash };
}
function pgCatalog(value: unknown): { schema: string; relations: { name: string; kind: string; checksum: string }[] } {
  if (!exactRecord(value, ["schema", "relations"]) || value.schema !== "nearyou" || !exactArray(value.relations)) throw new Error("private tester baseline invalid");
  const seen = new Set<string>(); const relations = value.relations.map((relation) => { if (!exactRecord(relation, ["name", "kind", "checksum"]) || !text(relation.name, /^[A-Za-z0-9_.:() ,=-]{1,511}$/) || !text(relation.kind, /^[a-z_]{1,40}$/) || typeof relation.checksum !== "string" || !HASH.test(relation.checksum) || seen.has(`${relation.kind}:${relation.name}`)) throw new Error("private tester baseline invalid"); seen.add(`${relation.kind}:${relation.name}`); return { name: relation.name, kind: relation.kind, checksum: relation.checksum }; });
  return { schema: "nearyou", relations };
}
function dns(value: unknown): { records: { name: string; recordId: string; type: string }[] } {
  if (!exactRecord(value, ["records"]) || !exactArray(value.records)) throw new Error("private tester baseline invalid"); const seen = new Set<string>(); const records = value.records.map((record) => { if (!exactRecord(record, ["name", "recordId", "type"]) || !text(record.name, /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/) || !text(record.recordId) || !text(record.type, /^(?:A|AAAA|CNAME|MX|NS|SOA|TXT)$/) || seen.has(record.recordId)) throw new Error("private tester baseline invalid"); seen.add(record.recordId); return { name: record.name, recordId: record.recordId, type: record.type }; }); return { records };
}
function oauth(value: unknown): { issuer: string; audience: string; clientId: string; providerAcceptedRedirectUri: string; proof: "interaction_required" } { if (!exactRecord(value, ["issuer", "audience", "clientId", "providerAcceptedRedirectUri", "proof"]) || value.issuer !== GOOGLE_ISSUER || value.audience !== GOOGLE_CLIENT_ID || value.clientId !== GOOGLE_CLIENT_ID || value.audience !== value.clientId || value.providerAcceptedRedirectUri !== GOOGLE_REDIRECT || value.proof !== "interaction_required") throw new Error("private tester baseline invalid"); return { issuer: GOOGLE_ISSUER, audience: GOOGLE_CLIENT_ID, clientId: GOOGLE_CLIENT_ID, providerAcceptedRedirectUri: GOOGLE_REDIRECT, proof: "interaction_required" }; }
function versions(value: unknown): string[] { if (!exactRecord(value, ["versions"]) || !exactArray(value.versions)) throw new Error("private tester baseline invalid"); const result = value.versions.map((name) => { if (typeof name !== "string" || !SECRET_VERSION.test(name)) throw new Error("private tester baseline invalid"); return name; }).sort(); if (new Set(result).size !== result.length) throw new Error("private tester baseline invalid"); return result; }
function gates(value: unknown): { nearfamily: false; nearstory: false; scheduler: false } { if (!exactRecord(value, ["nearfamily", "nearstory", "scheduler"]) || value.nearfamily !== false || value.nearstory !== false || value.scheduler !== false) throw new Error("private tester baseline invalid"); return { nearfamily: false, nearstory: false, scheduler: false }; }
function readers(value: unknown): Readers { if (!exactRecord(value, ["controlPlane", "d1", "postgres", "dns", "oauth", "secretManager", "gates"])) throw new Error("private tester baseline invalid"); const methods = (item: unknown, keys: string[]) => exactRecord(item, keys) && keys.every((key) => typeof item[key] === "function"); if (!methods(value.controlPlane, ["read"]) || !methods(value.d1, ["readLedger", "readSchema"]) || !methods(value.postgres, ["readMigrations", "readCatalog"]) || !methods(value.dns, ["readIdentifiers"]) || !methods(value.oauth, ["readIdentifiers"]) || !methods(value.secretManager, ["listVersions"]) || !methods(value.gates, ["read"])) throw new Error("private tester baseline invalid"); return value as unknown as Readers; }

export async function capturePrivateTesterBaseline(input: PrivateTesterBaselineInput): Promise<PrivateTesterBaseline> {
  if (!exactRecord(input, ["release", "expectedD1Ledger", "expectedD1SourceHash", "expectedD1SchemaDefinitionHash", "expectedD1SchemaObjectCount", "outputPath", "now", "readers"]) || typeof input.outputPath !== "string" || input.outputPath.length < 1 || input.outputPath.length > 4_096 || typeof input.now !== "function" || typeof input.expectedD1SourceHash !== "string" || !HASH.test(input.expectedD1SourceHash) || typeof input.expectedD1SchemaDefinitionHash !== "string" || !HASH.test(input.expectedD1SchemaDefinitionHash) || !Number.isSafeInteger(input.expectedD1SchemaObjectCount) || Number(input.expectedD1SchemaObjectCount) < 1 || Number(input.expectedD1SchemaObjectCount) > 1_000) throw new Error("private tester baseline invalid");
  const startedAt = input.now();
  if (!Number.isSafeInteger(startedAt)) throw new Error("private tester baseline invalid");
  const release = parsePrivateTesterRelease(input.release, startedAt), expected = ledger(input.expectedD1Ledger), read = readers(input.readers);
  const raw = await Promise.all([read.controlPlane.read(), read.d1.readLedger(), read.d1.readSchema(), read.postgres.readMigrations(), read.postgres.readCatalog(), read.dns.readIdentifiers(), read.oauth.readIdentifiers(), read.secretManager.listVersions(), read.gates.read()]);
  const capturedAt = input.now();
  if (!Number.isSafeInteger(capturedAt) || capturedAt < startedAt) throw new Error("private tester baseline invalid");
  const finalRelease = parsePrivateTesterRelease(input.release, capturedAt);
  if (canonical(finalRelease) !== canonical(release)) throw new Error("private tester baseline invalid");
  const controlRaw = observation(raw[0], capturedAt), d1LedgerRaw = runtimeObservation(raw[1], capturedAt), d1SchemaRaw = runtimeObservation(raw[2], capturedAt), pgMigrationsRaw = observation(raw[3], capturedAt), pgCatalogRaw = observation(raw[4], capturedAt), dnsRaw = observation(raw[5], capturedAt), oauthRaw = runtimeObservation(raw[6], capturedAt), versionsRaw = observation(raw[7], capturedAt), gatesRaw = runtimeObservation(raw[8], capturedAt);
  if (controlRaw.meta.provider !== "sites-control-plane" || d1LedgerRaw.meta.provider !== "sites-runtime" || d1SchemaRaw.meta.provider !== "sites-runtime" || oauthRaw.meta.provider !== "sites-runtime" || gatesRaw.meta.provider !== "sites-runtime") throw new Error("private tester baseline invalid");
  const control = sitesControlPlane(controlRaw.body);
  const runtime = d1LedgerRaw.meta.workerRuntime;
  if (control.current.version !== release.sitesVersion || control.current.commitSha !== release.commitSha || runtime.commitSha !== control.current.commitSha || canonical(d1SchemaRaw.meta.workerRuntime) !== canonical(runtime) || canonical(oauthRaw.meta.workerRuntime) !== canonical(runtime) || canonical(gatesRaw.meta.workerRuntime) !== canonical(runtime)) throw new Error("private tester baseline invalid");
  const applied = d1Applied(d1LedgerRaw.body, expected), schemaBody = d1Schema(d1SchemaRaw.body, input.expectedD1SchemaDefinitionHash, Number(input.expectedD1SchemaObjectCount)), migrations = ledger(exactRecord(pgMigrationsRaw.body, ["ledger"]) ? pgMigrationsRaw.body.ledger : undefined), catalog = pgCatalog(pgCatalogRaw.body), dnsBody = dns(dnsRaw.body), oauthBody = oauth(oauthRaw.body), secretVersions = versions(versionsRaw.body), gateBody = gates(gatesRaw.body);
  const observations = { controlPlane: controlRaw.meta, d1Ledger: d1LedgerRaw.meta, d1Schema: d1SchemaRaw.meta, postgresMigrations: pgMigrationsRaw.meta, postgresCatalog: pgCatalogRaw.meta, dns: dnsRaw.meta, oauth: oauthRaw.meta, secretManager: versionsRaw.meta, gates: gatesRaw.meta };
  const baseline: PrivateTesterBaseline = { version: 1, capturedAt, release, sites: { ...control, workerRuntime: runtime }, d1: { appliedMigrations: applied, appliedLedgerHash: hash(applied), reviewedSourceHash: input.expectedD1SourceHash, schemaHash: hash(schemaBody.objects), schemaObjectCount: schemaBody.objects.length, sourceSchemaDefinitionHash: schemaBody.definitionHash, sourceSchemaObjectCount: schemaBody.sourceObjects.length, providerInternalSchemaHash: hash(schemaBody.providerInternalObjects), providerInternalSchemaObjectCount: schemaBody.providerInternalObjects.length }, postgres: { migrationsHash: hash(migrations), catalogHash: hash(catalog) }, dns: dnsBody, oauth: oauthBody, bindings: { bindings: control.resources }, secretVersions, gates: gateBody, observations };
  await writeFile(input.outputPath, `${canonical(baseline)}\n`, { flag: "wx" }); return baseline;
}

function envId(environment: NodeJS.ProcessEnv, name: string, pattern = ID): string { const value = environment[name]; if (!value || !pattern.test(value)) throw new Error("private tester baseline configuration missing"); return value; }
async function metadata(path: string, fetcher: typeof fetch): Promise<string> { const response = await fetcher(`http://metadata.google.internal${path}`, { headers: { "metadata-flavor": "Google" }, signal: AbortSignal.timeout(5_000) }); const value = await response.text(); if (!response.ok || value.length < 3 || value.length > 16_384) throw new Error("private tester baseline identity unavailable"); return value; }
async function token(fetcher: typeof fetch): Promise<string> { const value = JSON.parse(await metadata("/computeMetadata/v1/instance/service-accounts/default/token", fetcher)) as { access_token?: unknown; expires_in?: unknown }, expiresIn = value.expires_in; if (typeof value.access_token !== "string" || value.access_token.length < 20 || !Number.isSafeInteger(expiresIn) || Number(expiresIn) < 60 || Number(expiresIn) > 3_600) throw new Error("private tester baseline identity unavailable"); return value.access_token; }
async function gatewayToken(fetcher: typeof fetch): Promise<string> { const value = await metadata(`/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(SITES_GATEWAY_ORIGIN)}&format=standard`, fetcher); if (value.split(".").length !== 3) throw new Error("private tester baseline identity unavailable"); return value; }
async function json(url: string, bearer: string, fetcher: typeof fetch): Promise<RecordValue> { const response = await fetcher(url, { headers: { authorization: `Bearer ${bearer}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) }); const raw = await response.text(); if (!response.ok || new TextEncoder().encode(raw).byteLength > MAX_READER_JSON_BYTES) throw new Error("private tester baseline reader unavailable"); try { const value = JSON.parse(raw); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as RecordValue; } catch { throw new Error("private tester baseline reader unavailable"); } }
function stamp(provider: string, identity: string, body: unknown, now: () => number): Observed { return { provider, identity, observedAt: now(), body }; }
function sitesGateway(subject: string, expectedRelease: PrivateTesterRelease, fetcher: typeof fetch, now: () => number) { const principal = `service:${subject}`, endpoint = new URL(SITES_GATEWAY_ORIGIN); return async (kind: string): Promise<Observed> => { const response = await json(new URL(`/api/internal/private-tester-baseline/${encodeURIComponent(kind)}`, endpoint).toString(), await gatewayToken(fetcher), fetcher), completedAt = now(); if (!exactRecord(response, ["issuer", "audience", "subject", "principal", "observedAt", "release", "workerRuntime", "body"]) || response.issuer !== GOOGLE_ISSUER || response.audience !== SITES_GATEWAY_ORIGIN || response.subject !== subject || response.principal !== principal || canonical(response.release) !== canonical(expectedRelease) || !Number.isSafeInteger(completedAt) || !Number.isSafeInteger(response.observedAt) || Number(response.observedAt) < completedAt - MAX_AGE_MS || Number(response.observedAt) > completedAt + MAX_FUTURE_MS) throw new Error("private tester baseline reader unavailable"); const runtime = workerRuntime(response.workerRuntime, completedAt); if (runtime.commitSha !== expectedRelease.commitSha) throw new Error("private tester baseline reader unavailable"); return { provider: "sites-runtime", identity: principal, observedAt: Number(response.observedAt), workerRuntime: runtime, body: response.body }; }; }
function postgresConnection(environment: NodeJS.ProcessEnv): string { const raw = environment.READINESS_CONTROL_DATABASE_URL ?? "", marker = environment.CLOUD_SQL_IAM_CONNECTOR ?? "", instance = environment.CLOUD_SQL_INSTANCE_CONNECTION_NAME ?? "", expected = environment.CLOUD_SQL_PROXY_ARGS_CHECKSUM ?? "", template = readFileSync(new URL("../infra/production/cloud-sql-auth-proxy.args", import.meta.url), "utf8"), artifact = template.replace("${CLOUD_SQL_INSTANCE_CONNECTION_NAME}", instance), checksum = createHash("sha256")["up\u0064ate"](artifact).digest("hex"); let url: URL; try { url = new URL(raw); } catch { throw new Error("private tester baseline configuration missing"); } if (marker !== "cloud-sql-auth-proxy" || instance !== "nearnight:us-central1:nearyou-production" || expected !== checksum || !artifact.includes("--auto-iam-authn") || !artifact.endsWith(`${instance}\n`) || !["postgres:", "postgresql:"].includes(url.protocol) || url.password || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.searchParams.get("sslmode") !== "disable") throw new Error("private tester baseline configuration missing"); return raw; }
function postgresReaders(environment: NodeJS.ProcessEnv, identity: string) { const connectionString = postgresConnection(environment), expectedUser = envId(environment, "NEARYOU_READINESS_DATABASE_USER", /^nearyou-readiness-ctl@nearnight\.iam\.gserviceaccount\.com$/); const query = async <T extends RecordValue>(sql: string) => { const name = "pg", { Pool } = await import(name) as typeof import("pg"), pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } }); try { const statement = sql.trim().replace(/;$/, ""), rows = (await pool.query<T>(statement)).rows, completion = (await pool.query<{ observed_at: string; session_identity: string; current_identity: string; database_name: string }>("SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint::text AS observed_at,session_user::text AS session_identity,current_user::text AS current_identity,current_database()::text AS database_name")).rows[0], observedAt = Number(completion?.observed_at); if (!Number.isSafeInteger(observedAt) || rows.length < 1 || completion?.session_identity !== expectedUser || completion.current_identity !== expectedUser || completion.database_name !== "nearyou") throw new Error("private tester baseline reader unavailable"); return { observedAt, rows }; } finally { await pool.end(); } };
  return { readMigrations: async (): Promise<Observed> => { const result = await query<{ id: string; checksum: string }>("SELECT id,checksum FROM nearyou.schema_migrations ORDER BY id"); return { provider: "cloud-sql", identity, observedAt: result.observedAt, body: { ledger: result.rows } }; }, readCatalog: async (): Promise<Observed> => { const result = await query<{ kind: string; identity: string; definition: string }>(LIVE_CATALOG_QUERY); return { provider: "cloud-sql", identity, observedAt: result.observedAt, body: { schema: "nearyou", relations: result.rows.map((row) => ({ name: row.identity, kind: row.kind, checksum: hash(row.definition) })) } }; } };
}
export function createAuthenticatedProductionReaders(environment: NodeJS.ProcessEnv = process.env, dependencies: { fetch?: typeof fetch; now?: () => number } = {}, expectedReleaseRaw: unknown): Readers {
  const fetcher = dependencies.fetch ?? fetch, now = dependencies.now ?? Date.now, project = envId(environment, "PRIVATE_TESTER_GCP_PROJECT", /^[a-z][a-z0-9-]{2,62}$/), dnsZone = envId(environment, "PRIVATE_TESTER_DNS_ZONE", NAME), subject = envId(environment, "PRIVATE_TESTER_READER_SUBJECT", /^[1-9][0-9]{10,30}$/), identity = `service:${subject}`; let expectedRelease: PrivateTesterRelease; try { expectedRelease = parsePrivateTesterRelease(expectedReleaseRaw, now()); } catch { throw new Error("private tester baseline configuration missing"); } const sites = sitesGateway(subject, expectedRelease, fetcher, now), postgres = postgresReaders(environment, identity);
  const google = async (host: string, path: string) => stamp("google", identity, await json(`https://${host}${path}`, await token(fetcher), fetcher), now);
  const pages = async (host: string, path: string, key: string) => { const values: unknown[] = [], tokens = new Set<string>(); let pageToken = ""; for (let page = 0; page < 100; page += 1) { const separator = path.includes("?") ? "&" : "?", value = await google(host, `${path}${pageToken ? `${separator}pageToken=${encodeURIComponent(pageToken)}` : ""}`), body = value.body as RecordValue, items = body[key]; if (!Array.isArray(items) || items.length > 1_000) throw new Error("private tester baseline reader unavailable"); values.push(...items); const next = body.nextPageToken; if (next === undefined) return { meta: { provider: value.provider, identity: value.identity, observedAt: value.observedAt }, values }; if (!text(next, /^[A-Za-z0-9_-]{1,512}$/) || tokens.has(next)) throw new Error("private tester baseline reader unavailable"); tokens.add(next); pageToken = next; } throw new Error("private tester baseline reader unavailable"); };
  return {
    controlPlane: { read: async () => { throw new Error("private tester Sites control-plane unavailable"); } },
    d1: { readLedger: async () => sites("d1-ledger"), readSchema: async () => sites("d1-schema") },
    postgres, gates: { read: async () => sites("gates") },
    secretManager: { listVersions: async () => { const inventories = await Promise.all(REVIEWED_SECRETS.map(async (secret) => ({ secret, value: await pages("secretmanager.googleapis.com", `/v1/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(secret)}/versions?filter=state%3DENABLED&pageSize=1000`, "versions") }))), listed = inventories.flatMap(({ secret, value }) => value.values.map((item) => item && typeof item === "object" && !Array.isArray(item) && (item as RecordValue).state === "ENABLED" && (item as RecordValue).name?.toString().startsWith(`projects/${project}/secrets/${secret}/versions/`) ? (item as RecordValue).name : undefined)), completedAt = now(); if (!Number.isSafeInteger(completedAt)) throw new Error("private tester baseline reader unavailable"); return { provider: "google", identity, observedAt: completedAt, body: { versions: listed } }; } },
    dns: { readIdentifiers: async () => { const value = await pages("dns.googleapis.com", `/dns/v1/projects/${encodeURIComponent(project)}/managedZones/${encodeURIComponent(dnsZone)}/rrsets?maxResults=1000`, "rrsets"), rows = value.values.map((item) => item && typeof item === "object" && !Array.isArray(item) && typeof (item as RecordValue).name === "string" && typeof (item as RecordValue).type === "string" && /^(?:A|AAAA|CNAME|MX|NS|SOA|TXT)$/.test(String((item as RecordValue).type)) && Array.isArray((item as RecordValue).rrdatas) ? { name: String((item as RecordValue).name).replace(/\.$/, ""), recordId: hash({ name: (item as RecordValue).name, type: (item as RecordValue).type, rrdatas: (item as RecordValue).rrdatas }), type: (item as RecordValue).type } : undefined); return { ...value.meta, body: { records: rows } }; } },
    oauth: { readIdentifiers: async () => sites("oauth") },
  };
}
if (import.meta.url === `file://${process.argv[1]}`) { const [releasePath, outputPath] = process.argv.slice(2); if (!releasePath || !outputPath) throw new Error("private tester baseline configuration missing"); Promise.all([readFile(releasePath, "utf8"), verifyPrivateTesterD1SourceBaseline()]).then(async ([releaseRaw, reviewed]) => { const release = JSON.parse(releaseRaw); return capturePrivateTesterBaseline({ release, expectedD1Ledger: reviewed.sources.slice(1), expectedD1SourceHash: reviewed.sourceHash, expectedD1SchemaDefinitionHash: reviewed.schemaDefinitionHash, expectedD1SchemaObjectCount: reviewed.schemaObjectCount, outputPath, now: Date.now, readers: createAuthenticatedProductionReaders(process.env, { now: Date.now }, release) }); }).catch(() => { process.stderr.write("private tester baseline failed\n"); process.exitCode = 1; }); }
