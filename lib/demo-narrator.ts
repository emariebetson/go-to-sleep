export function demoNarratorEnabled() {
  return process.env.NEARNIGHT_ENABLE_DEMO_NARRATOR === "true" || process.env.NODE_ENV !== "production";
}

