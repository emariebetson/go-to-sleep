// Reviewed source activation is intentionally independent of runtime environment.
// PostgreSQL household authorization remains the second, mandatory gate.
const NEARFAMILY_SOURCE_ACTIVATED = false as const;

export function nearFamilySourceActivated(): boolean {
  return NEARFAMILY_SOURCE_ACTIVATED;
}
