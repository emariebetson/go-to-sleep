import assert from "node:assert/strict";
import test from "node:test";
import { validateStripeCheckoutResponse, validateStripePortalResponse } from "../lib/stripe.ts";

test("checkout accepts only the pinned Stripe Checkout response shape and origin", () => {
  assert.deepEqual(validateStripeCheckoutResponse({ id: "cs_test_abc123", url: "https://checkout.stripe.com/c/pay/cs_test_abc123", expires_at: 1_800_000_000 }), {
    id: "cs_test_abc123",
    url: "https://checkout.stripe.com/c/pay/cs_test_abc123",
    expiresAt: 1_800_000_000,
  });
  assert.throws(() => validateStripeCheckoutResponse({ id: "pi_123", url: "https://checkout.stripe.com/c/pay/example" }), /Session ID/i);
  assert.throws(() => validateStripeCheckoutResponse({ id: "cs_test_abc123", url: "https://checkout.stripe.com.evil.test/pay" }), /trusted/i);
  assert.throws(() => validateStripeCheckoutResponse({ id: "cs_test_abc123", url: "javascript:alert(1)" }), /trusted/i);
  assert.throws(() => validateStripeCheckoutResponse({ id: "cs_test_abc123", url: "https://checkout.stripe.com/c/pay/example" }), /expiration/i);
});

test("portal accepts only a trusted Stripe billing response URL", () => {
  assert.equal(
    validateStripePortalResponse({ url: "https://billing.stripe.com/p/session/test_123" }),
    "https://billing.stripe.com/p/session/test_123",
  );
  assert.throws(() => validateStripePortalResponse({ url: "https://billing.stripe.com.evil.test/p/session/test_123" }), /trusted/i);
  assert.throws(() => validateStripePortalResponse({ url: "javascript:alert(1)" }), /trusted/i);
});
