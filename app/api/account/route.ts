import { env } from "cloudflare:workers";
import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { householdMembers, households, sleepSessions, users, voices } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { ensureUser } from "@/lib/data";
import { assertSameOrigin, fetchWithTimeout, jsonNoStore } from "@/lib/http";
import { stripeDelete } from "@/lib/stripe";

type AudioBucket = { delete(keys: string | string[]): Promise<void> };

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireApiUser(request);
    await ensureUser(user);
    const db = getDb();
    const [account, ownedHouseholds, voiceRecords, sessionRecords] = await Promise.all([
      db.select().from(users).where(eq(users.id, user.userId)).get(),
      db.select({ id: households.id }).from(households).where(eq(households.ownerUserId, user.userId)).all(),
      db.select().from(voices).where(eq(voices.userId, user.userId)).all(),
      db.select({ audioKey: sleepSessions.audioKey }).from(sleepSessions).where(eq(sleepSessions.userId, user.userId)).all(),
    ]);
    if (!account) return jsonNoStore({ deleted: true });
    const ownedHouseholdIds = ownedHouseholds.map(({ id }) => id);
    const otherActiveMembers = ownedHouseholdIds.length ? await db.select({ id: householdMembers.id }).from(householdMembers)
      .where(and(inArray(householdMembers.householdId, ownedHouseholdIds), eq(householdMembers.status, "active"), ne(householdMembers.userId, user.userId))).all() : [];
    if (otherActiveMembers.length) return jsonNoStore({ error: "Transfer every shared household you own or remove its other active members before deleting this account." }, { status: 409 });

    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    if (voiceRecords.some((voice) => voice.status !== "deleted") && !elevenLabsKey) return jsonNoStore({ error: "Voice-provider deletion is not configured. Your account was not deleted." }, { status: 503 });
    if (account.subscriptionId && !process.env.STRIPE_SECRET_KEY) return jsonNoStore({ error: "Billing cancellation is not configured. Your account was not deleted." }, { status: 503 });
    for (const voice of voiceRecords.filter((record) => record.status !== "deleted")) {
      const response = await fetchWithTimeout(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voice.providerVoiceId)}`, { method: "DELETE", headers: { "xi-api-key": elevenLabsKey! } });
      if (!response.ok && response.status !== 404) return jsonNoStore({ error: "A voice could not be deleted at the provider. Local account deletion was paused; support has been alerted." }, { status: 502 });
    }

    if (account.subscriptionId) await stripeDelete(`/subscriptions/${encodeURIComponent(account.subscriptionId)}`);
    const bucket = (env as unknown as { AUDIO?: AudioBucket }).AUDIO;
    const audioKeys = sessionRecords.flatMap((record) => record.audioKey ? [record.audioKey] : []);
    if (bucket && audioKeys.length) await bucket.delete(audioKeys);
    if (ownedHouseholdIds.length) await db.delete(households).where(and(inArray(households.id, ownedHouseholdIds), eq(households.ownerUserId, user.userId)));
    await db.delete(users).where(eq(users.id, user.userId));
    return jsonNoStore({ deleted: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Account deletion failed", error);
    return jsonNoStore({ error: "Account deletion could not be completed. Local account data was retained so deletion can be retried safely." }, { status: 500 });
  }
}
