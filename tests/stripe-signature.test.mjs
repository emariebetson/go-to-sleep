import assert from "node:assert/strict";
import test from "node:test";
import { readLimitedText, verifyStripeSignature } from "../lib/stripe-signature.ts";

async function signature(payload, timestamp, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("accepts one valid v1 signature among multiple signatures", async () => {
  const payload = JSON.stringify({ id: "evt_test" });
  const secret = "whsec_test_secret";
  const now = 1_786_400_000_000;
  const timestamp = Math.floor(now / 1000);
  const valid = await signature(payload, timestamp, secret);
  assert.equal(await verifyStripeSignature(payload, `t=${timestamp},v1=${"0".repeat(64)},v1=${valid}`, secret, now), true);
  assert.equal(await verifyStripeSignature(`${payload}x`, `t=${timestamp},v1=${valid}`, secret, now), false);
});
test("rejects stale, future, malformed, missing, and nonnumeric signatures", async () => {
  const payload = "{}";
  const secret = "whsec_test_secret";
  const now = 1_786_400_000_000;
  for (const timestamp of [Math.floor(now / 1000) - 301, Math.floor(now / 1000) + 301]) {
    const digest = await signature(payload, timestamp, secret);
    assert.equal(await verifyStripeSignature(payload, `t=${timestamp},v1=${digest}`, secret, now), false);
  }
  assert.equal(await verifyStripeSignature(payload, "", secret, now), false);
  assert.equal(await verifyStripeSignature(payload, "t=nope,v1=bad", secret, now), false);
  assert.equal(await verifyStripeSignature(payload, "garbage", secret, now), false);
});

test("bounds webhook bodies even without Content-Length", async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("12345")); controller.enqueue(new TextEncoder().encode("67890")); controller.close(); } });
  const request = new Request("https://example.test/webhook", { method: "POST", body, duplex: "half" });
  await assert.rejects(() => readLimitedText(request, 8), (error) => error instanceof Response && error.status === 413);
});
