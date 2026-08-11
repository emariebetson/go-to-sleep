import { applyPronunciation } from "./pronunciation";
import { previewExcerpt, type SessionInput } from "./sleep-session";

type NarrationInput = Pick<SessionInput, "script" | "childName" | "pronunciation">;

export function prepareNarration(input: NarrationInput) {
  const full = applyPronunciation(input.script, input.childName, input.pronunciation);
  return { full, preview: previewExcerpt(full) };
}
