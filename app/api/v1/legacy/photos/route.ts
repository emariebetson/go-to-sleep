import { env } from "cloudflare:workers";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readLimitedBytes } from "@/lib/http";
import { putPrivateLegacyObject } from "@/lib/nearlegacy-media";
import { legacyHash, legacyInternalId, legacyText } from "@/lib/nearlegacy-route";
import { nearLegacyReady, requireLegacyEntitlement } from "../production";

type Bucket = Parameters<typeof putPrivateLegacyObject>[0];
const bucket = () => (env as unknown as { AUDIO: Bucket }).AUDIO;
async function digest(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)), (value) => value.toString(16).padStart(2, "0")).join(""); }
function validPrefix(bytes: Uint8Array, type: string) { return type === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff : type === "image/png" ? bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) : false; }
async function verifyPhoto(bytes: Uint8Array, type: string, checksum: string, householdId: string, userId: string) {
  const root = process.env.NEARYOU_LEGACY_MEDIA_PROCESSOR_URL || "", token = process.env.NEARYOU_LEGACY_MEDIA_PROCESSOR_TOKEN || "";
  if (!root.startsWith("https://") || token.length < 32) throw new Error("photo_processor_unavailable");
  const url = new URL(root); url.pathname = url.pathname.replace(/\/probe$/, "") + "/image-probe";
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": type, "x-content-sha256": checksum, "x-nearyou-household-id": householdId, "x-nearyou-user-id": userId }, body: new Uint8Array(bytes).buffer as ArrayBuffer });
  if (!response.ok) throw new Error(response.status === 422 ? "invalid_photo" : "photo_processor_unavailable");
  const result = await response.json() as { checksum?: string; byteSize?: number; width?: number; height?: number; contentType?: string };
  if (result.checksum !== checksum || result.byteSize !== bytes.byteLength || result.contentType !== type || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || Number(result.width) * Number(result.height) > 40_000_000) throw new Error("invalid_photo_receipt");
}

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    if (!await nearLegacyReady()) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 });
    const { householdId, user } = await requireHouseholdContext(request, "archive:write");
    if (!await requireLegacyEntitlement(householdId)) return jsonNoStore({ error: "NearLegacy is required." }, { status: 403 });
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.startsWith("multipart/form-data;")) return jsonNoStore({ error: "Photo upload requires multipart form data." }, { status: 400 });
    const raw = await readLimitedBytes(request, 10_500_000), form = await new Response(raw, { headers: { "content-type": contentType } }).formData(), file = form.get("photo");
    if (!(file instanceof File) || file.size < 50 || file.size > 10_000_000 || !["image/jpeg", "image/png"].includes(file.type)) return jsonNoStore({ error: "A JPEG or PNG up to 10 MB is required." }, { status: 400 });
    const caption = form.get("caption") ? legacyText(form.get("caption"), "caption", 500) : null, key = request.headers.get("idempotency-key") || "", id = await legacyInternalId("legacy-photo", householdId, key), mediaId = await legacyInternalId("legacy-photo-media", householdId, key), bytes = new Uint8Array(await file.arrayBuffer());
    if (!validPrefix(bytes, file.type)) return jsonNoStore({ error: "The uploaded file does not match its declared image type." }, { status: 400 });
    const checksum = await digest(bytes);
    try { await verifyPhoto(bytes, file.type, checksum, householdId, user.userId); } catch (error) { const invalid = error instanceof Error && error.message === "invalid_photo"; return jsonNoStore({ error: invalid ? "The image is malformed, truncated, or unsafe." : "Photo verification is temporarily unavailable." }, { status: invalid ? 400 : 503 }); }
    const extension = file.type === "image/png" ? "png" : "jpg", storageKey = `legacy/${householdId}/photo/${id}.${extension}`, requestHash = await legacyHash(JSON.stringify({ caption, checksum })), prior = await env.DB.prepare("SELECT p.id,a.request_hash FROM legacy_photos p JOIN legacy_audit_events a ON a.household_id=p.household_id AND a.target_id=p.id WHERE p.id=? AND p.household_id=?").bind(id, householdId).all();
    if (prior.results?.length) { if ((prior.results[0] as Record<string, unknown>).request_hash !== requestHash) return jsonNoStore({ error: "That idempotency key belongs to another photo." }, { status: 409 }); return jsonNoStore({ photo: prior.results[0], duplicate: true }); }
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO media_assets (id,household_id,owner_user_id,kind,status,storage_key,content_type,byte_size,checksum,private,created_at,updated_at) VALUES (?,?,?,'photo','processing',?,?,?,?,1,?,?)").bind(mediaId, householdId, user.userId, storageKey, file.type, file.size, checksum, now, now),
      env.DB.prepare("INSERT INTO household_storage_reservations (id,household_id,media_asset_id,byte_size,status,created_at,updated_at) VALUES (?,?,?,?,'reserved',?,?)").bind(`storage:${mediaId}`, householdId, mediaId, file.size, now, now),
    ]);
    try {
      await putPrivateLegacyObject(bucket(), storageKey, bytes, file.type, checksum);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO task2c_media_integrity (media_asset_id,byte_size,checksum,verified_at) VALUES (?,?,?,?)").bind(mediaId, file.size, checksum, now),
        env.DB.prepare("UPDATE media_assets SET status='ready',updated_at=? WHERE id=? AND household_id=? AND status='processing'").bind(now, mediaId, householdId),
        env.DB.prepare("INSERT INTO legacy_photos (id,household_id,media_asset_id,caption,created_at) VALUES (?,?,?,?,?)").bind(id, householdId, mediaId, caption, now),
        env.DB.prepare("INSERT INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,'photo_created','photo',?,?,?)").bind(`${id}:created`, householdId, user.userId, id, requestHash, now),
      ]);
    } catch (error) {
      await env.DB.batch([
        env.DB.prepare("UPDATE media_assets SET status='deleted',deleted_at=?,updated_at=? WHERE id=? AND household_id=? AND status='processing'").bind(now, now, mediaId, householdId),
        env.DB.prepare("UPDATE household_storage_reservations SET status='released',released_at=?,updated_at=? WHERE media_asset_id=? AND household_id=? AND status='reserved'").bind(now, now, mediaId, householdId),
      ]); throw error;
    }
    return jsonNoStore({ photo: { id, caption } }, { status: 201 });
  } catch (error) { return apiV1Failure(error, "Archive photo could not be saved."); }
}
