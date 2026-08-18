import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertPrivateTesterDeploymentContract, createGoogleServiceIdentityAuthenticator, createPrivateTesterBaselineGateway, createPrivateTesterBaselineRuntime } from "../lib/private-tester-baseline-gateway.ts";

const now = Date.parse("2026-08-14T18:00:00.000Z");
const trust = Object.freeze({ issuer: "https://accounts.google.com", audience: "https://nearyoustill.com", subject: "109876543210987654321" });
const release = Object.freeze({ releaseId: "rel_20260814_private_01", commitSha: "a".repeat(40), sitesVersion: "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_example", startsAt: "2026-08-14T18:00:00.000Z", expiresAt: "2026-08-21T18:00:00.000Z", products: ["nearfamily", "nearstory"] });
const workerRuntime = Object.freeze({ id: "11111111-1111-4111-8111-111111111111", commitSha: "a".repeat(40), deployedAt: "2026-08-14T17:59:00.000Z" });
const migrationNames = [
  "0000_nearnight_foundation.sql",
  "0001_google_apple_auth.sql", "0002_sharp_shinobi_shaw.sql", "0003_white_groot.sql", "0004_salty_sugar_man.sql",
  "0005_pronunciation_frequency_layers.sql", "0006_nearyou_shared_foundation.sql", "0007_nearsleep_production_upgrade.sql",
  "0008_nearsleep_live_integration.sql", "0009_nearsleep_audio_atomic.sql", "0010_child_profile_pronunciation.sql",
  "0011_household_billing_accounts.sql", "0012_nearsleep_library_privacy.sql", "0013_nearstory_parent_beta.sql",
  "0014_nearlegacy_archive.sql", "0015_platform_release_foundation.sql", "0016_marketing_waitlist.sql",
];
const migrationRows = migrationNames.map((name, index) => ({ id: index + 1, name, applied_at: `2026-08-14 17:${String(index).padStart(2, "0")}:00` }));
const sourceSchemaRows = Object.freeze([
  { type: "index", name: "accounts_email_idx", tbl_name: "accounts", rootpage: 3, sql: "CREATE INDEX accounts_email_idx ON accounts(email)" },
  { type: "index", name: "sqlite_autoindex_accounts_1", tbl_name: "accounts", rootpage: 4, sql: null },
  { type: "table", name: "accounts", tbl_name: "accounts", rootpage: 2, sql: "CREATE TABLE accounts(id TEXT PRIMARY KEY,email TEXT)" },
  { type: "trigger", name: "accounts_touch", tbl_name: "accounts", rootpage: 0, sql: "CREATE TRIGGER accounts_touch AFTER UPDATE ON accounts BEGIN SELECT 1; END" },
  { type: "view", name: "account_ids", tbl_name: "account_ids", rootpage: 0, sql: "CREATE VIEW account_ids AS SELECT id FROM accounts" },
]);
const providerSchemaRows = Object.freeze([
  { type: "index", name: "sqlite_autoindex_d1_migrations_1", tbl_name: "d1_migrations", rootpage: 7, sql: null },
  { type: "table", name: "_cf_METADATA", tbl_name: "_cf_METADATA", rootpage: 5, sql: "CREATE TABLE _cf_METADATA (\n        key INTEGER PRIMARY KEY,\n        value BLOB\n      )" },
  { type: "table", name: "d1_migrations", tbl_name: "d1_migrations", rootpage: 6, sql: "CREATE TABLE d1_migrations(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n)" },
  { type: "table", name: "sqlite_sequence", tbl_name: "sqlite_sequence", rootpage: 8, sql: "CREATE TABLE sqlite_sequence(name,seq)" },
  { type: "table", name: "sqlite_stat1", tbl_name: "sqlite_stat1", rootpage: 9, sql: "CREATE TABLE sqlite_stat1(tbl,idx,stat)" },
]);
const schemaRows = Object.freeze([...sourceSchemaRows, ...providerSchemaRows].sort((left, right) => `${left.type}\u0000${left.name}\u0000${left.tbl_name}`.localeCompare(`${right.type}\u0000${right.name}\u0000${right.tbl_name}`)));
const schemaDefinitionHash = createHash("sha256").update(JSON.stringify(sourceSchemaRows.map((row) => ({ type: row.type, name: row.name, tableName: row.tbl_name, sql: row.sql })))).digest("hex");
const ledgerQuery = "SELECT id,name,applied_at FROM d1_migrations ORDER BY id";
const schemaQuery = "SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name,tbl_name";

test("deployment contract distinguishes configured runtime bindings from provider-observed resource identities", () => {
  const bindings = JSON.parse(readFileSync(new URL("../.openai/worker-bindings.json", import.meta.url), "utf8"));
  const hosting = JSON.parse(readFileSync(new URL("../.openai/hosting.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => assertPrivateTesterDeploymentContract(bindings, hosting));
  assert.deepEqual(bindings.private_tester_baseline_gateway.runtime_bindings, ["DB", "GOOGLE_CLIENT_ID", "BETTER_AUTH_URL", "PUBLIC_APP_URL"]);
  assert.deepEqual(bindings.required_worker_bindings.version_metadata, []);
  assert.equal(Object.hasOwn(bindings.private_tester_baseline_gateway, "live_bindings"), false);
  assert.equal(Object.hasOwn(bindings.private_tester_baseline_gateway, "rollback_binding"), false);
  const missingRuntimeBinding = structuredClone(bindings);
  missingRuntimeBinding.private_tester_baseline_gateway.runtime_bindings.pop();
  assert.throws(() => assertPrivateTesterDeploymentContract(missingRuntimeBinding, hosting), /deployment contract invalid/);
  assert.throws(() => assertPrivateTesterDeploymentContract(bindings, { ...hosting, project_id: "appgprj_wrong" }), /deployment contract invalid/);
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
  const request = new Request("https://nearyoustill.com/api/internal/private-tester-baseline/d1-ledger");
  Object.defineProperty(request, "url", { get: () => { throw new Error("route parsed before authentication"); } });
  const gateway = createPrivateTesterBaselineGateway({ trust, authenticate: async () => { throw new Error("service_oidc_invalid"); }, load: async () => { loaded = true; throw new Error("must not load"); }, now: () => now });
  const response = await gateway(request);
  assert.equal(response.status, 401);
  assert.equal(loaded, false);
  assert.equal(await response.text(), "Unauthorized");
});

test("timestamps the authenticated runtime observation after the read without self-attesting deployment metadata", async () => {
  let clock = now;
  const gateway = createPrivateTesterBaselineGateway({
    trust,
    authenticate: async () => ({ ...trust }),
    load: async () => ({ release, read: async () => { clock += 1_234; return { appliedMigrations: [] }; } }),
    now: () => clock,
  });
  const response = await gateway(new Request("https://nearyoustill.com/api/internal/private-tester-baseline/d1-ledger"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { issuer: trust.issuer, audience: trust.audience, subject: trust.subject, principal: `service:${trust.subject}`, observedAt: now + 1_234, release, body: { appliedMigrations: [] } });
  assert.equal(Object.hasOwn(await (await gateway(new Request("https://nearyoustill.com/api/internal/private-tester-baseline/d1-ledger"))).json(), "workerRuntime"), false);
});

test("does not accept caller-supplied version-affinity metadata as deployment evidence", async () => {
  let clock = now;
  const gateway = createPrivateTesterBaselineGateway({
    trust,
    authenticate: async () => ({ ...trust }),
    load: async () => ({ release, read: async () => { clock += 1; return { appliedMigrations: [] }; } }),
    now: () => clock,
  });
  const response = await gateway(new Request("https://nearyoustill.com/api/internal/private-tester-baseline/d1-ledger", { headers: { "cloudflare-workers-version-key": workerRuntime.id,"cf-ray":"aaaaaaaaaaaaaaaa-ORD" } }));
  assert.equal(response.status, 200);
  const body=await response.json();assert.equal(Object.hasOwn(body, "workerRuntime"), false);assert.equal(Object.hasOwn(body,"rayId"),false);
  const routeSource = readFileSync(new URL("../app/api/internal/private-tester-baseline/[kind]/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(routeSource, /cloudflare-workers-version-key|workerRuntime|VERSION_METADATA/);
});

test("rejects issuer, audience, or subject drift before any evidence read", async () => {
  for (const key of ["issuer", "audience", "subject"]) {
    let loaded = false;
    const gateway = createPrivateTesterBaselineGateway({ trust, authenticate: async () => ({ ...trust, [key]: `${trust[key]}-wrong` }), load: async () => { loaded = true; return { release, workerRuntime, read: async () => ({}) }; }, now: () => now });
    assert.equal((await gateway(new Request("https://nearyoustill.com/api/internal/private-tester-baseline/gates"))).status, 401, key);
    assert.equal(loaded, false, key);
  }
});

test("exposes only fixed runtime reads and never self-asserts Sites versions or binding resources", async () => {
  let reads = 0;
  const gateway = createPrivateTesterBaselineGateway({ trust, authenticate: async () => trust, load: async () => ({ release, workerRuntime, read: async () => { reads += 1; return {}; } }), now: () => now });
  for (const request of [
    new Request("https://wrong.example/api/internal/private-tester-baseline/gates"),
    new Request("https://nearyoustill.com/api/internal/private-tester-baseline/sites-version"),
    new Request("https://nearyoustill.com/api/internal/private-tester-baseline/rollback-sites-version"),
    new Request("https://nearyoustill.com/api/internal/private-tester-baseline/bindings"),
    new Request("https://nearyoustill.com/api/internal/private-tester-baseline/gates?release=caller"),
    new Request("https://nearyoustill.com/api/internal/private-tester-baseline/gates", { method: "POST" }),
  ]) assert.equal((await gateway(request)).status, 404);
  assert.equal(reads, 0);
});

function runtimeEnvironment(overrides = {}) {
  return {
    DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
    VERSION_METADATA: { id: workerRuntime.id, tag: workerRuntime.commitSha, timestamp: workerRuntime.deployedAt },
    PRIVATE_TESTER_BASELINE_RELEASE_JSON: JSON.stringify(release),
    GOOGLE_CLIENT_ID: "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com",
    BETTER_AUTH_URL: "https://nearyoustill.com",
    PUBLIC_APP_URL: "https://nearyoustill.com",
    NEARYOU_ENABLE_STORY: "false",
    NEARYOU_ENABLE_LEGACY_ARCHIVE: "false",
    PRIVATE_TESTER_SCHEDULER_ENABLED: "false",
    ...overrides,
  };
}

test("reads and verifies exact live D1 ledger fields and every sqlite_schema object type", async () => {
  const statements = [];
  const DB = { prepare(sql) { statements.push(sql); return { async all() { if (sql === ledgerQuery) return { results: migrationRows }; if (sql === schemaQuery) return { results: schemaRows }; throw new Error("unexpected query"); } }; } };
  const oauthCalls = [];
  const runtime = createPrivateTesterBaselineRuntime(runtimeEnvironment({ DB }), {
    now: () => now,
    expectedD1SchemaDefinitionHash: schemaDefinitionHash,
    expectedD1SchemaObjectCount: sourceSchemaRows.length,
    fetch: async (url, init) => {
      oauthCalls.push([String(url), init]);
      const state = new URL(String(url)).searchParams.get("state");
      return new Response(null, { status: 302, headers: { location: `https://nearyoustill.com/api/auth/callback/google?state=${state}&error=interaction_required` } });
    },
  });

  assert.deepEqual(await runtime.read("d1-ledger"), { appliedMigrations: migrationRows.map((row) => ({ sequence: row.id, name: row.name, appliedAt: row.applied_at })) });
  const extensionlessRows = migrationRows.map((row) => ({ ...row, name: row.name.slice(0, -4) }));
  const extensionlessRuntime = createPrivateTesterBaselineRuntime(runtimeEnvironment({ DB: { prepare: () => ({ all: async () => ({ results: extensionlessRows }) }) } }), { now: () => now, expectedD1SchemaDefinitionHash: schemaDefinitionHash, expectedD1SchemaObjectCount: sourceSchemaRows.length, fetch });
  assert.deepEqual(await extensionlessRuntime.read("d1-ledger"), { appliedMigrations: extensionlessRows.map((row) => ({ sequence: row.id, name: row.name, appliedAt: row.applied_at })) });
  assert.deepEqual(await runtime.read("d1-schema"), { schema: "sqlite_schema", objects: schemaRows.map((row) => ({ type: row.type, name: row.name, tableName: row.tbl_name, rootPage: row.rootpage, sql: row.sql })) });
  assert.deepEqual(await runtime.read("gates"), { nearfamily: false, nearstory: false, scheduler: false });
  assert.deepEqual(await runtime.read("oauth"), { issuer: "https://accounts.google.com", audience: "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com", clientId: "619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com", providerAcceptedRedirectUri: "https://nearyoustill.com/api/auth/callback/google", proof: "interaction_required" });
  assert.equal(Object.hasOwn(await runtime.read("oauth"), "authorizedOrigins"), false);
  assert.equal(statements[0], ledgerQuery);
  assert.equal(statements[1], schemaQuery);
  assert.equal(statements[1].includes("name NOT LIKE 'sqlite_%'"), false);
  assert.equal(/\bLIMIT\b/i.test(statements[1]), false);
  assert.equal((await runtime.read("d1-schema")).objects.some((object) => object.name === "sqlite_autoindex_accounts_1" && object.sql === null), true);
  assert.deepEqual(await runtime.read("d1-source-fingerprint"), { sourceObjectCount: sourceSchemaRows.length, sourceDefinitionsSha256: schemaDefinitionHash });
  assert.equal((await runtime.read("d1-source-manifest")).objects.length, sourceSchemaRows.length);
  assert.equal(oauthCalls.every(([, init]) => init.redirect === "manual"), true);
  await assert.rejects(() => runtime.read("sites-version"), /evidence unavailable/);
});

test("captures bounded raw Sites convergence schema and provider migration rows without user data", async () => {
  const providerRows = [
    { id: 1, name: "0000_nearnight_foundation.sql", applied_at: "2026-08-17 00:00:00" },
    { id: 2, name: "0016_marketing_waitlist.sql", applied_at: "2026-08-17 00:01:00" },
  ];
  const DB = { prepare: (sql) => ({ all: async () => {
    if (sql === "SELECT sqlite_version() AS version") return { results: [{ version: "3.49.1" }] };
    if (sql === schemaQuery) return { results: schemaRows };
    if (sql === "SELECT * FROM __appgarden_migrations ORDER BY 1") return { results: providerRows };
    throw new Error("unexpected query");
  } }) };
  const runtime = createPrivateTesterBaselineRuntime(runtimeEnvironment({ DB }), { now: () => now, expectedD1SchemaDefinitionHash: schemaDefinitionHash, expectedD1SchemaObjectCount: sourceSchemaRows.length, fetch });
  assert.deepEqual(await runtime.read("d1-convergence-schema"), {
    objects: schemaRows.map((row) => ({ type: row.type, name: row.name, tableName: row.tbl_name, rootPage: row.rootpage, sql: row.sql })),
  });
  assert.deepEqual(await runtime.read("d1-convergence-ledger"), { providerMigrationRows: providerRows });

  const unsafeDB = { prepare: (sql) => ({ all: async () => ({
    results: sql === "SELECT sqlite_version() AS version" ? [{ version: "3.49.1" }] : sql === schemaQuery ? schemaRows : [{ id: 1, name: `bad${String.fromCharCode(0)}name` }],
  }) }) };
  const unsafe = createPrivateTesterBaselineRuntime(runtimeEnvironment({ DB: unsafeDB }), { now: () => now, expectedD1SchemaDefinitionHash: schemaDefinitionHash, expectedD1SchemaObjectCount: sourceSchemaRows.length, fetch });
  await assert.rejects(() => unsafe.read("d1-convergence-ledger"), /evidence unavailable/);
});

test("OAuth redirect proof rejects wrong origin, state, error, or an authorization code", async () => {
  const locations = [
    (state) => `https://attacker.example/api/auth/callback/google?state=${state}&error=interaction_required`,
    () => "https://nearyoustill.com/api/auth/callback/google?state=wrong&error=interaction_required",
    (state) => `https://nearyoustill.com/api/auth/callback/google?state=${state}&error=access_denied`,
    (state) => `https://nearyoustill.com/api/auth/callback/google?state=${state}&error=interaction_required&code=forbidden`,
  ];
  for (const location of locations) {
    const runtime = createPrivateTesterBaselineRuntime(runtimeEnvironment(), {
      now: () => now,
      expectedD1SchemaDefinitionHash: schemaDefinitionHash,
      expectedD1SchemaObjectCount: sourceSchemaRows.length,
      fetch: async (url) => {
        const state = new URL(String(url)).searchParams.get("state");
        return new Response(null, { status: 302, headers: { location: location(state) } });
      },
    });
    await assert.rejects(() => runtime.read("oauth"), /evidence unavailable/);
  }
});

test("fails closed on altered migration fields or missing index, trigger, or view definitions", async () => {
  const cases = [
    { ledger: migrationRows.map((row, index) => index === 0 ? { ...row, id: 9 } : row), schema: schemaRows },
    { ledger: migrationRows.map((row, index) => index === 0 ? { ...row, applied_at: "" } : row), schema: schemaRows },
    { ledger: migrationRows, schema: schemaRows.filter((row) => row.type !== "trigger") },
    { ledger: migrationRows, schema: schemaRows.map((row) => row.type === "view" ? { ...row, sql: `${row.sql} WHERE 1=1` } : row) },
    { ledger: migrationRows, schema: [schemaRows[0], { type: "index", name: "d1_migrations_rogue_idx", tbl_name: "d1_migrations", rootpage: 10, sql: "CREATE INDEX d1_migrations_rogue_idx ON d1_migrations(name)" }, ...schemaRows.slice(1)] },
    { ledger: migrationRows, schema: [...schemaRows.slice(0, 4), { type: "trigger", name: "d1_migrations_rogue", tbl_name: "d1_migrations", rootpage: 0, sql: "CREATE TRIGGER d1_migrations_rogue AFTER INSERT ON d1_migrations BEGIN SELECT 1; END" }, ...schemaRows.slice(4)] },
  ];
  for (const item of cases) {
    const DB = { prepare: (sql) => ({ all: async () => ({ results: sql.includes("d1_migrations") ? item.ledger : item.schema }) }) };
    const runtime = createPrivateTesterBaselineRuntime(runtimeEnvironment({ DB }), { now: () => now, expectedD1SchemaDefinitionHash: schemaDefinitionHash, expectedD1SchemaObjectCount: sourceSchemaRows.length, fetch });
    await assert.rejects(() => runtime.read(item.ledger === migrationRows ? "d1-schema" : "d1-ledger"), /evidence unavailable/);
  }
});

test("fails closed unless the exact five D1 provider-internal schema objects are present", async () => {
  const remove = (name) => schemaRows.filter((row) => row.name !== name);
  const replace = (name, patch) => schemaRows.map((row) => row.name === name ? { ...row, ...patch } : row);
  const cases = [
    ...providerSchemaRows.map(({ name }) => remove(name)),
    ...providerSchemaRows.map(({ name }) => [...schemaRows, ...schemaRows.filter((row) => row.name === name)]),
    replace("sqlite_stat1", { name: "sqlite_stat2" }),
    replace("d1_migrations", { type: "view" }),
    replace("sqlite_sequence", { tbl_name: "d1_migrations" }),
    replace("sqlite_autoindex_d1_migrations_1", { sql: "CREATE INDEX sqlite_autoindex_d1_migrations_1 ON d1_migrations(name)" }),
    replace("sqlite_autoindex_d1_migrations_1", { sql: "null" }),
    [...schemaRows, { type: "index", name: "d1_migrations_rogue_idx", tbl_name: "d1_migrations", rootpage: 10, sql: "CREATE INDEX d1_migrations_rogue_idx ON d1_migrations(name)" }],
  ];
  for (const schema of cases) {
    const DB = { prepare: (sql) => ({ all: async () => ({ results: sql.includes("d1_migrations") ? migrationRows : schema }) }) };
    const runtime = createPrivateTesterBaselineRuntime(runtimeEnvironment({ DB }), { now: () => now, expectedD1SchemaDefinitionHash: schemaDefinitionHash, expectedD1SchemaObjectCount: sourceSchemaRows.length, fetch });
    await assert.rejects(() => runtime.read("d1-schema"), /evidence unavailable/);
  }
});

test("runtime fails closed without exact release, OAuth configuration, or dark gates", () => {
  for (const patch of [{ PRIVATE_TESTER_BASELINE_RELEASE_JSON: "{}" }, { GOOGLE_CLIENT_ID: "invented.apps.googleusercontent.com" }, { NEARYOU_ENABLE_STORY: "true" }]) {
    assert.throws(() => createPrivateTesterBaselineRuntime(runtimeEnvironment(patch), { now: () => now, expectedD1SchemaDefinitionHash: schemaDefinitionHash, fetch }), /gateway configuration invalid/);
  }
});
