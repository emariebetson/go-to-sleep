"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  DEFAULT_VISUALIZER_PREFERENCES,
  parseVisualizerPreferences,
  visualizerAnimationState,
  type VisualizerEffect,
  type VisualizerMotion,
  type VisualizerPalette,
  type VisualizerPreferences,
} from "@/lib/visualizer-config";

const STORAGE_KEY = "nearnight:visualizer:v1";
const paletteOptions: ReadonlyArray<{ value: VisualizerPalette; label: string }> = [
  { value: "moonlit", label: "Moonlit" },
  { value: "ocean", label: "Ocean" },
  { value: "aurora", label: "Aurora" },
];
const effectOptions: ReadonlyArray<{ value: VisualizerEffect; label: string }> = [
  { value: "glow", label: "Breathing glow" },
  { value: "orbs", label: "Drifting orbs" },
  { value: "ripples", label: "Gentle ripples" },
];
const motionOptions: ReadonlyArray<{ value: VisualizerMotion; label: string }> = [
  { value: "still", label: "Still" },
  { value: "subtle", label: "Subtle" },
  { value: "flowing", label: "Flowing" },
];

type SleepVisualizerProps = {
  launcherRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  playing: boolean;
  paused: boolean;
  currentTime: number;
  duration: number;
  onClose(): void;
  onTogglePlayback(): void;
  onSeek(time: number): void;
};

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function SleepVisualizer({ launcherRef, open, playing, paused, currentTime, duration, onClose, onTogglePlayback, onSeek }: SleepVisualizerProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [preferences, setPreferences] = useState<VisualizerPreferences>(DEFAULT_VISUALIZER_PREFERENCES);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [deviceFullscreen, setDeviceFullscreen] = useState(false);
  const [supportsDeviceFullscreen, setSupportsDeviceFullscreen] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(query.matches);
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try { setPreferences(parseVisualizerPreferences(window.localStorage.getItem(STORAGE_KEY))); } catch { /* storage can be disabled */ }
      setSupportsDeviceFullscreen(document.fullscreenEnabled && typeof HTMLElement.prototype.requestFullscreen === "function");
      update();
    });
    query.addEventListener("change", update);
    return () => { active = false; query.removeEventListener("change", update); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const launcher = launcherRef.current;
    const overlay = overlayRef.current;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const controls = Array.from(overlay?.querySelectorAll<HTMLElement>("button:not(:disabled), summary, input:not(:disabled)") || []);
        if (!controls.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const onFullscreenChange = () => setDeviceFullscreen(document.fullscreenElement === overlay);
    const onVisibilityChange = () => setPageVisible(!document.hidden);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (document.fullscreenElement === overlay) void document.exitFullscreen();
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      launcher?.focus();
    };
  }, [launcherRef, onClose, open]);

  function updatePreferences(next: Partial<VisualizerPreferences>) {
    setPreferences((current) => {
      const updated = { ...current, ...next };
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch { /* storage can be disabled */ }
      return updated;
    });
  }

  async function toggleDeviceFullscreen() {
    try {
      if (document.fullscreenElement === overlayRef.current) await document.exitFullscreen();
      else await overlayRef.current?.requestFullscreen();
    } catch {
      setDeviceFullscreen(false);
    }
  }

  const animation = visualizerAnimationState({ playing: playing && pageVisible, motion: preferences.motion, reduceMotion });
  const progressMax = Number.isFinite(duration) && duration > 0 ? duration : 0;

  return <div
    aria-hidden={!open}
    aria-label="Soothing bedtime visualizer"
    aria-modal="true"
    className={`sleep-visualizer palette-${preferences.palette} effect-${preferences.effect} motion-${animation.motion} ${animation.active ? "is-active" : "is-paused"} ${open ? "is-open" : ""}`}
    ref={overlayRef}
    role="dialog"
  >
    <div className="visualizer-scene" aria-hidden="true">
      <span className="visualizer-halo" />
      <span className="visualizer-shape shape-one" />
      <span className="visualizer-shape shape-two" />
      <span className="visualizer-shape shape-three" />
      <span className="visualizer-ring ring-one" />
      <span className="visualizer-ring ring-two" />
      <span className="visualizer-ring ring-three" />
      <span className="visualizer-moon" />
    </div>

    <div className="visualizer-topbar">
      <div><span className="eyebrow">Nearnight</span><strong>Soothing visualizer</strong></div>
      <div className="visualizer-top-actions">
        {supportsDeviceFullscreen && <button className="visualizer-icon-button visualizer-fullscreen-button" type="button" onClick={() => void toggleDeviceFullscreen()} aria-label={deviceFullscreen ? "Exit device fullscreen" : "Fill device screen"}>{deviceFullscreen ? "↙" : "↗"}</button>}
        <button className="visualizer-icon-button" type="button" onClick={onClose} ref={closeRef} aria-label="Close visualizer">×</button>
      </div>
    </div>

    <div className="visualizer-controls">
      <button className="visualizer-play" type="button" onClick={onTogglePlayback} aria-label={paused ? "Play bedtime" : "Pause bedtime"}>{paused ? "▶" : "Ⅱ"}</button>
      <div className="visualizer-timeline">
        <input aria-label="Bedtime playback position" type="range" min="0" max={progressMax} step="0.1" value={Math.min(currentTime, progressMax)} disabled={!progressMax} onChange={(event) => onSeek(Number(event.target.value))} />
        <div><span>{formatTime(currentTime)}</span><span>{formatTime(duration)}</span></div>
      </div>
      <details className="visualizer-customize">
        <summary>Customize</summary>
        <div className="visualizer-options">
          <fieldset><legend>Colors</legend><div>{paletteOptions.map((option) => <button aria-pressed={preferences.palette === option.value} key={option.value} type="button" onClick={() => updatePreferences({ palette: option.value })}>{option.label}</button>)}</div></fieldset>
          <fieldset><legend>Effect</legend><div>{effectOptions.map((option) => <button aria-pressed={preferences.effect === option.value} key={option.value} type="button" onClick={() => updatePreferences({ effect: option.value })}>{option.label}</button>)}</div></fieldset>
          <fieldset><legend>Motion</legend><div>{motionOptions.map((option) => <button aria-pressed={preferences.motion === option.value} key={option.value} type="button" onClick={() => updatePreferences({ motion: option.value })}>{option.label}</button>)}</div>{reduceMotion && <small>Your device’s reduced-motion setting keeps the scene still.</small>}</fieldset>
        </div>
      </details>
    </div>
  </div>;
}
