import assert from "node:assert/strict";
import test from "node:test";
import { circuitFailureState, providerRetryDelay, shouldRetryProviderStatus } from "../lib/provider-guard.ts";

test("provider retries are bounded to transient failures with capped exponential delays", () => {
  assert.equal(shouldRetryProviderStatus(429), true);
  assert.equal(shouldRetryProviderStatus(503), true);
  assert.equal(shouldRetryProviderStatus(400), false);
  assert.equal(providerRetryDelay(0), 250);
  assert.equal(providerRetryDelay(1), 500);
  assert.equal(providerRetryDelay(9), 2_000);
});

test("the circuit opens after five consecutive provider failures", () => {
  assert.deepEqual(circuitFailureState(4, 1_786_442_400_000), { consecutiveFailures: 5, openUntil: 1_786_442_460_000 });
  assert.deepEqual(circuitFailureState(1, 1_786_442_400_000), { consecutiveFailures: 2, openUntil: null });
});
