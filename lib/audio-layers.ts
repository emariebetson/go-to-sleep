import { frequencyGainPerOscillator, validateFrequencyLayers } from "./frequency-layers";

export type ActiveFrequencyLayers = {
  oscillators: OscillatorNode[];
  masterGain: GainNode;
};

type FrequencyAudioContext = Pick<AudioContext, "createGain" | "createOscillator" | "destination">;

export function stopFrequencyLayers(active: ActiveFrequencyLayers | null) {
  if (!active) return;
  for (const oscillator of active.oscillators) {
    try { oscillator.stop(); } catch { /* already stopped */ }
    oscillator.disconnect();
  }
  active.masterGain.disconnect();
}

export function startFrequencyLayers(context: FrequencyAudioContext, value: unknown): ActiveFrequencyLayers | null {
  const frequencies = validateFrequencyLayers(value);
  if (!frequencies.length) return null;
  const masterGain = context.createGain();
  const active: ActiveFrequencyLayers = { oscillators: [], masterGain };
  masterGain.gain.value = frequencyGainPerOscillator(frequencies.length);
  masterGain.connect(context.destination);
  try {
    for (const frequency of frequencies) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(masterGain);
      oscillator.start();
      active.oscillators.push(oscillator);
    }
    return active;
  } catch (error) {
    stopFrequencyLayers(active);
    throw error;
  }
}
