type ProviderErrorPayload = {
  detail?: string | {
    message?: string;
    status?: string;
    code?: string;
  };
};

export type VoiceCreationError = {
  code: "voice_cloning_unavailable" | "voice_sample_invalid" | "voice_provider_busy" | "voice_provider_unavailable";
  message: string;
  httpStatus: number;
};

export type SpeechGenerationError = {
  code: "provider_quota_exhausted" | "speech_provider_unavailable";
  message: string;
  httpStatus: number;
};

function providerErrorText(payload: ProviderErrorPayload) {
  if (typeof payload.detail === "string") return payload.detail;
  return [payload.detail?.status, payload.detail?.code, payload.detail?.message].filter(Boolean).join(" ");
}

export function classifyVoiceCreationError(status: number, payload: ProviderErrorPayload): VoiceCreationError {
  const detail = providerErrorText(payload).toLowerCase();
  const cloningPlanError = detail.includes("instant voice cloning")
    && (detail.includes("subscription") || detail.includes("upgrade") || detail.includes("plan"));

  if (cloningPlanError) {
    return {
      code: "voice_cloning_unavailable",
      message: "Parent voice cloning is unavailable on Nearnight’s current provider plan.",
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
  return {
    code: "voice_provider_unavailable",
    message: "Voice setup is temporarily unavailable. Please try again later.",
    httpStatus: 502,
  };
}

export function classifySpeechGenerationError(status: number, providerBody: string): SpeechGenerationError {
  const detail = providerBody.toLowerCase();
  if ((status === 401 || status === 402) && (detail.includes("quota_exceeded") || detail.includes("exceeds your quota"))) {
    return {
      code: "provider_quota_exhausted",
      message: "Nearnight’s ElevenLabs credits are exhausted. Add provider credits or upgrade the ElevenLabs plan, then try again.",
      httpStatus: 503,
    };
  }
  return {
    code: "speech_provider_unavailable",
    message: "Audio generation is temporarily unavailable.",
    httpStatus: 502,
  };
}
