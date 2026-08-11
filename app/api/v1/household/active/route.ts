import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdMembers } from "@/db/schema";
import { apiV1Failure, badRequest, requireFoundationUser } from "@/lib/api-v1-context";
import { parseActiveHouseholdInput } from "@/lib/api-v1-input";
import { assertSameOrigin, jsonNoStore, readJsonObject } from "@/lib/http";

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const { user } = await requireFoundationUser(request);
    let input;
    try { input = parseActiveHouseholdInput(await readJsonObject(request, 2_000)); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    const membership = await getDb().select({ role: householdMembers.role }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, input.householdId), eq(householdMembers.userId, user.userId), eq(householdMembers.status, "active"))).get();
    if (!membership) return jsonNoStore({ error: "An active membership in that household is required." }, { status: 403 });
    const response = jsonNoStore({ apiVersion: "v1", activeHouseholdId: input.householdId, role: membership.role });
    response.headers.append("set-cookie", `nearyou_active_household=${encodeURIComponent(input.householdId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
    return response;
  } catch (error) {
    return apiV1Failure(error, "Active household could not be selected.");
  }
}
