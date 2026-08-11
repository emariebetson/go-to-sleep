import { and, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { accountReauthChallenges } from "@/db/schema";
import { requireApiAuthContext } from "@/lib/auth";
import { ensureUser } from "@/lib/data";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

function enabled() { return nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env)); }

const REAUTH_WINDOW_MS = 10 * 60 * 1000;

export async function POST(request: Request) {
  try {
    if (!enabled()) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const auth = await requireApiAuthContext(request);
    await ensureUser(auth.user);
    const id = crypto.randomUUID();
    const now = new Date();
    await getDb().insert(accountReauthChallenges).values({
      id,
      userId: auth.user.userId,
      initialSessionId: auth.sessionId,
      status: "pending",
      expiresAt: new Date(now.getTime() + REAUTH_WINDOW_MS),
      createdAt: now,
    });
    return jsonNoStore({
      challengeId: id,
      signInUrl: `/sign-in?returnTo=${encodeURIComponent(`/account?reauthChallenge=${id}`)}`,
      expiresAt: new Date(now.getTime() + REAUTH_WINDOW_MS),
    }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "A fresh sign-in challenge could not be started." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    if (!enabled()) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const auth = await requireApiAuthContext(request);
    let challengeId = "";
    try { challengeId = String((await readJsonObject(request, 1_000)).challengeId || "").trim(); } catch (error) {
      return error instanceof Response ? error : jsonNoStore({ error: "challengeId is required." }, { status: 400 });
    }
    const challenge = await getDb().select().from(accountReauthChallenges).where(and(
      eq(accountReauthChallenges.id, challengeId), eq(accountReauthChallenges.userId, auth.user.userId), inArray(accountReauthChallenges.status, ["pending", "verified"]), gt(accountReauthChallenges.expiresAt, new Date()),
    )).get();
    if (!challenge) return jsonNoStore({ error: "The reauthentication challenge is invalid or expired." }, { status: 410 });
    if (challenge.status === "verified") {
      if (challenge.verifiedSessionId !== auth.sessionId) return jsonNoStore({ error: "The reauthentication challenge is bound to another sign-in session." }, { status: 403 });
      return jsonNoStore({ challengeId: challenge.id, verified: true, duplicate: true, expiresAt: challenge.expiresAt });
    }
    if (challenge.initialSessionId === auth.sessionId || auth.sessionCreatedAt.getTime() < challenge.createdAt.getTime()) {
      return jsonNoStore({ error: "Complete a new Google sign-in before confirming account deletion." }, { status: 403 });
    }
    const verifiedAt = new Date();
    const verified = await getDb().update(accountReauthChallenges).set({
      verifiedSessionId: auth.sessionId,
      status: "verified",
      verifiedAt,
    }).where(and(eq(accountReauthChallenges.id, challenge.id), eq(accountReauthChallenges.status, "pending"))).returning({ id: accountReauthChallenges.id }).get();
    if (!verified) return jsonNoStore({ error: "The reauthentication challenge changed. Reload account privacy controls." }, { status: 409 });
    return jsonNoStore({ challengeId: challenge.id, verified: true, expiresAt: challenge.expiresAt });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "Fresh sign-in could not be verified." }, { status: 500 });
  }
}
