import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { entitlements } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";
import { resolveEffectiveEntitlement } from "@/lib/nearyou-foundation";

export async function GET(request: Request) {
  try {
    const { householdId } = await requireHouseholdContext(request, "entitlement:read");
    const records = await getDb().select({
        id: entitlements.id,
        planId: entitlements.planId,
        status: entitlements.status,
        allowanceMilliunits: entitlements.allowanceMilliunits,
        remainingMilliunits: entitlements.remainingMilliunits,
        validFrom: entitlements.validFrom,
        validUntil: entitlements.validUntil,
        updatedAt: entitlements.updatedAt,
      }).from(entitlements)
      .where(and(eq(entitlements.householdId, householdId), inArray(entitlements.status, ["active", "grace"])))
      .orderBy(desc(entitlements.updatedAt)).all();
    if (!records.length) return jsonNoStore({ error: "No household entitlement is available." }, { status: 404 });
    return jsonNoStore({ apiVersion: "v1", entitlement: resolveEffectiveEntitlement(records), grants: records });
  } catch (error) {
    return apiV1Failure(error, "Entitlements could not be loaded.");
  }
}
