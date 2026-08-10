import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { bestEffortEnsureUser } from "@/lib/data";
import { assertSameOrigin, jsonNoStore, publicAppOrigin } from "@/lib/http";
import { stripePost } from "@/lib/stripe";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireApiUser(request);
    const priceId = process.env.STRIPE_PRICE_PLUS_MONTHLY;
    if (!priceId) return jsonNoStore({ error: "The Plus plan is not configured yet." }, { status: 503 });
    await bestEffortEnsureUser(user);
    let customerId: string | null = null;
    try { customerId = (await getDb().select({ id: users.stripeCustomerId }).from(users).where(eq(users.id, user.userId)).get())?.id || null; } catch { /* local preview */ }
    const origin = publicAppOrigin(request);
    const session = await stripePost("/checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      customer: customerId || undefined,
      customer_email: customerId ? undefined : user.email,
      "client_reference_id": user.userId,
      "metadata[user_id]": user.userId,
      success_url: `${origin}/library?checkout=success`,
      cancel_url: `${origin}/pricing?checkout=canceled`,
      allow_promotion_codes: "true",
      "subscription_data[metadata][user_id]": user.userId,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL.");
    return Response.redirect(session.url, 303);
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: error instanceof Error ? error.message : "Checkout is unavailable." }, { status: 500 });
  }
}
