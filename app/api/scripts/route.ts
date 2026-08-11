import { usageEvents } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { assertSameOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { curatedScript, personalizedScript, validateScriptInput } from "@/lib/sleep-script";
import { resolveYouTubeSource } from "@/lib/youtube-source";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireApiUser(request);
    const input = validateScriptInput(await readJsonObject(request, 8_000));
    input.source = await resolveYouTubeSource(input.sourceUrl);
    const script = input.scriptMode === "curated" ? curatedScript(input) : await personalizedScript(input);
    const [{ getDb }, { bestEffortEnsureUser }] = await Promise.all([import("@/db"), import("@/lib/data")]);
    const ensured = await bestEffortEnsureUser(user);
    try {
      await getDb().insert(usageEvents).values({ id: crypto.randomUUID(), userId: user.userId, householdId: ensured?.householdId, type: "script_generation", units: script.length, metadata: { mode: input.scriptMode, model: input.scriptMode === "personalized" ? (process.env.OPENAI_MODEL || "gpt-5-mini") : "curated" }, createdAt: new Date() });
    } catch (error) { if (process.env.NODE_ENV === "production") throw error; }
    return jsonNoStore({ script, mode: input.scriptMode, source: input.source });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: error instanceof Error ? error.message : "The story could not be written." }, { status: 400 });
  }
}
