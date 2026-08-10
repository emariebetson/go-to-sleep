import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { assertSameOrigin, jsonNoStore, publicAppOrigin } from "@/lib/http";
import { stripePost } from "@/lib/stripe";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireApiUser();
    const record = await getDb().select({ customerId: users.stripeCustomerId }).from(users).where(eq(users.id, user.userId)).get();
    if (!record?.customerId) return jsonNoStore({ error: "No Stripe subscription was found." }, { status: 404 });
    const session = await stripePost("/billing_portal/sessions", { customer: record.customerId, return_url: `${publicAppOrigin(request)}/account` });
    if (!session.url) throw new Error("Stripe did not return a portal URL.");
    return Response.redirect(session.url, 303);
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: error instanceof Error ? error.message : "Billing is unavailable." }, { status: 500 });
  }
}
