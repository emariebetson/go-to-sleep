import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdBillingAccounts } from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, publicAppOrigin } from "@/lib/http";
import { stripePost, validateStripePortalResponse } from "@/lib/stripe";

export async function postProductionPortal(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    const { householdId } = await requireHouseholdContext(request, "household:write");
    const billing = await getDb().select({ customerId: householdBillingAccounts.customerId }).from(householdBillingAccounts)
      .where(eq(householdBillingAccounts.householdId, householdId)).get();
    if (!billing?.customerId) return jsonNoStore({ error: "No Stripe subscription was found for this household." }, { status: 404 });
    const session = await stripePost("/billing_portal/sessions", { customer: billing.customerId, return_url: `${publicAppOrigin(request)}/account` });
    return Response.redirect(validateStripePortalResponse(session), 303);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("NearYou Stripe portal failed", error);
    return jsonNoStore({ error: "Billing management is unavailable right now. Please try again later." }, { status: 502 });
  }
}
