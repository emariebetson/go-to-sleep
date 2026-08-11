import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdMembers, households } from "@/db/schema";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { parseOwnershipTransferInput } from "@/lib/api-v1-input";
import { assertSameOrigin, jsonNoStore, readJsonObject } from "@/lib/http";

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const { householdId, user } = await requireHouseholdContext(request, "household:write");
    let input;
    try { input = parseOwnershipTransferInput(await readJsonObject(request, 2_000)); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    if (input.newOwnerUserId === user.userId) return jsonNoStore({ apiVersion: "v1", householdId, ownerUserId: user.userId, duplicate: true });
    const target = await getDb().select({ id: householdMembers.id, role: householdMembers.role }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, input.newOwnerUserId), eq(householdMembers.status, "active"))).get();
    if (!target || target.role !== "adult_manager") {
      return jsonNoStore({ error: "Ownership can be transferred only to an active adult manager." }, { status: 400 });
    }
    const current = await getDb().select({ id: householdMembers.id }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, user.userId), eq(householdMembers.role, "owner"))).get();
    if (!current) return jsonNoStore({ error: "Only the current owner can transfer ownership." }, { status: 403 });
    await getDb().batch([
      getDb().update(householdMembers).set({ role: "owner", updatedAt: new Date() }).where(eq(householdMembers.id, target.id)),
      getDb().update(households).set({ ownerUserId: input.newOwnerUserId, updatedAt: new Date() }).where(and(eq(households.id, householdId), eq(households.ownerUserId, user.userId))),
      getDb().update(householdMembers).set({ role: "adult_manager", updatedAt: new Date() }).where(eq(householdMembers.id, current.id)),
    ]);
    return jsonNoStore({ apiVersion: "v1", householdId, ownerUserId: input.newOwnerUserId });
  } catch (error) {
    return apiV1Failure(error, "Household ownership could not be transferred.");
  }
}
