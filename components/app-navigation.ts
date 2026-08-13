export type AppNavigationKey = "studio" | "stories" | "family" | "legacy" | "library" | "account";
export type AppNavigationLink = readonly [AppNavigationKey, string, string];

export async function resolveFamilyNavigationAvailability(explicit: boolean | undefined, load: () => Promise<{ available: boolean }>) {
  return explicit ?? (await load()).available;
}

export function appNavigationLinks(input: { showStories: boolean; showLegacy: boolean; familyAvailable: boolean }): AppNavigationLink[] {
  return [
    ["studio", "/studio", "Create a bedtime"],
    ...(input.showStories ? [["stories", "/stories", "Create a story"] as const] : []),
    ...(input.familyAvailable ? [["family", "/family", "Family capacity"] as const] : []),
    ...(input.showLegacy ? [["legacy", "/legacy", "Family archive"] as const] : []),
    ["library", "/library", "My nights"],
    ["account", "/account", "Voice & account"],
  ];
}
