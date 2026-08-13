type AxeModule = { source?: unknown; default?: { source?: unknown } };

export function resolveAxeSource(module: AxeModule): string {
  const source = module.source ?? module.default?.source;
  if (typeof source !== "string" || source.length < 100_000) {
    throw new Error("accessibility runtime unavailable");
  }
  return source;
}
