export const WAITLIST_CONSENT_VERSION = "marketing-consent-v1" as const;
export const WAITLIST_PRODUCTS = ["nearstory", "nearfamily", "nearlegacy"] as const;
export type WaitlistProduct = typeof WAITLIST_PRODUCTS[number];
export type WaitlistSource = "home" | "pricing";
export type SealedEmail = { ciphertext: string; iv: string };

export async function ensureMarketingWaitlistSchema(database: D1Database) {
  await database.batch([
    database.prepare("CREATE TABLE IF NOT EXISTS marketing_waitlist_contacts (id TEXT PRIMARY KEY NOT NULL,email_lookup_hash TEXT NOT NULL UNIQUE,email_ciphertext TEXT NOT NULL,email_iv TEXT NOT NULL,consent_version TEXT NOT NULL,consented_at INTEGER NOT NULL,unsubscribed_at INTEGER,version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    database.prepare("CREATE TABLE IF NOT EXISTS marketing_waitlist_interests (id TEXT PRIMARY KEY NOT NULL,contact_id TEXT NOT NULL REFERENCES marketing_waitlist_contacts(id) ON DELETE CASCADE,product TEXT NOT NULL,signup_source TEXT NOT NULL,joined_at INTEGER NOT NULL,UNIQUE(contact_id,product))"),
    database.prepare("CREATE TABLE IF NOT EXISTS marketing_waitlist_sync (id TEXT PRIMARY KEY NOT NULL,contact_id TEXT NOT NULL REFERENCES marketing_waitlist_contacts(id) ON DELETE CASCADE,contact_version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempt_token TEXT,lease_expires_at INTEGER,attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER,error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(contact_id,contact_version))"),
    database.prepare("CREATE INDEX IF NOT EXISTS marketing_waitlist_sync_status_next_idx ON marketing_waitlist_sync(status,next_attempt_at)"),
  ]);
}

function hexBytes(value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("waitlist_configuration_unavailable");
  return Uint8Array.from(value.match(/.{2}/g)!, (part) => Number.parseInt(part, 16));
}

function base64(bytes: Uint8Array) { return Buffer.from(bytes).toString("base64"); }
function unbase64(value: string) { return new Uint8Array(Buffer.from(value, "base64")); }

export function normalizeWaitlistInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_waitlist_request");
  const input = value as Record<string, unknown>;
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid_email");
  const products = Array.isArray(input.products) ? [...new Set(input.products)] : [];
  if (!products.length || products.length > 3 || products.some((product) => !WAITLIST_PRODUCTS.includes(product as WaitlistProduct))) throw new Error("invalid_products");
  if (input.source !== "home" && input.source !== "pricing") throw new Error("invalid_source");
  if (input.consent !== true || input.consentVersion !== WAITLIST_CONSENT_VERSION) throw new Error("marketing_consent_required");
  return { email, products: products as WaitlistProduct[], source: input.source as WaitlistSource, consentVersion: WAITLIST_CONSENT_VERSION };
}

export async function emailLookupHash(email: string, keyHex: string) {
  const key = await crypto.subtle.importKey("raw", hexBytes(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email.trim().toLowerCase()));
  return Buffer.from(digest).toString("hex");
}

export async function encryptWaitlistEmail(email: string, keyHex: string): Promise<SealedEmail> {
  const key = await crypto.subtle.importKey("raw", hexBytes(keyHex), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(email));
  return { ciphertext: base64(new Uint8Array(ciphertext)), iv: base64(iv) };
}

export async function decryptWaitlistEmail(sealed: SealedEmail, keyHex: string) {
  const key = await crypto.subtle.importKey("raw", hexBytes(keyHex), "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(sealed.iv) }, key, unbase64(sealed.ciphertext));
  return new TextDecoder().decode(plaintext);
}
