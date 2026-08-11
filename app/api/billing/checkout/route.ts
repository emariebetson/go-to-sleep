import { and, eq, isNull, lt, or } from "drizzle-orm";
import { users } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { bestEffortEnsureUser } from "@/lib/data";
import { assertSameOrigin, jsonNoStore, publicAppOrigin } from "@/lib/http";
import { stripePost } from "@/lib/stripe";
import { isExistingSubscriptionStatus } from "@/lib/stripe-events";
import { featureFlagsFromEnv, nearSleepProductionEnabled } from "@/lib/nearyou-foundation";

export async function POST(request: Request) {
  if (nearSleepProductionEnabled(featureFlagsFromEnv(process.env))) {
    const { postProductionCheckout } = await import("./production");
    return postProductionCheckout(request);
  }
  try {
    assertSameOrigin(request);
    const user = await requireApiUser(request);
    const priceId = process.env.STRIPE_PRICE_PLUS_MONTHLY;
    if (!priceId || !/^price_[A-Za-z0-9]+$/.test(priceId)) return jsonNoStore({ error: "The Plus plan is not configured yet." }, { status: 503 });
    await bestEffortEnsureUser(user);
    const { getDb } = await import("@/db");
    const db = getDb();
    const account = await db.select({ customerId: users.stripeCustomerId, subscriptionId: users.subscriptionId, status: users.subscriptionStatus })
      .from(users).where(eq(users.id, user.userId)).get();
    if (account?.subscriptionId && isExistingSubscriptionStatus(account.status)) {
      return jsonNoStore({ error: "This account already has a subscription. Manage it from Voice & account." }, { status: 409 });
    }
    const now = new Date();
    const pendingCutoff = new Date(now.getTime() - 15 * 60 * 1000);
    const claimed = await db.update(users).set({ checkoutPendingAt: now, updatedAt: now })
      .where(and(eq(users.id, user.userId), or(isNull(users.checkoutPendingAt), lt(users.checkoutPendingAt, pendingCutoff))))
      .returning({ id: users.id }).get();
    if (!claimed) return jsonNoStore({ error: "A checkout is already open. Use that tab or wait a few minutes before trying again." }, { status: 429 });
    const origin = publicAppOrigin(request);
    try {
      const session = await stripePost("/checkout/sessions", {
        mode: "subscription",
        integration_identifier: "nearnight_checkout_qmtxrvka",
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        customer: account?.customerId || undefined,
        customer_email: account?.customerId ? undefined : user.email,
        "client_reference_id": user.userId,
        "metadata[user_id]": user.userId,
        "metadata[price_id]": priceId,
        success_url: `${origin}/library?checkout=success`,
        cancel_url: `${origin}/pricing?checkout=canceled`,
        allow_promotion_codes: "true",
        "subscription_data[metadata][user_id]": user.userId,
        "subscription_data[metadata][price_id]": priceId,
      }, { idempotencyKey: `checkout-${user.userId}-${Math.floor(now.getTime() / (15 * 60 * 1000))}` });
      if (!session.url) throw new Error("Stripe did not return a checkout URL.");
      return Response.redirect(session.url, 303);
    } catch (error) {
      await db.update(users).set({ checkoutPendingAt: null, updatedAt: new Date() }).where(eq(users.id, user.userId));
      throw error;
    }
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Stripe checkout failed", error);
    return jsonNoStore({ error: "Checkout is unavailable right now. Please try again later." }, { status: 502 });
  }
}
