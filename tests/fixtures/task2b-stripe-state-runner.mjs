import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migrations = [
  "0000_nearnight_foundation.sql",
  "0001_google_apple_auth.sql",
  "0002_sharp_shinobi_shaw.sql",
  "0003_white_groot.sql",
  "0004_salty_sugar_man.sql",
  "0005_pronunciation_frequency_layers.sql",
  "0006_nearyou_shared_foundation.sql",
  "0007_nearsleep_production_upgrade.sql",
  "0008_nearsleep_live_integration.sql",
  "0009_nearsleep_audio_atomic.sql",
  "0010_child_profile_pronunciation.sql",
  "0011_household_billing_accounts.sql",
];

class D1Statement {
  constructor(database, source, control, parameters = []) {
    this.database = database;
    this.source = source;
    this.control = control;
    this.parameters = parameters;
  }

  bind(...parameters) { return new D1Statement(this.database, this.source, this.control, parameters); }

  execute() {
    if (this.control.failCompletedEventOnce
      && /^update\s+"stripe_events"\s+set/i.test(this.source)
      && this.parameters[0] === "completed") {
      this.control.failCompletedEventOnce = false;
      throw new Error("simulated_event_completion_write_loss");
    }
    const statement = this.database.prepare(this.source);
    const columns = statement.columns();
    if (columns.length) {
      const results = statement.all(...this.parameters);
      return { success: true, results, meta: { changes: this.database.prepare("SELECT changes() AS value").get().value } };
    }
    const result = statement.run(...this.parameters);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }

  async all() { return this.execute(); }
  async run() { return this.execute(); }
  async raw() {
    const result = this.execute();
    return result.results.map((row) => Object.values(row));
  }
}

class D1DatabaseFixture {
  constructor(database, control) { this.database = database; this.control = control; }
  prepare(source) { return new D1Statement(this.database, source, this.control); }
  async batch(statements) { return statements.map((statement) => statement.execute()); }
}

function applyMigrations(database) {
  for (const name of migrations) {
    const source = readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
  }
}

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
applyMigrations(database);
const control = { failCompletedEventOnce: false };
globalThis.__TASK2B_CLOUDFLARE_ENV__ = { DB: new D1DatabaseFixture(database, control) };

process.env.STRIPE_PRICE_NEARYOU_PLUS_MONTHLY = "price_plus_month";
process.env.STRIPE_TEST_MODE_ONLY = "true";

const { handleProductionStripeEvent } = await import("../../app/api/webhooks/stripe/production.ts");

const PRICE = "price_plus_month";
const PERIOD_START = 1_786_420_000;
const PERIOD_END = PERIOD_START + 30 * 24 * 60 * 60;

function event(id, type, created, object) {
  return { id, type, created, livemode: false, data: { object } };
}

function checkoutObject(ids) {
  return {
    id: ids.session,
    mode: "subscription",
    payment_status: "paid",
    client_reference_id: ids.user,
    customer: ids.customer,
    subscription: ids.subscription,
    metadata: {
      user_id: ids.user,
      household_id: ids.household,
      price_id: PRICE,
      checkout_operation_id: ids.operation,
    },
  };
}

function subscriptionObject(ids, status = "active") {
  return {
    id: ids.subscription,
    customer: ids.customer,
    status,
    current_period_end: PERIOD_END,
    metadata: {
      user_id: ids.user,
      household_id: ids.household,
      price_id: PRICE,
      checkout_operation_id: ids.operation,
    },
    items: { data: [{ price: { id: PRICE }, current_period_end: PERIOD_END }] },
  };
}

function invoiceObject(ids, invoiceId) {
  return {
    id: invoiceId,
    customer: ids.customer,
    subscription: ids.subscription,
    status: "paid",
    paid: true,
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    lines: { data: [{ price: { id: PRICE }, period: { start: PERIOD_START, end: PERIOD_END } }] },
  };
}

function seedOpenCheckout(suffix) {
  const ids = {
    user: `adult_${suffix}`,
    household: `household_${suffix}`,
    customer: `cus_${suffix}`,
    subscription: `sub_${suffix}`,
    operation: `checkout-op-${suffix}`,
    session: `cs_test_${suffix}`,
  };
  database.prepare("INSERT INTO users (id, email, subscription_status, credits_remaining, created_at, updated_at) VALUES (?, ?, 'free', 1, ?, ?)")
    .run(ids.user, `${ids.user}@example.test`, PERIOD_START * 1000, PERIOD_START * 1000);
  database.prepare("INSERT INTO households (id, name, owner_user_id, created_at, updated_at) VALUES (?, 'Home', ?, ?, ?)")
    .run(ids.household, ids.user, PERIOD_START * 1000, PERIOD_START * 1000);
  database.prepare("INSERT INTO household_members (id, household_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?)")
    .run(`member_${suffix}`, ids.household, ids.user, PERIOD_START * 1000, PERIOD_START * 1000);
  database.prepare("INSERT INTO entitlements (id, household_id, plan_id, source, status, allowance_milliunits, remaining_milliunits, valid_from, created_at, updated_at) VALUES (?, ?, 'nearsleep_free', 'manual', 'active', 1000, 1000, ?, ?, ?)")
    .run(`free_${suffix}`, ids.household, PERIOD_START * 1000, PERIOD_START * 1000, PERIOD_START * 1000);
  database.prepare("INSERT INTO household_billing_accounts (household_id, status, checkout_pending_at, checkout_operation_id, checkout_session_id, checkout_session_url, checkout_price_id, checkout_status, checkout_expires_at, created_at, updated_at) VALUES (?, 'free', ?, ?, ?, ?, ?, 'open', ?, ?, ?)")
    .run(ids.household, PERIOD_START * 1000, ids.operation, ids.session, `https://checkout.stripe.com/c/pay/${ids.session}`, PRICE, PERIOD_END * 1000, PERIOD_START * 1000, PERIOD_START * 1000);
  return ids;
}

async function deliver(stripeEvent, expectedStatus = 200) {
  const response = await handleProductionStripeEvent(stripeEvent);
  assert.equal(response.status, expectedStatus, `${stripeEvent.type}/${stripeEvent.id}: ${await response.text()}`);
  return response;
}

async function bindCheckout(ids, created) {
  await deliver(event(`evt_checkout_${ids.household}`, "checkout.session.completed", created, checkoutObject(ids)));
}

// subscription.created -> invoice.paid -> replay grants exactly one period.
{
  const ids = seedOpenCheckout("ordered");
  await bindCheckout(ids, PERIOD_START + 1);
  await deliver(event("evt_sub_ordered", "customer.subscription.created", PERIOD_START + 2, subscriptionObject(ids)));
  assert.equal(database.prepare("SELECT remaining_milliunits FROM entitlements WHERE external_ref = ?").get(ids.subscription).remaining_milliunits, 0);
  const invoice = event("evt_invoice_ordered", "invoice.paid", PERIOD_START + 3, invoiceObject(ids, "in_ordered"));
  await deliver(invoice);
  await deliver(invoice);
  assert.deepEqual({ ...database.prepare("SELECT remaining_milliunits, billing_period_start FROM entitlements WHERE external_ref = ?").get(ids.subscription) }, {
    remaining_milliunits: 60_000,
    billing_period_start: PERIOD_START,
  });
}

// invoice-before-subscription remains retryable, then converges when subscription state arrives.
{
  const ids = seedOpenCheckout("reordered");
  await bindCheckout(ids, PERIOD_START + 10);
  const invoice = event("evt_invoice_reordered", "invoice.paid", PERIOD_START + 12, invoiceObject(ids, "in_reordered"));
  await deliver(invoice, 500);
  assert.equal(database.prepare("SELECT status FROM stripe_events WHERE id = 'evt_invoice_reordered'").get().status, "failed");
  await deliver(event("evt_sub_reordered", "customer.subscription.created", PERIOD_START + 11, subscriptionObject(ids)));
  await deliver(invoice);
  assert.equal(database.prepare("SELECT remaining_milliunits FROM entitlements WHERE external_ref = ?").get(ids.subscription).remaining_milliunits, 60_000);
}

// A lost completion write after the financially material invoice grant cannot
// credit that same billing period twice.
{
  const ids = seedOpenCheckout("crash");
  await bindCheckout(ids, PERIOD_START + 20);
  const subscription = event("evt_sub_crash", "customer.subscription.created", PERIOD_START + 21, subscriptionObject(ids));
  await deliver(subscription);
  assert.equal(database.prepare("SELECT remaining_milliunits FROM entitlements WHERE external_ref = ?").get(ids.subscription).remaining_milliunits, 0);
  const invoice = event("evt_invoice_crash", "invoice.paid", PERIOD_START + 22, invoiceObject(ids, "in_crash"));
  control.failCompletedEventOnce = true;
  await deliver(invoice, 500);
  assert.equal(database.prepare("SELECT status FROM stripe_events WHERE id = 'evt_invoice_crash'").get().status, "failed");
  assert.equal(database.prepare("SELECT remaining_milliunits FROM entitlements WHERE external_ref = ?").get(ids.subscription).remaining_milliunits, 60_000);
  await deliver(invoice);
  await deliver(invoice);
  assert.equal(database.prepare("SELECT status FROM stripe_events WHERE id = 'evt_invoice_crash'").get().status, "completed");
  assert.equal(database.prepare("SELECT remaining_milliunits FROM entitlements WHERE external_ref = ?").get(ids.subscription).remaining_milliunits, 60_000);
}

// Cancel -> resubscribe supersedes history; delayed old Checkout/invoice events complete as ignored.
{
  const oldIds = seedOpenCheckout("lifecycle");
  await bindCheckout(oldIds, PERIOD_START + 30);
  await deliver(event("evt_sub_lifecycle_old", "customer.subscription.created", PERIOD_START + 31, subscriptionObject(oldIds)));
  await deliver(event("evt_invoice_lifecycle_old", "invoice.paid", PERIOD_START + 32, invoiceObject(oldIds, "in_lifecycle_old")));
  await deliver(event("evt_cancel_lifecycle_old", "customer.subscription.deleted", PERIOD_START + 40, subscriptionObject(oldIds, "canceled")));

  const newIds = { ...oldIds, subscription: "sub_lifecycle_new", operation: "checkout-op-lifecycle-new", session: "cs_test_lifecyclenew" };
  database.prepare("UPDATE household_billing_accounts SET checkout_pending_at = ?, checkout_operation_id = ?, checkout_session_id = ?, checkout_session_url = ?, checkout_price_id = ?, checkout_status = 'open', checkout_expires_at = ?, updated_at = ? WHERE household_id = ?")
    .run((PERIOD_START + 41) * 1000, newIds.operation, newIds.session, `https://checkout.stripe.com/c/pay/${newIds.session}`, PRICE, PERIOD_END * 1000, (PERIOD_START + 41) * 1000, newIds.household);
  await deliver(event("evt_checkout_lifecycle_new", "checkout.session.completed", PERIOD_START + 42, checkoutObject(newIds)));
  await deliver(event("evt_sub_lifecycle_new", "customer.subscription.created", PERIOD_START + 43, subscriptionObject(newIds)));
  await deliver(event("evt_invoice_lifecycle_new", "invoice.paid", PERIOD_START + 44, invoiceObject(newIds, "in_lifecycle_new")));

  await deliver(event("evt_checkout_lifecycle_old_late", "checkout.session.completed", PERIOD_START + 45, checkoutObject(oldIds)));
  await deliver(event("evt_invoice_lifecycle_old_late", "invoice.paid", PERIOD_START + 46, invoiceObject(oldIds, "in_lifecycle_old_late")));
  assert.deepEqual({ ...database.prepare("SELECT subscription_id, status FROM household_billing_accounts WHERE household_id = ?").get(newIds.household) }, {
    subscription_id: newIds.subscription,
    status: "active",
  });
  assert.equal(database.prepare("SELECT superseded_at IS NOT NULL AS value FROM household_billing_subscriptions WHERE subscription_id = ?").get(oldIds.subscription).value, 1);
  assert.equal(database.prepare("SELECT status FROM entitlements WHERE external_ref = ?").get(oldIds.subscription).status, "revoked");
  assert.equal(database.prepare("SELECT remaining_milliunits FROM entitlements WHERE external_ref = ?").get(newIds.subscription).remaining_milliunits, 60_000);
}
