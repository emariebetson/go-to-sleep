export const VISUALIZER_PALETTES = ["moonlit", "ocean", "aurora"] as const;
export const VISUALIZER_EFFECTS = ["glow", "orbs", "ripples"] as const;
export const VISUALIZER_MOTION_LEVELS = ["still", "subtle", "flowing"] as const;

export type VisualizerPalette = (typeof VISUALIZER_PALETTES)[number];
export type VisualizerEffect = (typeof VISUALIZER_EFFECTS)[number];
export type VisualizerMotion = (typeof VISUALIZER_MOTION_LEVELS)[number];

export type VisualizerPreferences = {
  palette: VisualizerPalette;
  effect: VisualizerEffect;
  motion: VisualizerMotion;
};

export const DEFAULT_VISUALIZER_PREFERENCES: VisualizerPreferences = {
  palette: "moonlit",
  effect: "glow",
  motion: "subtle",
};

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function parseVisualizerPreferences(value: unknown): VisualizerPreferences {
  if (typeof value !== "string") return { ...DEFAULT_VISUALIZER_PREFERENCES };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      palette: includes(VISUALIZER_PALETTES, parsed.palette) ? parsed.palette : DEFAULT_VISUALIZER_PREFERENCES.palette,
      effect: includes(VISUALIZER_EFFECTS, parsed.effect) ? parsed.effect : DEFAULT_VISUALIZER_PREFERENCES.effect,
      motion: includes(VISUALIZER_MOTION_LEVELS, parsed.motion) ? parsed.motion : DEFAULT_VISUALIZER_PREFERENCES.motion,
    };
  } catch {
    return { ...DEFAULT_VISUALIZER_PREFERENCES };
  }
}

export function visualizerAnimationState({
  playing,
  motion,
  reduceMotion,
}: {
  playing: boolean;
  motion: VisualizerMotion;
  reduceMotion: boolean;
}) {
  if (reduceMotion) return { active: false, motion: "still" as const };
  return { active: playing && motion !== "still", motion };
}
