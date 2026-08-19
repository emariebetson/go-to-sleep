import assert from "node:assert/strict";
import test from "node:test";
import {
  createPrivateTesterActivationTestController,
  createPrivateTesterActivationTestStore,
  createPostgresPrivateTesterActivationStore,
} from "../lib/private-tester-activation.ts";
import { createPostgresHouseholdProductAccess, createPostgresPrivateTesterInvitationEvaluator } from "../lib/product-release-readiness-service.ts";
import { inspectPrivateTesterActivationCli } from "../scripts/private-tester-activation-cli.ts";

const now = 1_787_000_000_000;
const hash = (character) => character.repeat(64);
const releaseId = "rel_20260819_private_01";
const invitedHouseholdHash = hash("a");
const deniedHouseholdHash = hash("b");

function request(overrides = {}) {
  return {
    action: "activate",
    operationId: "activate-nearstory-0001",
    principal: "service:readiness",
    product: "nearstory",
    expectedVersion: 1,
    promotedBaselineSha256: hash("c"),
    releaseEvidence: {
      digest: hash("d"),
      releaseId,
      product: "nearstory",
      expiresAt: now + 60_000,
      controllerMapping: {
        verified: true,
        principal: "service:readiness",
        artifact: hash("e"),
      },
    },
    invites: [{ householdHash: invitedHouseholdHash, expiresAt: now + 30_000 }],
    ...overrides,
  };
}

function durableRequest(overrides = {}) {
  return {
    action: "activate",
    operationId: "activate-nearstory-0007",
    product: "nearstory",
    expectedVersion: 1,
    promotedBaselineSha256: hash("c"),
    releaseEvidenceDigest: hash("d"),
    releaseId,
    invites: [{ householdHash: invitedHouseholdHash, expiresAt: now + 30_000 }],
    ...overrides,
  };
}

function controller(overrides = {}) {
  const store = createPrivateTesterActivationTestStore({
    promotedBaselines: [{ sha256: hash("c"), releaseId, darkGates: { nearfamily: false, nearstory: false, scheduler: false } }],
    products: ["nearstory", "nearfamily"],
  });
  return { store, controller: createPrivateTesterActivationTestController({ store, now: () => now, verifyReleaseEvidence: async (evidence) => evidence.digest === hash("d"), ...overrides }) };
}

test("activation requires a promoted dark baseline before it records an invite authorization", async () => {
  const { controller: activate } = controller();
  await assert.rejects(() => activate(request({ promotedBaselineSha256: hash("f") })), /baseline/);
});

test("activation fails closed when the signed release evidence cannot be verified", async () => {
  const { controller: activate } = controller({ verifyReleaseEvidence: async () => false });
  await assert.rejects(() => activate(request()), /signature/);
});

test("activation requires the exact product release and readiness-controller mapping", async () => {
  const { controller: activate } = controller();
  await assert.rejects(() => activate(request({ releaseEvidence: { ...request().releaseEvidence, product: "nearfamily" } })), /evidence/);
  await assert.rejects(() => activate(request({ releaseEvidence: { ...request().releaseEvidence, controllerMapping: { ...request().releaseEvidence.controllerMapping, principal: "service:other" } } })), /mapping/);
});

test("activation authorizes only the exact invited synthetic household and leaves global percent at zero", async () => {
  const { controller: activate } = controller();
  const result = await activate(request());
  assert.equal(result.globalPercent, 0);
  assert.equal(await activate.authorize({ product: "nearstory", householdHash: invitedHouseholdHash }), true);
  assert.equal(await activate.authorize({ product: "nearstory", householdHash: deniedHouseholdHash }), false);
  assert.equal(await activate.authorize({ product: "nearfamily", householdHash: invitedHouseholdHash }), false);
});

test("activation refuses expired invites and stale release evidence", async () => {
  const { controller: activate } = controller();
  await assert.rejects(() => activate(request({ invites: [{ householdHash: invitedHouseholdHash, expiresAt: now }] })), /invite/);
  await assert.rejects(() => activate(request({ releaseEvidence: { ...request().releaseEvidence, expiresAt: now } })), /evidence/);
});

test("activation uses per-product compare-and-swap under a race", async () => {
  const { controller: activate } = controller();
  const [first, second] = await Promise.allSettled([activate(request()), activate(request({ operationId: "activate-nearstory-0002" }))]);
  assert.equal([first, second].filter((item) => item.status === "fulfilled").length, 1);
  assert.equal([first, second].filter((item) => item.status === "rejected").length, 1);
});

test("a replay converges only when its immutable request evidence is exact", async () => {
  const { controller: activate } = controller();
  const first = await activate(request());
  assert.deepEqual(await activate(request()), first);
  await assert.rejects(() => activate(request({ invites: [{ householdHash: deniedHouseholdHash, expiresAt: now + 30_000 }] })), /replay/);
});

test("revocation and the kill switch immediately deny an already invited household", async () => {
  const { controller: activate } = controller();
  const active = await activate(request());
  await activate({ ...request({ action: "revoke", operationId: "revoke-nearstory-0001", expectedVersion: active.version }), invites: [{ householdHash: invitedHouseholdHash, expiresAt: now + 30_000 }] });
  assert.equal(await activate.authorize({ product: "nearstory", householdHash: invitedHouseholdHash }), false);
  const reactivated = await activate({ ...request({ operationId: "activate-nearstory-0003", expectedVersion: active.version + 1 }) });
  await activate({ ...request({ action: "kill", operationId: "kill-nearstory-000001", expectedVersion: reactivated.version, invites: [] }) });
  assert.equal(await activate.authorize({ product: "nearstory", householdHash: invitedHouseholdHash }), false);
});

test("the kill switch still wins when promoted evidence is no longer available", async () => {
  const { controller: activate } = controller();
  const active = await activate(request());
  const killed = await activate(request({ action: "kill", operationId: "kill-nearstory-000002", expectedVersion: active.version, promotedBaselineSha256: hash("f"), invites: [] }));
  assert.equal(killed.status, "killed");
  assert.equal(await activate.authorize({ product: "nearstory", householdHash: invitedHouseholdHash }), false);
});

test("callers cannot mutate controller state or reopen a killed authorization", async () => {
  const { store, controller: activate } = controller();
  const active = await activate(request());
  await activate(request({ action: "kill", operationId: "kill-nearstory-000003", expectedVersion: active.version, invites: [] }));
  store.state("nearstory").killSwitch = false;
  assert.equal(await activate.authorize({ product: "nearstory", householdHash: invitedHouseholdHash }), false);
});

test("a normal activate operation cannot clear a terminal kill switch", async () => {
  const { controller: activate } = controller();
  const active = await activate(request());
  const killed = await activate(request({ action: "kill", operationId: "kill-nearstory-000004", expectedVersion: active.version, invites: [] }));
  await assert.rejects(() => activate(request({ operationId: "activate-nearstory-0005", expectedVersion: killed.version })), /terminal/);
});

test("the store exposes no externally writable state or audit hooks", () => {
  const { store } = controller();
  assert.equal("replaceState" in store, false);
  assert.equal("appendAudit" in store, false);
});

test("activation rejects a stale expected rollout-state version", async () => {
  const { controller: activate } = controller();
  await activate(request());
  await assert.rejects(() => activate(request({ operationId: "activate-nearstory-0004" })), /version/);
});

test("the release-readiness adapter evaluates an injected invitation controller before any rollout percentage", async () => {
  const { controller: activate } = controller();
  await activate(request());
  const calls = [];
  const pg = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: [] }; } };
  const access = createPostgresHouseholdProductAccess(pg, activate);
  assert.equal(await access("nearstory", "hh_12345678"), false);
  const invitedAccess = createPostgresHouseholdProductAccess(pg, { authorize: async () => true });
  assert.equal(await invitedAccess("nearstory", "hh_12345678"), true);
  assert.equal(calls.length, 0);
});

test("the durable invitation evaluator asks PostgreSQL for the exact product and household hash", async () => {
  const calls = [];
  const evaluator = createPostgresPrivateTesterInvitationEvaluator({ query: async (sql, args) => { calls.push({ sql, args }); return { rows: [{ allowed: true }] }; } });
  assert.equal(await evaluator.authorize({ product: "nearstory", householdHash: invitedHouseholdHash }), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /authorize_private_tester_household/);
  assert.deepEqual(calls[0].args, ["nearstory", invitedHouseholdHash]);
});

test("the production store delegates one activation to the durable PostgreSQL transaction boundary", async () => {
  const calls = [];
  const pg = { transaction: async (run) => run({ query: async (sql, args) => { calls.push({ sql, args }); return { rows: [{ result: { product: "nearstory", releaseId, version: 2, globalPercent: 0, status: "active", auditDigest: hash("f") } }] }; } }) };
  const store = createPostgresPrivateTesterActivationStore(pg);
  const result = await store.apply({ operationId: "activate-nearstory-0006", product: "nearstory", expectedVersion: 1, action: "activate", principal: "service:readiness", promotedBaselineSha256: hash("c"), releaseEvidenceDigest: hash("d"), releaseId, canonicalClaims: "{}", invites: [{ householdHash: invitedHouseholdHash, expiresAt: now + 30_000 }] });
  assert.equal(result.status, "active");
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /apply_private_tester_activation/);
  assert.equal(calls[0].args[0], "service:readiness");
});

test("the activation CLI only emits a controller-only validation receipt", async () => {
  const receipt = await inspectPrivateTesterActivationCli(JSON.stringify(durableRequest()));
  assert.equal(receipt.mode, "controller-only");
  assert.match(receipt.requestSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(() => inspectPrivateTesterActivationCli(JSON.stringify(durableRequest({ action: "kill" }))), /activation CLI invalid/);
});
