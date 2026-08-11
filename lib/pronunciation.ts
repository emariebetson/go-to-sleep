function cleanText(value: unknown, limit: number) {
  return Array.from(String(value || "").normalize("NFKC"))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return character !== "<" && character !== ">" && (code > 31 || character === "\t" || character === "\n" || character === "\r");
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function cleanNickname(value: unknown) {
  return cleanText(value, 32);
}

export function normalizeNickname(value: unknown) {
  return cleanNickname(value).toLocaleLowerCase("en-US");
}

export function cleanPronunciation(value: unknown) {
  return cleanText(value, 64);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyPronunciation(text: string, childName: string, pronunciation: string) {
  const safeName = cleanNickname(childName);
  const safePronunciation = cleanPronunciation(pronunciation);
  if (!text || !safeName || !safePronunciation || safeName.toLocaleLowerCase("en-US") === safePronunciation.toLocaleLowerCase("en-US")) return text;
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(safeName)}(?=$|[^\\p{L}\\p{N}])`, "giu");
  return text.replace(pattern, (_match, prefix: string) => `${prefix}${safePronunciation}`);
}
