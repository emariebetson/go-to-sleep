import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { nearFamilySourceActivated } from "@/lib/nearfamily-activation";
import { createNearFamilyPrivateDecisionClient } from "@/lib/nearfamily-private-decision-client";
import { createNearFamilyAvailability, createNearFamilyPageAvailability } from "@/lib/nearfamily-route";

const availability = createNearFamilyPageAvailability(createNearFamilyAvailability({
  sourceActivated: () => nearFamilySourceActivated(env.NEARFAMILY_PRIVATE_ROUTE_ENABLED),
  requireHousehold: async request => (await requireHouseholdContext(request, "entitlement:read")).householdId,
  authorizeProduct: createNearFamilyPrivateDecisionClient({
    endpoint: env.NEARFAMILY_DECISION_ENDPOINT,
    signingKey: env.NEARFAMILY_DECISION_SIGNING_KEY,
    keyVersion: Number(env.NEARFAMILY_DECISION_KEY_VERSION),
    releaseId: env.NEARFAMILY_DECISION_RELEASE_ID,
  }).authorize,
}));

export async function nearFamilyPageAvailability() {
  const requestHeaders = new Headers(await headers());
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") || "https";
  return availability(new Request(`${protocol}://${host}/family`, { headers: requestHeaders }));
}
