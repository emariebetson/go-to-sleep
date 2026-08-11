import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VISUALIZER_PREFERENCES,
  parseVisualizerPreferences,
  visualizerAnimationState,
} from "../lib/visualizer-config.ts";

test("visualizer preferences default to a calm, subtle presentation", () => {
  assert.deepEqual(parseVisualizerPreferences(undefined), DEFAULT_VISUALIZER_PREFERENCES);
  assert.deepEqual(parseVisualizerPreferences("not-json"), DEFAULT_VISUALIZER_PREFERENCES);
});

test("visualizer preferences accept only supported values", () => {
  assert.deepEqual(parseVisualizerPreferences(JSON.stringify({
    palette: "ocean",
    effect: "ripples",
    motion: "flowing",
  })), { palette: "ocean", effect: "ripples", motion: "flowing" });

  assert.deepEqual(parseVisualizerPreferences(JSON.stringify({
    palette: "neon",
    effect: "strobe",
    motion: "extreme",
  })), DEFAULT_VISUALIZER_PREFERENCES);
});

test("animation pauses with audio and becomes still for reduced motion", () => {
  assert.deepEqual(visualizerAnimationState({ playing: true, motion: "flowing", reduceMotion: false }), {
    active: true,
    motion: "flowing",
  });
  assert.deepEqual(visualizerAnimationState({ playing: false, motion: "flowing", reduceMotion: false }), {
    active: false,
    motion: "flowing",
  });
  assert.deepEqual(visualizerAnimationState({ playing: true, motion: "flowing", reduceMotion: true }), {
    active: false,
    motion: "still",
  });
});
