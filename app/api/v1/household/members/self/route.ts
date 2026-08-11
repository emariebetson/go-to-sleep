import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdMembers } from "@/db/schema";
import { apiV1Failure, requireFoundationUser, selectedHouseholdId } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

export async function DELETE(request: Request) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { user, personalHouseholdId } = await requireFoundationUser(request);
    const householdId = selectedHouseholdId(request, personalHouseholdId);
    const membership = await getDb().select({ role: householdMembers.role, status: householdMembers.status }).from(householdMembers).where(and(
      eq(householdMembers.householdId, householdId), eq(householdMembers.userId, user.userId),
    )).get();
    if (!membership || membership.status === "removed") {
      const duplicate = jsonNoStore({ left: true, duplicate: true });
      duplicate.headers.append("set-cookie", `nearyou_active_household=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
      return duplicate;
    }
    if (membership.role === "owner") return jsonNoStore({ error: "Transfer household ownership before leaving this household." }, { status: 409 });
    const now = new Date();
    const removed = await getDb().update(householdMembers).set({ status: "removed", updatedAt: now }).where(and(
      eq(householdMembers.householdId, householdId), eq(householdMembers.userId, user.userId), eq(householdMembers.status, "active"),
    )).returning({ id: householdMembers.id }).get();
    if (!removed) return jsonNoStore({ left: true, duplicate: true });
    const response = jsonNoStore({ left: true });
    response.headers.append("set-cookie", `nearyou_active_household=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
    return response;
  } catch (error) {
    return apiV1Failure(error, "The household membership could not be removed.");
  }
}
