import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { entitlements } from "@/db/schema";
import { resolveEffectiveEntitlement } from "@/lib/nearyou-foundation";

export async function loadEffectiveHouseholdEntitlement(householdId: string) {
  const grants = await getDb().select({
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
  return resolveEffectiveEntitlement(grants);
}
