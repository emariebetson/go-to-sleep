export function redactRestoreFailure(stage: string, error: unknown): string {
  const reason = (error instanceof Error ? error.message : "unknown")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgres-url-redacted")
    .replace(/\b(?:ya29\.|token_)[-._A-Za-z0-9]{20,4096}\b/g, "token-redacted")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
  return `stage=${stage} reason=${reason}`;
}
