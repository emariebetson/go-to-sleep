import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mediaAssets, storyExperiences } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";
import { parseByteRange } from "@/lib/http-range";
import { storyReady } from "../../production";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!await storyReady()) return jsonNoStore({ error: "NearStory is not available." }, { status: 404 });
    const { householdId } = await requireHouseholdContext(request, "job:read");
    const { id } = await context.params;
    const media = await getDb().select({ key: mediaAssets.storageKey, size: mediaAssets.byteSize, checksum: mediaAssets.checksum, contentType: mediaAssets.contentType })
      .from(storyExperiences).innerJoin(mediaAssets, and(eq(storyExperiences.mediaAssetId, mediaAssets.id), eq(mediaAssets.householdId, householdId), eq(mediaAssets.status, "ready")))
      .where(and(eq(storyExperiences.id, id), eq(storyExperiences.householdId, householdId), eq(storyExperiences.status, "completed"))).get();
    if (!media?.key || !media.size || !media.checksum) return jsonNoStore({ error: "Story audio not found." }, { status: 404 });
    const head = await env.AUDIO.head(media.key);
    if (!head || head.size !== media.size || head.customMetadata?.checksum !== media.checksum) return jsonNoStore({ error: "Story audio is awaiting integrity reconciliation." }, { status: 503 });
    const range = parseByteRange(request.headers.get("range"), media.size);
    if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "content-range": `bytes */${media.size}`, "cache-control": "private, no-store" } });
    const object = await env.AUDIO.get(media.key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
    if (!object) return jsonNoStore({ error: "Story audio not found." }, { status: 404 });
    const headers = new Headers({ "content-type": media.contentType || "audio/mpeg", "accept-ranges": "bytes", "cache-control": "private, no-store" });
    if (range) { headers.set("content-range", `bytes ${range.start}-${range.end}/${media.size}`); headers.set("content-length", String(range.end - range.start + 1)); }
    else headers.set("content-length", String(media.size));
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) { return apiV1Failure(error, "Story audio could not be loaded."); }
}
