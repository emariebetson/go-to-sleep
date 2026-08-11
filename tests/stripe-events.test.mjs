import assert from "node:assert/strict";
import test from "node:test";
import { checkoutBinding, isEntitledSubscriptionStatus, isExistingSubscriptionStatus, paidInvoice, subscriptionInvoice, subscriptionUpdate } from "../lib/stripe-events.ts";

const expectedPrice = "price_nearnight_test";

test("checkout binding requires a paid subscription session", () => {
  const valid = { mode: "subscription", payment_status: "paid", client_reference_id: "user_1", customer: "cus_1", subscription: "sub_1", metadata: { price_id: expectedPrice } };
  assert.deepEqual(checkoutBinding(valid, expectedPrice), { userId: "user_1", customerId: "cus_1", subscriptionId: "sub_1" });
  assert.equal(checkoutBinding(valid, "price_wrong"), null);
  assert.equal(checkoutBinding({ ...valid, mode: "payment" }, expectedPrice), null);
  assert.equal(checkoutBinding({ ...valid, payment_status: "unpaid" }, expectedPrice), null);
  assert.equal(checkoutBinding({ ...valid, subscription: "" }, expectedPrice), null);
});

test("subscription updates require the expected server-owned price", () => {
  const subscription = {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    metadata: { user_id: "user_1" },
    items: { data: [{ price: { id: expectedPrice } }] },
  };
  assert.equal(subscriptionUpdate(subscription, expectedPrice)?.priceId, expectedPrice);
  assert.equal(subscriptionUpdate(subscription, "price_wrong"), null);
  assert.equal(subscriptionUpdate({ ...subscription, metadata: {} }, expectedPrice), null);
});

test("paid invoices require the expected subscription price and billing period", () => {
  const legacyInvoice = {
    id: "in_1", customer: "cus_1", subscription: "sub_1", status: "paid", paid: true, period_start: 1_786_000_000,
    lines: { data: [{ price: { id: expectedPrice }, period: { start: 1_786_000_000 } }] },
  };
  assert.deepEqual(paidInvoice(legacyInvoice, expectedPrice), { invoiceId: "in_1", customerId: "cus_1", subscriptionId: "sub_1", periodStart: 1_786_000_000 });
  assert.equal(paidInvoice(legacyInvoice, "price_wrong"), null);
  assert.equal(paidInvoice({ ...legacyInvoice, status: "open", paid: false }, expectedPrice), null);

  const currentInvoice = {
    id: "in_2", customer: "cus_1", status: "open", period_start: 1_787_000_000,
    parent: { subscription_details: { subscription: "sub_1" } },
    lines: { data: [{ pricing: { price_details: { price: expectedPrice } }, period: { start: 1_787_000_000 } }] },
  };
  assert.equal(subscriptionInvoice(currentInvoice, expectedPrice)?.subscriptionId, "sub_1");
});

test("subscription status helpers distinguish entitlements from portal access", () => {
  assert.equal(isEntitledSubscriptionStatus("active"), true);
  assert.equal(isEntitledSubscriptionStatus("trialing"), true);
  assert.equal(isEntitledSubscriptionStatus("past_due"), false);
  assert.equal(isExistingSubscriptionStatus("past_due"), true);
  assert.equal(isExistingSubscriptionStatus("canceled"), false);
});
