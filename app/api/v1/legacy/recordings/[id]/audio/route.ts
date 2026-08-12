import { env } from "cloudflare:workers";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";
import { parseByteRange } from "@/lib/http-range";
import { nearLegacyReady, requireLegacyEntitlement } from "../../../production";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!await nearLegacyReady("read")) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 });
    const { householdId } = await requireHouseholdContext(request, "archive:read");
    if (!await requireLegacyEntitlement(householdId, "read")) return jsonNoStore({ error: "NearLegacy is required." }, { status: 403 });
    const { id } = await context.params; const now = Date.now();
    const result = await env.DB.prepare(`SELECT m.storage_key,m.byte_size,m.checksum,m.content_type FROM legacy_recordings r
      JOIN media_assets m ON m.id=r.media_asset_id AND m.household_id=r.household_id
      JOIN contributors n ON n.id=r.contributor_id AND n.household_id=r.household_id
      JOIN legacy_consents c ON c.id=r.consent_id AND c.household_id=r.household_id
      WHERE r.id=? AND r.household_id=? AND r.status='ready' AND m.status='ready' AND m.private=1
      AND n.status IN ('active','deceased_pending_review') AND c.status='active' AND (c.expires_at IS NULL OR c.expires_at>?)
      AND NOT EXISTS (SELECT 1 FROM legacy_deletion_operations d WHERE d.household_id=r.household_id AND d.status IN ('queued','processing','failed','dead_letter') AND (d.target_kind='archive' OR (d.target_kind='contributor' AND d.target_id=r.contributor_id) OR (d.target_kind='recording' AND d.target_id=r.id)))
      AND NOT EXISTS (SELECT 1 FROM account_deletion_operations a WHERE a.household_id=r.household_id AND a.status NOT IN ('completed','canceled')) LIMIT 1`).bind(id, householdId, now).all();
    const media = result.results?.[0] as { storage_key?: string; byte_size?: number; checksum?: string; content_type?: string } | undefined;
    if (!media?.storage_key || !media.byte_size || !media.checksum) return jsonNoStore({ error: "Recording not found." }, { status: 404 });
    const head = await env.AUDIO.head(media.storage_key);
    if (!head || head.size !== media.byte_size || head.customMetadata?.checksum !== media.checksum || head.customMetadata?.private !== "true") return jsonNoStore({ error: "Recording is awaiting integrity reconciliation." }, { status: 503 });
    const range = parseByteRange(request.headers.get("range"), media.byte_size);
    if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "content-range": `bytes */${media.byte_size}`, "cache-control": "private, no-store" } });
    const object = await env.AUDIO.get(media.storage_key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
    if (!object || object.size !== media.byte_size || object.customMetadata?.checksum !== media.checksum || object.customMetadata?.private !== "true") return jsonNoStore({ error: "Recording changed during verification; retry safely." }, { status: 503 });
    const headers = new Headers({ "content-type": media.content_type || "audio/mpeg", "accept-ranges": "bytes", "cache-control": "private, no-store", "content-length": String(range ? range.end - range.start + 1 : media.byte_size) });
    if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${media.byte_size}`);
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) { return apiV1Failure(error, "Recording audio could not be loaded."); }
}
