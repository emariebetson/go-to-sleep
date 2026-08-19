import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalDecisionBody,
  canonicalDecisionEnvelope,
  canonicalDecisionSigningClaims,
  sha256Hex,
  signDecisionEnvelope,
} from "../services/readiness-decision/src/envelope.ts";
import {
  createReadinessDecisionServer,
  createPostgresDecisionAuthority,
} from "../services/readiness-decision/src/server.ts";
import { createReadinessControllerServer } from "../services/readiness-controller/src/server.ts";

const now = 1_787_000_000_000;
const releaseId = "rel_20260819_private_01";
const householdHash = "a".repeat(64);
const key = new TextEncoder().encode("decision-key-material-32-bytes-long!");
const audience = "https://readiness-controller.example.run.app";
const emergencyAudience = "https://readiness-emergency.example.run.app";
const ordinarySubject = "controller-build@nearnight.iam.gserviceaccount.com";
const emergencySubject = "controller-kill@nearnight.iam.gserviceaccount.com";

async function decisionRaw(overrides = {}) {
  const base = {
    version: 1,
    releaseId,
    householdHash,
    issuedAt: now,
    nonce: "nonce_abcdefghijklmnopqrstuv",
    bodySha256: await sha256Hex(canonicalDecisionBody({ releaseId, householdHash })),
    keyVersion: 7,
    ...overrides,
  };
  const signature = await signDecisionEnvelope(base, key);
  return canonicalDecisionEnvelope({ ...base, signature });
}

function decisionServer(overrides = {}) {
  const calls = { nonce: [], decision: [] };
  const server = createReadinessDecisionServer({
    issuer: "cloudflare:nearyoustill-production",
    now: async () => now,
    keys: [{ version: 7, status: "current", notBefore: now - 600_000, notAfter: now + 600_000, key }],
    nonceStore: { consume: async (input) => { calls.nonce.push(input); return true; } },
    authority: { authorize: async (input) => { calls.decision.push(input); return { allowed: true, expiresAt: now + 60_000 }; } },
    ...overrides,
  });
  return { server, calls };
}

async function postDecision(server, raw) {
  return server.handle(new Request("https://decision.example/v1/nearfamily/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  }));
}

test("decision accepts the canonical HMAC vector and consumes its nonce before one fixed query", async () => {
  const raw = await decisionRaw();
  assert.equal(canonicalDecisionBody({ releaseId, householdHash }), '{"householdHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","releaseId":"rel_20260819_private_01"}');
  assert.equal((await sha256Hex(canonicalDecisionBody({ releaseId, householdHash }))), "f1afd2dee8c6ea8fc1948b4b2016552932ba7b812f63df9d74f9793c54230550");
  assert.equal(canonicalDecisionSigningClaims(JSON.parse(raw)), '{"bodySha256":"f1afd2dee8c6ea8fc1948b4b2016552932ba7b812f63df9d74f9793c54230550","householdHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","issuedAt":1787000000000,"keyVersion":7,"nonce":"nonce_abcdefghijklmnopqrstuv","releaseId":"rel_20260819_private_01","version":1}');
  assert.equal(JSON.parse(raw).signature, "qNlKMHXfHXTMr0Gc-xhPwIPNi6Nzey57BBjm1FLrx0Y");
  const { server, calls } = decisionServer();
  const response = await postDecision(server, raw);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: 1, allowed: true, expiresAt: now + 60_000 });
  assert.equal(calls.nonce.length, 1);
  assert.equal(calls.decision.length, 1);
  assert.deepEqual(calls.decision[0], { householdHash, releaseId, observedAt: now });
});

test("decision rejects a valid-shape envelope whose signed canonical claims were changed", async () => {
  const parsed = JSON.parse(await decisionRaw());
  parsed.nonce = "nonce_zabcdefghijklmnopqrstu";
  const { server, calls } = decisionServer();
  assert.equal((await postDecision(server, canonicalDecisionEnvelope(parsed))).status, 401);
  assert.deepEqual(calls, { nonce: [], decision: [] });
});

test("decision rejects unknown fields and noncanonical bytes before nonce or database work", async () => {
  const canonical = await decisionRaw();
  const parsed = JSON.parse(canonical);
  const vectors = [
    JSON.stringify({ ...parsed, extra: true }),
    JSON.stringify(parsed, null, 2),
    ` ${canonical}`,
  ];
  for (const raw of vectors) {
    const { server, calls } = decisionServer();
    const response = await postDecision(server, raw);
    assert.equal(response.status, 401);
    assert.deepEqual(calls, { nonce: [], decision: [] });
  }
});

test("decision enforces the four-KiB request limit before parsing", async () => {
  const { server, calls } = decisionServer();
  const response = await postDecision(server, " ".repeat(4097));
  assert.equal(response.status, 413);
  assert.deepEqual(calls, { nonce: [], decision: [] });
});

test("decision accepts only the database-clock window from five minutes before to one minute after", async () => {
  for (const issuedAt of [now - 300_000, now + 60_000]) {
    const { server } = decisionServer();
    assert.equal((await postDecision(server, await decisionRaw({ issuedAt }))).status, 200);
  }
  for (const issuedAt of [now - 300_001, now + 60_001]) {
    const { server, calls } = decisionServer();
    assert.equal((await postDecision(server, await decisionRaw({ issuedAt }))).status, 401);
    assert.deepEqual(calls, { nonce: [], decision: [] });
  }
});

test("decision rejects duplicate and uncertain nonce consumption without querying authorization", async () => {
  for (const consume of [async () => false, async () => { throw new Error("commit response lost"); }]) {
    const { server, calls } = decisionServer({ nonceStore: { consume } });
    const response = await postDecision(server, await decisionRaw());
    assert.equal(response.status, 401);
    assert.equal(calls.decision.length, 0);
  }
});

test("decision supports only current or rollback-compatible draining keys inside explicit windows", async () => {
  const raw = await decisionRaw();
  const accepted = decisionServer({ keys: [
    { version: 8, status: "current", notBefore: now - 60_000, notAfter: now + 600_000, key },
    { version: 7, status: "draining", rollbackCompatible: true, notBefore: now - 60_000, notAfter: now + 1, key },
  ] });
  assert.equal((await postDecision(accepted.server, raw)).status, 200);
  const rejected = [
    [{ version: 7, status: "draining", rollbackCompatible: false, notBefore: now - 60_000, notAfter: now + 1, key }],
    [{ version: 7, status: "current", notBefore: now + 1, notAfter: now + 600_000, key }],
    [{ version: 7, status: "current", notBefore: now - 60_000, notAfter: now, key }],
    [{ version: 8, status: "current", notBefore: now - 60_000, notAfter: now + 600_000, key }],
  ];
  for (const keys of rejected) {
    const candidate = decisionServer({ keys });
    assert.equal((await postDecision(candidate.server, raw)).status, 401);
    assert.deepEqual(candidate.calls, { nonce: [], decision: [] });
  }
});

test("decision authority calls only the fixed NearFamily authorization function", async () => {
  const calls = [];
  const authority = createPostgresDecisionAuthority({ query: async (sql, args) => {
    calls.push({ sql, args });
    return { rows: [{ allowed: false, expires_at: null }] };
  } });
  assert.deepEqual(await authority.authorize({ householdHash, releaseId, observedAt: now }), { allowed: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^SELECT allowed, expires_at FROM nearyou\.authorize_nearfamily_private_tester\(\$1,\$2,\$3\)$/);
  assert.deepEqual(calls[0].args, [householdHash, releaseId, new Date(now)]);
  assert.doesNotMatch(calls[0].sql, /INSERT|UPDATE|DELETE|;|authorize_private_tester_household/i);
});

function controllerBody(overrides = {}) {
  return {
    action: "activate",
    operationId: "activate-nearfamily-0001",
    product: "nearfamily",
    expectedVersion: 1,
    promotedBaselineSha256: "b".repeat(64),
    releaseEvidenceDigest: "c".repeat(64),
    releaseId,
    invites: [{ householdHash, expiresAt: now + 60_000 }],
    ...overrides,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, canonical(item)]));
}

async function controllerRequest(path, body, token = "ordinary-token") {
  const raw = JSON.stringify(canonical(body));
  return {
    raw,
    request: new Request(`https://controller.example${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-nearyou-request-sha256": await sha256Hex(raw),
      },
      body: raw,
    }),
  };
}

function controllerServer(overrides = {}) {
  const calls = [];
  const server = createReadinessControllerServer({
    now: async () => now,
    ordinaryIdentity: { issuer: "https://accounts.google.com", audience, subject: ordinarySubject },
    emergencyIdentity: { issuer: "https://accounts.google.com", audience: emergencyAudience, subject: emergencySubject },
    verifyIdToken: async ({ token, audience: expectedAudience }) => token === "ordinary-token"
      ? { issuer: "https://accounts.google.com", audience: expectedAudience, subject: ordinarySubject, expiresAt: now + 60_000 }
      : { issuer: "https://accounts.google.com", audience: expectedAudience, subject: emergencySubject, expiresAt: now + 60_000 },
    ordinaryController: { apply: async (request) => { calls.push({ lane: "ordinary", request }); return { product: "nearfamily", releaseId, version: 2, globalPercent: 0, status: request.action === "revoke" ? "revoked" : "active", auditDigest: "d".repeat(64) }; } },
    emergencyController: { apply: async (request) => { calls.push({ lane: "emergency", request }); return { product: "nearfamily", releaseId, version: 2, globalPercent: 0, status: request.action === "kill" ? "killed" : "revoked", auditDigest: "e".repeat(64) }; } },
    ...overrides,
  });
  return { server, calls };
}

test("controller denies decision credentials before invoking the ordinary controller", async () => {
  const { server, calls } = controllerServer({ verifyIdToken: async () => ({ issuer: "https://accounts.google.com", audience, subject: "nearyou-pt-decision@nearnight.iam.gserviceaccount.com", expiresAt: now + 60_000 }) });
  const { request } = await controllerRequest("/v1/nearfamily/controller", controllerBody(), "decision-token");
  assert.equal((await server.handle(request)).status, 403);
  assert.equal(calls.length, 0);
});

test("controller rejects wrong issuer, audience, and expired Google identities", async () => {
  const identities = [
    { issuer: "https://issuer.example", audience, subject: ordinarySubject, expiresAt: now + 60_000 },
    { issuer: "https://accounts.google.com", audience: emergencyAudience, subject: ordinarySubject, expiresAt: now + 60_000 },
    { issuer: "https://accounts.google.com", audience, subject: ordinarySubject, expiresAt: now },
  ];
  for (const identity of identities) {
    const { server, calls } = controllerServer({ verifyIdToken: async () => identity });
    const { request } = await controllerRequest("/v1/nearfamily/controller", controllerBody());
    assert.equal((await server.handle(request)).status, 403);
    assert.equal(calls.length, 0);
  }
});

test("controller verifies exact Google identity, digest, canonical bytes, and strict NearFamily schema", async () => {
  const vectors = [
    { body: { ...controllerBody(), extra: true } },
    { body: controllerBody({ product: "nearstory" }) },
    { body: controllerBody({ action: "kill" }) },
    { body: controllerBody({ expectedVersion: 0 }) },
  ];
  for (const vector of vectors) {
    const { server, calls } = controllerServer();
    const { request } = await controllerRequest("/v1/nearfamily/controller", vector.body);
    assert.equal((await server.handle(request)).status, 400);
    assert.equal(calls.length, 0);
  }
  const { server, calls } = controllerServer();
  const { request } = await controllerRequest("/v1/nearfamily/controller", controllerBody());
  request.headers.set("x-nearyou-request-sha256", "f".repeat(64));
  assert.equal((await server.handle(request)).status, 401);
  assert.equal(calls.length, 0);
});

test("controller retries require byte-identical canonical operation data", async () => {
  const accepted = new Map();
  const apply = async (request, context) => {
    const prior = accepted.get(request.operationId);
    if (prior && prior !== context.requestSha256) throw new Error("private tester activation replay conflict");
    accepted.set(request.operationId, context.requestSha256);
    return { product: "nearfamily", releaseId, version: 2, globalPercent: 0, status: "active", auditDigest: "d".repeat(64) };
  };
  const { server } = controllerServer({ ordinaryController: { apply } });
  const first = await controllerRequest("/v1/nearfamily/controller", controllerBody());
  assert.equal((await server.handle(first.request)).status, 200);
  const retry = await controllerRequest("/v1/nearfamily/controller", controllerBody());
  assert.equal((await server.handle(retry.request)).status, 200);
  const changed = await controllerRequest("/v1/nearfamily/controller", controllerBody({ invites: [] }));
  assert.equal((await server.handle(changed.request)).status, 409);
});

test("emergency terminal kill remains available when ordinary controller access is unavailable", async () => {
  const { server, calls } = controllerServer({
    verifyIdToken: async ({ token, audience: expectedAudience }) => {
      if (token === "ordinary-token") throw new Error("ordinary IAM unavailable");
      return { issuer: "https://accounts.google.com", audience: expectedAudience, subject: emergencySubject, expiresAt: now + 60_000 };
    },
  });
  const ordinary = await controllerRequest("/v1/nearfamily/controller", controllerBody());
  assert.equal((await server.handle(ordinary.request)).status, 403);
  const emergency = await controllerRequest("/v1/nearfamily/emergency", controllerBody({ action: "kill", operationId: "kill-nearfamily-000001", invites: [] }), "emergency-token");
  const response = await server.handle(emergency.request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "killed");
  assert.deepEqual(calls.map((call) => call.lane), ["emergency"]);
});
