import { getDb } from "@/db";
import { entitlements, householdMembers, households, users } from "@/db/schema";
import type { AppUser } from "./auth";
import { householdIdForUser } from "./nearyou-foundation";

export async function ensureUser(user: AppUser) {
  const now = new Date();
  const db = getDb();
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
  const householdId = householdIdForUser(user.userId);
  await db.insert(households).values({
    id: householdId,
    name: `${user.displayName.trim().slice(0, 88) || "My"}'s household`,
    ownerUserId: user.userId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  await db.insert(householdMembers).values({
    id: `household-member:${user.userId}`,
    householdId,
    userId: user.userId,
    role: "owner",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  await db.insert(entitlements).values({
    id: `entitlement:legacy:${user.userId}`,
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
  return { householdId };
}

export async function bestEffortEnsureUser(user: AppUser) {
  try { return await ensureUser(user); } catch (error) {
    if (process.env.NODE_ENV === "production") throw error;
    return undefined;
  }
}
