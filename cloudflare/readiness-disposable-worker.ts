type WorkerDependencies = Readonly<{
  gatewayUrl: string;
  keyBase64: string;
  now(): number;
  nonce(): string;
  fetch: typeof fetch;
}>;

const BODY = /^\{"householdHash":"([a-f0-9]{64})","releaseId":"(rel_[A-Za-z0-9_-]{8,100})"\}$/;

function bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function base64Url(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function buffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createDisposableDecisionWorker(input: WorkerDependencies): (request: Request) => Promise<Response> {
  if (!/^https:\/\/[^/?#]+\/v1\/nearfamily\/decision$/.test(input.gatewayUrl) || !/^[A-Za-z0-9+/]{43}=$/.test(input.keyBase64) || typeof input.fetch !== "function") throw new Error("disposable decision worker invalid");
  const keyBytes = bytes(input.keyBase64);
  if (keyBytes.byteLength !== 32) throw new Error("disposable decision worker invalid");
  return async (request) => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/nearfamily/decision") return new Response("not found", { status: 404 });
    if (request.headers.get("content-type") !== "application/json") return new Response("denied", { status: 415 });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 4096) return new Response("denied", { status: 413 });
    const match = BODY.exec(raw);
    if (!match) return new Response("denied", { status: 400 });
    const [, householdHash, releaseId] = match;
    const issuedAt = input.now(), nonce = input.nonce();
    if (!Number.isSafeInteger(issuedAt) || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)) return new Response("unavailable", { status: 503 });
    const bodySha256 = await sha256(raw);
    const claims = `{"bodySha256":"${bodySha256}","householdHash":"${householdHash}","issuedAt":${issuedAt},"keyVersion":1,"nonce":"${nonce}","releaseId":"${releaseId}","version":1}`;
    const key = await crypto.subtle.importKey("raw", buffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = base64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(claims)));
    const envelope = `{"bodySha256":"${bodySha256}","householdHash":"${householdHash}","issuedAt":${issuedAt},"keyVersion":1,"nonce":"${nonce}","releaseId":"${releaseId}","signature":"${signature}","version":1}`;
    try {
      return await input.fetch(input.gatewayUrl, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: envelope });
    } catch { return new Response("unavailable", { status: 503 }); }
  };
}

type Env = { READINESS_GATEWAY_URL: string; NEARFAMILY_DECISION_SIGNING_KEY: string };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return createDisposableDecisionWorker({
      gatewayUrl: env.READINESS_GATEWAY_URL,
      keyBase64: env.NEARFAMILY_DECISION_SIGNING_KEY,
      now: Date.now,
      nonce: () => crypto.randomUUID().replace(/-/g, ""),
      fetch,
    })(request);
  },
};
