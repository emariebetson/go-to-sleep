export const WAITLIST_CONSENT_VERSION = "marketing-consent-v1" as const;
export const WAITLIST_PRODUCTS = ["nearstory", "nearfamily", "nearlegacy"] as const;
export type WaitlistProduct = typeof WAITLIST_PRODUCTS[number];
export type WaitlistSource = "home" | "pricing";
export type SealedEmail = { ciphertext: string; iv: string };

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
