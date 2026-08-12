import { env } from "cloudflare:workers";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { emailLookupHash, encryptWaitlistEmail, ensureMarketingWaitlistSchema, normalizeWaitlistInput } from "@/lib/marketing-waitlist";

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    const input = normalizeWaitlistInput(await readJsonObject(request, 4_096));
    const key = process.env.MARKETING_WAITLIST_ENCRYPTION_KEY || "";
    if (!/^[a-f0-9]{64}$/i.test(key)) return jsonNoStore({ error: "The waitlist is temporarily unavailable." }, { status: 503 });
    await ensureMarketingWaitlistSchema(env.DB);
    const lookup = await emailLookupHash(input.email, key);
    const sealed = await encryptWaitlistEmail(input.email, key);
    const now = Date.now();
    const contactId = crypto.randomUUID();
    const contact = env.DB.prepare(`INSERT INTO marketing_waitlist_contacts
      (id,email_lookup_hash,email_ciphertext,email_iv,consent_version,consented_at,unsubscribed_at,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,NULL,1,?,?)
      ON CONFLICT(email_lookup_hash) DO UPDATE SET email_ciphertext=excluded.email_ciphertext,email_iv=excluded.email_iv,
      consent_version=excluded.consent_version,consented_at=excluded.consented_at,unsubscribed_at=NULL,version=version+1,updated_at=excluded.updated_at`)
      .bind(contactId, lookup, sealed.ciphertext, sealed.iv, input.consentVersion, now, now, now);
    const statements = [contact];
    for (const product of input.products) statements.push(env.DB.prepare(`INSERT INTO marketing_waitlist_interests
      (id,contact_id,product,signup_source,joined_at) VALUES (?,(SELECT id FROM marketing_waitlist_contacts WHERE email_lookup_hash=?),?,?,?)
      ON CONFLICT(contact_id,product) DO UPDATE SET signup_source=excluded.signup_source`)
      .bind(crypto.randomUUID(), lookup, product, input.source, now));
    statements.push(env.DB.prepare(`INSERT INTO marketing_waitlist_sync
      (id,contact_id,contact_version,status,attempt_count,created_at,updated_at)
      SELECT ?,id,version,'pending',0,?,? FROM marketing_waitlist_contacts WHERE email_lookup_hash=?
      ON CONFLICT(contact_id,contact_version) DO NOTHING`).bind(crypto.randomUUID(), now, now, lookup));
    await env.DB.batch(statements);
    return jsonNoStore({ products: input.products }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    const code = error instanceof Error ? error.message : "";
    if (["invalid_waitlist_request", "invalid_email", "invalid_products", "invalid_source", "marketing_consent_required"].includes(code)) {
      return jsonNoStore({ error: code === "marketing_consent_required" ? "Marketing consent is required." : "Check your email and product selections." }, { status: 400 });
    }
    return jsonNoStore({ error: "The waitlist is temporarily unavailable." }, { status: 503 });
  }
}
