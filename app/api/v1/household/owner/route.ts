import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdMembers, householdOwnerTransferGuards, households } from "@/db/schema";
import { apiV1Failure, badRequest, requireFoundationUser, selectedHouseholdId } from "@/lib/api-v1-context";
import { parseOwnershipTransferInput } from "@/lib/api-v1-input";
import { assertSameOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const { user, personalHouseholdId } = await requireFoundationUser(request);
    const householdId = selectedHouseholdId(request, personalHouseholdId);
    let input;
    try { input = parseOwnershipTransferInput(await readJsonObject(request, 2_000)); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    if (input.newOwnerUserId === user.userId) return jsonNoStore({ apiVersion: "v1", householdId, ownerUserId: user.userId, duplicate: true });
    const [household, caller] = await Promise.all([
      getDb().select({ ownerUserId: households.ownerUserId }).from(households).where(eq(households.id, householdId)).get(),
      getDb().select({ role: householdMembers.role, status: householdMembers.status }).from(householdMembers).where(and(
        eq(householdMembers.householdId, householdId), eq(householdMembers.userId, user.userId),
      )).get(),
    ]);
    if (household?.ownerUserId === input.newOwnerUserId && caller?.status === "active" && caller.role === "adult_manager") {
      return jsonNoStore({ apiVersion: "v1", householdId, ownerUserId: input.newOwnerUserId, duplicate: true });
    }
    if (!household || household.ownerUserId !== user.userId || caller?.status !== "active" || caller.role !== "owner") {
      return jsonNoStore({ error: "Only the current owner can transfer ownership." }, { status: 403 });
    }
    const target = await getDb().select({ id: householdMembers.id, role: householdMembers.role }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, input.newOwnerUserId), eq(householdMembers.status, "active"))).get();
    if (!target || target.role !== "adult_manager") {
      return jsonNoStore({ error: "Ownership can be transferred only to an active adult manager." }, { status: 400 });
    }
    const current = await getDb().select({ id: householdMembers.id }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, user.userId), eq(householdMembers.role, "owner"))).get();
    if (!current) return jsonNoStore({ error: "Only the current owner can transfer ownership." }, { status: 403 });
    const now = new Date();
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) {
      await getDb().batch([
        getDb().update(householdMembers).set({ role: "adult_manager", updatedAt: now }).where(eq(householdMembers.id, current.id)),
        getDb().update(householdMembers).set({ role: "owner", updatedAt: now }).where(eq(householdMembers.id, target.id)),
        getDb().update(households).set({ ownerUserId: input.newOwnerUserId, updatedAt: now }).where(and(eq(households.id, householdId), eq(households.ownerUserId, user.userId))),
      ]);
      return jsonNoStore({ apiVersion: "v1", householdId, ownerUserId: input.newOwnerUserId });
    }
    const guardId = `owner-transfer:${crypto.randomUUID()}`;
    await getDb().batch([
      getDb().update(householdMembers).set({ role: "adult_manager", updatedAt: now }).where(and(eq(householdMembers.id, current.id), eq(householdMembers.userId, user.userId), eq(householdMembers.role, "owner"), eq(householdMembers.status, "active"))),
      getDb().update(householdMembers).set({ role: "owner", updatedAt: now }).where(and(eq(householdMembers.id, target.id), eq(householdMembers.userId, input.newOwnerUserId), eq(householdMembers.role, "adult_manager"), eq(householdMembers.status, "active"))),
      getDb().update(households).set({ ownerUserId: input.newOwnerUserId, updatedAt: now }).where(and(eq(households.id, householdId), eq(households.ownerUserId, user.userId))),
      getDb().insert(householdOwnerTransferGuards).values({ id: guardId, householdId, priorOwnerUserId: user.userId, newOwnerUserId: input.newOwnerUserId, createdAt: now }),
      getDb().delete(householdOwnerTransferGuards).where(eq(householdOwnerTransferGuards.id, guardId)),
    ]);
    return jsonNoStore({ apiVersion: "v1", householdId, ownerUserId: input.newOwnerUserId });
  } catch (error) {
    return apiV1Failure(error, "Household ownership could not be transferred.");
  }
}
