const JSON_CONTENT_TYPE = { "content-type": "application/json; charset=utf-8" };

export function jsonNoStore(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  for (const [key, value] of Object.entries(JSON_CONTENT_TYPE)) headers.set(key, value);
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function assertSameOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    throw jsonNoStore({ error: "Cross-site requests are not allowed." }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (!origin) return;
  const requestUrl = new URL(request.url);
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw jsonNoStore({ error: "Invalid request origin." }, { status: 403 });
  }
  if (originUrl.origin !== requestUrl.origin) {
    throw jsonNoStore({ error: "Cross-site requests are not allowed." }, { status: 403 });
  }
}

export async function readJsonObject(request: Request, maxBytes = 32_000) {
  const raw = new TextDecoder().decode(await readLimitedBytes(request, maxBytes));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw jsonNoStore({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw jsonNoStore({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  return parsed as Record<string, unknown>;
}

export async function readLimitedBytes(request: Request, maxBytes: number) {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw jsonNoStore({ error: "Request is too large." }, { status: 413 });
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw jsonNoStore({ error: "Request is too large." }, { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: init.signal || controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export function publicAppOrigin(request: Request) {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (!configured) return new URL(request.url).origin;
  const url = new URL(configured);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("PUBLIC_APP_URL must use HTTPS outside local development.");
  }
  return url.origin;
}
