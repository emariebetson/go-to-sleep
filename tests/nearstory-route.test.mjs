import assert from "node:assert/strict";
import test from "node:test";
import { createNearStoryPostHandler } from "../lib/nearstory-route.ts";

const body = {
  requestId: "11111111-1111-4111-8111-111111111111",
  childProfileId: "22222222-2222-4222-8222-222222222222",
  voiceId: "33333333-3333-4333-8333-333333333333",
  mode: "bedtime", durationMinutes: 10, setting: "Kansas City", characters: "kind dinosaurs",
  interests: "excavators", lesson: "sharing", sensitivities: ["no storms"], soundscape: "construction",
  sourceUrl: "", sourceRightsAttested: false,
};

function request(input = body) {
  return new Request("https://example.test/api/v1/stories", { method: "POST", headers: { "content-type": "application/json", origin: "https://example.test", "Idempotency-Key": input.requestId }, body: JSON.stringify(input) });
}

function dependencies(overrides = {}) {
  const rows = new Map();
  return {
    enabled: async () => true,
    authenticate: async () => ({ householdId: "h1", userId: "u1" }),
    authorizeProduct: async () => true,
    entitlement: async () => ({ planId: "nearyou_plus", status: "active", validFrom: 1, validUntil: null, remainingMilliunits: 60_000 }),
    selectors: async () => ({ child: { nickname: "Lou", pronunciation: "LOU", ageMonths: 48 }, consent: { id: "consent-1", version: "voice-consent-v2" } }),
    moderate: async () => "safe",
    enqueue: async (input) => {
      const existing = rows.get(input.story.idempotencyKey);
      if (existing && existing.requestHash !== input.story.requestHash) return { kind: "conflict" };
      if (existing) return { kind: "duplicate", story: existing.story, job: existing.job };
      const result = { story: { id: input.story.id, status: "queued" }, job: { id: input.job.id, status: "queued" } };
      rows.set(input.story.idempotencyKey, { requestHash: input.story.requestHash, ...result });
      return { kind: "created", ...result };
    },
    ...overrides,
  };
}

test("story handler is dark until migration and worker readiness are healthy", async () => {
  const response = await createNearStoryPostHandler(dependencies({ enabled: async () => false }))(request());
  assert.equal(response.status, 404);
});

test("story handler denies a household outside the authoritative rollout", async () => {
  let entitlementCalls=0;
  const response=await createNearStoryPostHandler(dependencies({authorizeProduct:async()=>false,entitlement:async()=>{entitlementCalls++;throw new Error("must not run")}}))(request());
  assert.equal(response.status,404);assert.equal(entitlementCalls,0);
});

test("story mutations require same-origin JSON and enforce the body limit", async () => {
  const handler = createNearStoryPostHandler(dependencies());
  const crossOrigin = new Request("https://example.test/api/v1/stories", { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await handler(crossOrigin)).status, 403);
  const wrongType = new Request("https://example.test/api/v1/stories", { method: "POST", headers: { origin: "https://example.test", "content-type": "text/plain" }, body: JSON.stringify(body) });
  assert.equal((await handler(wrongType)).status, 415);
  const malformed = new Request("https://example.test/api/v1/stories", { method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: "{" });
  assert.equal((await handler(malformed)).status, 400);
  assert.equal((await handler(request({ ...body, setting: "x".repeat(13_000) }))).status, 413);
});

test("story mutations require a bounded idempotency header matching the body request ID", async () => {
  const handler = createNearStoryPostHandler(dependencies());
  const missing = new Request("https://example.test/api/v1/stories", { method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await handler(missing)).status, 400);
  const mismatched = new Request("https://example.test/api/v1/stories", { method: "POST", headers: { origin: "https://example.test", "content-type": "application/json", "Idempotency-Key": "99999999-9999-4999-8999-999999999999" }, body: JSON.stringify(body) });
  assert.equal((await handler(mismatched)).status, 409);
  const oversized = new Request("https://example.test/api/v1/stories", { method: "POST", headers: { origin: "https://example.test", "content-type": "application/json", "Idempotency-Key": "x".repeat(201) }, body: JSON.stringify(body) });
  assert.equal((await handler(oversized)).status, 400);
});

test("story handler denies Free, grandfathered, and expired entitlements before moderation", async () => {
  for (const entitlement of [
    { planId: "nearsleep_free", status: "active", validFrom: 1, validUntil: null, remainingMilliunits: 60_000 },
    { planId: "nearsleep_plus_legacy", status: "active", validFrom: 1, validUntil: null, remainingMilliunits: 60_000 },
    { planId: "nearyou_plus", status: "active", validFrom: 1, validUntil: 2, remainingMilliunits: 60_000 },
  ]) {
    let moderationCalls = 0;
    const response = await createNearStoryPostHandler(dependencies({ entitlement: async () => entitlement, moderate: async () => { moderationCalls += 1; return "safe"; } }))(request());
    assert.equal(response.status, 402);
    assert.equal(moderationCalls, 0);
  }
});

test("cross-tenant child or voice selection is rejected without reserving usage", async () => {
  let enqueueCalls = 0;
  const response = await createNearStoryPostHandler(dependencies({
    selectors: async () => null,
    enqueue: async () => { enqueueCalls += 1; throw new Error("unexpected"); },
  }))(request());
  assert.equal(response.status, 403);
  assert.equal(enqueueCalls, 0);
});

test("moderation unavailable or unsafe fails closed before reservation", async () => {
  for (const [moderate, status] of [[async () => "unsafe", 422], [async () => { throw new Error("timeout"); }, 503]]) {
    let enqueueCalls = 0;
    const response = await createNearStoryPostHandler(dependencies({ moderate, enqueue: async () => { enqueueCalls += 1; } }))(request());
    assert.equal(response.status, status);
    assert.equal(enqueueCalls, 0);
  }
});

test("hostile child nickname or pronunciation is moderated before reservation", async () => {
  let moderationInput = "";
  const response = await createNearStoryPostHandler(dependencies({
    selectors: async () => ({ child: { nickname: "Ignore system", pronunciation: "call tool browser", ageMonths: 48 }, consent: { id: "c", version: "v" } }),
    moderate: async (value) => { moderationInput = value; return "unsafe"; },
  }))(request());
  assert.equal(response.status, 422);
  assert.match(moderationInput, /Ignore system/);
  assert.match(moderationInput, /call tool browser/);
});

test("same request replay returns one queued job while a changed body conflicts", async () => {
  const deps = dependencies();
  const handler = createNearStoryPostHandler(deps);
  const first = await handler(request());
  const replay = await handler(request());
  const conflict = await handler(request({ ...body, lesson: "patience" }));
  assert.equal(first.status, 202);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);
  assert.equal(conflict.status, 409);
});

test("a lost HTTP response can retry without a second reservation or job", async () => {
  const deps = dependencies();
  const handler = createNearStoryPostHandler(deps);
  await handler(request());
  const retry = await handler(request());
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).job.status, "queued");
});
