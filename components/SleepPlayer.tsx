"use client";

import { useCallback, useEffect, useRef } from "react";
import { startFrequencyLayers, stopFrequencyLayers, type ActiveFrequencyLayers } from "@/lib/audio-layers";
import { parseStoredFrequencyLayers } from "@/lib/frequency-layers";

type SleepPlayerProps = { src: string; sound: string; frequencies?: readonly number[] };

export function SleepPlayer({ src, sound, frequencies = [] }: SleepPlayerProps) {
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const frequencyLayersRef = useRef<ActiveFrequencyLayers | null>(null);
  const playingLayersRef = useRef(false);

  const stopSound = useCallback(() => {
    try { sourceRef.current?.stop(); } catch { /* already stopped */ }
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    stopFrequencyLayers(frequencyLayersRef.current);
    frequencyLayersRef.current = null;
    playingLayersRef.current = false;
  }, []);

  async function startSound() {
    if (playingLayersRef.current) return;
    const safeFrequencies = parseStoredFrequencyLayers(frequencies);
    if (sound === "none" && !safeFrequencies.length) return;
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      const context = contextRef.current || new AudioContextClass();
      contextRef.current = context;
      await context.resume();
      if (sound !== "none") {
        const frameCount = context.sampleRate * 3;
        const buffer = context.createBuffer(1, frameCount, context.sampleRate);
        const channel = buffer.getChannelData(0);
        let brown = 0;
        for (let index = 0; index < frameCount; index++) {
          const white = Math.random() * 2 - 1;
          brown = (brown + 0.02 * white) / 1.02;
          channel[index] = sound === "brown-noise" ? brown * 3.2 : white * 0.34;
        }
        const source = context.createBufferSource();
        const filter = context.createBiquadFilter();
        const gain = context.createGain();
        source.buffer = buffer;
        source.loop = true;
        filter.type = sound === "soft-rain" ? "bandpass" : "lowpass";
        filter.frequency.value = sound === "soft-rain" ? 2600 : 520;
        filter.Q.value = sound === "soft-rain" ? 0.55 : 0.3;
        gain.gain.value = sound === "soft-rain" ? 0.055 : 0.075;
        source.connect(filter).connect(gain).connect(context.destination);
        source.start();
        sourceRef.current = source;
      }
      frequencyLayersRef.current = startFrequencyLayers(context, safeFrequencies);
      playingLayersRef.current = Boolean(sourceRef.current || frequencyLayersRef.current);
    } catch {
      stopSound();
    }
  }

  const frequencyKey = frequencies.join(",");
  useEffect(() => { stopSound(); }, [frequencyKey, sound, src, stopSound]);
  useEffect(() => () => {
    stopSound();
    const context = contextRef.current;
    contextRef.current = null;
    void context?.close();
  }, [stopSound]);

  return (
    <div>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- The full narration transcript is the editable script immediately above this player. */}
      <audio controls src={src} onPlay={() => void startSound()} onPause={stopSound} onEnded={stopSound} style={{ width: "100%" }}>
        Your browser does not support audio playback.
      </audio>
      {(sound !== "none" || frequencies.length > 0) && <small style={{ display: "block", marginTop: 6, color: "var(--ink-soft)" }}>Background layers are created on this device and stop with the voice track.</small>}
    </div>
  );
}
