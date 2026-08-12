export function legacyUuid(value: unknown, field = "requestId") {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${field} must be a UUID.`);
  return value.toLowerCase();
}
export function legacyText(value: unknown, field: string, max: number) {
  if (typeof value !== "string") throw new Error(`${field} is required.`);
  const text = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!text || Array.from(text).length > max || /\p{Cc}/u.test(text)) throw new Error(`${field} must be at most ${max} characters.`);
  return text;
}
export function optionalLegacyText(value: unknown, field: string, max: number) { return value == null || value === "" ? null : legacyText(value, field, max); }
export async function legacyHash(value: string) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
export async function legacyInternalId(namespace: string, householdId: string, idempotencyKey: string) {
  const hex = await legacyHash(`nearlegacy:v1:${namespace}:${householdId}:${legacyUuid(idempotencyKey, "Idempotency-Key")}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function enforceLegacyRateLimit(db: { prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<{ results?: unknown[] }> } } }, householdId: string, userId: string, operation: string, limit: number, windowMs: number) {
  const now = Date.now();
  const result = await db.prepare("INSERT INTO legacy_rate_limits (household_id,user_id,operation,window_started_at,request_count) VALUES (?,?,?,?,1) ON CONFLICT(household_id,user_id,operation) DO UPDATE SET window_started_at=CASE WHEN legacy_rate_limits.window_started_at+?<=? THEN ? ELSE legacy_rate_limits.window_started_at END,request_count=CASE WHEN legacy_rate_limits.window_started_at+?<=? THEN 1 ELSE legacy_rate_limits.request_count+1 END RETURNING request_count").bind(householdId, userId, operation, now, windowMs, now, now, windowMs, now).all();
  const count = Number((result.results?.[0] as { request_count?: number } | undefined)?.request_count || 0);
  if (!count || count > limit) return new Response(JSON.stringify({ error: "Too many requests. Please wait and try again.", code: "rate_limited" }), { status: 429, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": String(Math.ceil(windowMs / 1000)) } });
  return null;
}
