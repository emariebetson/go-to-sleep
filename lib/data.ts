import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { entitlements, householdMembers, households, users } from "@/db/schema";
import type { AppUser } from "./auth";
import { AccountBootstrapError, accountBootstrapCauseClassName, runAccountBootstrap } from "./account-bootstrap";
import { householdIdForUser } from "./nearyou-foundation";

export async function ensureUser(user: AppUser) {
  const now = new Date();
  const db = getDb();
  const householdId = householdIdForUser(user.userId);
  const membershipId = `household-member:${user.userId}`;
  const entitlementId = `entitlement:legacy:${user.userId}`;

  try {
    await runAccountBootstrap({
      async upsertUser() {
        await db.insert(users).values({
          id: user.userId,
          email: user.email,
          displayName: user.displayName,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: users.id,
          set: { email: user.email, displayName: user.displayName, updatedAt: now },
        });
      },
      async hasHousehold() {
        return Boolean(await db.select({ id: households.id }).from(households).where(eq(households.id, householdId)).get());
      },
      async hasMembership() {
        return Boolean(await db.select({ id: householdMembers.id }).from(householdMembers).where(eq(householdMembers.id, membershipId)).get());
      },
      async hasEntitlement() {
        return Boolean(await db.select({ id: entitlements.id }).from(entitlements).where(eq(entitlements.id, entitlementId)).get());
      },
      async createHousehold() {
        await db.insert(households).values({
          id: householdId,
          name: `${user.displayName.trim().slice(0, 88) || "My"}'s household`,
          ownerUserId: user.userId,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing();
      },
      async createMembership() {
        await db.insert(householdMembers).values({
          id: membershipId,
          householdId,
          userId: user.userId,
          role: "owner",
          status: "active",
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing();
      },
      async createEntitlement() {
        await db.insert(entitlements).values({
          id: entitlementId,
          householdId,
          planId: "nearsleep_free",
          source: "legacy",
          status: "active",
          allowanceMilliunits: 1_000,
          remainingMilliunits: 1_000,
          legacyCreditsRemaining: 1,
          validFrom: now,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing();
      },
    });
  } catch (error) {
    if (error instanceof AccountBootstrapError) {
      console.error(JSON.stringify({ stage: error.stage, cause: accountBootstrapCauseClassName(error.cause) }));
    }
    throw error;
  }
  return { householdId };
}

export async function bestEffortEnsureUser(user: AppUser) {
  try { return await ensureUser(user); } catch (error) {
    if (process.env.NODE_ENV === "production") throw error;
    return undefined;
  }
}
