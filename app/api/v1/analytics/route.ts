import { assertTrustedMutationOrigin, readJsonObject } from "@/lib/http";
import { normalizeGrowthEvent } from "@/lib/growth-analytics";

const POSTHOG_HOSTS = new Set(["https://us.i.posthog.com", "https://eu.i.posthog.com"]);

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    const body = await readJsonObject(request, 2_048) as Record<string, unknown>;
    const event = normalizeGrowthEvent(body);
    const anonymousId = typeof body.anonymousId === "string" && /^[a-f0-9-]{36}$/.test(body.anonymousId) ? body.anonymousId : "";
    if (!anonymousId) return new Response(null, { status: 204 });
    const apiKey = process.env.POSTHOG_PROJECT_KEY?.trim() || "";
    const host = process.env.POSTHOG_HOST?.trim().replace(/\/$/, "") || "";
    if (!apiKey || !/^phc_[A-Za-z0-9_-]{20,200}$/.test(apiKey) || !POSTHOG_HOSTS.has(host)) return new Response(null, { status: 204 });
    await fetch(`${host}/capture/`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        event: event.event,
        properties: { ...event.properties, distinct_id: anonymousId, $process_person_profile: false },
      }),
    }).catch(() => undefined);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch { return new Response(null, { status: 204, headers: { "cache-control": "no-store" } }); }
}
