import { and, eq, gte, sql } from "drizzle-orm";
import { requireApiUser } from "@/lib/auth";
import { assertSameOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { cleanNickname, normalizeNickname } from "@/lib/pronunciation";
import { localPronunciationGuess, requestPronunciationGuess } from "@/lib/pronunciation-guess";

const MAX_GUESSES_PER_HOUR = 20;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireApiUser(request);
    const body = await readJsonObject(request, 1_000);
    const nickname = cleanNickname(body.nickname);
    if (!nickname) return jsonNoStore({ error: "Enter a nickname first." }, { status: 400 });

    const [{ getDb }, { children, usageEvents }, { ensureUser }] = await Promise.all([
      import("@/db"),
      import("@/db/schema"),
      import("@/lib/data"),
    ]);
    await ensureUser(user);
    const db = getDb();
    const saved = await db.select({ pronunciation: children.pronunciation }).from(children)
      .where(and(eq(children.userId, user.userId), eq(children.normalizedNickname, normalizeNickname(nickname))))
      .get();
    if (saved?.pronunciation) return jsonNoStore({ pronunciation: saved.pronunciation, saved: true });

    const localGuess = localPronunciationGuess(nickname);
    if (localGuess) return jsonNoStore({ pronunciation: localGuess, local: true });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return jsonNoStore({ error: "Automatic pronunciation guessing is temporarily unavailable." }, { status: 503 });
    const now = new Date();
    const usageId = `pronunciation:${crypto.randomUUID()}`;
    await db.insert(usageEvents).values({
      id: usageId,
      userId: user.userId,
      type: "pronunciation_guess",
      units: 1,
      metadata: { provider: "openai", nicknameLength: nickname.length },
      createdAt: now,
    });
    const windowStart = new Date(now.getTime() - 60 * 60 * 1000);
    const count = await db.select({ value: sql<number>`count(*)` }).from(usageEvents)
      .where(and(eq(usageEvents.userId, user.userId), eq(usageEvents.type, "pronunciation_guess"), gte(usageEvents.createdAt, windowStart)))
      .get();
    if (Number(count?.value || 0) > MAX_GUESSES_PER_HOUR) {
      await db.delete(usageEvents).where(eq(usageEvents.id, usageId));
      return jsonNoStore({ error: "You’ve reached the pronunciation-guess limit. Type it manually or try again in about an hour." }, { status: 429 });
    }

    try {
      const pronunciation = await requestPronunciationGuess(nickname, apiKey);
      return jsonNoStore({ pronunciation });
    } catch {
      return jsonNoStore({ error: "We couldn’t guess that pronunciation. Type it how it sounds and continue." }, { status: 503 });
    }
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Pronunciation guess request failed");
    return jsonNoStore({ error: "Automatic pronunciation guessing is temporarily unavailable." }, { status: 500 });
  }
}
