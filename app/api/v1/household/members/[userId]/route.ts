import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { householdMembers } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

export async function DELETE(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId, user, role } = await requireHouseholdContext(request, "household:write");
    if (role !== "owner") return jsonNoStore({ error: "Only the household owner can remove another member." }, { status: 403 });
    const { userId } = await context.params;
    if (!userId || userId === user.userId) return jsonNoStore({ error: "Transfer ownership before removing the owner." }, { status: 409 });
    const removedAt = new Date();
    const removed = await getDb().update(householdMembers).set({ status: "removed", updatedAt: removedAt }).where(and(
      eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId), eq(householdMembers.status, "active"), ne(householdMembers.role, "owner"),
    )).returning({ id: householdMembers.id }).get();
    return jsonNoStore({ removed: true, ...(removed ? {} : { duplicate: true }) });
  } catch (error) {
    return apiV1Failure(error, "The household member could not be removed.");
  }
}
