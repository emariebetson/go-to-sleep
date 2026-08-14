import { env } from "cloudflare:workers";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { normalizeWaitlistInput, recordWaitlistSignup } from "@/lib/marketing-waitlist";

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    const input = normalizeWaitlistInput(await readJsonObject(request, 4_096));
    const idempotencyKey = request.headers.get("idempotency-key") || "";
    const key = process.env.MARKETING_WAITLIST_ENCRYPTION_KEY || "";
    if (!/^[a-f0-9]{64}$/i.test(key)) return jsonNoStore({ error: "The waitlist is temporarily unavailable." }, { status: 503 });
    const result = await recordWaitlistSignup(env.DB, input, key, idempotencyKey);
    return jsonNoStore({ products: result.products }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    const code = error instanceof Error ? error.message : "";
    if (["invalid_waitlist_request", "invalid_email", "invalid_products", "invalid_source", "marketing_consent_required", "invalid_idempotency_key", "idempotency_conflict"].includes(code)) {
      return jsonNoStore({ error: code === "marketing_consent_required" ? "Marketing consent is required." : "Check your email and product selections." }, { status: 400 });
    }
    return jsonNoStore({ error: "The waitlist is temporarily unavailable." }, { status: 503 });
  }
}
