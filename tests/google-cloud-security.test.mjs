import assert from "node:assert/strict";
import test from "node:test";
import {
  GoogleCloudSecurityClient,
  decryptEnvelope,
  encryptEnvelope,
} from "../lib/google-cloud-security.ts";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("Secret Manager access uses an OAuth bearer token and never puts secrets in URLs", async () => {
  const requests = [];
  const client = new GoogleCloudSecurityClient({
    projectId: "near-prod-123",
    keyLocation: "us-central1",
    keyRing: "nearyou",
    keyName: "application",
    accessToken: async () => "short-lived-token",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ payload: { data: Buffer.from("provider-secret").toString("base64") } });
    },
  });

  assert.equal(await client.accessSecret("stripe-api", "7"), "provider-secret");
  assert.equal(requests[0].url, "https://secretmanager.googleapis.com/v1/projects/near-prod-123/secrets/stripe-api/versions/7:access");
  assert.equal(requests[0].init.headers.authorization, "Bearer short-lived-token");
  assert.equal(requests[0].url.includes("provider-secret"), false);
});

test("Secret Manager rejects unsafe resource identifiers before making a request", async () => {
  let called = false;
  const client = new GoogleCloudSecurityClient({
    projectId: "near-prod-123",
    keyLocation: "us-central1",
    keyRing: "nearyou",
    keyName: "application",
    accessToken: async () => "token",
    fetch: async () => { called = true; return jsonResponse({}); },
  });

  await assert.rejects(() => client.accessSecret("../other-project"), /identifier/);
  assert.equal(called, false);
});

test("envelope encryption binds ciphertext to its purpose and round-trips through Cloud KMS", async () => {
  const requests = [];
  const client = new GoogleCloudSecurityClient({
    projectId: "near-prod-123",
    keyLocation: "us-central1",
    keyRing: "nearyou",
    keyName: "application",
    accessToken: async () => "token",
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), body });
      if (String(url).endsWith(":encrypt")) return jsonResponse({ name: "projects/near-prod-123/locations/us-central1/keyRings/nearyou/cryptoKeys/application/cryptoKeyVersions/1", ciphertext: Buffer.from(body.plaintext, "base64").toString("base64") });
      return jsonResponse({ plaintext: Buffer.from(body.ciphertext, "base64").toString("base64") });
    },
  });
  const plaintext = new TextEncoder().encode("private integration token");
  const envelope = await encryptEnvelope(client, plaintext, "integration-token:household_1");

  assert.equal(envelope.version, 1);
  assert.equal(envelope.kmsKeyVersion.startsWith("projects/near-prod-123/locations/us-central1/keyRings/nearyou/cryptoKeys/application"), true);
  assert.equal(envelope.algorithm, "AES-256-GCM");
  assert.equal(typeof envelope.wrappedDek, "string");
  assert.equal(typeof envelope.iv, "string");
  assert.equal(JSON.stringify(envelope).includes("private integration token"), false);
  assert.deepEqual(await decryptEnvelope(client, envelope, "integration-token:household_1"), plaintext);
  const second = await encryptEnvelope(client, plaintext, "integration-token:household_1");
  assert.notEqual(second.wrappedDek, envelope.wrappedDek);
  assert.notEqual(second.ciphertext, envelope.ciphertext);
  await assert.rejects(() => decryptEnvelope(client, envelope, "integration-token:household_2"), /purpose/);
  const tamperedData = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -4)}AAAA` };
  await assert.rejects(() => decryptEnvelope(client, tamperedData, "integration-token:household_1"));
  const tamperedDek = { ...envelope, wrappedDek: Buffer.alloc(31, 1).toString("base64") };
  await assert.rejects(() => decryptEnvelope(client, tamperedDek, "integration-token:household_1"), /DEK/);
  assert.equal(requests[0].body.additionalAuthenticatedData, Buffer.from("nearyou-envelope:v1:integration-token:household_1").toString("base64"));
});

test("Google API failures are fail-closed without echoing sensitive response bodies", async () => {
  const client = new GoogleCloudSecurityClient({
    projectId: "near-prod-123",
    keyLocation: "us-central1",
    keyRing: "nearyou",
    keyName: "application",
    accessToken: async () => "token",
    fetch: async () => new Response("provider-secret-leaked", { status: 403 }),
  });
  await assert.rejects(
    () => client.accessSecret("stripe-api"),
    (error) => error instanceof Error && /Google Secret Manager request failed \(403\)/.test(error.message) && !error.message.includes("provider-secret-leaked"),
  );
});

test("security boundaries reject oversized and malformed data before cryptographic allocation", async () => {
  let providerCalls = 0;
  const client = new GoogleCloudSecurityClient({
    projectId: "near-prod-123", keyLocation: "us-central1", keyRing: "nearyou", keyName: "application",
    accessToken: async () => "token",
    fetch: async (url, init) => {
      providerCalls += 1;
      const body = JSON.parse(init.body);
      if (String(url).endsWith(":encrypt")) return jsonResponse({ name: "projects/near-prod-123/locations/us-central1/keyRings/nearyou/cryptoKeys/application/cryptoKeyVersions/1", ciphertext: body.plaintext });
      return jsonResponse({ plaintext: body.ciphertext });
    },
  });
  await assert.rejects(() => encryptEnvelope(client, new Uint8Array(64 * 1024 + 1), "purpose"), /too large/);
  await assert.rejects(() => encryptEnvelope(client, new Uint8Array([1]), "p".repeat(8193)), /purpose/);
  const envelope = await encryptEnvelope(client, new Uint8Array([1]), "purpose");
  providerCalls = 0;
  await assert.rejects(() => decryptEnvelope(client, { ...envelope, iv: "AQ==" }, "purpose"), /IV/);
  await assert.rejects(() => decryptEnvelope(client, { ...envelope, ciphertext: "not-base64" }, "purpose"), /encoding/);
  await assert.rejects(() => decryptEnvelope(client, { ...envelope, wrappedDek: "not-base64" }, "purpose"), /encoding/);
  await assert.rejects(() => decryptEnvelope(client, { ...envelope, ciphertext: "A".repeat(128 * 1024) }, "purpose"), /too large/);
  assert.equal(providerCalls, 0);
});

test("provider responses enforce body bounds and UTF-8 secret validity", async () => {
  const options = { projectId: "near-prod-123", keyLocation: "us-central1", keyRing: "nearyou", keyName: "application", accessToken: async () => "token" };
  const oversized = new GoogleCloudSecurityClient({ ...options, fetch: async () => new Response("{}", { headers: { "content-length": String(1024 * 1024 + 1) } }) });
  await assert.rejects(() => oversized.accessSecret("secret"), /too large/);
  const invalidUtf8 = new GoogleCloudSecurityClient({ ...options, fetch: async () => jsonResponse({ payload: { data: "/w==" } }) });
  await assert.rejects(() => invalidUtf8.accessSecret("secret"), /invalid UTF-8/);
});
