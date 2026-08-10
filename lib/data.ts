import { getDb } from "@/db";
import { users } from "@/db/schema";
import type { AppUser } from "./auth";

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
}

export async function bestEffortEnsureUser(user: AppUser) {
  try { await ensureUser(user); } catch (error) {
    if (process.env.NODE_ENV === "production") throw error;
  }
}
