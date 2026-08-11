import { fetchWithTimeout } from "./http";
import { stripeSecretMatchesMode } from "./stripe-config";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2026-07-29.dahlia";

function stripeHeaders(secret: string) {
  return { authorization: `Bearer ${secret}`, "stripe-version": STRIPE_API_VERSION };
}

export async function stripePost(path: string, values: Record<string, string | undefined>, options: { idempotencyKey?: string } = {}) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("Stripe is not configured.");
  if (!stripeSecretMatchesMode(secret, process.env.STRIPE_TEST_MODE_ONLY === "true")) throw new Error("Stripe test-mode configuration is required.");
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) body.set(key, value);
  const headers: Record<string, string> = { ...stripeHeaders(secret), "content-type": "application/x-www-form-urlencoded" };
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  const response = await fetchWithTimeout(`${STRIPE_API}${path}`, { method: "POST", headers, body });
  const payload = await response.json() as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || "Stripe rejected the request.");
  return payload;
}

export async function stripeDelete(path: string) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("Stripe is not configured.");
  if (!stripeSecretMatchesMode(secret, process.env.STRIPE_TEST_MODE_ONLY === "true")) throw new Error("Stripe test-mode configuration is required.");
  const response = await fetchWithTimeout(`${STRIPE_API}${path}`, { method: "DELETE", headers: stripeHeaders(secret) });
  if (!response.ok) {
    const payload = await response.json() as { error?: { message?: string } };
    throw new Error(payload.error?.message || "Stripe rejected the cancellation.");
  }
}
