import { nearFamilySourceActivated } from "./nearfamily-activation";
import { parsePrivateTesterRelease, type PrivateTesterRelease } from "./private-tester-release";
import d1SourceBaseline from "../infra/production/private-tester-d1-schema-baseline.json";

const ORIGIN = "https://nearyoustill.com";
const PREFIX = "/api/internal/private-tester-baseline/";
const KINDS = new Set([
  "d1-ledger",
  "d1-schema",
  "gates",
  "oauth",
]);

type Trust = { issuer: string; audience: string; subject: string };
type WorkerRuntime = { id: string; commitSha: string; deployedAt: string };
type LoadedEvidence = {
  release: PrivateTesterRelease;
  workerRuntime: WorkerRuntime;
  read(kind: string): Promise<unknown>;
};

type D1Result = { results?: unknown[] };
type GatewayEnvironment = Record<string, unknown> & {
  DB?: { prepare(sql: string): { all(): Promise<D1Result> } };
};

const HASH = /^[a-f0-9]{64}$/;
const SITES_PROJECT_PREFIX = "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GOOGLE_CLIENT_ID = "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com";
const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_ORIGIN = "https://nearyoustill.com";
const GOOGLE_REDIRECT = `${GOOGLE_ORIGIN}/api/auth/callback/google`;
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const MAX_JWKS_BYTES = 65_536;
const MAX_RUNTIME_AGE_MS = 300_000;
const MAX_FUTURE_MS = 30_000;
const REVIEWED_D1_SCHEMA_DEFINITION_HASH = d1SourceBaseline.sqlite_schema_source_definitions_sha256;
const REVIEWED_D1_SCHEMA_OBJECT_COUNT = d1SourceBaseline.sqlite_schema_source_object_count;
export const EXACT_D1_PROVIDER_INTERNAL_OBJECTS = Object.freeze([
  Object.freeze({ type: "index", name: "sqlite_autoindex_d1_migrations_1", tableName: "d1_migrations", sql: null }),
  Object.freeze({ type: "table", name: "_cf_METADATA", tableName: "_cf_METADATA", sql: "CREATE TABLE _cf_METADATA (\n        key INTEGER PRIMARY KEY,\n        value BLOB\n      )" }),
  Object.freeze({ type: "table", name: "d1_migrations", tableName: "d1_migrations", sql: "CREATE TABLE d1_migrations(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n)" }),
  Object.freeze({ type: "table", name: "sqlite_sequence", tableName: "sqlite_sequence", sql: "CREATE TABLE sqlite_sequence(name,seq)" }),
  Object.freeze({ type: "table", name: "sqlite_stat1", tableName: "sqlite_stat1", sql: "CREATE TABLE sqlite_stat1(tbl,idx,stat)" }),
]);
const D1_PROVIDER_INTERNAL_IDENTITIES = new Set(EXACT_D1_PROVIDER_INTERNAL_OBJECTS.map(({ type, name, tableName }) => `${type}\u0000${name}\u0000${tableName}`));
const D1_PROVIDER_INTERNAL_NAMES: ReadonlySet<string> = new Set(EXACT_D1_PROVIDER_INTERNAL_OBJECTS.map(({ name }) => name));
const D1_PROVIDER_INTERNAL_TABLE_NAMES: ReadonlySet<string> = new Set(EXACT_D1_PROVIDER_INTERNAL_OBJECTS.map(({ tableName }) => tableName));
const D1_PROVIDER_INTERNAL_RECORDS = new Set(EXACT_D1_PROVIDER_INTERNAL_OBJECTS.map(({ type, name, tableName, sql }) => JSON.stringify([type, name, tableName, sql])));
const REQUIRED_GATEWAY_VARS = Object.freeze([
  "PRIVATE_TESTER_BASELINE_OIDC_SUBJECT",
  "PRIVATE_TESTER_BASELINE_RELEASE_JSON",
  "PRIVATE_TESTER_SCHEDULER_ENABLED",
  "NEARYOU_ENABLE_STORY",
  "NEARYOU_ENABLE_LEGACY_ARCHIVE",
]);
const RUNTIME_BINDINGS = Object.freeze(["DB", "VERSION_METADATA", "GOOGLE_CLIENT_ID", "BETTER_AUTH_URL", "PUBLIC_APP_URL"]);
const DARK_BINDINGS = Object.freeze(["NEARYOU_ENABLE_STORY", "NEARYOU_ENABLE_LEGACY_ARCHIVE", "PRIVATE_TESTER_SCHEDULER_ENABLED"]);
const D1_MIGRATIONS = Object.freeze([
  "0000_nearnight_foundation",
  "0001_google_apple_auth",
  "0002_sharp_shinobi_shaw",
  "0003_white_groot",
  "0004_salty_sugar_man",
  "0005_pronunciation_frequency_layers",
  "0006_nearyou_shared_foundation",
  "0007_nearsleep_production_upgrade",
  "0008_nearsleep_live_integration",
  "0009_nearsleep_audio_atomic",
  "0010_child_profile_pronunciation",
  "0011_household_billing_accounts",
  "0012_nearsleep_library_privacy",
  "0013_nearstory_parent_beta",
  "0014_nearlegacy_archive",
  "0015_platform_release_foundation",
  "0016_marketing_waitlist",
]);

function configurationError(): never { throw new Error("private tester gateway configuration invalid"); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
async function sha256(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function exactStrings(value: unknown, expected: readonly string[]): boolean { return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected); }

export function validateExactD1ProviderObjects(objects: readonly { type: string; name: string; tableName: string; sql: string | null }[]): void {
  const providerRecords = objects
    .filter(({ name, tableName }) => D1_PROVIDER_INTERNAL_NAMES.has(name) || D1_PROVIDER_INTERNAL_TABLE_NAMES.has(tableName))
    .map(({ type, name, tableName, sql }) => JSON.stringify([type, name, tableName, sql]));
  const actual = new Set(providerRecords);
  if (providerRecords.length !== D1_PROVIDER_INTERNAL_RECORDS.size || actual.size !== providerRecords.length || [...D1_PROVIDER_INTERNAL_RECORDS].some((record) => !actual.has(record))) throw new Error("private tester D1 provider schema invalid");
}

export function assertPrivateTesterDeploymentContract(bindings: unknown, hosting: unknown): void {
  try {
    if (!object(bindings) || !object(hosting) || !object(bindings.required_worker_bindings) || !object(bindings.private_tester_baseline_gateway)) throw new Error();
    const required = bindings.required_worker_bindings;
    const contract = bindings.private_tester_baseline_gateway;
    const requiredVars = required.vars;
    if (!Array.isArray(requiredVars) || requiredVars.some((name) => typeof name !== "string") || REQUIRED_GATEWAY_VARS.some((name) => !requiredVars.includes(name)) || !exactStrings(required.version_metadata, ["VERSION_METADATA"])) throw new Error();
    if (hosting.project_id !== "appgprj_6a79f8a66eb4819198bb42a2b26addea" || hosting.d1 !== "DB" || hosting.r2 !== "AUDIO" || contract.sites_project_id !== hosting.project_id || contract.d1_binding !== hosting.d1 || contract.r2_binding !== hosting.r2) throw new Error();
    if (!object(contract.route) || contract.route.origin !== ORIGIN || contract.route.path_prefix !== PREFIX || !object(contract.oidc) || contract.oidc.issuer !== GOOGLE_ISSUER || contract.oidc.audience !== ORIGIN || contract.oidc.subject_binding !== "PRIVATE_TESTER_BASELINE_OIDC_SUBJECT" || contract.oidc.jwks_url !== GOOGLE_JWKS) throw new Error();
    if (!exactStrings(contract.runtime_bindings, RUNTIME_BINDINGS) || Object.hasOwn(contract, "live_bindings") || Object.hasOwn(contract, "rollback_binding") || contract.version_metadata_tag !== "release.commitSha" || !exactStrings(contract.default_dark_bindings, DARK_BINDINGS) || contract.release_binding !== "PRIVATE_TESTER_BASELINE_RELEASE_JSON") throw new Error();
  } catch {
    throw new Error("private tester deployment contract invalid");
  }
}
function base64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error("private tester service identity invalid");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), (character) => character.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  if (canonical !== value) throw new Error("private tester service identity invalid");
  return bytes;
}
function jwtObject(value: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64url(value))); } catch { throw new Error("private tester service identity invalid"); }
  if (!object(parsed) || Reflect.ownKeys(parsed).some((key) => typeof key !== "string" || !allowed.includes(key)) || required.some((key) => !Object.hasOwn(parsed, key))) throw new Error("private tester service identity invalid");
  return parsed;
}

async function fetchWithin(fetcher: typeof fetch, resource: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetcher(resource, init),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("request timed out")), timeoutMs); }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function createGoogleServiceIdentityAuthenticator(input: Trust & { fetch?: typeof fetch; now?: () => number }) {
  if (input.issuer !== GOOGLE_ISSUER || input.audience !== GOOGLE_ORIGIN || !/^[1-9][0-9]{10,30}$/.test(input.subject)) configurationError();
  const fetcher = input.fetch ?? fetch;
  const requireProviderUrl = input.fetch === undefined;
  const now = input.now ?? Date.now;
  return async (request: Request): Promise<Trust> => {
    let failureStage = "authorization";
    try {
      const authorization = request.headers.get("authorization") ?? "";
      if (!authorization.startsWith("Bearer ")) throw new Error();
      const token = authorization.slice(7), parts = token.split(".");
      if (parts.length !== 3 || token.length > 16_384) throw new Error();
      const header = jwtObject(parts[0]!, ["alg", "kid", "typ"], ["alg", "kid"]);
      const claims = jwtObject(parts[1]!, ["aud", "azp", "email", "email_verified", "exp", "iat", "iss", "sub"], ["aud", "exp", "iat", "iss", "sub"]);
      failureStage = "claims";
      const timestamp = now(), issuedAt = claims.iat, expiresAt = claims.exp;
      if (header.alg !== "RS256" || typeof header.kid !== "string" || (header.typ !== undefined && header.typ !== "JWT") || claims.iss !== input.issuer || claims.aud !== input.audience || claims.sub !== input.subject || (claims.azp !== undefined && claims.azp !== input.subject) || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(timestamp) || Number(issuedAt) > timestamp / 1000 + 30 || Number(expiresAt) <= timestamp / 1000 || Number(expiresAt) - Number(issuedAt) > 3_600) throw new Error();
      failureStage = "jwks-fetch";
      const response = await fetchWithin(fetcher, GOOGLE_JWKS, {}, 5_000);
      failureStage = "jwks-body";
      const raw = await response.text();
      failureStage = "jwks-contract";
      if (!response.ok || response.redirected || (requireProviderUrl && response.url !== GOOGLE_JWKS) || response.headers.get("content-type")?.split(";")[0] !== "application/json" || new TextEncoder().encode(raw).byteLength > MAX_JWKS_BYTES) throw new Error();
      failureStage = "jwks-json";
      const root = JSON.parse(raw) as unknown;
      failureStage = "jwks-shape";
      if (!object(root) || Reflect.ownKeys(root).length !== 1 || !Array.isArray(root.keys) || root.keys.length < 1 || root.keys.length > 10) throw new Error();
      const keys = root.keys.map((item) => {
        if (!object(item) || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(["alg", "e", "kid", "kty", "n", "use"]) || item.kty !== "RSA" || item.alg !== "RS256" || item.use !== "sig" || item.e !== "AQAB" || typeof item.kid !== "string" || typeof item.n !== "string" || base64url(item.n).byteLength < 256) throw new Error();
        return item as unknown as JsonWebKey & { kid: string };
      });
      if (new Set(keys.map((key) => key.kid)).size !== keys.length) throw new Error();
      const jwk = keys.find((key) => key.kid === header.kid);
      if (!jwk) throw new Error();
      failureStage = "signature";
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const signature = base64url(parts[2]!);
      const signatureBuffer = Uint8Array.from(signature).buffer;
      if (signature.byteLength !== (key.algorithm as RsaHashedKeyAlgorithm).modulusLength / 8 || !await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureBuffer, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error();
      return { issuer: input.issuer, audience: input.audience, subject: input.subject };
    } catch {
      console.warn(`private tester service identity rejected at ${failureStage}`);
      throw new Error("private tester service identity invalid");
    }
  };
}

function assertWorkerRuntime(value: WorkerRuntime, release: PrivateTesterRelease, observedAt: number): void {
  const deployedAt = Date.parse(value.deployedAt);
  if (!Number.isSafeInteger(observedAt) || !UUID.test(value.id) || value.commitSha !== release.commitSha || !Number.isFinite(deployedAt) || deployedAt < observedAt - MAX_RUNTIME_AGE_MS || deployedAt > observedAt + MAX_FUTURE_MS) configurationError();
}

export function createPrivateTesterBaselineRuntime(environment: GatewayEnvironment, dependencies: { fetch?: typeof fetch; now?: () => number; expectedD1SchemaDefinitionHash?: string; expectedD1SchemaObjectCount?: number } = {}): LoadedEvidence {
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const expectedD1SchemaDefinitionHash = dependencies.expectedD1SchemaDefinitionHash ?? REVIEWED_D1_SCHEMA_DEFINITION_HASH;
  const expectedD1SchemaObjectCount = dependencies.expectedD1SchemaObjectCount ?? REVIEWED_D1_SCHEMA_OBJECT_COUNT;
  let rawRelease: unknown;
  try { rawRelease = JSON.parse(String(environment.PRIVATE_TESTER_BASELINE_RELEASE_JSON ?? "")); } catch { console.warn("private tester runtime rejected at release-json"); configurationError(); }
  const startsAt = object(rawRelease) && typeof rawRelease.startsAt === "string" ? Date.parse(rawRelease.startsAt) : Number.NaN;
  let release: PrivateTesterRelease;
  try { release = parsePrivateTesterRelease(rawRelease, startsAt); } catch { console.warn("private tester runtime rejected at release-contract"); configurationError(); }
  const metadata = environment.VERSION_METADATA;
  const db = environment.DB;
  const runtimeNow = now();
  const manifestProviderObjects = EXACT_D1_PROVIDER_INTERNAL_OBJECTS.map(({ type, name, tableName }) => ({ type, name, table_name: tableName }));
  if (!release.sitesVersion.startsWith(SITES_PROJECT_PREFIX)) { console.warn("private tester runtime rejected at sites-version"); configurationError(); }
  if (!object(metadata)) { console.warn("private tester runtime rejected at metadata-object"); configurationError(); }
  if (Reflect.ownKeys(metadata).length !== 3 || typeof metadata.id !== "string" || typeof metadata.tag !== "string" || typeof metadata.timestamp !== "string") { console.warn(`private tester runtime rejected at metadata-shape:${Object.keys(metadata).sort().join(",")}`); configurationError(); }
  if (!HASH.test(expectedD1SchemaDefinitionHash) || !Number.isSafeInteger(expectedD1SchemaObjectCount) || expectedD1SchemaObjectCount < 1 || expectedD1SchemaObjectCount > 1_000 || JSON.stringify(d1SourceBaseline.provider_internal_schema_objects) !== JSON.stringify(manifestProviderObjects)) { console.warn("private tester runtime rejected at reviewed-baseline"); configurationError(); }
  if (!db || typeof db.prepare !== "function") { console.warn("private tester runtime rejected at d1-binding"); configurationError(); }
  const workerRuntime = { id: metadata.id, commitSha: metadata.tag, deployedAt: metadata.timestamp };
  try { assertWorkerRuntime(workerRuntime, release, runtimeNow); } catch { console.warn("private tester runtime rejected at worker-binding"); configurationError(); }
  if (environment.GOOGLE_CLIENT_ID !== GOOGLE_CLIENT_ID || environment.BETTER_AUTH_URL !== GOOGLE_ORIGIN || environment.PUBLIC_APP_URL !== GOOGLE_ORIGIN || environment.NEARYOU_ENABLE_STORY !== "false" || environment.NEARYOU_ENABLE_LEGACY_ARCHIVE !== "false" || environment.PRIVATE_TESTER_SCHEDULER_ENABLED !== "false" || nearFamilySourceActivated()) { console.warn("private tester runtime rejected at environment-contract"); configurationError(); }

  const d1Ledger = async () => {
    const result = await db.prepare("SELECT id,name,applied_at FROM d1_migrations ORDER BY id").all();
    const expected = D1_MIGRATIONS.map((id) => `${id}.sql`);
    if (!Array.isArray(result.results) || result.results.length !== expected.length) throw new Error("private tester gateway evidence unavailable");
    const appliedMigrations = result.results.map((row, index) => {
      if (!object(row) || Reflect.ownKeys(row).length !== 3 || row.id !== index + 1 || row.name !== expected[index] || typeof row.applied_at !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?$/.test(row.applied_at)) throw new Error("private tester gateway evidence unavailable");
      return { sequence: row.id, name: row.name, appliedAt: row.applied_at };
    });
    return { appliedMigrations };
  };
  const d1Schema = async () => {
    const result = await db.prepare("SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name,tbl_name").all();
    if (!Array.isArray(result.results) || result.results.length < 1 || result.results.length > 1_000) throw new Error("private tester gateway evidence unavailable");
    let previous = "";
    const objects = result.results.map((row) => {
      if (!object(row) || Reflect.ownKeys(row).length !== 5 || !["table", "index", "trigger", "view"].includes(String(row.type)) || typeof row.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.name) || typeof row.tbl_name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.tbl_name) || !Number.isSafeInteger(row.rootpage) || Number(row.rootpage) < 0 || (row.sql !== null && (typeof row.sql !== "string" || row.sql.length < 1 || row.sql.length > 1_048_576))) throw new Error("private tester gateway evidence unavailable");
      const key = `${row.type}\u0000${row.name}\u0000${row.tbl_name}`;
      if (key <= previous) throw new Error("private tester gateway evidence unavailable");
      previous = key;
      return { type: row.type as string, name: row.name, tableName: row.tbl_name, rootPage: Number(row.rootpage), sql: row.sql };
    });
    try { validateExactD1ProviderObjects(objects); } catch { throw new Error("private tester gateway evidence unavailable"); }
    const sourceObjects = objects.filter(({ type, name, tableName }) => !D1_PROVIDER_INTERNAL_IDENTITIES.has(`${type}\u0000${name}\u0000${tableName}`));
    if (sourceObjects.length !== expectedD1SchemaObjectCount) throw new Error("private tester gateway evidence unavailable");
    const definitions = sourceObjects.map(({ type, name, tableName, sql }) => ({ type, name, tableName, sql }));
    if (await sha256(JSON.stringify(definitions)) !== expectedD1SchemaDefinitionHash) throw new Error("private tester gateway evidence unavailable");
    return { schema: "sqlite_schema", objects };
  };
  const oauth = async () => {
    const state = crypto.randomUUID();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [key, value] of [["client_id", GOOGLE_CLIENT_ID], ["redirect_uri", GOOGLE_REDIRECT], ["response_type", "code"], ["scope", "openid email profile"], ["state", state], ["nonce", state], ["prompt", "none"]]) url.searchParams.set(key, value);
    const response = await fetchWithin(fetcher, url, { redirect: "manual" }, 5_000);
    const location = response.headers.get("location");
    let returned: URL;
    try { returned = new URL(location ?? ""); } catch { throw new Error("private tester gateway evidence unavailable"); }
    if (response.status !== 302 || returned.origin !== GOOGLE_ORIGIN || returned.pathname !== "/api/auth/callback/google" || returned.searchParams.get("state") !== state || returned.searchParams.get("error") !== "interaction_required" || returned.searchParams.has("code")) throw new Error("private tester gateway evidence unavailable");
    return { issuer: GOOGLE_ISSUER, audience: GOOGLE_CLIENT_ID, clientId: GOOGLE_CLIENT_ID, providerAcceptedRedirectUri: GOOGLE_REDIRECT, proof: "interaction_required" };
  };
  return {
    release,
    workerRuntime,
    async read(kind: string) {
      if (kind === "d1-ledger") return d1Ledger();
      if (kind === "d1-schema") return d1Schema();
      if (kind === "gates") return { nearfamily: false, nearstory: false, scheduler: false };
      if (kind === "oauth") return oauth();
      throw new Error("private tester gateway evidence unavailable");
    },
  };
}

export function createPrivateTesterBaselineGateway(input: {
  trust: Trust;
  authenticate(request: Request): Promise<Trust>;
  load(): Promise<LoadedEvidence>;
  now(): number;
}) {
  return async (request: Request): Promise<Response> => {
    let claims: Trust;
    try {
      claims = await input.authenticate(request);
      if (claims.issuer !== input.trust.issuer || claims.audience !== input.trust.audience || claims.subject !== input.trust.subject) throw new Error("claim mismatch");
    } catch {
      return new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
    }

    let evidenceFailureStage = "runtime-load";
    try {
      const url = new URL(request.url);
      const kind = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : "";
      if (request.method !== "GET" || url.origin !== ORIGIN || url.search || url.hash || !KINDS.has(kind)) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
      const loaded = await input.load();
      evidenceFailureStage = "evidence-read";
      const body = await loaded.read(kind);
      evidenceFailureStage = "observation";
      const observedAt = input.now();
      if (!Number.isSafeInteger(observedAt)) throw new Error("clock unavailable");
      assertWorkerRuntime(loaded.workerRuntime, loaded.release, observedAt);
      return Response.json({
        issuer: claims.issuer,
        audience: claims.audience,
        subject: claims.subject,
        principal: `service:${claims.subject}`,
        observedAt,
        release: loaded.release,
        workerRuntime: loaded.workerRuntime,
        body,
      }, { headers: { "cache-control": "no-store" } });
    } catch {
      console.warn(`private tester evidence unavailable at ${evidenceFailureStage}`);
      return new Response("Unavailable", { status: 503, headers: { "cache-control": "no-store" } });
    }
  };
}
