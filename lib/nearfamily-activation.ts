// This is intentionally a closed vocabulary: the public path has no value that
// enables it, and an omitted Worker binding remains dark.
export function nearFamilySourceActivated(value?: unknown): boolean {
  return value === "private";
}
