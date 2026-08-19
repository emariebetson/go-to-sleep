import { env } from "cloudflare:workers";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { createNearFamilySummaryService } from "@/lib/nearfamily-service";
import { createPostgresHouseholdProductAccess, createPostgresPrivateTesterInvitationEvaluator } from "@/lib/product-release-readiness-service";
import { nearFamilySourceActivated } from "@/lib/nearfamily-activation";
import { createNearFamilyGetHandler } from "@/lib/nearfamily-route";

// NearFamily is a bundle over existing identity/member/entitlement/invitation
// capabilities, not a separately deployed processor.
export const GET = createNearFamilyGetHandler({
  sourceActivated: nearFamilySourceActivated,
  requireHousehold: async request => (await requireHouseholdContext(request, "entitlement:read")).householdId,
  authorizeProduct: async householdId => {
    const pg = (env as unknown as { READINESS_PG?: { query<T>(sql: string, args: unknown[]): Promise<{ rows: T[] }> } }).READINESS_PG;
    return Boolean(pg && await createPostgresHouseholdProductAccess(pg, createPostgresPrivateTesterInvitationEvaluator(pg))("nearfamily", householdId));
  },
  loadSummary: createNearFamilySummaryService(env.DB),
});
