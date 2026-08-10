import { fetchWithTimeout } from "./http";

const STRIPE_API = "https://api.stripe.com/v1";

export async function stripePost(path: string, values: Record<string, string | undefined>) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("Stripe is not configured.");
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) body.set(key, value);
  const response = await fetchWithTimeout(`${STRIPE_API}${path}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/x-www-form-urlencoded" }, body });
  const payload = await response.json() as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || "Stripe rejected the request.");
  return payload;
}

export async function stripeDelete(path: string) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("Stripe is not configured.");
  const response = await fetchWithTimeout(`${STRIPE_API}${path}`, { method: "DELETE", headers: { authorization: `Bearer ${secret}` } });
  if (!response.ok) {
    const payload = await response.json() as { error?: { message?: string } };
    throw new Error(payload.error?.message || "Stripe rejected the cancellation.");
  }
}

export async function verifyStripeSignature(payload: string, header: string, secret: string) {
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !signatures.length || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return signatures.some((signature) => timingSafeEqual(expected, signature));
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return mismatch === 0;
}
