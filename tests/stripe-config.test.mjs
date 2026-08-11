import assert from "node:assert/strict";
import test from "node:test";
import { stripeEventMatchesMode, stripeSecretMatchesMode } from "../lib/stripe-config.ts";

test("private test deployments reject live Stripe secrets", () => {
  assert.equal(stripeSecretMatchesMode("sk_test_example", true), true);
  assert.equal(stripeSecretMatchesMode("rk_test_example", true), true);
  assert.equal(stripeSecretMatchesMode("sk_live_example", true), false);
  assert.equal(stripeSecretMatchesMode("rk_live_example", true), false);
  assert.equal(stripeSecretMatchesMode("sk_live_example", false), true);
  assert.equal(stripeSecretMatchesMode("not_a_key", false), false);
});

test("private test deployments reject live Stripe webhook events", () => {
  assert.equal(stripeEventMatchesMode(false, true), true);
  assert.equal(stripeEventMatchesMode(true, true), false);
  assert.equal(stripeEventMatchesMode(true, false), true);
});
