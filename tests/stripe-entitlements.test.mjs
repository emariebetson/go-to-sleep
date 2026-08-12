import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredStripePrices,
  parseStripeCheckoutSelection,
  stripeInvoiceOrderingDecision,
  stripeCheckoutPrice,
  stripeEntitlementStatus,
  stripeEntitlementValidUntil,
} from "../lib/stripe-entitlements.ts";

const environment = {
  STRIPE_PRICE_PLUS_MONTHLY: "price_legacy12",
  STRIPE_PRICE_NEARYOU_PLUS_MONTHLY: "price_plus_month",
  STRIPE_PRICE_NEARYOU_PLUS_ANNUAL: "price_plus_year",
  STRIPE_PRICE_NEARYOU_FAMILY_MONTHLY: "price_family_month",
  STRIPE_PRICE_NEARYOU_FAMILY_ANNUAL: "price_family_year",
  STRIPE_PRICE_NEARLEGACY_MONTHLY: "price_archive_month",
  STRIPE_PRICE_NEARLEGACY_ANNUAL: "price_archive_year",
  STRIPE_PRICE_ARCHIVE_CARE_ANNUAL: "price_archive_care_year",
  STRIPE_PRICE_ARCHIVE_BUILDER: "price_archive_builder",
};

test("server-owned Stripe prices map exactly to canonical plans and allowances", () => {
  const prices = configuredStripePrices(environment);
  assert.deepEqual(prices.get("price_legacy12"), { priceId: "price_legacy12", planId: "nearsleep_plus_legacy", interval: "month", allowanceMilliunits: 12_000, grandfathered: true });
  assert.deepEqual(prices.get("price_plus_year"), { priceId: "price_plus_year", planId: "nearyou_plus", interval: "year", allowanceMilliunits: 60_000, grandfathered: false });
  assert.deepEqual(prices.get("price_family_month"), { priceId: "price_family_month", planId: "nearyou_family", interval: "month", allowanceMilliunits: 120_000, grandfathered: false });
});

test("invoice delivery never overrides a newer authoritative subscription state", () => {
  assert.equal(stripeInvoiceOrderingDecision(200, "canceled", 100, ["active", "trialing"]), "ignore");
  assert.equal(stripeInvoiceOrderingDecision(100, "past_due", 200, ["active", "trialing"]), "retry");
  assert.equal(stripeInvoiceOrderingDecision(200, "canceled", 200, ["active", "trialing"]), "reconcile");
  assert.equal(stripeInvoiceOrderingDecision(300, "active", 100, ["active", "trialing"]), "apply");
  assert.equal(stripeInvoiceOrderingDecision(300, "active", 100, ["past_due"]), "ignore");
});

test("invalid or duplicate Stripe price configuration fails closed", () => {
  assert.throws(() => configuredStripePrices({ ...environment, STRIPE_PRICE_NEARYOU_PLUS_MONTHLY: "live_product" }), /invalid Stripe price/i);
  assert.throws(() => configuredStripePrices({ ...environment, STRIPE_PRICE_NEARYOU_PLUS_MONTHLY: environment.STRIPE_PRICE_PLUS_MONTHLY }), /multiple plans/i);
});

test("checkout preserves grandfathering and exposes only configured canonical intervals", () => {
  assert.throws(() => stripeCheckoutPrice(environment, "nearsleep_plus_legacy", "month"), /grandfathered plan is not available/i);
  assert.equal(stripeCheckoutPrice(environment, "nearyou_plus", "year").priceId, "price_plus_year");
  assert.equal(stripeCheckoutPrice(environment, "nearyou_plus", "month").priceId, "price_plus_month");
  assert.equal(stripeCheckoutPrice(environment, "nearyou_family", "month").priceId, "price_family_month");
  assert.equal(stripeCheckoutPrice(environment, "nearlegacy", "month").priceId, "price_archive_month");
  assert.equal(stripeCheckoutPrice(environment, "archive_care", "year").priceId, "price_archive_care_year");
  assert.equal(stripeCheckoutPrice(environment, "archive_builder", "one_time").priceId, "price_archive_builder");
  assert.throws(() => stripeCheckoutPrice(environment, "archive_builder", "month"), /not available/i);
});

test("checkout selection accepts only bounded URL-encoded or JSON plan fields", () => {
  assert.deepEqual(parseStripeCheckoutSelection("application/x-www-form-urlencoded", "plan=nearyou_plus&interval=month"), { planId: "nearyou_plus", interval: "month" });
  assert.deepEqual(parseStripeCheckoutSelection("application/json; charset=utf-8", JSON.stringify({ plan: "nearyou_family", interval: "month" })), { planId: "nearyou_family", interval: "month" });
  assert.throws(() => parseStripeCheckoutSelection("multipart/form-data", ""), /unsupported/i);
  assert.throws(() => parseStripeCheckoutSelection("application/json", "x".repeat(2_049)), /too large/i);
});

test("Stripe subscription statuses map to bounded household entitlement states", () => {
  for (const status of ["active", "trialing"]) assert.equal(stripeEntitlementStatus(status, false), "active");
  assert.equal(stripeEntitlementStatus("past_due", false), "grace");
  assert.equal(stripeEntitlementStatus("unpaid", false), "inactive");
  assert.equal(stripeEntitlementStatus("canceled", false), "inactive");
  assert.equal(stripeEntitlementStatus("active", true), "revoked");
  assert.throws(() => stripeEntitlementStatus("mystery", false), /unsupported/i);
  const eventTime = new Date("2026-08-11T00:00:00Z");
  assert.equal(stripeEntitlementValidUntil("grace", eventTime)?.toISOString(), "2026-08-18T00:00:00.000Z");
  assert.equal(
    stripeEntitlementValidUntil("grace", new Date("2026-08-14T00:00:00Z"), undefined, new Date("2026-08-18T00:00:00Z"))?.toISOString(),
    "2026-08-18T00:00:00.000Z",
    "later past_due updates must not extend the first bounded grace deadline",
  );
  assert.equal(stripeEntitlementValidUntil("inactive", eventTime)?.toISOString(), eventTime.toISOString());
});
