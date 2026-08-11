import { applyPronunciation } from "./pronunciation";
import { previewExcerpt, type SessionInput } from "./sleep-session";

type NarrationInput = Pick<SessionInput, "script" | "childName" | "pronunciation">;

export function prepareNarration(input: NarrationInput) {
  const full = applyPronunciation(input.script, input.childName, input.pronunciation);
  return { full, preview: previewExcerpt(full) };
}

export function validateNarrationDuration(narration: string, durationMinutes: 5 | 10 | 15 | 20) {
  const words = narration.trim().split(/\s+/).filter(Boolean).length;
  const maximumWords = durationMinutes * 120;
  if (words > maximumWords) throw new Error(`The edited narration is too long for a ${durationMinutes}-minute session. Shorten it before generating audio.`);
  return words;
}
