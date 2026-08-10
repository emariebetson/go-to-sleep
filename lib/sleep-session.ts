export type SessionInput = {
  requestId: string;
  childName: string;
  ageMonths: number;
  challenge: "settling" | "frequent-waking" | "separation" | "overtired" | "nap-transition";
  theme: "moonlit-meadow" | "sleepy-sea" | "cloud-garden";
  durationMinutes: 5 | 10 | 15 | 20;
  sound: "soft-rain" | "brown-noise" | "none";
  style: "slow-story" | "rhythmic" | "lullaby";
  scriptMode: "curated" | "personalized";
  script: string;
  providerVoiceId: string;
};

const allowed = {
  challenge: ["settling", "frequent-waking", "separation", "overtired", "nap-transition"],
  theme: ["moonlit-meadow", "sleepy-sea", "cloud-garden"],
  duration: ["5", "10", "15", "20"],
  sound: ["soft-rain", "brown-noise", "none"],
  style: ["slow-story", "rhythmic", "lullaby"],
  scriptMode: ["curated", "personalized"],
} as const;

const unsafeScriptPatterns = [
  /\b(?:guarantee|promise)\b.{0,24}\b(?:sleep|asleep)\b/i,
  /\b(?:cure|diagnose|treat(?:ment)?)\b/i,
  /\bignore\b.{0,24}\b(?:cry|crying|cries)\b/i,
  /\b(?:stomach|belly|side)\s+(?:sleep|sleeping|position)\b/i,
  /\b(?:medicine|medication|dosage|dose)\b/i,
  /\b(?:hypnosis|hypnotize|hypnotic)\b/i,
];

function cleanText(value: unknown, limit: number) {
  return Array.from(String(value || ""))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return character !== "<" && character !== ">" && (code > 31 || character === "\t" || character === "\n" || character === "\r");
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function allowedValue<K extends keyof typeof allowed>(key: K, value: unknown) {
  const candidate = String(value || "");
  if (!allowed[key].includes(candidate as never)) throw new Error(`Invalid ${key}.`);
  return candidate as (typeof allowed)[K][number];
}

export function validateSessionInput(body: Record<string, unknown>): SessionInput {
  const requestId = String(body.requestId || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
    throw new Error("A valid generation request ID is required.");
  }
  const childName = cleanText(body.childName, 32);
  if (!childName) throw new Error("A baby nickname is required.");
  const ageMonths = Math.max(0, Math.min(24, Number.parseInt(String(body.ageMonths || "0"), 10) || 0));
  const script = String(body.script || "").replace(/\r\n/g, "\n").trim();
  if (script.length < 80 || script.length > 18_000) throw new Error("Review the script length and try again.");
  if (unsafeScriptPatterns.some((pattern) => pattern.test(script))) {
    throw new Error("The edited script contains language outside Nearnight’s safety boundaries. Please revise it before creating audio.");
  }
  const providerVoiceId = cleanText(body.voiceId, 80);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(providerVoiceId)) throw new Error("Create or select your voice first.");
  const duration = allowedValue("duration", body.duration);
  return {
    requestId,
    childName,
    ageMonths,
    challenge: allowedValue("challenge", body.challenge),
    theme: allowedValue("theme", body.theme),
    durationMinutes: Number(duration) as SessionInput["durationMinutes"],
    sound: allowedValue("sound", body.sound),
    style: allowedValue("style", body.style),
    scriptMode: allowedValue("scriptMode", body.scriptMode),
    script,
    providerVoiceId,
  };
}
