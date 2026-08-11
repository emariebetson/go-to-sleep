"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { startFrequencyLayers, stopFrequencyLayers, type ActiveFrequencyLayers } from "@/lib/audio-layers";
import { parseStoredFrequencyLayers } from "@/lib/frequency-layers";
import { SleepVisualizer } from "@/components/SleepVisualizer";

type SleepPlayerProps = { src: string; sound: string; frequencies?: readonly number[] };
type AmbientSoundGraph = { source: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode };
const PLAYER_START_EVENT = "nearnight:player-start";

export function SleepPlayer({ src, sound, frequencies = [] }: SleepPlayerProps) {
  const playerId = useId();
  const contextRef = useRef<AudioContext | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const visualizerLauncherRef = useRef<HTMLButtonElement>(null);
  const ambientSoundRef = useRef<AmbientSoundGraph | null>(null);
  const frequencyLayersRef = useRef<ActiveFrequencyLayers | null>(null);
  const playingLayersRef = useRef(false);
  const playbackEpochRef = useRef(0);
  const pendingStartRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [mediaPaused, setMediaPaused] = useState(true);
  const [visualizerOpen, setVisualizerOpen] = useState(false);
  const [playbackTime, setPlaybackTime] = useState({ currentTime: 0, duration: 0 });

  const stopSound = useCallback(() => {
    playbackEpochRef.current += 1;
    pendingStartRef.current = false;
    try { ambientSoundRef.current?.source.stop(); } catch { /* already stopped */ }
    ambientSoundRef.current?.source.disconnect();
    ambientSoundRef.current?.filter.disconnect();
    ambientSoundRef.current?.gain.disconnect();
    ambientSoundRef.current = null;
    stopFrequencyLayers(frequencyLayersRef.current);
    frequencyLayersRef.current = null;
    playingLayersRef.current = false;
  }, []);
  const closeVisualizer = useCallback(() => setVisualizerOpen(false), []);

  async function startSound() {
    const safeFrequencies = parseStoredFrequencyLayers(frequencies);
    if (sound === "none" && !safeFrequencies.length) return;
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    if (playingLayersRef.current || pendingStartRef.current) return;
    const playbackEpoch = ++playbackEpochRef.current;
    pendingStartRef.current = true;
    try {
      const context = contextRef.current || new AudioContextClass();
      contextRef.current = context;
      await context.resume();
      if (playbackEpoch !== playbackEpochRef.current || audioRef.current?.paused !== false) return;
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
        ambientSoundRef.current = { source, filter, gain };
      }
      frequencyLayersRef.current = startFrequencyLayers(context, safeFrequencies);
      playingLayersRef.current = Boolean(ambientSoundRef.current || frequencyLayersRef.current);
    } catch {
      stopSound();
    } finally {
      if (playbackEpoch === playbackEpochRef.current) pendingStartRef.current = false;
    }
  }

  const frequencyKey = frequencies.join(",");
  useEffect(() => { stopSound(); }, [frequencyKey, sound, src, stopSound]);
  useEffect(() => {
    const stopOtherPlayer = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== playerId) audioRef.current?.pause();
    };
    window.addEventListener(PLAYER_START_EVENT, stopOtherPlayer);
    return () => window.removeEventListener(PLAYER_START_EVENT, stopOtherPlayer);
  }, [playerId]);
  useEffect(() => () => {
    stopSound();
    const context = contextRef.current;
    contextRef.current = null;
    void context?.close();
  }, [stopSound]);

  return (
    <div className="sleep-player">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- The full narration transcript is the editable script immediately above this player. */}
      <audio controls preload="none" ref={audioRef} src={src}
        onLoadStart={() => { setPlaying(false); setMediaPaused(true); setVisualizerOpen(false); setPlaybackTime({ currentTime: 0, duration: 0 }); }}
        onLoadedMetadata={(event) => setPlaybackTime({ currentTime: event.currentTarget.currentTime, duration: event.currentTarget.duration })}
        onTimeUpdate={(event) => setPlaybackTime({ currentTime: event.currentTarget.currentTime, duration: event.currentTarget.duration })}
        onPlay={() => { window.dispatchEvent(new CustomEvent(PLAYER_START_EVENT, { detail: playerId })); setMediaPaused(false); setPlaying(true); void startSound(); }}
        onWaiting={() => { setPlaying(false); stopSound(); }}
        onSeeking={() => { setPlaying(false); stopSound(); }}
        onSeeked={(event) => { if (!event.currentTarget.paused) { setPlaying(true); void startSound(); } }}
        onPlaying={() => { setMediaPaused(false); setPlaying(true); void startSound(); }}
        onError={() => { setMediaPaused(true); setPlaying(false); stopSound(); }}
        onPause={() => { setMediaPaused(true); setPlaying(false); stopSound(); }}
        onEnded={() => { setMediaPaused(true); setPlaying(false); stopSound(); }} style={{ width: "100%" }}>
        Your browser does not support audio playback.
      </audio>
      <button className="visualizer-launcher" ref={visualizerLauncherRef} type="button" onClick={() => setVisualizerOpen(true)}>✦ Open soothing visualizer</button>
      {(sound !== "none" || frequencies.length > 0) && <small style={{ display: "block", marginTop: 6, color: "var(--ink-soft)" }}>Background layers are created on this device and stop with the voice track.</small>}
      {visualizerOpen && <SleepVisualizer
        launcherRef={visualizerLauncherRef}
        open={visualizerOpen}
        playing={playing}
        paused={mediaPaused}
        currentTime={playbackTime.currentTime}
        duration={playbackTime.duration}
        onClose={closeVisualizer}
        onTogglePlayback={() => {
          const audio = audioRef.current;
          if (!audio) return;
          if (audio.paused) void audio.play();
          else audio.pause();
        }}
        onSeek={(time) => {
          if (audioRef.current && Number.isFinite(time)) audioRef.current.currentTime = time;
        }}
      />}
    </div>
  );
}
