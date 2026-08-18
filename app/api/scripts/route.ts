import { eq } from "drizzle-orm";
import { usageEvents, users } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { assertSameOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { curatedScript, personalizedScriptResult, validateScriptInput } from "@/lib/sleep-script";
import { resolveYouTubeSource } from "@/lib/youtube-source";
import { featureFlagsFromEnv } from "@/lib/nearyou-foundation";
import { assertLegacyNarrationDuration } from "@/lib/usage-reservations";

export async function POST(request: Request) {
  if (featureFlagsFromEnv(process.env).nearSleepProduction) {
    const { postProductionScript } = await import("./production");
    return postProductionScript(request);
  }
  try {
    assertSameOrigin(request);
    const user = await requireApiUser(request);
    const input = validateScriptInput(await readJsonObject(request, 8_000));
    const [{ getDb }, { ensureUser }] = await Promise.all([import("@/db"), import("@/lib/data")]);
    const ensured = await ensureUser(user);
    const account = await getDb().select({ subscriptionStatus: users.subscriptionStatus }).from(users).where(eq(users.id, user.userId)).get();
    try {
      assertLegacyNarrationDuration(account?.subscriptionStatus || "free", Number(input.duration));
    } catch (error) {
      return jsonNoStore({ error: error instanceof Error ? error.message : "Choose a paid plan to unlock that duration.", code: "upgrade_required" }, { status: 402 });
    }
    input.source = await resolveYouTubeSource(input.sourceUrl);
    const personalized = input.scriptMode === "personalized" ? await personalizedScriptResult(input) : null;
    const script = personalized?.script || curatedScript(input);
    try {
      await getDb().insert(usageEvents).values({ id: crypto.randomUUID(), userId: user.userId, householdId: ensured?.householdId, type: "script_generation", units: script.length, metadata: { mode: input.scriptMode, model: input.scriptMode === "personalized" ? (process.env.OPENAI_MODEL || "gpt-5-mini") : "curated" }, createdAt: new Date() });
    } catch (error) { if (process.env.NODE_ENV === "production") throw error; }
    return jsonNoStore({ script, mode: input.scriptMode, source: input.source, notice: personalized?.notice || null });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: error instanceof Error ? error.message : "The story could not be written." }, { status: 400 });
  }
}
