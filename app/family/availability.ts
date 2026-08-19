import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { nearFamilySourceActivated } from "@/lib/nearfamily-activation";
import { createNearFamilyAvailability, createNearFamilyPageAvailability } from "@/lib/nearfamily-route";
import { createPostgresHouseholdProductAccess, createPostgresPrivateTesterInvitationEvaluator } from "@/lib/product-release-readiness-service";

const availability = createNearFamilyPageAvailability(createNearFamilyAvailability({
  sourceActivated: nearFamilySourceActivated,
  requireHousehold: async request => (await requireHouseholdContext(request, "entitlement:read")).householdId,
  authorizeProduct: async householdId => {
    const pg = (env as unknown as { READINESS_PG?: { query<T>(sql: string, args: unknown[]): Promise<{ rows: T[] }> } }).READINESS_PG;
    return Boolean(pg && await createPostgresHouseholdProductAccess(pg, createPostgresPrivateTesterInvitationEvaluator(pg))("nearfamily", householdId));
  },
}));

export async function nearFamilyPageAvailability() {
  const requestHeaders = new Headers(await headers());
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") || "https";
  return availability(new Request(`${protocol}://${host}/family`, { headers: requestHeaders }));
}
