import { env } from "cloudflare:workers";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readLimitedBytes } from "@/lib/http";
import { enforceLegacyRateLimit, legacyHash, legacyInternalId, legacyUuid } from "@/lib/nearlegacy-route";
import { nearLegacyReady, requireLegacyEntitlement } from "../production";

const WORDS = [
  "amber","anchor","apple","arrow","bamboo","beacon","berry","birch",
  "bluebird","breeze","brook","candle","cedar","clover","comet","coral",
  "dawn","dove","dream","echo","fern","firefly","forest","garden",
  "harbor","hazel","island","jasmine","kettle","lagoon","lantern","lilac",
  "lotus","maple","meadow","mist","moon","moss","nectar","ocean",
  "orchid","pebble","pine","plum","quartz","rain","river","robin",
  "rose","sage","shell","silver","sparrow","spruce","star","stone",
  "sunrise","thistle","valley","violet","wave","willow","wren","zephyr",
] as const;

function spokenNonce() {
  const random = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(random, value => WORDS[value & 63]).join(" ");
}

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    if (!await nearLegacyReady()) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 });
    const { householdId, user } = await requireHouseholdContext(request, "archive:self");
    const limited = await enforceLegacyRateLimit(env.DB, householdId, user.userId, "liveness_challenge", 4, 60_000);
    if (limited) return limited;
    if (!await requireLegacyEntitlement(householdId)) return jsonNoStore({ error: "NearLegacy is required." }, { status: 403 });
    const body = JSON.parse(new TextDecoder().decode(await readLimitedBytes(request, 2_048))) as Record<string, unknown>;
    const contributorId = legacyUuid(body.contributorId, "contributorId");
    const kind = String(body.kind || "");
    if (!(["recording", "transcription", "synthetic"] as string[]).includes(kind)) return jsonNoStore({ error: "Consent kind is invalid." }, { status: 400 });
    const contributor = await env.DB.prepare("SELECT id FROM contributors WHERE id=? AND household_id=? AND adult_user_id=? AND status='active'").bind(contributorId, householdId, user.userId).all();
    if (!contributor.results?.length) return jsonNoStore({ error: "Contributors must verify their own consent." }, { status: 403 });
    const idempotencyKey = request.headers.get("idempotency-key") || "";
    const id = await legacyInternalId("legacy-liveness", householdId, idempotencyKey);
    const requestHash = await legacyHash(JSON.stringify({ contributorId, kind }));
    const existing = await env.DB.prepare("SELECT id,phrase,phrase_hash,status,expires_at FROM legacy_liveness_challenges WHERE id=? AND household_id=?").bind(id, householdId).all();
    if (existing.results?.length) {
      const row = existing.results[0] as Record<string, unknown>;
      const audit = await env.DB.prepare("SELECT request_hash FROM legacy_audit_events WHERE household_id=? AND target_kind='liveness_challenge' AND target_id=? LIMIT 1").bind(householdId, id).all();
      if ((audit.results?.[0] as Record<string, unknown> | undefined)?.request_hash !== requestHash) return jsonNoStore({ error: "That idempotency key belongs to another liveness challenge." }, { status: 409 });
      if (row.status !== "issued" || Number(row.expires_at) <= Date.now()) return jsonNoStore({ error: "That liveness challenge is no longer active." }, { status: 409 });
      return jsonNoStore({ id: row.id, phrase: row.phrase, expiresAt: row.expires_at, duplicate: true });
    }
    // 72 bits of fresh entropy makes prerecording the challenge impractical;
    // idempotent retries return the already-issued phrase above.
    const phrase = spokenNonce();
    const phraseHash = await legacyHash(phrase.normalize("NFKC").toLocaleLowerCase("en-US"));
    const now = Date.now(), expiresAt = now + 10 * 60_000;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO legacy_liveness_challenges (id,household_id,contributor_id,user_id,kind,phrase,phrase_hash,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,'issued',?,?)").bind(id, householdId, contributorId, user.userId, kind, phrase, phraseHash, expiresAt, now),
      env.DB.prepare("INSERT INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`liveness:${id}`, householdId, user.userId, "liveness_challenge_issued", "liveness_challenge", id, requestHash, now),
    ]);
    return jsonNoStore({ id, phrase, expiresAt }, { status: 201 });
  } catch (error) { return apiV1Failure(error, "Liveness challenge could not be created."); }
}
