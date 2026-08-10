import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { stripeEvents, users } from "@/db/schema";
import { jsonNoStore } from "@/lib/http";
import { verifyStripeSignature } from "@/lib/stripe";

type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") || "0") > 1_000_000) return new Response("Payload too large", { status: 413 });
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") || "";
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !(await verifyStripeSignature(payload, signature, secret))) return new Response("Invalid signature", { status: 400 });
  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!event.id || !event.type || !event.data?.object) return new Response("Invalid event", { status: 400 });
  const db = getDb();
  const claimed = await db.insert(stripeEvents).values({ id: event.id, type: event.type, processedAt: new Date() }).onConflictDoNothing().returning({ id: stripeEvents.id }).get();
  if (!claimed) return jsonNoStore({ received: true, duplicate: true });

  try {
    const object = event.data.object;
    if (event.type === "checkout.session.completed") {
      const userId = String(object.client_reference_id || (object.metadata as Record<string, string> | undefined)?.user_id || "");
      if (userId) await db.update(users).set({ stripeCustomerId: String(object.customer || ""), subscriptionId: String(object.subscription || ""), subscriptionStatus: "active", creditsRemaining: 12, updatedAt: new Date() }).where(eq(users.id, userId));
    }
    if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
      const customerId = String(object.customer || "");
      const status = String(object.status || "canceled");
      if (customerId) await db.update(users).set({ subscriptionId: String(object.id || ""), subscriptionStatus: status, updatedAt: new Date() }).where(eq(users.stripeCustomerId, customerId));
    }
    if (event.type === "invoice.paid") {
      const customerId = String(object.customer || "");
      if (customerId) await db.update(users).set({ subscriptionStatus: "active", creditsRemaining: 12, updatedAt: new Date() }).where(eq(users.stripeCustomerId, customerId));
    }
    if (event.type === "invoice.payment_failed") {
      const customerId = String(object.customer || "");
      if (customerId) await db.update(users).set({ subscriptionStatus: "past_due", updatedAt: new Date() }).where(eq(users.stripeCustomerId, customerId));
    }
  } catch (error) {
    await db.delete(stripeEvents).where(eq(stripeEvents.id, event.id));
    throw error;
  }
  return jsonNoStore({ received: true });
}
