import { decryptWaitlistEmail } from "./marketing-waitlist";

type RuntimeEnv = { DB: D1Database; GOOGLE_WAITLIST_SHEET_ID?: string; GOOGLE_SERVICE_ACCOUNT_EMAIL?: string; GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string };

function b64url(value: string | Uint8Array) { return Buffer.from(value).toString("base64url"); }
function pemBytes(pem: string) { return Uint8Array.from(Buffer.from(pem.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64")); }

async function googleToken(config: RuntimeEnv) {
  if (!config.GOOGLE_SERVICE_ACCOUNT_EMAIL || !config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) throw new Error("google_configuration");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: config.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 300 }));
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${b64url(new Uint8Array(signature))}` }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("google_auth");
  const body = await response.json() as { access_token?: string };
  if (!body.access_token) throw new Error("google_auth");
  return body.access_token;
}

async function upsertGoogleRow(sheetId: string, token: string, values: string[]) {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values`;
  const current = await fetch(`${base}/${encodeURIComponent("Waitlist!A:H")}?majorDimension=ROWS`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!current.ok) throw new Error("google_read");
  const rows = (await current.json() as { values?: string[][] }).values || [];
  const index = rows.findIndex((row) => row[0] === values[0]);
  const range = index >= 0 ? `Waitlist!A${index + 1}:H${index + 1}` : "Waitlist!A:H";
  const method = index >= 0 ? "PUT" : "POST";
  const suffix = index >= 0 ? `/${encodeURIComponent(range)}?valueInputOption=RAW` : `/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const response = await fetch(`${base}${suffix}`, { method, headers, body: JSON.stringify({ values: [values] }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("google_write");
}

export async function processOneWaitlistSync(runtime: RuntimeEnv, encryptionKey: string) {
  const token = crypto.randomUUID();
  const now = Date.now();
  const claim = await runtime.DB.prepare(`UPDATE marketing_waitlist_sync SET status='processing',attempt_token=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=?
    WHERE id=(SELECT id FROM marketing_waitlist_sync WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT 1)
    RETURNING id,contact_id contactId,contact_version contactVersion`).bind(token, now + 60_000, now, now).first<{ id: string; contactId: string; contactVersion: number }>();
  if (!claim) return { processed: 0 };
  try {
    const contact = await runtime.DB.prepare("SELECT email_ciphertext ciphertext,email_iv iv,consent_version consentVersion,consented_at consentedAt,unsubscribed_at unsubscribedAt FROM marketing_waitlist_contacts WHERE id=? AND version=?").bind(claim.contactId, claim.contactVersion).first<{ ciphertext: string; iv: string; consentVersion: string; consentedAt: number; unsubscribedAt: number | null }>();
    if (!contact) throw new Error("stale_contact");
    const interests = await runtime.DB.prepare("SELECT product,signup_source source FROM marketing_waitlist_interests WHERE contact_id=? ORDER BY product").bind(claim.contactId).all<{ product: string; source: string }>();
    const email = await decryptWaitlistEmail(contact, encryptionKey);
    const access = await googleToken(runtime);
    if (!runtime.GOOGLE_WAITLIST_SHEET_ID) throw new Error("google_configuration");
    await upsertGoogleRow(runtime.GOOGLE_WAITLIST_SHEET_ID, access, [claim.contactId, email, interests.results.map((row) => row.product).join(", "), [...new Set(interests.results.map((row) => row.source))].join(", "), contact.consentVersion, new Date(contact.consentedAt).toISOString(), contact.unsubscribedAt ? "unsubscribed" : "subscribed", new Date().toISOString()]);
    await runtime.DB.prepare("UPDATE marketing_waitlist_sync SET status='completed',attempt_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND attempt_token=?").bind(Date.now(), claim.id, token).run();
    return { processed: 1 };
  } catch {
    await runtime.DB.prepare("UPDATE marketing_waitlist_sync SET status=CASE WHEN attempt_count>=5 THEN 'dead_letter' ELSE 'pending' END,next_attempt_at=?,error_code=CASE WHEN error_code LIKE 'request_sha256:%' THEN error_code ELSE 'sync_failed' END,attempt_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND attempt_token=?").bind(Date.now() + 60_000, Date.now(), claim.id, token).run();
    throw new Error("waitlist_sync_failed");
  }
}

export const WAITLIST_SHEET_HIDDEN_COLUMN = "hidden_contact_id";
