export type ReleaseEvidence = {
  releaseId: string;
  schemaChecksum: string;
  backfillChecksum: string;
  backfill: "pending" | "verified";
  shadowReads: "pending" | "verified";
  rlsNegativeTest: "pending" | "verified";
  mediaWorker: "pending" | "verified";
};

const encoder = new TextEncoder();

export function assertPlatformActivation(
  environment: Record<string, string | undefined>,
  evidence: ReleaseEvidence,
) {
  if (environment.NEARYOU_ENABLE_POSTGRES_CUTOVER !== "true") {
    throw new Error("PostgreSQL cutover is not enabled.");
  }
  if (!environment.DATABASE_URL?.startsWith("postgresql://") || !/[?&]sslmode=(require|verify-ca|verify-full)(?:&|$)/.test(environment.DATABASE_URL)) {
    throw new Error("DATABASE_URL is not configured.");
  }
  if (!environment.NEARYOU_RELEASE_ID || evidence.releaseId !== environment.NEARYOU_RELEASE_ID
    || !environment.NEARYOU_POSTGRES_SCHEMA_CHECKSUM || evidence.schemaChecksum !== environment.NEARYOU_POSTGRES_SCHEMA_CHECKSUM) {
    throw new Error("Durable release evidence does not match this release and schema.");
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.backfillChecksum)
    || [evidence.backfill, evidence.shadowReads, evidence.rlsNegativeTest, evidence.mediaWorker].some((value) => value !== "verified")) {
    throw new Error("PostgreSQL activation requires durable release evidence.");
  }
  return { database: "postgres", mediaWorker: "ready" } as const;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

export async function canonicalRowsChecksum(rows: ReadonlyArray<Record<string, unknown>>) {
  const canonical = [...rows].map(stableValue).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(canonical)));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseRevenueCatSignature(header: string) {
  const fields = header.split(",").map((part) => part.trim());
  const timestamp = fields.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = fields.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return null;
  return { timestamp: Number(timestamp), signatures };
}

function hexBytes(value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g) || [], (part) => Number.parseInt(part, 16));
}

export async function verifyRevenueCatAuthorization(
  rawBody: string,
  header: string,
  secret: string,
  nowMs = Date.now(),
) {
  const parsed = parseRevenueCatSignature(header);
  if (!parsed || !secret || Math.abs(Math.floor(nowMs / 1000) - parsed.timestamp) > 300) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${parsed.timestamp}.${rawBody}`)));
  for (const candidate of parsed.signatures) {
    const bytes = hexBytes(candidate);
    if (!bytes || bytes.length !== expected.length) continue;
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) difference |= expected[index] ^ bytes[index];
    if (difference === 0) return true;
  }
  return false;
}

export function evaluateMobileEntitlementEvent(input: {
  id: string;
  occurredAtMs: number;
  priorOccurredAtMs: number | null;
  alreadyProcessed: boolean;
}) {
  if (input.alreadyProcessed) return { action: "ignore_replay" } as const;
  if (input.priorOccurredAtMs !== null && input.occurredAtMs <= input.priorOccurredAtMs) return { action: "ignore_stale" } as const;
  return { action: "apply" } as const;
}

type RevenueCatAllowlist = { appIds: readonly string[]; productIds: readonly string[]; entitlementIds: readonly string[]; environment: "SANDBOX" | "PRODUCTION" };

export function parseRevenueCatEntitlementEvent(payload: unknown, allowlist: RevenueCatAllowlist) {
  if (!payload || typeof payload !== "object" || !("event" in payload) || !payload.event || typeof payload.event !== "object") throw new Error("RevenueCat event is invalid.");
  const event = payload.event as Record<string, unknown>;
  const entitlementIds = Array.isArray(event.entitlement_ids) ? event.entitlement_ids.filter((value): value is string => typeof value === "string") : [];
  const entitlementId = entitlementIds.find((value) => allowlist.entitlementIds.includes(value));
  if (typeof event.app_id !== "string" || !allowlist.appIds.includes(event.app_id)
    || typeof event.product_id !== "string" || !allowlist.productIds.includes(event.product_id)
    || event.environment !== allowlist.environment || !entitlementId) throw new Error("RevenueCat event does not match the application allowlist.");
  if (typeof event.id !== "string" || !/^rc_[A-Za-z0-9_-]+$/.test(event.id)
    || typeof event.app_user_id !== "string" || !/^rcusr_[a-f0-9]{32,64}$/.test(event.app_user_id)
    || typeof event.event_timestamp_ms !== "number" || !Number.isSafeInteger(event.event_timestamp_ms)) throw new Error("RevenueCat identity fields are invalid.");
  if(typeof event.type!=="string"||!/^[A-Z_]{3,64}$/.test(event.type))throw new Error("RevenueCat event type is invalid.");
  const expiresAtMs=event.expiration_at_ms===null||event.expiration_at_ms===undefined?null:event.expiration_at_ms;if(expiresAtMs!==null&&(typeof expiresAtMs!=="number"||!Number.isSafeInteger(expiresAtMs)||expiresAtMs<0))throw new Error("RevenueCat expiration is invalid.");
  return { id: event.id, appId:event.app_id,appUserId: event.app_user_id, occurredAtMs: event.event_timestamp_ms, productId: event.product_id, entitlementId, environment: allowlist.environment,eventType:event.type,expiresAtMs };
}

export type OfflineAsset = { version: 1; mediaId: string; iv: Uint8Array; ciphertext: Uint8Array };

export async function encryptOfflineAsset(
  plaintext: Uint8Array,
  keyBytes: Uint8Array,
  metadata: { mediaId: string; accessToken?: string },
): Promise<OfflineAsset> {
  if (keyBytes.byteLength !== 32) throw new Error("Offline encryption requires a 256-bit device key.");
  const keyMaterial = new Uint8Array(keyBytes).buffer;
  const plainBuffer = new Uint8Array(plaintext).buffer;
  const key = await crypto.subtle.importKey("raw", keyMaterial, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(iv).buffer, additionalData: encoder.encode(metadata.mediaId) }, key, plainBuffer));
  return { version: 1, mediaId: metadata.mediaId, iv, ciphertext };
}

export async function decryptOfflineAsset(asset: OfflineAsset, keyBytes: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(keyBytes).buffer, "AES-GCM", false, ["decrypt"]);
  const value = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(asset.iv).buffer, additionalData: encoder.encode(asset.mediaId) }, key, new Uint8Array(asset.ciphertext).buffer);
  return new Uint8Array(value);
}

type Integration = "spotify" | "youtube";
type IntegrationAction = "create_catalog_playlist" | "upload_private_audio" | "import_metadata" | "adapt_content" | "rip_audio";

export function integrationPolicy(integration: Integration, action: IntegrationAction) {
  if (integration === "spotify" && action === "create_catalog_playlist") return { allowed: true, requiresOAuth: true, requiresRightsAttestation: false } as const;
  if (integration === "spotify" && action === "upload_private_audio") return { allowed: false, reason: "private_audio_upload_prohibited" } as const;
  if (integration === "youtube" && action === "import_metadata") return { allowed: true, requiresOAuth: false, requiresRightsAttestation: false } as const;
  if (integration === "youtube" && action === "adapt_content") return { allowed: true, requiresOAuth: false, requiresRightsAttestation: true } as const;
  if (integration === "youtube" && action === "rip_audio") return { allowed: false, reason: "media_ripping_prohibited" } as const;
  return { allowed: false, reason: "unsupported_integration_action" } as const;
}

const TELEMETRY_ALLOWLIST = new Set(["requestId", "traceId", "spanId", "jobId", "householdHash", "operation", "status", "code", "durationMs", "attempt", "provider", "units", "planId", "route", "method", "nested"]);

export function redactTelemetry(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 8) return "[REDACTED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((child) => redactTelemetry(child, seen, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED]";
  seen.add(value);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, child]) => [
    key,
    TELEMETRY_ALLOWLIST.has(key) ? redactTelemetry(child, seen, depth + 1) : "[REDACTED]",
  ]));
}
