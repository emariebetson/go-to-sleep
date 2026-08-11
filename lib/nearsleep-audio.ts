import { assessChildNarrationSafety } from "./child-safety";
import { canonicalGenerationFingerprint } from "./nearsleep-live";
import { prepareNarration, validateNarrationDuration } from "./session-narration";
import { validateSessionInput, type SessionInput } from "./sleep-session";

export type ParsedProductionAudioRequest = {
  input: SessionInput;
  childProfileId: string;
  narration: string;
  wordCount: number;
  fingerprint: string;
};

export type AudioGenerationResult = {
  generationMode: "preview" | "save";
  audioUrl: string;
  sessionId?: string;
  previewId?: string;
};

function localId(value: unknown, label: string) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{2,119}$/.test(id)) throw new Error(`Select a valid local ${label}.`);
  return id;
}

export async function parseProductionAudioRequest(body: Record<string, unknown>): Promise<ParsedProductionAudioRequest> {
  const childProfileId = localId(body.childId, "child profile");
  const ageMonths = Number(body.ageMonths);
  if (!Number.isInteger(ageMonths) || ageMonths < 0 || ageMonths > 96) throw new Error("Select a child age from 0 through 96 months.");
  const input = validateSessionInput(body);
  input.ageMonths = ageMonths;
  // In production this legacy-named field carries the local voices.id only.
  input.providerVoiceId = input.narrationKind === "parent_clone" ? localId(body.voiceId, "voice") : "";
  const prepared = prepareNarration(input);
  const narration = input.generationMode === "preview" ? prepared.preview : prepared.full;
  validateNarrationDuration(prepared.full, input.durationMinutes);
  const wordCount = narration.trim().split(/\s+/).filter(Boolean).length;
  if (!assessChildNarrationSafety(narration).safe) {
    throw new Error("The edited script contains language outside Nearnight’s safety boundaries. Please revise it before creating audio.");
  }
  const fingerprint = await canonicalGenerationFingerprint({
    input: {
      ...input,
      // Make the local-ID meaning explicit in the durable fingerprint.
      providerVoiceId: undefined,
      voiceId: input.providerVoiceId,
      childProfileId,
    },
    narration,
    wordCount,
  });
  return { input, childProfileId, narration, wordCount, fingerprint };
}

export async function productionSessionId(householdId: string, requestId: string) {
  const fingerprint = await canonicalGenerationFingerprint({ householdId, requestId, kind: "nearsleep_session" });
  return `nearsleep-${fingerprint.slice(0, 40)}`;
}

export function sessionAudioStorageKey(householdId: string, sessionId: string) {
  return `audio/${encodeURIComponent(householdId)}/${encodeURIComponent(sessionId)}.mp3`;
}

export function previewAudioStorageKey(householdId: string, requestId: string) {
  return `audio-previews/${encodeURIComponent(householdId)}/${encodeURIComponent(requestId)}.mp3`;
}

export function validateAudioGenerationResult(value: Record<string, unknown>): AudioGenerationResult {
  const keys = Object.keys(value);
  if (keys.some((key) => !["generationMode", "audioUrl", "sessionId", "previewId"].includes(key))) throw new Error("invalid_generation_result");
  const generationMode = value.generationMode;
  const audioUrl = value.audioUrl;
  if ((generationMode !== "preview" && generationMode !== "save") || typeof audioUrl !== "string" || !audioUrl.startsWith("/api/")) throw new Error("invalid_generation_result");
  if (generationMode === "save") {
    if (typeof value.sessionId !== "string" || !value.sessionId || value.previewId !== undefined || audioUrl !== `/api/audio/${encodeURIComponent(value.sessionId)}`) throw new Error("invalid_generation_result");
    return { generationMode, audioUrl, sessionId: value.sessionId };
  }
  if (typeof value.previewId !== "string" || !value.previewId || value.sessionId !== undefined || audioUrl !== `/api/audio-preview/${encodeURIComponent(value.previewId)}`) throw new Error("invalid_generation_result");
  return { generationMode, audioUrl, previewId: value.previewId };
}
