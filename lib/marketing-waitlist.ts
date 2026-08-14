export const WAITLIST_CONSENT_VERSION = "marketing-consent-v1" as const;
export const WAITLIST_PRODUCTS = ["nearstory", "nearfamily", "nearlegacy"] as const;
export type WaitlistProduct = typeof WAITLIST_PRODUCTS[number];
export type WaitlistSource = "home" | "pricing" | "nearstory" | "nearfamily" | "nearlegacy";
export type SealedEmail = { ciphertext: string; iv: string };
export type WaitlistInput = ReturnType<typeof normalizeWaitlistInput>;

const REQUEST_MARKER = "request_sha256:";

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
  if (!["home", "pricing", "nearstory", "nearfamily", "nearlegacy"].includes(input.source as string)) throw new Error("invalid_source");
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

async function waitlistRequestDigest(requestId: string, input: WaitlistInput, keyHex: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error("invalid_idempotency_key");
  const key = await crypto.subtle.importKey("raw", hexBytes(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const canonical = JSON.stringify({ requestId: requestId.toLowerCase(), email: input.email, products: [...input.products].sort(), source: input.source, consentVersion: input.consentVersion });
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical));
  return Buffer.from(digest).toString("hex");
}

async function loadRequest(database: D1Database, requestId: string) {
  return database.prepare("SELECT error_code marker FROM marketing_waitlist_sync WHERE id=?").bind(requestId.toLowerCase()).first<{ marker: string | null }>();
}

function assertExactRequest(record: { marker: string | null } | null, digest: string) {
  if (!record) return false;
  if (record.marker?.slice(0, REQUEST_MARKER.length + 64) !== `${REQUEST_MARKER}${digest}`) throw new Error("idempotency_conflict");
  return true;
}

function changedRows(result: unknown) {
  if (!result || typeof result !== "object") return 0;
  const value = result as { changes?: unknown; meta?: { changes?: unknown } };
  const changes = value.meta?.changes ?? value.changes;
  return typeof changes === "number" && Number.isSafeInteger(changes) ? changes : 0;
}

export async function recordWaitlistSignup(database: D1Database, input: WaitlistInput, keyHex: string, requestId: string) {
  await ensureMarketingWaitlistSchema(database);
  const normalizedRequestId = requestId.toLowerCase();
  const digest = await waitlistRequestDigest(normalizedRequestId, input, keyHex);
  if (assertExactRequest(await loadRequest(database, normalizedRequestId), digest)) return { products: input.products, replayed: true };

  const lookup = await emailLookupHash(input.email, keyHex);
  const sealed = await encryptWaitlistEmail(input.email, keyHex);
  const now = Date.now();
  const claim = crypto.randomUUID();
  const marker = `${REQUEST_MARKER}${digest}`;
  const statements: D1PreparedStatement[] = [
    database.prepare(`INSERT INTO marketing_waitlist_contacts
      (id,email_lookup_hash,email_ciphertext,email_iv,consent_version,consented_at,unsubscribed_at,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,NULL,0,?,?) ON CONFLICT(email_lookup_hash) DO NOTHING`)
      .bind(crypto.randomUUID(), lookup, sealed.ciphertext, sealed.iv, input.consentVersion, now, now, now),
    database.prepare(`INSERT INTO marketing_waitlist_sync
      (id,contact_id,contact_version,status,attempt_token,attempt_count,error_code,created_at,updated_at)
      SELECT ?,id,-1,'processing',?,0,?,?,? FROM marketing_waitlist_contacts WHERE email_lookup_hash=?
      ON CONFLICT(id) DO NOTHING`).bind(normalizedRequestId, claim, marker, now, now, lookup),
    database.prepare(`UPDATE marketing_waitlist_contacts SET email_ciphertext=?,email_iv=?,consent_version=?,consented_at=?,unsubscribed_at=NULL,version=version+1,updated_at=?
      WHERE email_lookup_hash=? AND EXISTS (SELECT 1 FROM marketing_waitlist_sync WHERE id=? AND attempt_token=? AND error_code=?)`)
      .bind(sealed.ciphertext, sealed.iv, input.consentVersion, now, now, lookup, normalizedRequestId, claim, marker),
  ];
  for (const product of input.products) statements.push(database.prepare(`INSERT INTO marketing_waitlist_interests
    (id,contact_id,product,signup_source,joined_at)
    SELECT ?,c.id,?,?,? FROM marketing_waitlist_contacts c JOIN marketing_waitlist_sync s ON s.contact_id=c.id
    WHERE c.email_lookup_hash=? AND s.id=? AND s.attempt_token=? AND s.error_code=?
    ON CONFLICT(contact_id,product) DO UPDATE SET signup_source=excluded.signup_source`)
    .bind(crypto.randomUUID(), product, input.source, now, lookup, normalizedRequestId, claim, marker));
  const finalizeIndex = statements.length;
  statements.push(database.prepare(`UPDATE marketing_waitlist_sync SET contact_version=(SELECT version FROM marketing_waitlist_contacts WHERE id=contact_id),status='pending',attempt_token=NULL,updated_at=?
    WHERE id=? AND attempt_token=? AND error_code=?`).bind(now, normalizedRequestId, claim, marker));
  statements.push(database.prepare(`DELETE FROM marketing_waitlist_contacts WHERE email_lookup_hash=? AND version=0
    AND NOT EXISTS (SELECT 1 FROM marketing_waitlist_sync WHERE contact_id=marketing_waitlist_contacts.id)`)
    .bind(lookup));
  let replayed = false;
  try {
    const results = await database.batch(statements);
    replayed = changedRows(results[finalizeIndex]) !== 1;
  } catch (error) {
    const recovered = await loadRequest(database, normalizedRequestId);
    if (!assertExactRequest(recovered, digest)) throw error;
    return { products: input.products, replayed: true };
  }
  const stored = await loadRequest(database, normalizedRequestId);
  if (!assertExactRequest(stored, digest)) throw new Error("waitlist_write_failed");
  return { products: input.products, replayed };
}
