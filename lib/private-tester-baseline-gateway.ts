import { nearFamilySourceActivated } from "./nearfamily-activation";
import { parsePrivateTesterRelease, type PrivateTesterRelease } from "./private-tester-release";
import d1SourceBaseline from "../infra/production/private-tester-d1-schema-baseline.json";
import { SITES_D1_PHASE_A_ARTIFACT } from "./sites-d1-phase-a-artifact.generated";
import { SITES_D1_PHASE_B_ARTIFACT } from "./sites-d1-phase-b-artifact.generated";
import { SITES_D1_PHASE_C_ARTIFACT } from "./sites-d1-phase-c-artifact.generated";
import { SITES_D1_FORWARD_ARTIFACT } from "./sites-d1-forward-artifact.generated";
import { createD1LedgerEvidenceReader, createD1SchemaEvidenceReader } from "./private-tester-sites-evidence";
import { privateTesterPackagedBuildId } from "./private-tester-packaged-build-id";

const ORIGIN = "https://nearyoustill.com";
const PREFIX = "/api/internal/private-tester-baseline/";
const KINDS = new Set([
  "d1-ledger",
  "d1-schema",
  "d1-schema-page",
  "d1-ledger-page",
  "d1-convergence-ledger",
  "d1-convergence-schema",
  "d1-convergence-shape",
  "d1-convergence-probes",
  "d1-phase-c-receipt",
  "d1-source-fingerprint",
  "d1-source-manifest",
  "gates",
  "oauth",
]);
export const D1_CONVERGENCE_PROBES=Object.freeze([
  ["0010-pronunciation-backfill","/* convergence_probe:0010-pronunciation-backfill */ SELECT p.id AS identity,COALESCE(c.pronunciation,'') AS target FROM child_profiles p LEFT JOIN children c ON c.id=p.legacy_child_id AND c.household_id=p.household_id WHERE p.legacy_child_id IS NOT NULL ORDER BY p.id"],
  ["0011-live-voice-preflight","/* convergence_probe:0011-live-voice-preflight */ SELECT COUNT(*) AS rowCount,COALESCE(SUM(live_count-1),0) AS violationCount FROM (SELECT COUNT(*) AS live_count FROM voices WHERE household_id IS NOT NULL AND status IN ('processing','ready') GROUP BY household_id,user_id HAVING COUNT(*)>1)"],
  ["0011-entitlement-period-backfill","/* convergence_probe:0011-entitlement-period-backfill */ SELECT id AS identity,CAST(valid_from/1000 AS INTEGER) AS target FROM entitlements WHERE external_ref IS NOT NULL ORDER BY id"],
  ["0011-billing-account-insert","/* convergence_probe:0011-billing-account-insert */ SELECT h.id AS identity,u.stripe_customer_id,u.subscription_id,u.subscription_price_id,u.subscription_status,u.subscription_event_created_at,u.checkout_pending_at,u.last_credited_invoice_id,u.last_credited_period_start,h.created_at,h.updated_at FROM households h JOIN users u ON h.id='household:'||u.id ORDER BY h.id"],
  ["0011-billing-subscription-insert","/* convergence_probe:0011-billing-subscription-insert */ SELECT h.id AS identity,u.subscription_id,u.stripe_customer_id,u.subscription_price_id,u.subscription_status,u.subscription_event_created_at,h.created_at,h.updated_at FROM households h JOIN users u ON h.id='household:'||u.id WHERE u.subscription_id IS NOT NULL AND u.stripe_customer_id IS NOT NULL ORDER BY h.id,u.subscription_id"],
  ["0011-consent-revocation","/* convergence_probe:0011-consent-revocation */ SELECT c.id AS identity,c.revoked_at AS prior,'revoke' AS target FROM voice_consents c WHERE c.status='active_verified' AND c.voice_id IS NOT NULL AND c.id<>COALESCE((SELECT v.current_consent_id FROM voices v WHERE v.id=c.voice_id),'') ORDER BY c.id"],
  ["0012-deletion-reconciliation-backfill","/* convergence_probe:0012-deletion-reconciliation-backfill */ SELECT d.id AS identity,COALESCE((SELECT s.household_id FROM sleep_sessions s WHERE s.id=d.scope_id),(SELECT v.household_id FROM voices v WHERE v.id=d.scope_id),(SELECT r.household_id FROM voice_replacements r WHERE r.id=d.scope_id),(SELECT h.id FROM households h WHERE h.id=d.scope_id AND d.scope='account')) AS target FROM deletion_reconciliations d ORDER BY d.id"],
  ["0012-storage-reservation-insert","/* convergence_probe:0012-storage-reservation-insert */ SELECT 'storage:'||m.id AS identity,m.household_id,m.id AS media_asset_id,m.byte_size,'reserved' AS target,m.created_at,m.updated_at FROM media_assets m WHERE m.status='ready' AND m.byte_size IS NOT NULL AND m.byte_size>0 ORDER BY m.id"],
  ["0012-storage-reservation-commit","/* convergence_probe:0012-storage-reservation-commit */ SELECT m.id AS identity,'committed' AS target FROM media_assets m WHERE m.status='ready' AND m.byte_size IS NOT NULL AND m.byte_size>0 ORDER BY m.id"],
  ["0012-ready-media-preflight","/* convergence_probe:0012-ready-media-preflight */ SELECT COUNT(*) AS rowCount,COUNT(*) AS violationCount FROM media_assets m WHERE m.status='ready'"],
  ["0012-owner-membership-preflight","/* convergence_probe:0012-owner-membership-preflight */ SELECT COUNT(*) AS rowCount,COUNT(*) AS violationCount FROM households h WHERE (SELECT COUNT(*) FROM household_members m WHERE m.household_id=h.id AND m.status='active' AND m.role='owner')<>1 OR NOT EXISTS(SELECT 1 FROM household_members m WHERE m.household_id=h.id AND m.user_id=h.owner_user_id AND m.status='active' AND m.role='owner')"],
  ["0012-playing-queue-preflight","/* convergence_probe:0012-playing-queue-preflight */ SELECT COUNT(*) AS rowCount,COALESCE(SUM(playing_count-1),0) AS violationCount FROM (SELECT COUNT(*) AS playing_count FROM bedtime_queue_items WHERE status='playing' GROUP BY household_id HAVING COUNT(*)>1)"],
  ["0012-foreign-key-preflight","/* convergence_probe:0012-foreign-key-preflight */ SELECT COUNT(*) AS rowCount,COUNT(*) AS violationCount FROM pragma_foreign_key_check"],
] as const);

type Trust = { issuer: string; audience: string; subject: string };
type LoadedEvidence = {
  release: PrivateTesterRelease;
  read(kind: string, cursor?: string | null): Promise<unknown>;
};

type D1Result = { results?: unknown[] };
type GatewayEnvironment = Record<string, unknown> & {
  DB?: { prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<D1Result> }; all(): Promise<D1Result> } };
};

const HASH = /^[a-f0-9]{64}$/;
const SITES_PROJECT_PREFIX = "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_";
const GOOGLE_CLIENT_ID = "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com";
const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_ORIGIN = "https://nearyoustill.com";
const GOOGLE_REDIRECT = `${GOOGLE_ORIGIN}/api/auth/callback/google`;
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const MAX_JWKS_BYTES = 65_536;
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
const RUNTIME_BINDINGS = Object.freeze(["DB", "GOOGLE_CLIENT_ID", "BETTER_AUTH_URL", "PUBLIC_APP_URL"]);
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
export const D1_CONVERGENCE_TABLES = Object.freeze([
  "auth_sessions", "auth_verifications", "child_profiles", "children", "contributors", "entitlements",
  "household_invitations", "household_members", "households", "jobs", "marketing_waitlist_contacts",
  "marketing_waitlist_interests", "marketing_waitlist_sync", "media_assets", "oauth_accounts", "playlist_items",
  "playlists", "sleep_sessions", "stripe_events", "usage_events", "usage_ledger", "users", "voice_consents", "voices",
]);
const D1_CONVERGENCE_TABLE_SQL = D1_CONVERGENCE_TABLES.map((name) => `'${name}'`).join(",");
export const D1_CONVERGENCE_SHAPE_QUERIES = Object.freeze({
  table_xinfo: `/* table_xinfo */ SELECT m.name AS "tableName",p.cid AS cid,p.name AS name,p.type AS type,p."notnull" AS "notNull",p.dflt_value AS "defaultValue",p.pk AS "primaryKey",p.hidden AS hidden FROM sqlite_schema AS m JOIN pragma_table_xinfo(m.name) AS p WHERE m.type='table' AND m.name IN (${D1_CONVERGENCE_TABLE_SQL}) ORDER BY m.name,p.cid`,
  foreign_key_list: `/* foreign_key_list */ SELECT m.name AS "tableName",p.id AS id,p.seq AS seq,p."table" AS "parentTable",p."from" AS "fromColumn",p."to" AS "toColumn",p.on_update AS "onUpdate",p.on_delete AS "onDelete",p.match AS match FROM sqlite_schema AS m JOIN pragma_foreign_key_list(m.name) AS p WHERE m.type='table' AND m.name IN (${D1_CONVERGENCE_TABLE_SQL}) ORDER BY m.name,p.id,p.seq`,
  index_list: `/* index_list */ SELECT m.name AS "tableName",p.seq AS seq,p.name AS name,p."unique" AS "unique",p.origin AS origin,p.partial AS partial FROM sqlite_schema AS m JOIN pragma_index_list(m.name) AS p WHERE m.type='table' AND m.name IN (${D1_CONVERGENCE_TABLE_SQL}) ORDER BY m.name,p.seq,p.name`,
  index_xinfo: `/* index_xinfo */ SELECT m.name AS "indexName",p.seqno AS seqno,p.cid AS cid,p.name AS name,p.desc AS desc,p.coll AS coll,p."key" AS "key" FROM sqlite_schema AS m JOIN pragma_index_xinfo(m.name) AS p WHERE m.type='index' AND m.tbl_name IN (${D1_CONVERGENCE_TABLE_SQL}) ORDER BY m.name,p.seqno`,
  foreign_key_check: "/* foreign_key_check */ SELECT \"table\" AS \"tableName\",rowid AS \"rowId\",parent AS \"parentTable\",fkid AS \"fkId\" FROM pragma_foreign_key_check LIMIT 101",
});

function configurationError(): never { throw new Error("private tester gateway configuration invalid"); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
async function sha256(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function exactStrings(value: unknown, expected: readonly string[]): boolean { return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected); }
function diagnosticText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2_048 && Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
  });
}

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
    if (!Array.isArray(requiredVars) || requiredVars.some((name) => typeof name !== "string") || REQUIRED_GATEWAY_VARS.some((name) => !requiredVars.includes(name)) || !exactStrings(required.version_metadata, [])) throw new Error();
    if (hosting.project_id !== "appgprj_6a79f8a66eb4819198bb42a2b26addea" || hosting.d1 !== "DB" || hosting.r2 !== "AUDIO" || contract.sites_project_id !== hosting.project_id || contract.d1_binding !== hosting.d1 || contract.r2_binding !== hosting.r2) throw new Error();
    if (!object(contract.route) || contract.route.origin !== ORIGIN || contract.route.path_prefix !== PREFIX || !object(contract.oidc) || contract.oidc.issuer !== GOOGLE_ISSUER || contract.oidc.audience !== ORIGIN || contract.oidc.subject_binding !== "PRIVATE_TESTER_BASELINE_OIDC_SUBJECT" || contract.oidc.jwks_url !== GOOGLE_JWKS) throw new Error();
    if (!exactStrings(contract.runtime_bindings, RUNTIME_BINDINGS) || Object.hasOwn(contract, "live_bindings") || Object.hasOwn(contract, "rollback_binding") || Object.hasOwn(contract, "version_metadata_tag") || !exactStrings(contract.default_dark_bindings, DARK_BINDINGS) || contract.release_binding !== "PRIVATE_TESTER_BASELINE_RELEASE_JSON") throw new Error();
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

export function createPrivateTesterBaselineRuntime(environment: GatewayEnvironment, dependencies: { fetch?: typeof fetch; now?: () => number; expectedD1SchemaDefinitionHash?: string; expectedD1SchemaObjectCount?: number; buildId?: string } = {}): LoadedEvidence {
  const fetcher = dependencies.fetch ?? fetch;
  const liveCheckpoint = SITES_D1_FORWARD_ARTIFACT.schemaCheckpoints.find(({ head }) => head === "0026");
  const liveState = dependencies.expectedD1SchemaDefinitionHash === undefined && dependencies.expectedD1SchemaObjectCount === undefined;
  const expectedD1SchemaDefinitionHash = dependencies.expectedD1SchemaDefinitionHash ?? liveCheckpoint?.definitionsSha256 ?? REVIEWED_D1_SCHEMA_DEFINITION_HASH;
  const expectedD1SchemaObjectCount = dependencies.expectedD1SchemaObjectCount ?? liveCheckpoint?.objectCount ?? REVIEWED_D1_SCHEMA_OBJECT_COUNT;
  let rawRelease: unknown;
  try { rawRelease = JSON.parse(String(environment.PRIVATE_TESTER_BASELINE_RELEASE_JSON ?? "")); } catch { console.warn("private tester runtime rejected at release-json"); configurationError(); }
  const startsAt = object(rawRelease) && typeof rawRelease.startsAt === "string" ? Date.parse(rawRelease.startsAt) : Number.NaN;
  let release: PrivateTesterRelease;
  try { release = parsePrivateTesterRelease(rawRelease, startsAt); } catch { console.warn("private tester runtime rejected at release-contract"); configurationError(); }
  const db = environment.DB;
  const manifestProviderObjects = EXACT_D1_PROVIDER_INTERNAL_OBJECTS.map(({ type, name, tableName }) => ({ type, name, table_name: tableName }));
  if (!release.sitesVersion.startsWith(SITES_PROJECT_PREFIX)) { console.warn("private tester runtime rejected at sites-version"); configurationError(); }
  if (!HASH.test(expectedD1SchemaDefinitionHash) || !Number.isSafeInteger(expectedD1SchemaObjectCount) || expectedD1SchemaObjectCount < 1 || expectedD1SchemaObjectCount > 2_000 || JSON.stringify(d1SourceBaseline.provider_internal_schema_objects) !== JSON.stringify(manifestProviderObjects)) { console.warn("private tester runtime rejected at reviewed-baseline"); configurationError(); }
  if (!db || typeof db.prepare !== "function") { console.warn("private tester runtime rejected at d1-binding"); configurationError(); }
  if (environment.GOOGLE_CLIENT_ID !== GOOGLE_CLIENT_ID || environment.BETTER_AUTH_URL !== GOOGLE_ORIGIN || environment.PUBLIC_APP_URL !== GOOGLE_ORIGIN || environment.NEARYOU_ENABLE_STORY !== "false" || environment.NEARYOU_ENABLE_LEGACY_ARCHIVE !== "false" || environment.PRIVATE_TESTER_SCHEDULER_ENABLED !== "false" || nearFamilySourceActivated()) { console.warn("private tester runtime rejected at environment-contract"); configurationError(); }

  const d1Ledger = async () => {
    if (liveState) {
      const provider = await db.prepare("SELECT id,name,applied_at FROM d1_migrations ORDER BY id").all();
      if (!Array.isArray(provider.results) || JSON.stringify(provider.results) !== JSON.stringify(SITES_D1_PHASE_A_ARTIFACT.providerMigrationRows)) throw new Error("private tester gateway evidence unavailable");
      const groups = [
        { table: "nearyou_d1_phase_a_migrations", operations: "nearyou_d1_phase_a_operations", expected: SITES_D1_PHASE_A_ARTIFACT.migrations },
        { table: "nearyou_d1_phase_b_migrations", operations: "nearyou_d1_phase_b_operations", expected: SITES_D1_PHASE_B_ARTIFACT.migrations },
        { table: "nearyou_d1_phase_c_migrations", operations: "nearyou_d1_phase_c_operations", expected: SITES_D1_PHASE_C_ARTIFACT.migrations },
        { table: "nearyou_d1_forward_migrations", operations: "nearyou_d1_forward_operations", expected: SITES_D1_FORWARD_ARTIFACT.migrations },
      ] as const;
      const repaired: { migration_id: string; source_sha256: string; applied_at: number }[] = [];
      for (const group of groups) {
        const result = await db.prepare(`SELECT m.migration_id,m.source_sha256,m.applied_at,o.status FROM ${group.table} m JOIN ${group.operations} o ON o.operation_id=m.operation_id ORDER BY m.migration_id`).all();
        if (!Array.isArray(result.results) || result.results.length !== group.expected.length) throw new Error("private tester gateway evidence unavailable");
        for (const [index, row] of result.results.entries()) {
          const expected = group.expected[index];
          if (!object(row) || JSON.stringify(Reflect.ownKeys(row).sort()) !== JSON.stringify(["applied_at", "migration_id", "source_sha256", "status"]) || row.migration_id !== expected?.id || row.source_sha256 !== expected.sha256 || row.status !== "complete" || !Number.isSafeInteger(row.applied_at) || Number(row.applied_at) <= 0) throw new Error("private tester gateway evidence unavailable");
          repaired.push({ migration_id: String(row.migration_id), source_sha256: String(row.source_sha256), applied_at: Number(row.applied_at) });
        }
      }
      const appliedMigrations = [
        ...SITES_D1_PHASE_A_ARTIFACT.providerMigrationRows.map((row, index) => ({ sequence: index + 1, name: row.name, appliedAt: row.applied_at })),
        ...repaired.map((row, index) => ({ sequence: index + 8, name: `${row.migration_id}.sql`, appliedAt: new Date(row.applied_at).toISOString().replace("T", " ").replace("Z", "") })),
      ];
      if (appliedMigrations.length !== 27) throw new Error("private tester gateway evidence unavailable");
      return { appliedMigrations };
    }
    const result = await db.prepare("SELECT id,name,applied_at FROM d1_migrations ORDER BY id").all();
    const expected = D1_MIGRATIONS.map((id) => `${id}.sql`);
    const expectedWithoutExtension = [...D1_MIGRATIONS];
    if (!Array.isArray(result.results) || result.results.length !== expected.length) throw new Error("private tester gateway evidence unavailable");
    const names = result.results.map((row) => object(row) ? row.name : undefined);
    if (JSON.stringify(names) !== JSON.stringify(expected) && JSON.stringify(names) !== JSON.stringify(expectedWithoutExtension)) throw new Error("private tester gateway evidence unavailable");
    const appliedMigrations = result.results.map((row, index) => {
      if (!object(row) || Reflect.ownKeys(row).length !== 3 || row.id !== index + 1 || typeof row.applied_at !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?$/.test(row.applied_at)) throw new Error("private tester gateway evidence unavailable");
      return { sequence: row.id, name: row.name, appliedAt: row.applied_at };
    });
    return { appliedMigrations };
  };
  const d1Schema = async () => {
    const result = await db.prepare("SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name,tbl_name").all();
    if (!Array.isArray(result.results) || result.results.length < 1 || result.results.length > 2_000) throw new Error("private tester gateway evidence unavailable");
    let previous = "";
    const objects = result.results.map((row) => {
      if (!object(row) || Reflect.ownKeys(row).length !== 5 || !["table", "index", "trigger", "view"].includes(String(row.type)) || typeof row.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.name) || typeof row.tbl_name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.tbl_name) || !Number.isSafeInteger(row.rootpage) || Number(row.rootpage) < 0 || (row.sql !== null && (typeof row.sql !== "string" || row.sql.length < 1 || row.sql.length > 1_048_576))) throw new Error("private tester gateway evidence unavailable");
      const key = `${row.type}\u0000${row.name}\u0000${row.tbl_name}`;
      if (key <= previous) throw new Error("private tester gateway evidence unavailable");
      previous = key;
      return { type: row.type as string, name: row.name, tableName: row.tbl_name, rootPage: Number(row.rootpage), sql: row.sql };
    });
    const liveProviderIdentities = new Set((liveCheckpoint?.providerObjects ?? []).map(({ type, name, tableName }) => `${type}\u0000${name}\u0000${tableName}`));
    const providerIdentities = liveState ? liveProviderIdentities : D1_PROVIDER_INTERNAL_IDENTITIES;
    if (liveState) {
      if (objects.filter(({ type, name, tableName }) => providerIdentities.has(`${type}\u0000${name}\u0000${tableName}`)).length > liveProviderIdentities.size) throw new Error("private tester gateway evidence unavailable");
    } else {
      try { validateExactD1ProviderObjects(objects); } catch { throw new Error("private tester gateway evidence unavailable"); }
    }
    const sourceObjects = objects.filter(({ type, name, tableName }) => !providerIdentities.has(`${type}\u0000${name}\u0000${tableName}`));
    if (sourceObjects.length !== expectedD1SchemaObjectCount) throw new Error("private tester gateway evidence unavailable");
    const definitions = sourceObjects.map(({ type, name, tableName, sql }) => ({ type, name, tableName, sql }));
    if (await sha256(JSON.stringify(definitions)) !== expectedD1SchemaDefinitionHash) throw new Error("private tester gateway evidence unavailable");
    return { schema: "sqlite_schema", objects };
  };
  const d1SourceFingerprint = async () => {
    const result = await db.prepare("SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name,tbl_name").all();
    if (!Array.isArray(result.results) || result.results.length < 1 || result.results.length > 1_000) throw new Error("private tester gateway evidence unavailable");
    const definitions = result.results.map((row) => {
      if (!object(row) || Reflect.ownKeys(row).length !== 5 || !["table", "index", "trigger", "view"].includes(String(row.type)) || typeof row.name !== "string" || typeof row.tbl_name !== "string" || !Number.isSafeInteger(row.rootpage) || (row.sql !== null && typeof row.sql !== "string")) throw new Error("private tester gateway evidence unavailable");
      return { type: String(row.type), name: row.name, tableName: row.tbl_name, sql: row.sql as string | null };
    }).filter(({ type, name, tableName }) => !D1_PROVIDER_INTERNAL_IDENTITIES.has(`${type}\u0000${name}\u0000${tableName}`));
    return { sourceObjectCount: definitions.length, sourceDefinitionsSha256: await sha256(JSON.stringify(definitions)) };
  };
  const d1SourceManifest = async () => {
    const result = await db.prepare("SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name,tbl_name").all();
    if (!Array.isArray(result.results) || result.results.length < 1 || result.results.length > 1_000) throw new Error("private tester gateway evidence unavailable");
    const rows = [];
    for (const row of result.results) {
      if (!object(row) || Reflect.ownKeys(row).length !== 5 || !["table", "index", "trigger", "view"].includes(String(row.type)) || typeof row.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.name) || typeof row.tbl_name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.tbl_name) || !Number.isSafeInteger(row.rootpage) || Number(row.rootpage) < 0 || (row.sql !== null && (typeof row.sql !== "string" || row.sql.length < 1 || row.sql.length > 1_048_576))) throw new Error("private tester gateway evidence unavailable");
      const type = String(row.type), tableName = row.tbl_name;
      if (D1_PROVIDER_INTERNAL_IDENTITIES.has(`${type}\u0000${row.name}\u0000${tableName}`)) continue;
      rows.push({ type, name: row.name, tableName, sqlSha256: await sha256(String(row.sql ?? "")) });
    }
    return { objects: rows };
  };
  const d1ConvergenceSchema = async () => {
    const schemaResult = await db.prepare("SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name,tbl_name").all();
    if (!Array.isArray(schemaResult.results) || schemaResult.results.length < 1 || schemaResult.results.length > 1_000) throw new Error("private tester gateway evidence unavailable");
    let previous = "";
    const objects = schemaResult.results.map((row) => {
      if (!object(row) || Reflect.ownKeys(row).length !== 5 || !["table", "index", "trigger", "view"].includes(String(row.type)) || typeof row.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.name) || typeof row.tbl_name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.tbl_name) || !Number.isSafeInteger(row.rootpage) || Number(row.rootpage) < 0 || (row.sql !== null && (typeof row.sql !== "string" || row.sql.length < 1 || row.sql.length > 1_048_576))) throw new Error("private tester gateway evidence unavailable");
      const key = `${row.type}\u0000${row.name}\u0000${row.tbl_name}`;
      if (key <= previous) throw new Error("private tester gateway evidence unavailable");
      previous = key;
      return { type: String(row.type), name: row.name, tableName: row.tbl_name, rootPage: Number(row.rootpage), sql: row.sql as string | null };
    });
    return { objects };
  };
  const d1ConvergenceLedger = async () => {
    const providerResult = await db.prepare("SELECT * FROM __appgarden_migrations ORDER BY 1").all();
    if (!Array.isArray(providerResult.results) || providerResult.results.length < 1 || providerResult.results.length > 26) throw new Error("private tester gateway evidence unavailable");
    const providerMigrationRows = providerResult.results.map((row) => {
      if (!object(row)) throw new Error("private tester gateway evidence unavailable");
      const rowKeys = Reflect.ownKeys(row);
      if (rowKeys.length < 1 || rowKeys.length > 8 || rowKeys.some((key) => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key))) throw new Error("private tester gateway evidence unavailable");
      for (const value of Object.values(row)) if (value !== null && !(typeof value === "number" && Number.isSafeInteger(value)) && !diagnosticText(value)) throw new Error("private tester gateway evidence unavailable");
      return { ...row };
    });
    return { providerMigrationRows };
  };
  const d1ConvergenceShape = async () => {
    const shapeFailure = (stage: string): never => { console.warn(`private tester D1 convergence shape unavailable at ${stage}`); throw new Error("private tester gateway evidence unavailable"); };
    const read = async (key: keyof typeof D1_CONVERGENCE_SHAPE_QUERIES, maximum: number) => {
      try {
        const result = await db.prepare(D1_CONVERGENCE_SHAPE_QUERIES[key]).all();
        if (!Array.isArray(result.results) || result.results.length > maximum) return shapeFailure(`${key}-shape`);
        return result.results;
      } catch { return shapeFailure(`${key}-query`); }
    };
    const [tables, foreignKeys, indexes, indexColumns, foreignKeyViolations] = await Promise.all([
      read("table_xinfo", 1_000), read("foreign_key_list", 1_000), read("index_list", 1_000),
      read("index_xinfo", 2_000), read("foreign_key_check", 101),
    ]);
    const rowCounts = [];
    for (const tableName of D1_CONVERGENCE_TABLES) {
      try {
        const result = await db.prepare(`/* row_counts:${tableName} */ SELECT COUNT(*) AS "rowCount" FROM "${tableName}"`).all();
        if (!Array.isArray(result.results) || result.results.length !== 1 || !object(result.results[0]) || JSON.stringify(Reflect.ownKeys(result.results[0]).sort()) !== JSON.stringify(["rowCount"])) return shapeFailure("row-count-shape");
        rowCounts.push({ tableName, rowCount: result.results[0].rowCount });
      } catch { return shapeFailure(`row-count-query-${tableName}`); }
    }
    const exact = (row: unknown, keys: readonly string[]) => object(row) && JSON.stringify(Reflect.ownKeys(row).sort()) === JSON.stringify([...keys].sort());
    const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
    const integer = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && Number(value) >= minimum;
    if (tables.length < D1_CONVERGENCE_TABLES.length || tables.some((row) => !exact(row, ["tableName", "cid", "name", "type", "notNull", "defaultValue", "primaryKey", "hidden"]) || !D1_CONVERGENCE_TABLES.includes(String((row as Record<string, unknown>).tableName)) || !integer((row as Record<string, unknown>).cid) || !identifier((row as Record<string, unknown>).name) || typeof (row as Record<string, unknown>).type !== "string" || String((row as Record<string, unknown>).type).length > 64 || ![0, 1].includes(Number((row as Record<string, unknown>).notNull)) || ![0, 1].includes(Number((row as Record<string, unknown>).primaryKey)) || ![0, 1, 2, 3].includes(Number((row as Record<string, unknown>).hidden)) || ((row as Record<string, unknown>).defaultValue !== null && !diagnosticText((row as Record<string, unknown>).defaultValue)))) return shapeFailure("table-xinfo-validation");
    if (foreignKeys.some((row) => !exact(row, ["tableName", "id", "seq", "parentTable", "fromColumn", "toColumn", "onUpdate", "onDelete", "match"]) || !D1_CONVERGENCE_TABLES.includes(String((row as Record<string, unknown>).tableName)) || !integer((row as Record<string, unknown>).id) || !integer((row as Record<string, unknown>).seq) || !identifier((row as Record<string, unknown>).parentTable) || !identifier((row as Record<string, unknown>).fromColumn) || ((row as Record<string, unknown>).toColumn !== null && !identifier((row as Record<string, unknown>).toColumn)) || !["NO ACTION", "RESTRICT", "SET NULL", "SET DEFAULT", "CASCADE"].includes(String((row as Record<string, unknown>).onUpdate)) || !["NO ACTION", "RESTRICT", "SET NULL", "SET DEFAULT", "CASCADE"].includes(String((row as Record<string, unknown>).onDelete)) || typeof (row as Record<string, unknown>).match !== "string")) return shapeFailure("foreign-key-validation");
    if (indexes.some((row) => !exact(row, ["tableName", "seq", "name", "unique", "origin", "partial"]) || !D1_CONVERGENCE_TABLES.includes(String((row as Record<string, unknown>).tableName)) || !integer((row as Record<string, unknown>).seq) || !identifier((row as Record<string, unknown>).name) || ![0, 1].includes(Number((row as Record<string, unknown>).unique)) || !["c", "u", "pk"].includes(String((row as Record<string, unknown>).origin)) || ![0, 1].includes(Number((row as Record<string, unknown>).partial)))) return shapeFailure("index-list-validation");
    if (indexColumns.some((row) => !exact(row, ["indexName", "seqno", "cid", "name", "desc", "coll", "key"]) || !identifier((row as Record<string, unknown>).indexName) || !integer((row as Record<string, unknown>).seqno) || !Number.isSafeInteger((row as Record<string, unknown>).cid) || ((row as Record<string, unknown>).name !== null && !identifier((row as Record<string, unknown>).name)) || ![0, 1].includes(Number((row as Record<string, unknown>).desc)) || ((row as Record<string, unknown>).coll !== null && !identifier((row as Record<string, unknown>).coll)) || ![0, 1].includes(Number((row as Record<string, unknown>).key)))) return shapeFailure("index-xinfo-validation");
    if (rowCounts.length !== D1_CONVERGENCE_TABLES.length || rowCounts.some((row, index) => !exact(row, ["tableName", "rowCount"]) || (row as Record<string, unknown>).tableName !== D1_CONVERGENCE_TABLES[index] || !integer((row as Record<string, unknown>).rowCount))) return shapeFailure("row-count-validation");
    if (foreignKeyViolations.length > 100 || foreignKeyViolations.some((row) => !exact(row, ["tableName", "rowId", "parentTable", "fkId"]) || !identifier((row as Record<string, unknown>).tableName) || !Number.isSafeInteger((row as Record<string, unknown>).rowId) || !identifier((row as Record<string, unknown>).parentTable) || !integer((row as Record<string, unknown>).fkId))) return shapeFailure("foreign-key-check-validation");
    return { tables, foreignKeys, indexes, indexColumns, rowCounts, foreignKeyViolations };
  };
  const d1ConvergenceProbes=async()=>{const stages=[];for(const[stage,sql]of D1_CONVERGENCE_PROBES){let result;try{result=await db.prepare(sql).all()}catch{console.warn(`private tester D1 convergence probe unavailable at ${stage}-query`);throw new Error("private tester gateway evidence unavailable")}if(!Array.isArray(result.results)||result.results.length>1_000)throw new Error("private tester gateway evidence unavailable");let rowCount=result.results.length,violationCount=0;for(const row of result.results){if(!object(row)){throw new Error("private tester gateway evidence unavailable")}const keys=Reflect.ownKeys(row);if(keys.length<1||keys.length>16||keys.some(key=>typeof key!=="string"||!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)))throw new Error("private tester gateway evidence unavailable");for(const value of Object.values(row))if(value!==null&&!(typeof value==="number"&&Number.isSafeInteger(value))&&!diagnosticText(value))throw new Error("private tester gateway evidence unavailable")}if(stage.endsWith("preflight")){if(result.results.length!==1||!object(result.results[0])||JSON.stringify(Reflect.ownKeys(result.results[0]).sort())!==JSON.stringify(["rowCount","violationCount"])||!Number.isSafeInteger(result.results[0].rowCount)||Number(result.results[0].rowCount)<0||!Number.isSafeInteger(result.results[0].violationCount)||Number(result.results[0].violationCount)<0)throw new Error("private tester gateway evidence unavailable");rowCount=Number(result.results[0].rowCount);violationCount=Number(result.results[0].violationCount)}stages.push({stage,rowCount,violationCount,projectionSha256:await sha256(JSON.stringify(result.results))})}return{version:1,stages}};
  const d1PhaseCReceipt=async()=>{const operationSql="/* phase_c_receipt:operation */ SELECT phase,operation_id,release_id,manifest_sha256,status,created_at,completed_at FROM nearyou_d1_phase_c_operations WHERE phase='0013-0016' ORDER BY phase LIMIT 2",migrationSql="/* phase_c_receipt:migrations */ SELECT m.migration_id,m.operation_id,m.source_sha256,m.schema_sha256,m.object_count,m.applied_at FROM nearyou_d1_phase_c_migrations m JOIN nearyou_d1_phase_c_operations o ON o.operation_id=m.operation_id WHERE o.phase='0013-0016' ORDER BY m.applied_at,m.migration_id LIMIT 5",operationResult=await db.prepare(operationSql).all();if(!Array.isArray(operationResult.results)||operationResult.results.length!==1||!object(operationResult.results[0]))throw new Error("private tester gateway evidence unavailable");const operation=operationResult.results[0],exact=(row:Record<string,unknown>,keys:string[])=>JSON.stringify(Reflect.ownKeys(row).sort())===JSON.stringify([...keys].sort()),id=(value:unknown)=>typeof value==="string"&&/^[A-Za-z0-9:_-]{8,128}$/.test(value),hash=(value:unknown)=>typeof value==="string"&&HASH.test(value),integer=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0;if(!exact(operation,["phase","operation_id","release_id","manifest_sha256","status","created_at","completed_at"])||operation.phase!=="0013-0016"||!id(operation.operation_id)||!id(operation.release_id)||!hash(operation.manifest_sha256)||!['running','complete'].includes(String(operation.status))||!integer(operation.created_at)||(operation.status==="running"?operation.completed_at!==null:!integer(operation.completed_at)||Number(operation.completed_at)<Number(operation.created_at)))throw new Error("private tester gateway evidence unavailable");const migrationResult=await db.prepare(migrationSql).all();if(!Array.isArray(migrationResult.results)||migrationResult.results.length>4)throw new Error("private tester gateway evidence unavailable");const expected=D1_MIGRATIONS.slice(13,13+migrationResult.results.length),migrations=migrationResult.results;let prior=Number(operation.created_at);for(const[index,row]of migrations.entries()){if(!object(row)||!exact(row,["migration_id","operation_id","source_sha256","schema_sha256","object_count","applied_at"])||row.migration_id!==expected[index]||row.operation_id!==operation.operation_id||!hash(row.source_sha256)||!hash(row.schema_sha256)||!Number.isSafeInteger(row.object_count)||Number(row.object_count)<1||Number(row.object_count)>1_000||!integer(row.applied_at)||Number(row.applied_at)<=prior)throw new Error("private tester gateway evidence unavailable");prior=Number(row.applied_at)}if(operation.status==="complete"&&migrations.length!==4)throw new Error("private tester gateway evidence unavailable");return{operation:{...operation},migrations:migrations.map(row=>({...row as Record<string,unknown>}))}};
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
    async read(kind: string, cursor: string | null = null) {
      if (kind === "d1-ledger") return d1Ledger();
      if (kind === "d1-schema") return d1Schema();
      if (kind === "d1-schema-page") return createD1SchemaEvidenceReader(db, dependencies.buildId ?? privateTesterPackagedBuildId())(cursor);
      if (kind === "d1-ledger-page") return createD1LedgerEvidenceReader(db, dependencies.buildId ?? privateTesterPackagedBuildId())(cursor);
      if (kind === "d1-convergence-ledger") return d1ConvergenceLedger();
      if (kind === "d1-convergence-schema") return d1ConvergenceSchema();
      if (kind === "d1-convergence-shape") return d1ConvergenceShape();
      if (kind === "d1-convergence-probes") return d1ConvergenceProbes();
      if (kind === "d1-phase-c-receipt") return d1PhaseCReceipt();
      if (kind === "d1-source-fingerprint") return d1SourceFingerprint();
      if (kind === "d1-source-manifest") return d1SourceManifest();
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
      const paginated = kind === "d1-schema-page" || kind === "d1-ledger-page";
      const cursor = paginated ? url.searchParams.get("cursor") : null;
      const validPaginationQuery = paginated && (url.search === "" || (url.searchParams.size === 1 && cursor !== null && /^[A-Za-z0-9_-]{1,4096}$/.test(cursor)));
      if (request.method !== "GET" || url.origin !== ORIGIN || url.hash || !KINDS.has(kind) || (paginated ? !validPaginationQuery : url.search !== "")) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
      const loaded = await input.load();
      evidenceFailureStage = "evidence-read";
      const body = await loaded.read(kind, cursor);
      evidenceFailureStage = "observation";
      const observedAt = input.now();
      if (!Number.isSafeInteger(observedAt)) throw new Error("clock unavailable");
      return Response.json({
        issuer: claims.issuer,
        audience: claims.audience,
        subject: claims.subject,
        principal: `service:${claims.subject}`,
        observedAt,
        release: loaded.release,
        body,
      }, { headers: { "cache-control": "no-store" } });
    } catch {
      console.warn(`private tester evidence unavailable at ${evidenceFailureStage}`);
      return new Response("Unavailable", { status: 503, headers: { "cache-control": "no-store" } });
    }
  };
}
