import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { sleepSessions } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";

type StoredAudio = { body: BodyInit | null; httpMetadata?: { contentType?: string }; writeHttpMetadata(headers: Headers): void };
type AudioBucket = { get(key: string): Promise<StoredAudio | null> };

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(request);
    const { id } = await context.params;
    const record = await getDb().select({ audioKey: sleepSessions.audioKey }).from(sleepSessions).where(and(eq(sleepSessions.id, id), eq(sleepSessions.userId, user.userId))).get();
    if (!record?.audioKey) return new Response("Not found", { status: 404 });
    const bucket = (env as unknown as { AUDIO?: AudioBucket }).AUDIO;
    if (!bucket) return new Response("Audio storage is unavailable", { status: 503 });
    const object = await bucket.get(record.audioKey);
    if (!object?.body) return new Response("Not found", { status: 404 });
    const headers = new Headers({
      "cache-control": "private, max-age=3600",
      "content-disposition": `inline; filename="nearnight-${id}.mp3"`,
      "content-type": object.httpMetadata?.contentType || "audio/mpeg",
    });
    object.writeHttpMetadata(headers);
    return new Response(object.body, { headers });
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response("Audio is unavailable", { status: 500 });
  }
}
