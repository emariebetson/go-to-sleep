import { nearFamilySourceActivated } from "./nearfamily-activation";
import { parsePrivateTesterRelease, type PrivateTesterRelease } from "./private-tester-release";

const ORIGIN = "https://nearyoustill.com";
const PREFIX = "/api/internal/private-tester-baseline/";
const KINDS = new Set([
  "sites-version",
  "rollback-sites-version",
  "d1-ledger",
  "d1-schema",
  "bindings",
  "gates",
  "oauth",
]);

type Trust = { issuer: string; audience: string; subject: string };
type LoadedEvidence = {
  release: PrivateTesterRelease;
  read(kind: string): Promise<unknown>;
};

type D1Result = { results?: unknown[] };
type GatewayEnvironment = Record<string, unknown> & {
  DB?: { prepare(sql: string): { all(): Promise<D1Result> } };
};

const VERSION = /^appgprj_[A-Za-z0-9_-]+~appgver_[A-Za-z0-9_-]+$/;
const SITES_PROJECT_PREFIX = "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GOOGLE_CLIENT_ID = "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com";
const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_ORIGIN = "https://nearyoustill.com";
const GOOGLE_REDIRECT = `${GOOGLE_ORIGIN}/api/auth/callback/google`;
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const MAX_JWKS_BYTES = 65_536;
const REQUIRED_GATEWAY_VARS = Object.freeze([
  "PRIVATE_TESTER_BASELINE_OIDC_SUBJECT",
  "PRIVATE_TESTER_BASELINE_RELEASE_JSON",
  "PRIVATE_TESTER_ROLLBACK_SITES_VERSION",
  "PRIVATE_TESTER_SCHEDULER_ENABLED",
  "NEARYOU_ENABLE_STORY",
  "NEARYOU_ENABLE_LEGACY_ARCHIVE",
]);
const LIVE_BINDINGS = Object.freeze(["DB", "AUDIO", "VERSION_METADATA", "GOOGLE_CLIENT_ID", "BETTER_AUTH_URL", "PUBLIC_APP_URL"]);
const DARK_BINDINGS = Object.freeze(["NEARYOU_ENABLE_STORY", "NEARYOU_ENABLE_LEGACY_ARCHIVE", "PRIVATE_TESTER_SCHEDULER_ENABLED"]);
const D1_LEDGER = Object.freeze([
  ["0001_google_apple_auth", "a072ad0d44adf87c8976f4c87c28348063ab8cd420cc49c34d5c28a503075e91"],
  ["0002_sharp_shinobi_shaw", "40c572af9e3aca3ce0ac755a8788df19121887e588712a58eb44bb423e5f5d0e"],
  ["0003_white_groot", "362f90ce36cde716715f38d8baabe908d9552d89f552ace9e00e869fdb22431b"],
  ["0004_salty_sugar_man", "bfdaf19606d77010edcd5344efc4019e3ec2c9bdae41eff1f34fbd22cf9157e8"],
  ["0005_pronunciation_frequency_layers", "c37fc59a0c92b14b64e71f25f8785fb64da642083427b1981e6e8779881328b9"],
  ["0006_nearyou_shared_foundation", "0da4384b9444995b41dd0bfb57f70ca1117a9ec7894fe2ef1110a0c7a39a5eb3"],
  ["0007_nearsleep_production_upgrade", "5319bd8c1c378c90d1be09fb7458cbafd773d5f748fe28a08de59d32cbe24055"],
  ["0008_nearsleep_live_integration", "e20baef4d0afa565791ee27d55137d172a863c25ac34f00d31d51e2b23597549"],
  ["0009_nearsleep_audio_atomic", "81644666644ca8fc9648dcf539a0e4cc26a16caee147170e1572360f4b02dedc"],
  ["0010_child_profile_pronunciation", "7e531ef1600ac930f5ea7a6d649f11b78c8bdb7ba25c82f555b44863d9ca6e41"],
  ["0011_household_billing_accounts", "8339773ad4f521880737f05f2e4a0066d5f327fccf25cafac6f425dcd214dc42"],
  ["0012_nearsleep_library_privacy", "91799e96d5cde8fe695bada23778f1877838144defe233674fc742d009817cf6"],
  ["0013_nearstory_parent_beta", "232a7f19e08a3e769c2cf89ec7027313dfabb636e229a0499d209cc3c9a2ff5f"],
  ["0014_nearlegacy_archive", "864b124ebf0c215f6ab4a56619e6f8c4af964ef942467d29a8974592c2dbb5e1"],
  ["0015_platform_release_foundation", "ae8dbe18672e424489b810217e3d1252fcc0880f960f1367ff2cd329c7f65f16"],
  ["0016_marketing_waitlist", "d559c5b5f760d974f071d1f64d481519fb25a78b209213bf90a77090c4b987d1"],
] as const);

function configurationError(): never { throw new Error("private tester gateway configuration invalid"); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
async function sha256(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function exactStrings(value: unknown, expected: readonly string[]): boolean { return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected); }

export function assertPrivateTesterDeploymentContract(bindings: unknown, hosting: unknown): void {
  try {
    if (!object(bindings) || !object(hosting) || !object(bindings.required_worker_bindings) || !object(bindings.private_tester_baseline_gateway)) throw new Error();
    const required = bindings.required_worker_bindings;
    const contract = bindings.private_tester_baseline_gateway;
    const requiredVars = required.vars;
    if (!Array.isArray(requiredVars) || requiredVars.some((name) => typeof name !== "string") || REQUIRED_GATEWAY_VARS.some((name) => !requiredVars.includes(name)) || !exactStrings(required.version_metadata, ["VERSION_METADATA"])) throw new Error();
    if (hosting.project_id !== "appgprj_6a79f8a66eb4819198bb42a2b26addea" || hosting.d1 !== "DB" || hosting.r2 !== "AUDIO" || contract.sites_project_id !== hosting.project_id || contract.d1_binding !== hosting.d1 || contract.r2_binding !== hosting.r2) throw new Error();
    if (!object(contract.route) || contract.route.origin !== ORIGIN || contract.route.path_prefix !== PREFIX || !object(contract.oidc) || contract.oidc.issuer !== GOOGLE_ISSUER || contract.oidc.audience !== ORIGIN || contract.oidc.subject_binding !== "PRIVATE_TESTER_BASELINE_OIDC_SUBJECT" || contract.oidc.jwks_url !== GOOGLE_JWKS) throw new Error();
    if (!exactStrings(contract.live_bindings, LIVE_BINDINGS) || contract.version_metadata_tag !== "release.commitSha" || !exactStrings(contract.default_dark_bindings, DARK_BINDINGS) || contract.release_binding !== "PRIVATE_TESTER_BASELINE_RELEASE_JSON" || contract.rollback_binding !== "PRIVATE_TESTER_ROLLBACK_SITES_VERSION") throw new Error();
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

export function createGoogleServiceIdentityAuthenticator(input: Trust & { fetch?: typeof fetch; now?: () => number }) {
  if (input.issuer !== GOOGLE_ISSUER || input.audience !== GOOGLE_ORIGIN || !/^[1-9][0-9]{10,30}$/.test(input.subject)) configurationError();
  const fetcher = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  return async (request: Request): Promise<Trust> => {
    try {
      const authorization = request.headers.get("authorization") ?? "";
      if (!authorization.startsWith("Bearer ")) throw new Error();
      const token = authorization.slice(7), parts = token.split(".");
      if (parts.length !== 3 || token.length > 16_384) throw new Error();
      const header = jwtObject(parts[0]!, ["alg", "kid", "typ"], ["alg", "kid"]);
      const claims = jwtObject(parts[1]!, ["aud", "azp", "email", "email_verified", "exp", "iat", "iss", "sub"], ["aud", "exp", "iat", "iss", "sub"]);
      const timestamp = now(), issuedAt = claims.iat, expiresAt = claims.exp;
      if (header.alg !== "RS256" || typeof header.kid !== "string" || (header.typ !== undefined && header.typ !== "JWT") || claims.iss !== input.issuer || claims.aud !== input.audience || claims.sub !== input.subject || (claims.azp !== undefined && claims.azp !== input.subject) || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(timestamp) || Number(issuedAt) > timestamp / 1000 + 30 || Number(expiresAt) <= timestamp / 1000 || Number(expiresAt) - Number(issuedAt) > 3_600) throw new Error();
      const response = await fetcher(GOOGLE_JWKS, { redirect: "error", signal: AbortSignal.timeout(5_000) });
      const raw = await response.text();
      if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";")[0] !== "application/json" || new TextEncoder().encode(raw).byteLength > MAX_JWKS_BYTES) throw new Error();
      const root = JSON.parse(raw) as unknown;
      if (!object(root) || Reflect.ownKeys(root).length !== 1 || !Array.isArray(root.keys) || root.keys.length < 1 || root.keys.length > 10) throw new Error();
      const keys = root.keys.map((item) => {
        if (!object(item) || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(["alg", "e", "kid", "kty", "n", "use"]) || item.kty !== "RSA" || item.alg !== "RS256" || item.use !== "sig" || item.e !== "AQAB" || typeof item.kid !== "string" || typeof item.n !== "string" || base64url(item.n).byteLength < 256) throw new Error();
        return item as unknown as JsonWebKey & { kid: string };
      });
      if (new Set(keys.map((key) => key.kid)).size !== keys.length) throw new Error();
      const jwk = keys.find((key) => key.kid === header.kid);
      if (!jwk) throw new Error();
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const signature = base64url(parts[2]!);
      const signatureBuffer = Uint8Array.from(signature).buffer;
      if (signature.byteLength !== (key.algorithm as RsaHashedKeyAlgorithm).modulusLength / 8 || !await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureBuffer, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error();
      return { issuer: input.issuer, audience: input.audience, subject: input.subject };
    } catch {
      throw new Error("private tester service identity invalid");
    }
  };
}

export function createPrivateTesterBaselineRuntime(environment: GatewayEnvironment, dependencies: { fetch?: typeof fetch; now?: () => number } = {}): LoadedEvidence {
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  let rawRelease: unknown;
  try { rawRelease = JSON.parse(String(environment.PRIVATE_TESTER_BASELINE_RELEASE_JSON ?? "")); } catch { configurationError(); }
  const startsAt = object(rawRelease) && typeof rawRelease.startsAt === "string" ? Date.parse(rawRelease.startsAt) : Number.NaN;
  let release: PrivateTesterRelease;
  try { release = parsePrivateTesterRelease(rawRelease, startsAt); } catch { configurationError(); }
  const rollback = environment.PRIVATE_TESTER_ROLLBACK_SITES_VERSION;
  const metadata = environment.VERSION_METADATA;
  const db = environment.DB;
  const runtimeNow = now();
  if (!release.sitesVersion.startsWith(SITES_PROJECT_PREFIX) || typeof rollback !== "string" || !VERSION.test(rollback) || !rollback.startsWith(SITES_PROJECT_PREFIX) || rollback === release.sitesVersion || !object(metadata) || typeof metadata.id !== "string" || !UUID.test(metadata.id) || metadata.tag !== release.commitSha || typeof metadata.timestamp !== "string" || !Number.isSafeInteger(runtimeNow) || !Number.isFinite(Date.parse(metadata.timestamp)) || Date.parse(metadata.timestamp) > runtimeNow + 30_000 || !db || typeof db.prepare !== "function") configurationError();
  if (!environment.AUDIO || typeof environment.AUDIO !== "object" || environment.GOOGLE_CLIENT_ID !== GOOGLE_CLIENT_ID || environment.BETTER_AUTH_URL !== GOOGLE_ORIGIN || environment.PUBLIC_APP_URL !== GOOGLE_ORIGIN || environment.NEARYOU_ENABLE_STORY !== "false" || environment.NEARYOU_ENABLE_LEGACY_ARCHIVE !== "false" || environment.PRIVATE_TESTER_SCHEDULER_ENABLED !== "false" || nearFamilySourceActivated()) configurationError();

  const d1Ledger = async () => {
    const result = await db.prepare("SELECT name FROM d1_migrations ORDER BY name").all();
    const names = result.results?.map((row) => object(row) ? row.name : undefined);
    const expected = D1_LEDGER.map(([id]) => `${id}.sql`);
    if (!names || JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("private tester gateway evidence unavailable");
    return { ledger: D1_LEDGER.map(([id, checksum]) => ({ id, checksum })) };
  };
  const d1Schema = async () => {
    const result = await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (!Array.isArray(result.results) || result.results.length < 1 || result.results.length > 1_000) throw new Error("private tester gateway evidence unavailable");
    const tables = await Promise.all(result.results.map(async (row) => {
      if (!object(row) || typeof row.name !== "string" || !/^[a-z][a-z0-9_]{1,127}$/.test(row.name) || typeof row.sql !== "string" || row.sql.length < 1 || row.sql.length > 1_048_576) throw new Error("private tester gateway evidence unavailable");
      return { name: row.name, sqlHash: await sha256(row.sql) };
    }));
    return { schema: "site_creator", tables };
  };
  const oauth = async () => {
    const state = crypto.randomUUID();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [key, value] of [["client_id", GOOGLE_CLIENT_ID], ["redirect_uri", GOOGLE_REDIRECT], ["response_type", "code"], ["scope", "openid email profile"], ["state", state], ["nonce", state], ["prompt", "none"]]) url.searchParams.set(key, value);
    const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
    const location = response.headers.get("location");
    let returned: URL;
    try { returned = new URL(location ?? ""); } catch { throw new Error("private tester gateway evidence unavailable"); }
    if (response.status !== 302 || returned.origin !== GOOGLE_ORIGIN || returned.pathname !== "/api/auth/callback/google" || returned.searchParams.get("state") !== state || returned.searchParams.get("error") !== "interaction_required" || returned.searchParams.has("code")) throw new Error("private tester gateway evidence unavailable");
    return { issuer: GOOGLE_ISSUER, audience: GOOGLE_CLIENT_ID, clientId: GOOGLE_CLIENT_ID, authorizedOrigins: [GOOGLE_ORIGIN], redirectUris: [GOOGLE_REDIRECT] };
  };
  const runtimeVersion = { id: metadata.id, tag: metadata.tag, timestamp: metadata.timestamp } as { id: string; tag: string; timestamp: string };
  return {
    release,
    async read(kind: string) {
      if (kind === "sites-version") return { version: release.sitesVersion, runtimeVersion };
      if (kind === "rollback-sites-version") return { version: rollback };
      if (kind === "d1-ledger") return d1Ledger();
      if (kind === "d1-schema") return d1Schema();
      if (kind === "bindings") return { bindings: [
        { name: "AUDIO", resource: "sites:r2:AUDIO" },
        { name: "DB", resource: "sites:d1:DB" },
        { name: "VERSION_METADATA", resource: `cloudflare:version:${runtimeVersion.id}` },
      ] };
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

    try {
      const url = new URL(request.url);
      const kind = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : "";
      if (request.method !== "GET" || url.origin !== ORIGIN || url.search || url.hash || !KINDS.has(kind)) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
      const loaded = await input.load();
      const observedAt = input.now();
      if (!Number.isSafeInteger(observedAt)) throw new Error("clock unavailable");
      const body = await loaded.read(kind);
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
      return new Response("Unavailable", { status: 503, headers: { "cache-control": "no-store" } });
    }
  };
}
