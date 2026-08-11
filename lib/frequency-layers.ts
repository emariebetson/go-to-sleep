export const SOLFEGGIO_FREQUENCIES = [174, 285, 396, 417, 528, 639, 741, 852, 963] as const;

export type SolfeggioFrequency = (typeof SOLFEGGIO_FREQUENCIES)[number];

export const SOLFEGGIO_OPTIONS: ReadonlyArray<{ frequency: SolfeggioFrequency; description: string }> = [
  { frequency: 174, description: "Traditionally associated with grounding and deep rest" },
  { frequency: 285, description: "Traditionally associated with restoration and renewal" },
  { frequency: 396, description: "Traditionally associated with releasing fear and tension" },
  { frequency: 417, description: "Traditionally associated with change and new beginnings" },
  { frequency: 528, description: "Traditionally associated with transformation and positive energy" },
  { frequency: 639, description: "Traditionally associated with connection and harmony" },
  { frequency: 741, description: "Traditionally associated with clarity and self-expression" },
  { frequency: 852, description: "Traditionally associated with intuition and inner awareness" },
  { frequency: 963, description: "Traditionally associated with wholeness and peace" },
];

const allowedFrequencies = new Set<number>(SOLFEGGIO_FREQUENCIES);

export function validateFrequencyLayers(value: unknown): SolfeggioFrequency[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Frequency layers must be an array.");
  if (value.length > 3) throw new Error("Choose no more than three frequency layers.");
  const result: SolfeggioFrequency[] = [];
  for (const candidate of value) {
    if (!Number.isInteger(candidate) || !allowedFrequencies.has(candidate)) throw new Error("An unsupported frequency layer was selected.");
    if (result.includes(candidate as SolfeggioFrequency)) throw new Error("Frequency layers cannot contain duplicates.");
    result.push(candidate as SolfeggioFrequency);
  }
  return result;
}

export function parseStoredFrequencyLayers(value: unknown): SolfeggioFrequency[] {
  try {
    return validateFrequencyLayers(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return [];
  }
}

export function frequencyGainPerOscillator(layerCount: number) {
  if (!Number.isFinite(layerCount) || layerCount <= 0) return 0;
  return 0.018 / Math.min(3, Math.max(1, Math.floor(layerCount)));
}

export function formatFrequencyLabel(layers: readonly SolfeggioFrequency[]) {
  const frequencies = validateFrequencyLayers(layers);
  return frequencies.length ? `${frequencies.join(" + ")} Hz` : "";
}
