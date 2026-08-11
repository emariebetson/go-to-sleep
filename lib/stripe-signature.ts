export async function verifyStripeSignature(payload: string, header: string, secret: string, nowMs = Date.now()) {
  const pairs = header.split(",").map((part) => {
    const separator = part.indexOf("=");
    return separator > 0 ? [part.slice(0, separator).trim(), part.slice(separator + 1).trim()] : ["", ""];
  });
  const timestamp = pairs.find(([key]) => key === "t")?.[1] || "";
  const timestampNumber = Number(timestamp);
  const signatures = pairs.filter(([key, value]) => key === "v1" && /^[a-f0-9]{64}$/i.test(value)).map(([, value]) => value.toLowerCase());
  if (!/^\d+$/.test(timestamp) || !Number.isFinite(timestampNumber) || !signatures.length || Math.abs(nowMs / 1000 - timestampNumber) > 300) return false;
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

export async function readLimitedText(request: Request, maxBytes: number) {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Response("Payload too large", { status: 413 });
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Response("Payload too large", { status: 413 });
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}
