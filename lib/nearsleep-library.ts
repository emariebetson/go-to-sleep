const REPEAT_TIMERS = new Set([15, 30, 45, 60]);

export type LibraryCursor = { createdAt: number; id: string };

export function encodeLibraryCursor(value: LibraryCursor) {
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt <= 0 || !value.id || value.id.length > 200) throw new Error("Library cursor data is invalid.");
  const bytes = new TextEncoder().encode(JSON.stringify([value.createdAt, value.id]));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeLibraryCursor(cursor: string): LibraryCursor {
  try {
    if (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid");
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(cursor.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || parsed[0] <= 0 || typeof parsed[1] !== "string" || !parsed[1] || parsed[1].length > 200) throw new Error("invalid");
    return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    throw new Error("Library cursor is invalid.");
  }
}

export function parseLibrarySessionUpdate(body: Record<string, unknown>) {
  if (typeof body.favorite !== "boolean") throw new Error("favorite must be true or false.");
  const repeatMinutes = body.repeatMinutes === null ? null : Number(body.repeatMinutes);
  if (repeatMinutes !== null && !REPEAT_TIMERS.has(repeatMinutes)) {
    throw new Error("repeatMinutes must be null, 15, 30, 45, or 60.");
  }
  return { favorite: body.favorite, repeatMinutes };
}

export function safeAudioFilename(title: string, sessionId: string) {
  const normalized = title.normalize("NFKD").replace(/[^\u0020-\u007E]/g, "").trim().toLowerCase().replace(/\.mp3$/i, "");
  const safeTitle = normalized.replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "session";
  return `${safeTitle || `nearsleep-${safeId}`}.mp3`;
}

export async function sha256Hex(value: ArrayBuffer | ArrayBufferView) {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function canonicalRequestHash(value: unknown) {
  function canonical(input: unknown): string {
    if (input === null || typeof input === "string" || typeof input === "boolean") return JSON.stringify(input);
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    if (input && typeof input === "object") {
      return `{${Object.entries(input as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
    }
    throw new Error("Request data must be JSON-compatible.");
  }
  return sha256Hex(new TextEncoder().encode(canonical(value)));
}

export function portableConsentEvidence(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const receipt: Record<string, string | boolean> = {};
  if (typeof source.kind === "string" && source.kind.length <= 80) receipt.kind = source.kind;
  for (const key of ["challengeVersion", "phraseHash", "audioSha256", "transcriptSha256", "transcriptionProvider", "transcriptionModel", "transcriptMatch", "replacementProviderVoiceIdHash"] as const) {
    if (typeof source[key] === "string" && source[key].length <= 160) receipt[key] = source[key];
  }
  for (const key of ["verified", "liveness", "cloneBoundToChallengeRecording", "posthumousSynthesis"] as const) if (typeof source[key] === "boolean") receipt[key] = source[key];
  return receipt;
}
