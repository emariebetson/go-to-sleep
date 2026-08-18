type ProviderErrorPayload = {
  detail?: unknown;
  voice_id?: unknown;
};

export type VoiceCreationError = {
  code: "voice_cloning_unavailable" | "provider_quota_exhausted" | "voice_sample_invalid" | "voice_provider_busy" | "voice_provider_unavailable";
  message: string;
  httpStatus: number;
};

export type SpeechGenerationError = {
  code: "provider_quota_exhausted" | "speech_provider_unavailable";
  message: string;
  httpStatus: number;
};

function providerErrorText(payload: ProviderErrorPayload) {
  try { return JSON.stringify(payload.detail ?? "").slice(0, 16_000); } catch { return ""; }
}

function providerUnavailable(): VoiceCreationError {
  return {
    code: "voice_provider_unavailable",
    message: "Voice setup is temporarily unavailable. Please try again later.",
    httpStatus: 502,
  };
}

export function classifyVoiceCreationError(status: number, payload: ProviderErrorPayload): VoiceCreationError {
  const detail = providerErrorText(payload).toLowerCase();
  const cloningPlanError = detail.includes("subscription_required")
    || detail.includes("paid subscription is required")
    || (detail.includes("instant voice cloning")
      && (detail.includes("subscription") || detail.includes("upgrade") || detail.includes("plan")));

  if (cloningPlanError) {
    return {
      code: "voice_cloning_unavailable",
      message: "Parent voice cloning is unavailable on NearSleep’s current provider plan.",
      httpStatus: 503,
    };
  }
  if ((status === 401 || status === 402 || status === 429)
    && (detail.includes("quota_exceeded") || detail.includes("exceeds your quota") || detail.includes("credits exhausted"))) {
    return {
      code: "provider_quota_exhausted",
      message: "NearSleep’s ElevenLabs credits are exhausted. Add provider credits or upgrade the ElevenLabs plan, then try again.",
      httpStatus: 503,
    };
  }
  if (status === 400 || status === 422) {
    return {
      code: "voice_sample_invalid",
      message: "ElevenLabs could not use that recording. Try again in a quiet room with 60–120 seconds of clear speech.",
      httpStatus: 422,
    };
  }
  if (status === 429) {
    return {
      code: "voice_provider_busy",
      message: "Voice setup is busy right now. Wait a minute, then try again.",
      httpStatus: 503,
    };
  }
  return providerUnavailable();
}

async function readProviderResponseText(response: Response, maxBytes = 64_000) {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel(); } catch { /* response is already unusable */ }
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    try { await reader.cancel(); } catch { /* response is already unusable */ }
    return null;
  }
}

export async function parseVoiceCreationResponse(response: Response): Promise<
  | { ok: true; voiceId: string; responseReadable: true }
  | { ok: false; failure: VoiceCreationError; responseReadable: boolean }
> {
  const raw = await readProviderResponseText(response);
  let payload: ProviderErrorPayload = {};
  let responseReadable = raw !== null;
  if (responseReadable) {
    try {
      const parsed = JSON.parse(raw!) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) responseReadable = false;
      else payload = parsed as ProviderErrorPayload;
    } catch {
      responseReadable = false;
    }
  }
  if (response.ok && responseReadable && typeof payload.voice_id === "string" && payload.voice_id.length > 0 && payload.voice_id.length <= 200) {
    return { ok: true, voiceId: payload.voice_id, responseReadable: true };
  }
  return { ok: false, responseReadable, failure: classifyVoiceCreationError(response.status, payload) };
}

export function classifyVoiceRequestException(error: unknown) {
  const rawClass = error === null ? "Null" : error === undefined ? "Undefined" : Object(error).constructor?.name;
  const causeClass = typeof rawClass === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(rawClass) ? rawClass : "Unknown";
  return { causeClass, failure: providerUnavailable() };
}

export function classifySpeechGenerationError(status: number, providerBody: string): SpeechGenerationError {
  const detail = providerBody.toLowerCase();
  if ((status === 401 || status === 402) && (detail.includes("quota_exceeded") || detail.includes("exceeds your quota"))) {
    return {
      code: "provider_quota_exhausted",
      message: "NearSleep’s ElevenLabs credits are exhausted. Add provider credits or upgrade the ElevenLabs plan, then try again.",
      httpStatus: 503,
    };
  }
  return {
    code: "speech_provider_unavailable",
    message: "Audio generation is temporarily unavailable.",
    httpStatus: 502,
  };
}
