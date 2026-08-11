import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { entitlements, householdBillingAccounts, householdBillingSubscriptions, households, stripeEvents } from "@/db/schema";
import { jsonNoStore } from "@/lib/http";
import { PLAN_CATALOG } from "@/lib/nearyou-foundation";
import { configuredStripePrices, stripeEntitlementStatus, stripeEntitlementValidUntil, stripeInvoiceOrderingDecision, type StripePriceBinding } from "@/lib/stripe-entitlements";
import { checkoutBinding, expiredCheckoutBinding, paidInvoice, subscriptionInvoice, subscriptionUpdate, type SubscriptionUpdate } from "@/lib/stripe-events";
import { stripeGet } from "@/lib/stripe";

export type ProductionStripeEvent = {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
};

const STALE_EVENT_CLAIM_MS = 5 * 60_000;
const GRACE_SECONDS = 7 * 24 * 60 * 60;

function boundedErrorCode(error: unknown) {
  return (error instanceof Error ? error.message : "stripe_event_failed").replace(/[^a-zA-Z0-9_:-]+/g, "_").slice(0, 120) || "stripe_event_failed";
}

function supportedLivePrice(price: StripePriceBinding, existingGrandfathered: boolean) {
  if (price.interval !== "month" || price.planId === "nearlegacy") return false;
  return !price.grandfathered || existingGrandfathered;
}

async function claimEvent(event: ProductionStripeEvent) {
  const db = getDb();
  const now = new Date();
  const attemptToken = crypto.randomUUID();
  const inserted = await db.insert(stripeEvents).values({
    id: event.id,
    type: event.type,
    eventCreatedAt: event.created,
    status: "processing",
    attemptToken,
    processedAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning({ id: stripeEvents.id }).get();
  if (inserted) return { kind: "claimed" as const, attemptToken };
  const existing = await db.select().from(stripeEvents).where(eq(stripeEvents.id, event.id)).get();
  if (!existing || existing.type !== event.type || existing.eventCreatedAt !== event.created) return { kind: "conflict" as const };
  if (existing.status === "completed") return { kind: "completed" as const };
  const reclaimed = await db.update(stripeEvents).set({ status: "processing", attemptToken, errorCode: null, updatedAt: now }).where(and(
    eq(stripeEvents.id, event.id),
    or(
      eq(stripeEvents.status, "failed"),
      and(eq(stripeEvents.status, "processing"), lt(stripeEvents.updatedAt, new Date(now.getTime() - STALE_EVENT_CLAIM_MS))),
    ),
  )).returning({ id: stripeEvents.id }).get();
  return reclaimed ? { kind: "claimed" as const, attemptToken } : { kind: "processing" as const };
}

async function completeEvent(eventId: string, attemptToken: string) {
  const completed = await getDb().update(stripeEvents).set({ status: "completed", errorCode: null, updatedAt: new Date() })
    .where(and(eq(stripeEvents.id, eventId), eq(stripeEvents.status, "processing"), eq(stripeEvents.attemptToken, attemptToken))).returning({ id: stripeEvents.id }).get();
  if (!completed) throw new Error("stripe_event_complete_conflict");
}

async function failEvent(eventId: string, attemptToken: string, error: unknown) {
  await getDb().update(stripeEvents).set({ status: "failed", errorCode: boundedErrorCode(error), updatedAt: new Date() })
    .where(and(eq(stripeEvents.id, eventId), eq(stripeEvents.status, "processing"), eq(stripeEvents.attemptToken, attemptToken)));
}

async function initialHouseholdBinding(userId: string, requestedHouseholdId?: string) {
  if (!requestedHouseholdId) throw new Error("stripe_household_binding_missing");
  const household = await getDb().select({ id: households.id }).from(households).where(and(
    eq(households.id, requestedHouseholdId),
    eq(households.ownerUserId, userId),
  )).get();
  if (!household) throw new Error("stripe_household_binding_invalid");
  return household.id;
}

async function billingBySubscription(subscriptionId: string) {
  return getDb().select().from(householdBillingAccounts).where(eq(householdBillingAccounts.subscriptionId, subscriptionId)).get();
}

async function historicalSubscription(subscriptionId: string) {
  return getDb().select().from(householdBillingSubscriptions).where(eq(householdBillingSubscriptions.subscriptionId, subscriptionId)).get();
}

async function entitlementForSubscription(householdId: string, subscriptionId: string) {
  return getDb().select().from(entitlements).where(and(
    eq(entitlements.householdId, householdId),
    eq(entitlements.externalRef, subscriptionId),
  )).get();
}

async function ensureBillingBinding(update: SubscriptionUpdate) {
  const existing = await billingBySubscription(update.subscriptionId);
  if (existing) {
    if (existing.customerId && existing.customerId !== update.customerId) throw new Error("stripe_subscription_customer_conflict");
    const now = new Date();
    await getDb().insert(householdBillingSubscriptions).values({
      subscriptionId: update.subscriptionId,
      householdId: existing.householdId,
      customerId: update.customerId,
      priceId: update.priceId,
      status: update.status,
      eventCreatedAt: existing.subscriptionEventCreatedAt,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    return existing;
  }
  const historical = await historicalSubscription(update.subscriptionId);
  if (historical) return null;
  const householdId = await initialHouseholdBinding(update.userId, update.householdId);
  const now = new Date();
  await getDb().insert(householdBillingAccounts).values({
    householdId,
    status: "free",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  const unbound = await getDb().select().from(householdBillingAccounts).where(eq(householdBillingAccounts.householdId, householdId)).get();
  if (!unbound) throw new Error("stripe_household_binding_missing");
  if (unbound.subscriptionId && unbound.subscriptionId !== update.subscriptionId) {
    const terminal = ["canceled", "incomplete_expired", "unpaid"].includes(unbound.status);
    const expectedCheckout = update.operationId && update.operationId === unbound.checkoutOperationId
      && ["creating", "open", "completed"].includes(unbound.checkoutStatus || "");
    if (!terminal || !expectedCheckout) return null;
    await getDb().update(householdBillingSubscriptions).set({ supersededAt: now, updatedAt: now })
      .where(eq(householdBillingSubscriptions.subscriptionId, unbound.subscriptionId));
  }
  if (unbound.subscriptionId !== update.subscriptionId) {
    const bound = await getDb().update(householdBillingAccounts).set({
      customerId: update.customerId,
      subscriptionId: update.subscriptionId,
      updatedAt: now,
    }).where(and(
      eq(householdBillingAccounts.householdId, householdId),
      or(isNull(householdBillingAccounts.subscriptionId), inArray(householdBillingAccounts.status, ["canceled", "incomplete_expired", "unpaid"])),
    )).returning().get();
    if (!bound) return null;
  }
  await getDb().insert(householdBillingSubscriptions).values({
    subscriptionId: update.subscriptionId,
    householdId,
    customerId: update.customerId,
    priceId: update.priceId,
    status: update.status,
    eventCreatedAt: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  return billingBySubscription(update.subscriptionId);
}

function exactBillingState(binding: typeof householdBillingAccounts.$inferSelect, update: SubscriptionUpdate, eventCreated: number) {
  return binding.subscriptionId === update.subscriptionId
    && binding.customerId === update.customerId
    && binding.priceId === update.priceId
    && binding.status === update.status
    && binding.subscriptionEventCreatedAt === eventCreated;
}

async function authoritativeSubscription(update: SubscriptionUpdate, priceIds: string[]) {
  const object = await stripeGet(`/subscriptions/${encodeURIComponent(update.subscriptionId)}`);
  const parsed = subscriptionUpdate(object, priceIds);
  if (!parsed || parsed.subscriptionId !== update.subscriptionId) throw new Error("stripe_subscription_authoritative_mismatch");
  return parsed;
}

async function syncSubscription(event: ProductionStripeEvent, original: SubscriptionUpdate, prices: Map<string, StripePriceBinding>) {
  let update = original;
  let binding = await ensureBillingBinding(update);
  if (!binding) return;
  if (binding.subscriptionEventCreatedAt !== null && binding.subscriptionEventCreatedAt > event.created) return;
  let authoritative = false;
  if (binding.subscriptionEventCreatedAt === event.created && !exactBillingState(binding, update, event.created)) {
    update = await authoritativeSubscription(update, [...prices.keys()]);
    authoritative = true;
    binding = await ensureBillingBinding(update);
    if (!binding) return;
  }
  const price = prices.get(update.priceId);
  if (!price) return;
  const currentEntitlement = await entitlementForSubscription(binding.householdId, update.subscriptionId);
  const existingGrandfathered = currentEntitlement?.planId === "nearsleep_plus_legacy";
  if (!supportedLivePrice(price, existingGrandfathered)) return;
  const deleted = event.type === "customer.subscription.deleted";
  const status = stripeEntitlementStatus(update.status, deleted);
  if (status === "active" && !update.periodEnd) throw new Error("stripe_subscription_period_end_missing");
  const eventTime = new Date(event.created * 1000);
  const validUntil = stripeEntitlementValidUntil(
    status,
    eventTime,
    update.periodEnd,
    currentEntitlement?.status === "grace" ? currentEntitlement.validUntil : null,
  );
  const shouldWriteBilling = binding.subscriptionEventCreatedAt === null
    || binding.subscriptionEventCreatedAt < event.created
    || authoritative;
  if (shouldWriteBilling) {
    const updated = await getDb().update(householdBillingAccounts).set({
      customerId: update.customerId,
      subscriptionId: update.subscriptionId,
      priceId: update.priceId,
      status: update.status,
      subscriptionEventCreatedAt: event.created,
      checkoutPendingAt: null,
      updatedAt: eventTime,
    }).where(and(
      eq(householdBillingAccounts.householdId, binding.householdId),
      authoritative
        ? eq(householdBillingAccounts.subscriptionEventCreatedAt, event.created)
        : or(isNull(householdBillingAccounts.subscriptionEventCreatedAt), lt(householdBillingAccounts.subscriptionEventCreatedAt, event.created)),
    )).returning({ householdId: householdBillingAccounts.householdId }).get();
    if (!updated) throw new Error("stripe_billing_state_race");
  }
  await getDb().update(householdBillingSubscriptions).set({
    customerId: update.customerId,
    priceId: update.priceId,
    status: update.status,
    eventCreatedAt: event.created,
    updatedAt: eventTime,
  }).where(and(
    eq(householdBillingSubscriptions.subscriptionId, update.subscriptionId),
    eq(householdBillingSubscriptions.householdId, binding.householdId),
    or(isNull(householdBillingSubscriptions.eventCreatedAt), lte(householdBillingSubscriptions.eventCreatedAt, event.created)),
  ));

  const allowance = PLAN_CATALOG[price.planId].monthlyAllowanceMilliunits;
  if (currentEntitlement) {
    await getDb().update(entitlements).set({
      planId: price.planId,
      status,
      allowanceMilliunits: allowance,
      remainingMilliunits: Math.min(currentEntitlement.remainingMilliunits, allowance * 2),
      validUntil,
      updatedAt: eventTime,
    }).where(and(eq(entitlements.id, currentEntitlement.id), eq(entitlements.householdId, binding.householdId)));
  } else {
    await getDb().insert(entitlements).values({
      id: `entitlement:stripe:${update.subscriptionId}`,
      householdId: binding.householdId,
      planId: price.planId,
      source: "stripe",
      status,
      allowanceMilliunits: allowance,
      // Subscription events establish access and capacity, but never grant the
      // paid period twice. The matching invoice.paid is the sole allowance
      // grant, fenced by billingPeriodStart.
      remainingMilliunits: 0,
      externalRef: update.subscriptionId,
      validFrom: eventTime,
      validUntil,
      createdAt: eventTime,
      updatedAt: eventTime,
    }).onConflictDoNothing();
    const inserted = await entitlementForSubscription(binding.householdId, update.subscriptionId);
    if (!inserted) throw new Error("stripe_entitlement_sync_failed");
  }
}

async function processCheckout(event: ProductionStripeEvent, prices: Map<string, StripePriceBinding>) {
  const checkout = checkoutBinding(event.data.object, [...prices.keys()]);
  if (!checkout) return;
  const price = prices.get(checkout.priceId);
  if (!price || price.interval !== "month" || price.grandfathered || price.planId === "nearlegacy") return;
  const householdId = await initialHouseholdBinding(checkout.userId, checkout.householdId);
  const now = new Date(event.created * 1000);
  await getDb().insert(householdBillingAccounts).values({ householdId, status: "free", createdAt: now, updatedAt: now }).onConflictDoNothing();
  const before = await getDb().select().from(householdBillingAccounts).where(eq(householdBillingAccounts.householdId, householdId)).get();
  const updated = await getDb().update(householdBillingAccounts).set({
    customerId: checkout.customerId,
    subscriptionId: checkout.subscriptionId,
    checkoutPendingAt: null,
    checkoutSessionId: checkout.sessionId,
    checkoutStatus: "completed",
    updatedAt: now,
  }).where(and(
    eq(householdBillingAccounts.householdId, householdId),
    eq(householdBillingAccounts.checkoutOperationId, checkout.operationId),
    or(isNull(householdBillingAccounts.checkoutSessionId), eq(householdBillingAccounts.checkoutSessionId, checkout.sessionId)),
    inArray(householdBillingAccounts.checkoutStatus, ["creating", "open", "completed"]),
    or(
      isNull(householdBillingAccounts.subscriptionId),
      eq(householdBillingAccounts.subscriptionId, checkout.subscriptionId),
      inArray(householdBillingAccounts.status, ["canceled", "incomplete_expired", "unpaid"]),
    ),
  )).returning({ householdId: householdBillingAccounts.householdId }).get();
  if (!updated) {
    const current = await getDb().select().from(householdBillingAccounts).where(eq(householdBillingAccounts.householdId, householdId)).get();
    if (current?.subscriptionId !== checkout.subscriptionId) {
      const historical = await historicalSubscription(checkout.subscriptionId);
      if (historical
        && historical.householdId === householdId
        && historical.customerId === checkout.customerId
        && historical.priceId === checkout.priceId
        && historical.supersededAt) return;
      throw new Error("stripe_checkout_binding_conflict");
    }
  }
  await getDb().insert(householdBillingSubscriptions).values({
    subscriptionId: checkout.subscriptionId,
    householdId,
    customerId: checkout.customerId,
    priceId: checkout.priceId,
    status: "checkout_completed",
    eventCreatedAt: event.created,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: householdBillingSubscriptions.subscriptionId,
    set: { customerId: checkout.customerId, priceId: checkout.priceId, updatedAt: now },
  });
  if (before?.subscriptionId && before.subscriptionId !== checkout.subscriptionId) {
    await getDb().update(householdBillingSubscriptions).set({ supersededAt: now, updatedAt: now })
      .where(eq(householdBillingSubscriptions.subscriptionId, before.subscriptionId));
    await getDb().update(entitlements).set({ status: "revoked", validUntil: now, updatedAt: now }).where(and(
      eq(entitlements.householdId, householdId),
      eq(entitlements.source, "stripe"),
      eq(entitlements.externalRef, before.subscriptionId),
    ));
  }
}

async function processExpiredCheckout(event: ProductionStripeEvent) {
  const checkout = expiredCheckoutBinding(event.data.object);
  if (!checkout) return;
  await getDb().update(householdBillingAccounts).set({
    checkoutStatus: "expired",
    checkoutPendingAt: null,
    updatedAt: new Date(event.created * 1000),
  }).where(and(
    eq(householdBillingAccounts.householdId, checkout.householdId),
    eq(householdBillingAccounts.checkoutOperationId, checkout.operationId),
    eq(householdBillingAccounts.checkoutSessionId, checkout.sessionId),
    inArray(householdBillingAccounts.checkoutStatus, ["creating", "open"]),
    isNull(householdBillingAccounts.subscriptionId),
  ));
}

async function invoiceStatusAllows(
  event: ProductionStripeEvent,
  binding: typeof householdBillingAccounts.$inferSelect,
  expectedStatuses: readonly string[],
  prices: Map<string, StripePriceBinding>,
) {
  const decision = stripeInvoiceOrderingDecision(binding.subscriptionEventCreatedAt, binding.status, event.created, expectedStatuses);
  if (decision === "apply") return true;
  if (decision === "ignore") return false;
  if (decision === "retry") throw new Error("stripe_invoice_waiting_for_subscription_state");
  if (!binding.subscriptionId) return false;
  const object = await stripeGet(`/subscriptions/${encodeURIComponent(binding.subscriptionId)}`);
  const authoritative = subscriptionUpdate(object, [...prices.keys()]);
  if (!authoritative || authoritative.subscriptionId !== binding.subscriptionId || authoritative.customerId !== binding.customerId) {
    throw new Error("stripe_invoice_authoritative_subscription_mismatch");
  }
  return expectedStatuses.includes(authoritative.status);
}

async function processPaidInvoice(event: ProductionStripeEvent, prices: Map<string, StripePriceBinding>) {
  const invoice = paidInvoice(event.data.object, [...prices.keys()]);
  if (!invoice) return;
  if (!invoice.periodEnd || invoice.periodEnd <= invoice.periodStart) throw new Error("stripe_invoice_period_invalid");
  const binding = await billingBySubscription(invoice.subscriptionId);
  if (!binding) {
    if (await historicalSubscription(invoice.subscriptionId)) return;
    throw new Error("stripe_invoice_binding_missing");
  }
  if (binding.customerId !== invoice.customerId || binding.priceId !== invoice.priceId) throw new Error("stripe_invoice_binding_missing");
  if (!await invoiceStatusAllows(event, binding, ["active", "trialing"], prices)) return;
  const price = prices.get(invoice.priceId);
  if (!price) return;
  const currentEntitlement = await entitlementForSubscription(binding.householdId, invoice.subscriptionId);
  if (!supportedLivePrice(price, currentEntitlement?.planId === "nearsleep_plus_legacy")) return;
  if (!currentEntitlement) throw new Error("stripe_invoice_entitlement_missing");
  const allowance = price.allowanceMilliunits;
  const eventTime = new Date(event.created * 1000);
  const periodStart = new Date(invoice.periodStart * 1000);
  const periodEnd = new Date(invoice.periodEnd * 1000);
  await getDb().update(entitlements).set({
    status: "active",
    allowanceMilliunits: allowance,
    remainingMilliunits: sql`MIN(${allowance * 2}, ${entitlements.remainingMilliunits} + ${allowance})`,
    billingPeriodStart: invoice.periodStart,
    validFrom: periodStart,
    validUntil: periodEnd,
    updatedAt: eventTime,
  }).where(and(
    eq(entitlements.id, currentEntitlement.id),
    or(isNull(entitlements.billingPeriodStart), lt(entitlements.billingPeriodStart, invoice.periodStart)),
  ));
  await getDb().update(householdBillingAccounts).set({
    status: "active",
    subscriptionEventCreatedAt: sql`MAX(COALESCE(${householdBillingAccounts.subscriptionEventCreatedAt}, 0), ${event.created})`,
    lastCreditedInvoiceId: invoice.invoiceId,
    lastCreditedPeriodStart: invoice.periodStart,
    updatedAt: eventTime,
  }).where(and(
    eq(householdBillingAccounts.householdId, binding.householdId),
    or(isNull(householdBillingAccounts.lastCreditedPeriodStart), lte(householdBillingAccounts.lastCreditedPeriodStart, invoice.periodStart)),
  ));
}

async function processFailedInvoice(event: ProductionStripeEvent, prices: Map<string, StripePriceBinding>) {
  const invoice = subscriptionInvoice(event.data.object, [...prices.keys()]);
  if (!invoice) return;
  const binding = await billingBySubscription(invoice.subscriptionId);
  if (!binding) {
    if (await historicalSubscription(invoice.subscriptionId)) return;
    throw new Error("stripe_invoice_binding_missing");
  }
  if (binding.customerId !== invoice.customerId || binding.priceId !== invoice.priceId) throw new Error("stripe_invoice_binding_missing");
  if (!await invoiceStatusAllows(event, binding, ["past_due"], prices)) return;
  const price = prices.get(invoice.priceId);
  const currentEntitlement = await entitlementForSubscription(binding.householdId, invoice.subscriptionId);
  if (!price || !supportedLivePrice(price, currentEntitlement?.planId === "nearsleep_plus_legacy") || !currentEntitlement) return;
  const eventTime = new Date(event.created * 1000);
  const graceUntil = new Date((invoice.periodStart + GRACE_SECONDS) * 1000);
  await getDb().update(householdBillingAccounts).set({
    status: "past_due",
    subscriptionEventCreatedAt: event.created,
    updatedAt: eventTime,
  }).where(and(
    eq(householdBillingAccounts.householdId, binding.householdId),
    or(isNull(householdBillingAccounts.subscriptionEventCreatedAt), lt(householdBillingAccounts.subscriptionEventCreatedAt, event.created)),
  ));
  await getDb().update(entitlements).set({ status: "grace", validUntil: graceUntil, updatedAt: eventTime }).where(and(
    eq(entitlements.id, currentEntitlement.id),
    or(isNull(entitlements.billingPeriodStart), lte(entitlements.billingPeriodStart, invoice.periodStart)),
    lt(entitlements.updatedAt, eventTime),
  ));
}

async function processEvent(event: ProductionStripeEvent, prices: Map<string, StripePriceBinding>) {
  if (event.type === "checkout.session.completed") return processCheckout(event, prices);
  if (event.type === "checkout.session.expired") return processExpiredCheckout(event);
  if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    const update = subscriptionUpdate(event.data.object, [...prices.keys()]);
    if (update) await syncSubscription(event, update, prices);
    return;
  }
  if (event.type === "invoice.paid") return processPaidInvoice(event, prices);
  if (event.type === "invoice.payment_failed") return processFailedInvoice(event, prices);
}

export async function handleProductionStripeEvent(event: ProductionStripeEvent) {
  let prices: Map<string, StripePriceBinding>;
  try { prices = configuredStripePrices(process.env); } catch (error) {
    console.error("Stripe price configuration is invalid", error);
    return new Response("Billing is not configured", { status: 503 });
  }
  if (!prices.size) return new Response("Billing is not configured", { status: 503 });
  const claim = await claimEvent(event);
  if (claim.kind === "conflict") return new Response("Conflicting event", { status: 409 });
  if (claim.kind === "completed") return jsonNoStore({ received: true, duplicate: true });
  // Stripe retries 5xx. Never acknowledge a concurrently processing claim until
  // the durable event state is completed.
  if (claim.kind === "processing") return jsonNoStore({ error: "Stripe event is already processing." }, { status: 503 });
  try {
    await processEvent(event, prices);
    await completeEvent(event.id, claim.attemptToken);
    return jsonNoStore({ received: true });
  } catch (error) {
    await failEvent(event.id, claim.attemptToken, error).catch((stateError) => console.error("Stripe event failure state could not be saved", event.id, stateError));
    console.error("Stripe event processing failed", event.id, error);
    return jsonNoStore({ error: "Stripe event could not be processed." }, { status: 500 });
  }
}
