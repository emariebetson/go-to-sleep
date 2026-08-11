import assert from "node:assert/strict";
import test from "node:test";
import {
  allowanceWeightForNarration,
  allowanceWeightForScript,
  classifyReservationFailure,
  executeConservativelyAccountedProviderCall,
  finalizeProviderSpend,
  providerSpendEstimateMicrocents,
  reserveHouseholdAllowance,
} from "../lib/usage-reservations.ts";

test("customer allowance stays separate from provider spend and follows the household plan", () => {
  assert.equal(allowanceWeightForScript("curated"), 0);
  assert.equal(allowanceWeightForScript("personalized"), 0);
  assert.equal(allowanceWeightForNarration("nearsleep_free", "save", 5), 1000);
  assert.throws(() => allowanceWeightForNarration("nearsleep_free", "save", 20), /five-minute/);
  assert.equal(allowanceWeightForNarration("nearsleep_plus_legacy", "preview", 10), 0);
  assert.equal(allowanceWeightForNarration("nearsleep_plus_legacy", "save", 10), 1000);
  assert.equal(allowanceWeightForNarration("nearyou_plus", "preview", 10), 0);
  assert.equal(allowanceWeightForNarration("nearyou_plus", "save", 5), 5000);
  assert.equal(allowanceWeightForNarration("nearyou_plus", "save", 20), 20000);
});

test("provider spend estimates are positive bounded integers for guarded operations", () => {
  assert.equal(providerSpendEstimateMicrocents("openai", "script", 2_600), 130_000);
  assert.equal(providerSpendEstimateMicrocents("elevenlabs", "audio", 1_000), 3_000_000);
  assert.throws(() => providerSpendEstimateMicrocents("openai", "script", -1));
});

test("reservation database failures map to stable fail-closed responses", () => {
  assert.deepEqual(classifyReservationFailure(new Error("allowance_exhausted")), { status: 402, code: "allowance_exhausted" });
  assert.deepEqual(classifyReservationFailure(new Error("provider_concurrency_limit")), { status: 429, code: "provider_busy" });
  assert.deepEqual(classifyReservationFailure(new Error("provider_circuit_open")), { status: 503, code: "provider_unavailable" });
  assert.deepEqual(classifyReservationFailure(new Error("secret database detail")), { status: 503, code: "reservation_unavailable" });
});

test("zero-weight customer allowance operations are no-ops before database access", async () => {
  assert.deepEqual(await reserveHouseholdAllowance({
    householdId: "household_1",
    userId: "user_1",
    idempotencyKey: "script:req_1",
    operation: "nearsleep_script_generation",
    quantity: 1,
    weightMilliunits: 0,
    requestFingerprint: "request_1",
  }), { reservation: null, duplicate: false });
  await assert.rejects(() => reserveHouseholdAllowance({
    householdId: "household_1",
    userId: "user_1",
    idempotencyKey: "script:req_2",
    operation: "nearsleep_script_generation",
    quantity: 1,
    weightMilliunits: -1,
    requestFingerprint: "request_2",
  }), /invalid_usage_reservation/);
});

test("provider work starts only after a durable charge commitment and ignores telemetry failures", async () => {
  const events = [];
  const result = await executeConservativelyAccountedProviderCall({
    commitBeforeInvoke: async () => events.push("charge committed"),
    invoke: async () => {
      events.push("provider");
      return "result";
    },
    settleAfterInvoke: async () => events.push("settled"),
    recordSuccess: async () => {
      events.push("telemetry");
      throw new Error("telemetry unavailable");
    },
    recordFailure: async () => events.push("failure telemetry"),
  });
  assert.equal(result, "result");
  assert.deepEqual(events, ["charge committed", "provider", "settled", "telemetry"]);

  let invoked = false;
  await assert.rejects(() => executeConservativelyAccountedProviderCall({
    commitBeforeInvoke: async () => { throw new Error("provider_spend_commit_conflict"); },
    invoke: async () => {
      invoked = true;
      return "unreachable";
    },
    settleAfterInvoke: async () => undefined,
    recordSuccess: async () => undefined,
    recordFailure: async () => undefined,
  }), /provider_spend_commit_conflict/);
  assert.equal(invoked, false);
});

test("provider settlement rejects invalid actual spend before database access", async () => {
  await assert.rejects(() => finalizeProviderSpend("spend_1", "settled", -1), /invalid_provider_spend_actual/);
  await assert.rejects(() => finalizeProviderSpend("spend_1", "settled", 0.5), /invalid_provider_spend_actual/);
  await assert.rejects(() => finalizeProviderSpend("spend_1", "released", 0), /invalid_provider_spend_actual/);
});

test("provider parsing failures remain conservatively settled even when failure telemetry also fails", async () => {
  const events = [];
  await assert.rejects(() => executeConservativelyAccountedProviderCall({
    commitBeforeInvoke: async () => events.push("charge committed"),
    invoke: async () => {
      events.push("provider accepted request");
      throw new Error("response parsing failed");
    },
    settleAfterInvoke: async () => {
      events.push("settlement telemetry");
      throw new Error("settlement unavailable");
    },
    recordSuccess: async () => events.push("success telemetry"),
    recordFailure: async () => {
      events.push("failure telemetry");
      throw new Error("telemetry unavailable");
    },
  }), /response parsing failed/);
  assert.deepEqual(events, ["charge committed", "provider accepted request", "settlement telemetry", "failure telemetry"]);
});
