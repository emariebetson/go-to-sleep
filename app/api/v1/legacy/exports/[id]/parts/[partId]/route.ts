import { env } from "cloudflare:workers";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";
import { parseByteRange } from "@/lib/http-range";
import { legacyUuid } from "@/lib/nearlegacy-route";
import { isLegacyCustodian, nearLegacyReady, requireLegacyEntitlement } from "../../../../production";

export async function GET(request: Request, context: { params: Promise<{ id: string; partId: string }> }) {
  try {
    if (!await nearLegacyReady("read")) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 });
    const { householdId, user, role } = await requireHouseholdContext(request, "archive:read");
    if (!await requireLegacyEntitlement(householdId, "read")) return jsonNoStore({ error: "NearLegacy is required." }, { status: 403 });
    if (role !== "owner" && !await isLegacyCustodian(householdId, user.userId)) return jsonNoStore({ error: "Only the owner or primary custodian may download an archive export." }, { status: 403 });
    const params = await context.params, id = legacyUuid(params.id, "exportId"), partId = legacyUuid(params.partId, "partId"), now = Date.now();
    const found = await env.DB.prepare("SELECT p.storage_key,p.byte_size,p.checksum,p.ordinal FROM legacy_export_parts p JOIN legacy_export_operations e ON e.id=p.export_id AND e.household_id=p.household_id WHERE p.id=? AND p.export_id=? AND p.household_id=? AND p.status='ready' AND e.status='ready' AND e.expires_at>? AND NOT EXISTS (SELECT 1 FROM legacy_export_consents x JOIN legacy_consents c ON c.id=x.consent_id AND c.household_id=x.household_id WHERE x.export_id=e.id AND x.household_id=e.household_id AND (c.status<>'active' OR (c.expires_at IS NOT NULL AND c.expires_at<=?))) AND NOT EXISTS (SELECT 1 FROM legacy_deletion_operations d WHERE d.household_id=e.household_id AND d.status IN ('queued','processing','failed','dead_letter')) LIMIT 1").bind(partId, id, householdId, now, now).all();
    const part = found.results?.[0] as { storage_key?: string; byte_size?: number; checksum?: string; ordinal?: number } | undefined;
    if (!part?.storage_key || !part.byte_size || !part.checksum) return jsonNoStore({ error: "Export part not found." }, { status: 404 });
    const head = await env.AUDIO.head(part.storage_key);
    if (!head || head.size !== part.byte_size || head.customMetadata?.checksum !== part.checksum || head.customMetadata?.private !== "true") return jsonNoStore({ error: "Export part is awaiting integrity reconciliation." }, { status: 503 });
    const range = parseByteRange(request.headers.get("range"), part.byte_size);
    if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "content-range": `bytes */${part.byte_size}`, "cache-control": "private, no-store" } });
    const object = await env.AUDIO.get(part.storage_key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
    if (!object || object.size !== part.byte_size || object.customMetadata?.checksum !== part.checksum || object.customMetadata?.private !== "true") return jsonNoStore({ error: "Export part changed during verification." }, { status: 503 });
    const extension = part.storage_key.split(".").pop() || "bin", contentType = extension === "json" ? "application/json" : extension === "png" ? "image/png" : extension === "jpg" ? "image/jpeg" : extension === "m4a" ? "audio/mp4" : extension === "webm" ? "audio/webm" : "audio/mpeg";
    const headers = new Headers({ "content-type": contentType, "content-disposition": `attachment; filename="nearlegacy-${id}-${part.ordinal}.${extension}"`, "accept-ranges": "bytes", "cache-control": "private, no-store", "content-length": String(range ? range.end - range.start + 1 : part.byte_size) });
    if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${part.byte_size}`);
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) { return apiV1Failure(error, "Archive export part could not be downloaded."); }
}
