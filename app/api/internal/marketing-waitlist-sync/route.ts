import { env } from "cloudflare:workers";
import { jsonNoStore } from "@/lib/http";
import { processOneWaitlistSync } from "@/lib/marketing-waitlist-google";

export async function POST(request: Request) {
  const expected = process.env.MARKETING_SYNC_SECRET || "";
  if (expected.length < 32 || request.headers.get("authorization") !== `Bearer ${expected}`) return jsonNoStore({ error: "Unauthorized" }, { status: 401 });
  const encryptionKey = process.env.MARKETING_WAITLIST_ENCRYPTION_KEY || "";
  try {
    return jsonNoStore(await processOneWaitlistSync(env, encryptionKey));
  } catch {
    return jsonNoStore({ error: "Synchronization is temporarily unavailable." }, { status: 503 });
  }
}
