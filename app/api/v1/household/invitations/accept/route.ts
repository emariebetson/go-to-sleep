import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdInvitations, householdMembers } from "@/db/schema";
import { apiV1Failure, badRequest, requireFoundationUser } from "@/lib/api-v1-context";
import { parseInvitationAcceptanceInput } from "@/lib/api-v1-input";
import { assertSameOrigin, jsonNoStore, readJsonObject } from "@/lib/http";

async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function acceptedResponse(householdId: string, role: string, duplicate: boolean) {
  const response = jsonNoStore({ apiVersion: "v1", activeHouseholdId: householdId, role, duplicate });
  response.headers.append("set-cookie", `nearyou_active_household=${encodeURIComponent(householdId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  return response;
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { user } = await requireFoundationUser(request);
    let input;
    try { input = parseInvitationAcceptanceInput(await readJsonObject(request, 2_000)); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    const hash = await tokenHash(input.token);
    const db = getDb();
    const invitation = await db.select().from(householdInvitations).where(eq(householdInvitations.tokenHash, hash)).get();
    if (!invitation || invitation.invitedEmail !== user.email.trim().toLowerCase()) return jsonNoStore({ error: "Invitation not found." }, { status: 404 });
    const duplicate = invitation.status === "accepted" && invitation.acceptedByUserId === user.userId;
    const existingMember = await db.select({ id: householdMembers.id, role: householdMembers.role, status: householdMembers.status })
      .from(householdMembers).where(and(eq(householdMembers.householdId, invitation.householdId), eq(householdMembers.userId, user.userId))).get();
    if (existingMember?.status === "active") {
      if (duplicate) return acceptedResponse(invitation.householdId, existingMember.role, true);
      return jsonNoStore({ error: "This adult is already an active household member." }, { status: 409 });
    }
    if (!duplicate && (invitation.status !== "pending" || invitation.expiresAt.getTime() <= Date.now())) {
      return jsonNoStore({ error: "Invitation is no longer valid." }, { status: 410 });
    }
    const now = new Date();
    if (!duplicate) {
      const accepted = await db.update(householdInvitations).set({ status: "accepted", acceptedByUserId: user.userId, updatedAt: now })
        .where(and(eq(householdInvitations.id, invitation.id), eq(householdInvitations.status, "pending"))).returning({ id: householdInvitations.id }).get();
      if (!accepted) return jsonNoStore({ error: "Invitation acceptance conflicted with another request." }, { status: 409 });
    }
    // Claiming the invitation happens first. Repair a missing/inactive membership on
    // same-user retry, but never overwrite an active role (especially owner).
    if (existingMember) {
      await db.update(householdMembers).set({ role: invitation.role, status: "active", updatedAt: now })
        .where(and(eq(householdMembers.id, existingMember.id), eq(householdMembers.status, existingMember.status)));
    } else {
      await db.insert(householdMembers).values({
        id: `household-member:${invitation.householdId}:${user.userId}`,
        householdId: invitation.householdId,
        userId: user.userId,
        role: invitation.role,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
    }
    const membership = await db.select({ role: householdMembers.role, status: householdMembers.status }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, invitation.householdId), eq(householdMembers.userId, user.userId))).get();
    if (!membership || membership.status !== "active") return jsonNoStore({ error: "Household membership could not be activated." }, { status: 409 });
    return acceptedResponse(invitation.householdId, membership.role, duplicate);
  } catch (error) {
    return apiV1Failure(error, "Household invitation could not be accepted.");
  }
}
