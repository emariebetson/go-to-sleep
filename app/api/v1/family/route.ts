import { env } from "cloudflare:workers";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { createNearFamilySummaryService } from "@/lib/nearfamily-service";
import { nearFamilySourceActivated } from "@/lib/nearfamily-activation";
import { createNearFamilyPrivateDecisionClient } from "@/lib/nearfamily-private-decision-client";
import { createNearFamilyGetHandler } from "@/lib/nearfamily-route";

// NearFamily is a bundle over existing identity/member/entitlement/invitation
// capabilities, not a separately deployed processor.
export const GET = createNearFamilyGetHandler({
  sourceActivated: () => nearFamilySourceActivated(env.NEARFAMILY_PRIVATE_ROUTE_ENABLED),
  requireHousehold: async request => (await requireHouseholdContext(request, "entitlement:read")).householdId,
  authorizeProduct: createNearFamilyPrivateDecisionClient({
    endpoint: env.NEARFAMILY_DECISION_ENDPOINT,
    signingKey: env.NEARFAMILY_DECISION_SIGNING_KEY,
    keyVersion: Number(env.NEARFAMILY_DECISION_KEY_VERSION),
    releaseId: env.NEARFAMILY_DECISION_RELEASE_ID,
  }).authorize,
  loadSummary: createNearFamilySummaryService(env.DB),
});
