import { and, eq, isNull, lt, or } from "drizzle-orm";
import { stripeEvents, users } from "@/db/schema";
import { jsonNoStore } from "@/lib/http";
import { checkoutBinding, paidInvoice, subscriptionInvoice, subscriptionUpdate } from "@/lib/stripe-events";
import { stripeEventMatchesMode } from "@/lib/stripe-config";
import { readLimitedText, verifyStripeSignature } from "@/lib/stripe-signature";
import { featureFlagsFromEnv, nearSleepProductionEnabled } from "@/lib/nearyou-foundation";

type StripeEvent = { id: string; type: string; created: number; livemode: boolean; data: { object: Record<string, unknown> } };

const BILLING_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

export async function POST(request: Request) {
  let payload: string;
  try { payload = await readLimitedText(request, 1_000_000); } catch (error) { if (error instanceof Response) return error; throw error; }
  const signature = request.headers.get("stripe-signature") || "";
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !(await verifyStripeSignature(payload, signature, secret))) return new Response("Invalid signature", { status: 400 });
  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!event.id || !event.type || !Number.isFinite(event.created) || typeof event.livemode !== "boolean" || !event.data?.object) return new Response("Invalid event", { status: 400 });
  if (!stripeEventMatchesMode(event.livemode, process.env.STRIPE_TEST_MODE_ONLY === "true")) return new Response("Live events are not accepted", { status: 400 });
  if (nearSleepProductionEnabled(featureFlagsFromEnv(process.env))) {
    const { handleProductionStripeEvent } = await import("./production");
    return handleProductionStripeEvent(event);
  }
  const expectedPriceId = process.env.STRIPE_PRICE_PLUS_MONTHLY || "";
  if (BILLING_EVENTS.has(event.type) && !/^price_[A-Za-z0-9]+$/.test(expectedPriceId)) return new Response("Billing is not configured", { status: 503 });
  const { getDb } = await import("@/db");
  const db = getDb();
  const claimed = await db.insert(stripeEvents).values({ id: event.id, type: event.type, processedAt: new Date() }).onConflictDoNothing().returning({ id: stripeEvents.id }).get();
  if (!claimed) return jsonNoStore({ received: true, duplicate: true });

  try {
    const object = event.data.object;
    if (event.type === "checkout.session.completed") {
      const binding = checkoutBinding(object, expectedPriceId);
      if (!binding) return jsonNoStore({ received: true, ignored: true });
      const updated = await db.update(users).set({ stripeCustomerId: binding.customerId, subscriptionId: binding.subscriptionId, checkoutPendingAt: null, updatedAt: new Date() })
        .where(eq(users.id, binding.userId)).returning({ id: users.id }).get();
      if (!updated) throw new Error("Checkout user was not found.");
    }
    if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
      const update = subscriptionUpdate(object, expectedPriceId);
      if (!update) return jsonNoStore({ received: true, ignored: true });
      const updated = await db.update(users).set({
        stripeCustomerId: update.customerId,
        subscriptionId: update.subscriptionId,
        subscriptionPriceId: update.priceId,
        subscriptionStatus: update.status,
        subscriptionEventCreatedAt: event.created,
        checkoutPendingAt: null,
        updatedAt: new Date(),
      }).where(and(eq(users.id, update.userId), or(isNull(users.subscriptionEventCreatedAt), lt(users.subscriptionEventCreatedAt, event.created))))
        .returning({ id: users.id }).get();
      if (!updated) {
        const knownUser = await db.select({ id: users.id }).from(users).where(eq(users.id, update.userId)).get();
        if (!knownUser) throw new Error("Subscription user was not found.");
      }
    }
    if (event.type === "invoice.paid") {
      const invoice = paidInvoice(object, expectedPriceId);
      if (!invoice) return jsonNoStore({ received: true, ignored: true });
      const updated = await db.update(users).set({ creditsRemaining: 12, lastCreditedInvoiceId: invoice.invoiceId, lastCreditedPeriodStart: invoice.periodStart, updatedAt: new Date() })
        .where(and(eq(users.stripeCustomerId, invoice.customerId), eq(users.subscriptionId, invoice.subscriptionId), eq(users.subscriptionPriceId, expectedPriceId), or(isNull(users.lastCreditedPeriodStart), lt(users.lastCreditedPeriodStart, invoice.periodStart))))
        .returning({ id: users.id }).get();
      if (!updated) {
        const knownSubscription = await db.select({ id: users.id }).from(users).where(and(eq(users.stripeCustomerId, invoice.customerId), eq(users.subscriptionId, invoice.subscriptionId), eq(users.subscriptionPriceId, expectedPriceId))).get();
        if (!knownSubscription) throw new Error("Invoice subscription was not found.");
      }
    }
    if (event.type === "invoice.payment_failed") {
      const invoice = subscriptionInvoice(object, expectedPriceId);
      if (!invoice) return jsonNoStore({ received: true, ignored: true });
      const updated = await db.update(users).set({ subscriptionStatus: "past_due", updatedAt: new Date() })
        .where(and(eq(users.stripeCustomerId, invoice.customerId), eq(users.subscriptionId, invoice.subscriptionId), eq(users.subscriptionPriceId, expectedPriceId), or(isNull(users.lastCreditedPeriodStart), lt(users.lastCreditedPeriodStart, invoice.periodStart)))).returning({ id: users.id }).get();
      if (!updated) {
        const knownSubscription = await db.select({ id: users.id }).from(users).where(and(eq(users.stripeCustomerId, invoice.customerId), eq(users.subscriptionId, invoice.subscriptionId), eq(users.subscriptionPriceId, expectedPriceId))).get();
        if (!knownSubscription) throw new Error("Failed invoice subscription was not found.");
      }
    }
  } catch (error) {
    await db.delete(stripeEvents).where(eq(stripeEvents.id, event.id));
    throw error;
  }
  return jsonNoStore({ received: true });
}
