export const ADULT_ONBOARDING_VERSION = "adult-caregiver-v1";
export const ADULT_ONBOARDING_ATTESTATION = "I am an adult caregiver and I will use NearSleep only for private, caregiver-managed household narration.";
export const VOICE_VERIFICATION_VERSION = "live-phrase-v1";
export const VERIFIED_VOICE_CONSENT_VERSION = "voice-v2-live-phrase";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHALLENGE_WORDS = [
  "amber", "breeze", "calm", "cedar", "cloud", "cove", "dawn", "drift",
  "fern", "gentle", "glow", "harbor", "honey", "lantern", "lilac", "meadow",
  "mist", "moon", "moss", "nest", "pearl", "petal", "pine", "quiet",
  "rain", "river", "sage", "silver", "sky", "soft", "star", "still",
  "stream", "tide", "willow", "winter", "wood", "wren", "yellow", "zephyr",
] as const;

export function parseAdultOnboardingAcceptance(body: Record<string, unknown>) {
  const requestId = typeof body.requestId === "string" ? body.requestId.trim().toLowerCase() : "";
  if (!UUID.test(requestId)) throw new Error("A valid onboarding request ID is required.");
  if (body.version !== ADULT_ONBOARDING_VERSION) throw new Error("The current adult caregiver onboarding version is required.");
  if (body.adultAccount !== true || body.caregiverResponsibility !== true || body.privateHouseholdUse !== true) {
    throw new Error("Every adult caregiver onboarding confirmation is required.");
  }
  if (body.attestation !== ADULT_ONBOARDING_ATTESTATION) throw new Error("The current caregiver attestation is required.");
  return { version: ADULT_ONBOARDING_VERSION, requestId };
}

export function parseVoiceChallengeRequest(body: Record<string, unknown>) {
  const requestId = typeof body.requestId === "string" ? body.requestId.trim().toLowerCase() : "";
  const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim().toLowerCase() : "";
  if (!UUID.test(requestId) || !UUID.test(voiceId)) throw new Error("Valid request and voice IDs are required.");
  return { requestId, voiceId };
}

export function validateLiveVoiceSample(sample: FormDataEntryValue | null) {
  const allowed = new Set(["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"]);
  const type = sample instanceof File ? sample.type.split(";", 1)[0].toLowerCase() : "";
  if (!(sample instanceof File) || sample.size < 100_000 || sample.size > 10_000_000 || !allowed.has(type)) {
    throw new Error("Record the full live verification passage as WebM, MP4, MP3, or WAV under 10 MB.");
  }
  return sample;
}

export function createVoiceChallengePhrase(randomValues?: Uint32Array) {
  const values = randomValues || crypto.getRandomValues(new Uint32Array(6));
  if (values.length < 6) throw new Error("Six random values are required for a voice challenge.");
  return {
    version: VOICE_VERIFICATION_VERSION,
    phrase: Array.from(values.slice(0, 6), (value) => CHALLENGE_WORDS[value % CHALLENGE_WORDS.length]).join(" "),
  } as const;
}

export function normalizeVerificationTranscript(value: unknown) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function verificationTranscriptMatches(transcript: unknown, phrase: unknown) {
  const normalizedPhrase = normalizeVerificationTranscript(phrase);
  return normalizedPhrase.split(" ").length === 6 && normalizeVerificationTranscript(transcript) === normalizedPhrase;
}

export function verificationTranscriptContainsPhrase(transcript: unknown, phrase: unknown) {
  const normalizedTranscript = ` ${normalizeVerificationTranscript(transcript)} `;
  const normalizedPhrase = normalizeVerificationTranscript(phrase);
  return normalizedPhrase.split(" ").length === 6 && normalizedTranscript.includes(` ${normalizedPhrase} `);
}

export async function voiceChallengePhraseHash(challengeId: string, phrase: string) {
  const bytes = new TextEncoder().encode(`${VOICE_VERIFICATION_VERSION}:${challengeId}:${normalizeVerificationTranscript(phrase)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildVerifiedConsentEvidence(input: {
  challengeId: string;
  challengeVersion: string;
  phraseHash: string;
  audioSha256: string;
  transcriptSha256: string;
  transcriptionModel: string;
  transcriptionRequestId: string;
  previousProviderVoiceId: string;
  replacementProviderVoiceId: string;
}) {
  if (!input.replacementProviderVoiceId || input.replacementProviderVoiceId === input.previousProviderVoiceId) {
    throw new Error("A challenge-recording replacement clone is required for verified consent.");
  }
  return {
    kind: "live_random_phrase_replacement_clone",
    verified: true,
    challengeId: input.challengeId,
    challengeVersion: input.challengeVersion,
    phraseHash: input.phraseHash,
    audioSha256: input.audioSha256,
    transcriptSha256: input.transcriptSha256,
    transcriptionProvider: "openai",
    transcriptionModel: input.transcriptionModel,
    transcriptionRequestId: input.transcriptionRequestId,
    transcriptMatch: "contained_exact_normalized_phrase",
    cloneBoundToChallengeRecording: true,
    replacementProviderVoiceIdHash: await sha256(input.replacementProviderVoiceId),
    posthumousSynthesis: false,
  } as const;
}
