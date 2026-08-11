import { and, desc, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { householdInvitations, householdMembers, users } from "@/db/schema";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { parseInvitationInput } from "@/lib/api-v1-input";
import { assertSameOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { loadEffectiveHouseholdEntitlement } from "@/lib/household-entitlements";

async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const invitationProjection = {
  id: householdInvitations.id,
  invitedEmail: householdInvitations.invitedEmail,
  role: householdInvitations.role,
  status: householdInvitations.status,
  expiresAt: householdInvitations.expiresAt,
  createdAt: householdInvitations.createdAt,
  updatedAt: householdInvitations.updatedAt,
};

export async function GET(request: Request) {
  try {
    const { householdId } = await requireHouseholdContext(request, "invitation:write");
    const invitations = await getDb().select(invitationProjection).from(householdInvitations)
      .where(eq(householdInvitations.householdId, householdId)).orderBy(desc(householdInvitations.createdAt)).limit(100).all();
    return jsonNoStore({ apiVersion: "v1", invitations });
  } catch (error) {
    return apiV1Failure(error, "Household invitations could not be loaded.");
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { householdId, user } = await requireHouseholdContext(request, "invitation:write");
    let input;
    try { input = parseInvitationInput(await readJsonObject(request, 4_000)); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    const db = getDb();
    const existing = await db.select(invitationProjection).from(householdInvitations)
      .where(and(eq(householdInvitations.id, input.requestId), eq(householdInvitations.householdId, householdId))).get();
    if (existing) {
      if (existing.invitedEmail !== input.email || existing.role !== input.role) {
        return jsonNoStore({ error: "That request ID is already associated with different invitation data." }, { status: 409 });
      }
      return jsonNoStore({ apiVersion: "v1", invitation: existing, duplicate: true });
    }
    const existingActiveMember = await db.select({ id: householdMembers.id }).from(householdMembers)
      .innerJoin(users, eq(householdMembers.userId, users.id))
      .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.status, "active"), sql`lower(${users.email}) = ${input.email}`)).get();
    if (existingActiveMember) return jsonNoStore({ error: "That adult is already an active household member." }, { status: 409 });
    const [entitlement, memberCount, pendingCount] = await Promise.all([
      loadEffectiveHouseholdEntitlement(householdId),
      db.select({ value: sql<number>`count(*)` }).from(householdMembers)
        .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.status, "active"))).get(),
      db.select({ value: sql<number>`count(*)` }).from(householdInvitations)
        .where(and(eq(householdInvitations.householdId, householdId), eq(householdInvitations.status, "pending"), gt(householdInvitations.expiresAt, new Date()))).get(),
    ]);
    if ((memberCount?.value || 0) + (pendingCount?.value || 0) >= entitlement.limits.members) {
      return jsonNoStore({ error: "This household has reached its member limit." }, { status: 409 });
    }
    const now = new Date();
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    const inserted = await db.insert(householdInvitations).values({
      id: input.requestId,
      householdId,
      invitedByUserId: user.userId,
      invitedEmail: input.email,
      role: input.role,
      tokenHash: await tokenHash(token),
      status: "pending",
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning(invitationProjection).get();
    if (inserted) return jsonNoStore({ apiVersion: "v1", invitation: inserted, token }, { status: 201 });
    const conflicted = await db.select(invitationProjection).from(householdInvitations)
      .where(and(eq(householdInvitations.id, input.requestId), eq(householdInvitations.householdId, householdId))).get();
    if (!conflicted || conflicted.invitedEmail !== input.email || conflicted.role !== input.role) {
      return jsonNoStore({ error: "That request ID is already associated with different invitation data." }, { status: 409 });
    }
    return jsonNoStore({ apiVersion: "v1", invitation: conflicted, duplicate: true });
  } catch (error) {
    return apiV1Failure(error, "Household invitation could not be created.");
  }
}
