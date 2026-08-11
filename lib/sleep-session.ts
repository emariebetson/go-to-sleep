import { canonicalYouTubeUrl } from "./youtube-source";
import { validateFrequencyLayers, type SolfeggioFrequency } from "./frequency-layers";
import { cleanPronunciation } from "./pronunciation";

export type SessionInput = {
  requestId: string;
  childName: string;
  pronunciation: string;
  ageMonths: number;
  challenge: "settling" | "frequent-waking" | "separation" | "overtired" | "nap-transition";
  theme: "moonlit-meadow" | "sleepy-sea" | "cloud-garden";
  durationMinutes: 5 | 10 | 15 | 20;
  sound: "soft-rain" | "brown-noise" | "none";
  frequencies: SolfeggioFrequency[];
  style: "slow-story" | "rhythmic" | "lullaby";
  scriptMode: "curated" | "personalized";
  contentType: "story" | "sleep-hypnosis";
  sourceUrl: string;
  sourceTitle: string;
  script: string;
  providerVoiceId: string;
  narrationKind: "parent_clone" | "demo_narrator";
  generationMode: "preview" | "save";
};

const allowed = {
  challenge: ["settling", "frequent-waking", "separation", "overtired", "nap-transition"],
  theme: ["moonlit-meadow", "sleepy-sea", "cloud-garden"],
  duration: ["5", "10", "15", "20"],
  sound: ["soft-rain", "brown-noise", "none"],
  style: ["slow-story", "rhythmic", "lullaby"],
  scriptMode: ["curated", "personalized"],
  contentType: ["story", "sleep-hypnosis"],
  generationMode: ["preview", "save"],
  narrationKind: ["parent_clone", "demo_narrator"],
} as const;

const unsafeScriptPatterns = [
  /\b(?:guarantee|promise)\b.{0,24}\b(?:sleep|asleep)\b/i,
  /\b(?:cure|diagnose|treat(?:ment)?)\b/i,
  /\bignore\b.{0,24}\b(?:cry|crying|cries)\b/i,
  /\b(?:stomach|belly|side)\s+(?:sleep|sleeping|position)\b/i,
  /\b(?:medicine|medication|dosage|dose)\b/i,
  /\b(?:hypnosis|hypnotize|hypnotic)\b/i,
];

export function validateNarrationSafety(script: string) {
  if (unsafeScriptPatterns.some((pattern) => pattern.test(script))) {
    throw new Error("The edited script contains language outside Nearnight’s safety boundaries. Please revise it before creating audio.");
  }
  return script;
}

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
  validateNarrationSafety(script);
  const narrationKind = allowedValue("narrationKind", body.narrationKind);
  const providerVoiceId = cleanText(body.voiceId, 80);
  if (narrationKind === "parent_clone" && !/^[A-Za-z0-9_-]{8,80}$/.test(providerVoiceId)) throw new Error("Create or select your voice first.");
  const duration = allowedValue("duration", body.duration);
  return {
    requestId,
    childName,
    pronunciation: cleanPronunciation(body.pronunciation),
    ageMonths,
    challenge: allowedValue("challenge", body.challenge),
    theme: allowedValue("theme", body.theme),
    durationMinutes: Number(duration) as SessionInput["durationMinutes"],
    sound: allowedValue("sound", body.sound),
    frequencies: validateFrequencyLayers(body.frequencies),
    style: allowedValue("style", body.style),
    scriptMode: allowedValue("scriptMode", body.scriptMode),
    contentType: allowedValue("contentType", body.contentType),
    sourceUrl: canonicalYouTubeUrl(body.sourceUrl),
    sourceTitle: cleanText(body.sourceTitle, 160),
    script,
    providerVoiceId,
    narrationKind,
    generationMode: allowedValue("generationMode", body.generationMode),
  };
}

export function previewExcerpt(script: string, maxWords = 68) {
  const words = script.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  const excerpt = words.slice(0, maxWords).join(" ");
  const lastSentence = Math.max(excerpt.lastIndexOf(". "), excerpt.lastIndexOf("! "), excerpt.lastIndexOf("? "));
  return `${lastSentence >= 35 ? excerpt.slice(0, lastSentence + 1) : excerpt.replace(/[,:;\s]+$/, "") + "…"}`;
}
