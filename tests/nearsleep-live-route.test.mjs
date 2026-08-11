import assert from "node:assert/strict";
import test from "node:test";
import { createDurableGenerationPostHandler, GenerationResultInvalidatedError, GenerationResultReconciliationError } from "../lib/nearsleep-live-route.ts";

function request(requestId = "11111111-1111-4111-8111-111111111111", value = "calm") {
  return new Request("https://example.test/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.test" },
    body: JSON.stringify({ requestId, value }),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function routeFixture(overrides = {}) {
  const operations = new Map();
  let authenticated = 0;
  let providerCalls = 0;
  let failedCalls = 0;
  const recoverableResults = new Map();
  const dependencies = {
    enabled: () => true,
    authenticate: async (incoming) => {
      authenticated += 1;
      const householdId = incoming.headers.get("x-test-household") || "household_1";
      return { userId: `adult:${householdId}`, householdId };
    },
    requireAdultGate: async () => undefined,
    parse: async (incoming) => incoming.json(),
    identify: (input) => ({ requestId: input.requestId, requestFingerprint: JSON.stringify(input) }),
    claim: async ({ operationId, requestFingerprint }) => {
      const existing = operations.get(operationId);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) return { kind: "conflict" };
        if (existing.status === "succeeded" || existing.result) return { kind: "replay", result: existing.result };
        if (existing.status === "failed") return { kind: "failed", error: existing.error };
        return { kind: "processing" };
      }
      operations.set(operationId, { requestFingerprint, status: "processing" });
      return { kind: "claimed" };
    },
    execute: async ({ input }) => {
      providerCalls += 1;
      const result = { output: `generated:${input.value}` };
      recoverableResults.set(`generation:household_1:script:${input.requestId}`, result);
      return result;
    },
    recover: async ({ operationId }) => recoverableResults.get(operationId) || null,
    recordReconciliation: () => undefined,
    stageResult: async ({ operationId, result }) => operations.set(operationId, { ...operations.get(operationId), result }),
    succeed: async ({ operationId, result }) => operations.set(operationId, { ...operations.get(operationId), status: "succeeded", result }),
    fail: async ({ operationId, error }) => {
      failedCalls += 1;
      operations.set(operationId, { ...operations.get(operationId), status: "failed", error });
    },
    operation: "script",
    ...overrides,
  };
  return {
    handler: createDurableGenerationPostHandler(dependencies),
    operations,
    authenticated: () => authenticated,
    providerCalls: () => providerCalls,
    failedCalls: () => failedCalls,
  };
}

test("production route gate returns 404 before authentication", async () => {
  const fixture = routeFixture({ enabled: () => false });
  const response = await fixture.handler(request());
  assert.equal(response.status, 404);
  assert.equal(fixture.authenticated(), 0);
  assert.deepEqual(await response.json(), { error: "NearSleep production generation is not enabled." });
});

test("production route blocks generation until current adult onboarding is complete", async () => {
  const fixture = routeFixture({
    requireAdultGate: async () => { throw new Response(JSON.stringify({ error: "Complete adult caregiver onboarding." }), { status: 403, headers: { "content-type": "application/json" } }); },
  });
  const response = await fixture.handler(request());
  assert.equal(response.status, 403);
  assert.equal(fixture.providerCalls(), 0);
});

test("concurrent requests with one ID invoke generation once and report the in-flight duplicate", async () => {
  const started = deferred();
  const release = deferred();
  const fixture = routeFixture({
    execute: async ({ input }) => {
      started.resolve();
      await release.promise;
      return { output: `generated:${input.value}` };
    },
  });
  const first = fixture.handler(request());
  await started.promise;
  const second = await fixture.handler(request());
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: "This generation request is already processing.", code: "generation_in_progress" });
  release.resolve();
  assert.equal((await first).status, 200);
});

test("a changed payload cannot reuse an existing generation request ID", async () => {
  const fixture = routeFixture();
  assert.equal((await fixture.handler(request())).status, 200);
  const response = await fixture.handler(request("11111111-1111-4111-8111-111111111111", "changed"));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "That request ID is already associated with different generation data.", code: "idempotency_conflict" });
});

test("a completed result is durably replayed after an ambiguous lost response", async () => {
  const fixture = routeFixture();
  const first = await fixture.handler(request());
  assert.equal(first.status, 200);
  const replay = await fixture.handler(request());
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { output: "generated:calm", duplicate: true });
  assert.equal(fixture.providerCalls(), 1);
});

test("a durable provider failure is replayed without a second invocation", async () => {
  const fixture = routeFixture({
    execute: async () => {
      throw new Response(JSON.stringify({ error: "Provider unavailable.", code: "provider_unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    },
  });
  const first = await fixture.handler(request());
  assert.equal(first.status, 503);
  const replay = await fixture.handler(request());
  assert.equal(replay.status, 503);
  assert.deepEqual(await replay.json(), { error: "Provider unavailable.", code: "provider_unavailable", duplicate: true });
});

test("a success-transition failure preserves the staged result and never converts provider success to terminal failure", async () => {
  let transitionAttempts = 0;
  const fixture = routeFixture({
    succeed: async () => {
      transitionAttempts += 1;
      throw new Error("database unavailable after result staging");
    },
  });
  const first = await fixture.handler(request());
  assert.equal(first.status, 503);
  assert.equal(fixture.failedCalls(), 0);
  const replay = await fixture.handler(request());
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { output: "generated:calm", duplicate: true });
  assert.equal(fixture.providerCalls(), 1);
  assert.equal(transitionAttempts, 1);
});

test("a result-staging failure is recovered from deterministic durable output without another provider call", async () => {
  let stageAttempts = 0;
  const fixture = routeFixture({
    stageResult: async ({ operationId, result }) => {
      stageAttempts += 1;
      if (stageAttempts === 1) throw new Error("D1 staging unavailable");
      fixture.operations.set(operationId, { ...fixture.operations.get(operationId), result });
    },
  });
  const first = await fixture.handler(request());
  assert.equal(first.status, 503);
  assert.equal(fixture.failedCalls(), 0);
  const replay = await fixture.handler(request());
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { output: "generated:calm", duplicate: true });
  assert.equal(fixture.providerCalls(), 1);
  assert.equal(stageAttempts, 2);
});

test("a transient recovery-store failure never converts a potentially successful operation to failed", async () => {
  const fixture = routeFixture({
    recover: async () => { throw new Error("R2 temporarily unavailable"); },
  });
  fixture.operations.set("generation:household_1:script:11111111-1111-4111-8111-111111111111", {
    requestFingerprint: JSON.stringify({ requestId: "11111111-1111-4111-8111-111111111111", value: "calm" }),
    status: "processing",
  });
  const response = await fixture.handler(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Generation completed but its result is still being reconciled. Retry this same request ID.",
    code: "generation_result_reconciliation",
  });
  assert.equal(fixture.failedCalls(), 0);
  assert.equal(fixture.providerCalls(), 0);
  assert.equal(fixture.operations.values().next().value.status, "processing");
});

test("a durably invalidated recovered result reaches terminal failure without invoking the provider", async () => {
  const fixture = routeFixture({
    recover: async () => { throw new GenerationResultInvalidatedError({ status: 409, error: "Consent changed before audio could be finalized.", code: "generation_consent_invalidated" }); },
  });
  fixture.operations.set("generation:household_1:script:11111111-1111-4111-8111-111111111111", {
    requestFingerprint: JSON.stringify({ requestId: "11111111-1111-4111-8111-111111111111", value: "calm" }),
    status: "processing",
  });
  const response = await fixture.handler(request());
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Consent changed before audio could be finalized.",
    code: "generation_consent_invalidated",
    duplicate: true,
  });
  assert.equal(fixture.failedCalls(), 1);
  assert.equal(fixture.providerCalls(), 0);
  assert.equal(fixture.operations.values().next().value.status, "failed");
});

test("an execution that completed provider work but lost both result stores remains reconciliation-pending", async () => {
  const fixture = routeFixture({
    execute: async () => { throw new GenerationResultReconciliationError(); },
  });
  const response = await fixture.handler(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Generation completed but its result is still being reconciled. Retry this same request ID.",
    code: "generation_result_reconciliation",
  });
  assert.equal(fixture.failedCalls(), 0);
  assert.equal(fixture.operations.values().next().value.status, "processing");
});

test("the same request ID in two households creates independent durable operations", async () => {
  const fixture = routeFixture();
  const firstRequest = request();
  firstRequest.headers.set("x-test-household", "household_1");
  const secondRequest = request();
  secondRequest.headers.set("x-test-household", "household_2");
  assert.equal((await fixture.handler(firstRequest)).status, 200);
  assert.equal((await fixture.handler(secondRequest)).status, 200);
  assert.equal(fixture.providerCalls(), 2);
  assert.equal(fixture.operations.size, 2);
});
