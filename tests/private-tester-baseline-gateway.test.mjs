import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertPrivateTesterDeploymentContract, createGoogleServiceIdentityAuthenticator, createPrivateTesterBaselineGateway, createPrivateTesterBaselineRuntime } from "../lib/private-tester-baseline-gateway.ts";

const now = Date.parse("2026-08-14T18:00:00.000Z");
const trust = Object.freeze({
  issuer: "https://accounts.google.com",
  audience: "https://nearyoustill.com",
  subject: "109876543210987654321",
});
const release = Object.freeze({
  releaseId: "rel_20260814_private_01",
  commitSha: "a".repeat(40),
  sitesVersion: "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_example",
  startsAt: "2026-08-14T18:00:00.000Z",
  expiresAt: "2026-08-21T18:00:00.000Z",
  products: ["nearfamily", "nearstory"],
});

test("exact-binds the gateway contract to the Sites deployment manifest", () => {
  const bindings = JSON.parse(readFileSync(new URL("../.openai/worker-bindings.json", import.meta.url), "utf8"));
  const hosting = JSON.parse(readFileSync(new URL("../.openai/hosting.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => assertPrivateTesterDeploymentContract(bindings, hosting));
  const missingLiveBinding = structuredClone(bindings);
  missingLiveBinding.private_tester_baseline_gateway.live_bindings.pop();
  assert.throws(() => assertPrivateTesterDeploymentContract(missingLiveBinding, hosting), /deployment contract invalid/);
  assert.throws(() => assertPrivateTesterDeploymentContract(bindings, { ...hosting, project_id: "appgprj_wrong" }), /deployment contract invalid/);
  const missingDarkBinding = structuredClone(bindings);
  missingDarkBinding.required_worker_bindings.vars = missingDarkBinding.required_worker_bindings.vars.filter((name) => name !== "NEARYOU_ENABLE_STORY");
  assert.throws(() => assertPrivateTesterDeploymentContract(missingDarkBinding, hosting), /deployment contract invalid/);
});

test("verifies a Google standard service identity token with exact issuer, audience, and subject", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const raw = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = { kid: "google-key", kty: "RSA", alg: "RS256", use: "sig", e: raw.e, n: raw.n };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: "google-key" });
  const claims = encode({ iss: trust.issuer, aud: trust.audience, sub: trust.subject, azp: trust.subject, iat: now / 1000 - 1, exp: now / 1000 + 60 });
  const signingInput = `${header}.${claims}`;
  const signature = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(signingInput))).toString("base64url");
  const authenticate = createGoogleServiceIdentityAuthenticator({ ...trust, fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } }), now: () => now });
  assert.deepEqual(await authenticate(new Request("https://nearyoustill.com", { headers: { authorization: `Bearer ${signingInput}.${signature}` } })), trust);
  await assert.rejects(() => createGoogleServiceIdentityAuthenticator({ ...trust, subject: `${trust.subject}0`, fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } }), now: () => now })(new Request("https://nearyoustill.com", { headers: { authorization: `Bearer ${signingInput}.${signature}` } })), /service identity invalid/);
});

test("authenticates before parsing the route or loading server evidence", async () => {
  let loaded = false;
  const request = new Request("https://nearyoustill.com/api/internal/private-tester-baseline/sites-version");
  Object.defineProperty(request, "url", { get: () => { throw new Error("route parsed before authentication"); } });
  const gateway = createPrivateTesterBaselineGateway({
    trust,
    authenticate: async () => { throw new Error("service_oidc_invalid"); },
    load: async () => { loaded = true; throw new Error("must not load"); },
    now: () => now,
  });

  const response = await gateway(request);
  assert.equal(response.status, 401);
  assert.equal(loaded, false);
  assert.equal(await response.text(), "Unauthorized");
});

test("derives the principal and observation time after exact claim validation", async () => {
  const calls = [];
  const gateway = createPrivateTesterBaselineGateway({
    trust,
    authenticate: async () => ({ ...trust }),
    load: async () => ({
      release,
      read: async (kind) => { calls.push(kind); return { version: release.sitesVersion }; },
    }),
    now: () => now,
  });

  const response = await gateway(new Request("https://nearyoustill.com/api/internal/private-tester-baseline/sites-version", {
    headers: { authorization: "Bearer signed.jwt.value" },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    issuer: trust.issuer,
    audience: trust.audience,
    subject: trust.subject,
    principal: `service:${trust.subject}`,
    observedAt: now,
    release,
    body: { version: release.sitesVersion },
  });
  assert.deepEqual(calls, ["sites-version"]);
});

test("rejects issuer, audience, or subject drift before any evidence read", async () => {
  for (const key of ["issuer", "audience", "subject"]) {
    let loaded = false;
    const gateway = createPrivateTesterBaselineGateway({
      trust,
      authenticate: async () => ({ ...trust, [key]: `${trust[key]}-wrong` }),
      load: async () => { loaded = true; return { release, read: async () => ({}) }; },
      now: () => now,
    });
    const response = await gateway(new Request("https://nearyoustill.com/api/internal/private-tester-baseline/gates"));
    assert.equal(response.status, 401, key);
    assert.equal(loaded, false, key);
  }
});

test("allows only fixed read operations on the exact production origin", async () => {
  let reads = 0;
  const gateway = createPrivateTesterBaselineGateway({
    trust,
    authenticate: async () => trust,
    load: async () => ({ release, read: async () => { reads += 1; return {}; } }),
    now: () => now,
  });
  for (const request of [
    new Request("https://wrong.example/api/internal/private-tester-baseline/gates"),
    new Request("https://nearyoustill.com/api/internal/private-tester-baseline/unknown"),
    new Request("https://nearyoustill.com/api/internal/private-tester-baseline/gates?release=caller"),
    new Request("https://nearyoustill.com/api/internal/private-tester-baseline/gates", { method: "POST" }),
  ]) assert.equal((await gateway(request)).status, 404);
  assert.equal(reads, 0);
});

test("reads D1, runtime bindings, dark gates, and provider-accepted OAuth configuration", async () => {
  const migrationNames = [
    "0001_google_apple_auth.sql", "0002_sharp_shinobi_shaw.sql", "0003_white_groot.sql", "0004_salty_sugar_man.sql",
    "0005_pronunciation_frequency_layers.sql", "0006_nearyou_shared_foundation.sql", "0007_nearsleep_production_upgrade.sql",
    "0008_nearsleep_live_integration.sql", "0009_nearsleep_audio_atomic.sql", "0010_child_profile_pronunciation.sql",
    "0011_household_billing_accounts.sql", "0012_nearsleep_library_privacy.sql", "0013_nearstory_parent_beta.sql",
    "0014_nearlegacy_archive.sql", "0015_platform_release_foundation.sql", "0016_marketing_waitlist.sql",
  ];
  const statements = [];
  const DB = {
    prepare(sql) {
      statements.push(sql);
      return {
        async all() {
          if (sql.includes("d1_migrations")) return { results: migrationNames.map((name) => ({ name })) };
          if (sql.includes("sqlite_schema")) return { results: [
            { name: "accounts", sql: "CREATE TABLE accounts(id TEXT PRIMARY KEY)" },
            { name: "families", sql: "CREATE TABLE families(id TEXT PRIMARY KEY)" },
          ] };
          throw new Error("unexpected query");
        },
      };
    },
  };
  const oauthCalls = [];
  const runtime = createPrivateTesterBaselineRuntime({
    DB,
    AUDIO: { head: async () => null },
    VERSION_METADATA: { id: "11111111-1111-4111-8111-111111111111", tag: "a".repeat(40), timestamp: "2026-08-14T17:59:00.000Z" },
    PRIVATE_TESTER_BASELINE_RELEASE_JSON: JSON.stringify(release),
    PRIVATE_TESTER_ROLLBACK_SITES_VERSION: "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_rollback",
    GOOGLE_CLIENT_ID: "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com",
    BETTER_AUTH_URL: "https://nearyoustill.com",
    PUBLIC_APP_URL: "https://nearyoustill.com",
    NEARYOU_ENABLE_STORY: "false",
    NEARYOU_ENABLE_LEGACY_ARCHIVE: "false",
    PRIVATE_TESTER_SCHEDULER_ENABLED: "false",
  }, {
    now: () => now,
    fetch: async (url, init) => {
      oauthCalls.push([String(url), init]);
      const state = new URL(String(url)).searchParams.get("state");
      return new Response(null, { status: 302, headers: { location: `https://nearyoustill.com/api/auth/callback/google?state=${state}&error=interaction_required` } });
    },
  });

  const sites = await runtime.read("sites-version");
  assert.deepEqual(sites, { version: release.sitesVersion, runtimeVersion: { id: "11111111-1111-4111-8111-111111111111", tag: "a".repeat(40), timestamp: "2026-08-14T17:59:00.000Z" } });
  assert.deepEqual(await runtime.read("rollback-sites-version"), { version: "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_rollback" });
  const d1 = await runtime.read("d1-ledger");
  assert.equal(d1.ledger.length, 16);
  assert.deepEqual(d1.ledger.at(-1), { id: "0016_marketing_waitlist", checksum: "d559c5b5f760d974f071d1f64d481519fb25a78b209213bf90a77090c4b987d1" });
  assert.deepEqual((await runtime.read("d1-schema")).tables.map((row) => row.name), ["accounts", "families"]);
  assert.deepEqual(await runtime.read("gates"), { nearfamily: false, nearstory: false, scheduler: false });
  assert.deepEqual(await runtime.read("bindings"), { bindings: [
    { name: "AUDIO", resource: "sites:r2:AUDIO" },
    { name: "DB", resource: "sites:d1:DB" },
    { name: "VERSION_METADATA", resource: "cloudflare:version:11111111-1111-4111-8111-111111111111" },
  ] });
  assert.deepEqual(await runtime.read("oauth"), {
    issuer: "https://accounts.google.com",
    audience: "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com",
    clientId: "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com",
    authorizedOrigins: ["https://nearyoustill.com"],
    redirectUris: ["https://nearyoustill.com/api/auth/callback/google"],
  });
  assert.equal(oauthCalls.length, 1);
  assert.equal(oauthCalls[0][1].redirect, "manual");
  assert.equal(statements.length, 2);
});

test("runtime fails closed without exact release, version metadata, OAuth, or dark gates", async () => {
  const base = {
    DB: { prepare: () => ({ all: async () => ({ results: [] }) }) }, AUDIO: {},
    VERSION_METADATA: { id: "11111111-1111-4111-8111-111111111111", tag: "a".repeat(40), timestamp: "2026-08-14T17:59:00.000Z" },
    PRIVATE_TESTER_BASELINE_RELEASE_JSON: JSON.stringify(release), PRIVATE_TESTER_ROLLBACK_SITES_VERSION: "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_rollback",
    GOOGLE_CLIENT_ID: "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com", BETTER_AUTH_URL: "https://nearyoustill.com", PUBLIC_APP_URL: "https://nearyoustill.com",
    NEARYOU_ENABLE_STORY: "false", NEARYOU_ENABLE_LEGACY_ARCHIVE: "false", PRIVATE_TESTER_SCHEDULER_ENABLED: "false",
  };
  for (const patch of [
    { PRIVATE_TESTER_BASELINE_RELEASE_JSON: "{}" },
    { VERSION_METADATA: undefined },
    { GOOGLE_CLIENT_ID: "invented.apps.googleusercontent.com" },
    { NEARYOU_ENABLE_STORY: "true" },
  ]) assert.throws(() => createPrivateTesterBaselineRuntime({ ...base, ...patch }, { now: () => now, fetch }), /gateway configuration invalid/);
});
