export type ChildSafetyCategory = "sexual" | "violence" | "abuse" | "self_harm" | "unsafe_care";
export type ChildSafetyAssessment = { safe: true; category: null } | { safe: false; category: ChildSafetyCategory };
export type RemoteModerationVerdict = "safe" | "unsafe" | "unavailable";

function normalizedNarration(value: string) {
  const normalized = value.normalize("NFKC").toLowerCase().replace(/[013457!]/g, (character) => ({
    "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "!": "i",
  })[character] || character).replace(/[^a-z]+/g, " ").trim().replace(/\s+/g, " ");
  return { words: normalized, compact: normalized.replace(/\s+/g, "") };
}

export function assessChildNarrationSafety(value: string): ChildSafetyAssessment {
  const { words, compact } = normalizedNarration(value);
  const checks: Array<[ChildSafetyCategory, RegExp[]]> = [
    ["sexual", [/\b(?:sexual|sex|nude|naked|porn)\b/, /(?:sexualtouch|privateparts?|touch(?:their|your)?private)/]],
    ["self_harm", [/\b(?:self harm|suicide|hurt yourself|kill yourself)\b/, /(?:selfharm|hurtyourself|killyourself|suicid)/]],
    ["unsafe_care", [
      /\b(?:leave|abandon)\b.{0,32}\b(?:baby|child|infant)\b.{0,32}\b(?:alone|bath|car|water)\b/,
      /\b(?:place|put|lay|sleep)\b.{0,24}\b(?:baby|child|infant)\b.{0,24}\b(?:face down|on (?:their|the) stomach)\b/,
      /\b(?:cover|wrap)\b.{0,24}\b(?:baby|child|infant)(?: s)?\b.{0,24}\b(?:head|face)\b/,
      /\b(?:weighted)\b.{0,12}\b(?:blanket|swaddle|sleep sack)\b/,
      /\b(?:pillow|loose blanket|weighted blanket)\b.{0,24}\b(?:crib|bassinet)\b|\b(?:crib|bassinet)\b.{0,24}\b(?:pillow|loose blanket|weighted blanket)\b/,
      /\b(?:give|feed|offer)\b.{0,24}\b(?:baby|child|infant)\b.{0,24}\b(?:alcohol|wine|liquor|drug|poison)\b/,
      /\b(?:leave|let)\b.{0,24}\b(?:baby|child|infant)\b.{0,24}\b(?:unattended|unsupervised)\b.{0,24}\b(?:water|pool|bath|fire|stove)\b/,
      /(?:leave|abandon)(?:the)?(?:baby|child|infant)alone(?:inthe)?(?:bath|car|water)|(?:baby|child|infant)(?:facedown|onthestomach)|cover(?:the)?(?:baby|child|infant)(?:s)?(?:head|face)|weighted(?:blanket|swaddle)|(?:pillow|weightedblanket)(?:in)?(?:the)?(?:crib|bassinet)/,
    ]],
    ["abuse", [/\b(?:shake|hit|beat|hurt|punish)\b.{0,24}\b(?:baby|child|infant)\b/, /(?:shake|hit|beat|hurt|punish)(?:the)?(?:baby|child|infant)/]],
    ["violence", [/\b(?:kill|murder|shoot|stab|weapon|gun|knife|blood|gore|choke|smother|suffocate|burn|drown|poison)\b/, /(?:kill|murder|shoot|stab|weapon|choke|smother|suffocate|burn|drown|poison)/]],
  ];
  for (const [category, patterns] of checks) {
    if (patterns.some((pattern) => pattern.test(words) || pattern.test(compact))) return { safe: false, category };
  }
  return { safe: true, category: null };
}

export async function synthesizeAfterChildModeration<Result>(
  narration: string,
  moderate: (narration: string) => Promise<RemoteModerationVerdict>,
  synthesize: () => Promise<Result>,
) {
  const local = assessChildNarrationSafety(narration);
  if (!local.safe) throw new Error(`edited_narration_${local.category}`);
  let verdict: RemoteModerationVerdict;
  try { verdict = await moderate(narration); } catch { verdict = "unavailable"; }
  if (verdict !== "safe") throw new Error(verdict === "unsafe" ? "edited_narration_remote_unsafe" : "edited_narration_moderation_unavailable");
  return synthesize();
}

export async function moderatedNarrationOrFallback(
  generated: string,
  fallback: string,
  moderate: (narration: string) => Promise<RemoteModerationVerdict>,
) {
  const fallbackAssessment = assessChildNarrationSafety(fallback);
  if (!fallbackAssessment.safe) throw new Error("unsafe_child_safety_fallback");
  const local = assessChildNarrationSafety(generated);
  if (!local.safe) return { script: fallback, fallbackUsed: true, reason: `local_${local.category}` } as const;
  let remote: RemoteModerationVerdict;
  try { remote = await moderate(generated); } catch { remote = "unavailable"; }
  if (remote !== "safe") return {
    script: fallback,
    fallbackUsed: true,
    reason: remote === "unsafe" ? "remote_unsafe" : "moderation_unavailable",
  } as const;
  return { script: generated, fallbackUsed: false, reason: null } as const;
}
