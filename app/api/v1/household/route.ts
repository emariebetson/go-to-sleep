import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdMembers, households } from "@/db/schema";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { parseHouseholdInput } from "@/lib/api-v1-input";
import { assertSameOrigin, jsonNoStore, readJsonObject } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const context = await requireHouseholdContext(request, "household:read");
    const [household, members] = await Promise.all([
      getDb().select({ id: households.id, name: households.name, createdAt: households.createdAt })
        .from(households).where(eq(households.id, context.householdId)).get(),
      getDb().select({ role: householdMembers.role, status: householdMembers.status })
        .from(householdMembers)
        .where(and(eq(householdMembers.householdId, context.householdId), eq(householdMembers.status, "active")))
        .all(),
    ]);
    if (!household) return jsonNoStore({ error: "Household not found." }, { status: 404 });
    return jsonNoStore({ apiVersion: "v1", household: { ...household, members } });
  } catch (error) {
    return apiV1Failure(error, "Household could not be loaded.");
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const context = await requireHouseholdContext(request, "household:write");
    let input;
    try { input = parseHouseholdInput(await readJsonObject(request, 2_000)); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    const household = await getDb().update(households).set({ name: input.name, updatedAt: new Date() })
      .where(and(eq(households.id, context.householdId), eq(households.ownerUserId, context.user.userId)))
      .returning({ id: households.id, name: households.name }).get();
    if (!household) return jsonNoStore({ error: "Only the household owner can rename this household." }, { status: 403 });
    return jsonNoStore({ apiVersion: "v1", household });
  } catch (error) {
    return apiV1Failure(error, "Household could not be updated.");
  }
}
