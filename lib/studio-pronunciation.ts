import { cleanNickname } from "./pronunciation";

export function shouldApplyPronunciationGuess(
  requestedNickname: string,
  currentNickname: string,
  manualVersionAtRequest: number,
  currentManualVersion: number,
) {
  return Boolean(cleanNickname(requestedNickname))
    && cleanNickname(requestedNickname) === cleanNickname(currentNickname)
    && manualVersionAtRequest === currentManualVersion;
}
