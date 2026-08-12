import { cleanPronunciation, normalizeNickname } from "./pronunciation";
import { VOICE_CONSENT_ATTESTATION, VOICE_CONSENT_VERSION, type JobType } from "./nearyou-foundation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_JOB_TYPES = new Set(["nearsleep_audio", "story_audio", "archive_transcription", "media_export"]);

function requiredUuid(value: unknown, field: string) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${field} must be a UUID.`);
  return value.toLowerCase();
}

function cleanText(value: unknown, field: string, maxLength: number) {
  const cleaned = typeof value === "string"
    ? Array.from(value.normalize("NFKC")).filter((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127).join("").trim()
    : "";
  if (!cleaned || cleaned.length > maxLength) throw new Error(`${field} is required and must be at most ${maxLength} characters.`);
  return cleaned;
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return null;
  return cleanText(value, field, maxLength);
}

export function parseHouseholdInput(body: Record<string, unknown>) {
  return { name: cleanText(body.name, "name", 100) };
}

export function parseActiveHouseholdInput(body: Record<string, unknown>) {
  const householdId = typeof body.householdId === "string" ? body.householdId.trim() : "";
  if (!/^[A-Za-z0-9:_-]{1,200}$/.test(householdId)) throw new Error("householdId is invalid.");
  return { householdId };
}

export function parseOwnershipTransferInput(body: Record<string, unknown>) {
  const newOwnerUserId = typeof body.newOwnerUserId === "string" ? body.newOwnerUserId.trim() : "";
  if (!/^[A-Za-z0-9:_-]{1,200}$/.test(newOwnerUserId)) throw new Error("newOwnerUserId is invalid.");
  return { newOwnerUserId };
}

export function parseInvitationInput(body: Record<string, unknown>): { requestId: string; email: string; role: "adult_manager" | "contributor" | "listener" } {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("A valid invitation email is required.");
  const role = body.role;
  if (role !== "adult_manager" && role !== "contributor" && role !== "listener") throw new Error("Invitation role must be adult_manager, contributor, or listener.");
  return { requestId: requiredUuid(body.requestId, "requestId"), email, role: role as "adult_manager" | "contributor" | "listener" };
}

export function parseInvitationAcceptanceInput(body: Record<string, unknown>) {
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("A valid invitation token is required.");
  return { token };
}

export function parseChildProfileInput(body: Record<string, unknown>) {
  if (["email", "password", "auth", "userId", "accountId"].some((field) => field in body)) {
    throw new Error("Child accounts are disabled; profiles must be managed by an adult household member.");
  }
  const nickname = cleanText(body.nickname, "nickname", 80);
  const ageMonths = body.ageMonths === undefined || body.ageMonths === null
    ? null
    : Number(body.ageMonths);
  if (ageMonths !== null && (!Number.isInteger(ageMonths) || ageMonths < 0 || ageMonths > 216)) {
    throw new Error("ageMonths must be an integer from 0 through 216.");
  }
  return {
    requestId: requiredUuid(body.requestId, "requestId"),
    nickname,
    normalizedNickname: normalizeNickname(nickname),
    pronunciation: cleanPronunciation(body.pronunciation),
    ageMonths,
    bedtimeChallenge: optionalText(body.bedtimeChallenge, "bedtimeChallenge", 240),
  };
}

export function parseVoiceConsentInput(body: Record<string, unknown>) {
  if (body.allowPosthumousSynthesis === true) throw new Error("Posthumous synthesis is disabled.");
  if (body.adultSelfAttestation !== true) throw new Error("The adult account holder must attest that this is their own voice.");
  if (body.attestation !== VOICE_CONSENT_ATTESTATION) throw new Error("The current voice consent attestation is required.");
  if (body.consentVersion !== VOICE_CONSENT_VERSION) throw new Error(`Unsupported consent version; expected ${VOICE_CONSENT_VERSION}.`);
  return {
    requestId: requiredUuid(body.requestId, "requestId"),
    voiceId: requiredUuid(body.voiceId, "voiceId"),
    consentVersion: VOICE_CONSENT_VERSION,
    scope: "adult_self_private_narration" as const,
  };
}

export function parsePlaylistInput(body: Record<string, unknown>) {
  return {
    requestId: requiredUuid(body.requestId, "requestId"),
    name: cleanText(body.name, "name", 100),
  };
}

export function parseJobInput(body: Record<string, unknown>) {
  if (typeof body.type !== "string" || !SAFE_JOB_TYPES.has(body.type)) throw new Error("Unsupported job type.");
  if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) throw new Error("input must be a JSON object.");
  if (new TextEncoder().encode(JSON.stringify(body.input)).byteLength > 16_000) throw new Error("Job input is too large.");
  return {
    requestId: requiredUuid(body.requestId, "requestId"),
    type: body.type as JobType,
    input: body.input as Record<string, unknown>,
  };
}
