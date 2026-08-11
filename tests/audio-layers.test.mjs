import assert from "node:assert/strict";
import test from "node:test";
import { startFrequencyLayers, stopFrequencyLayers } from "../lib/audio-layers.ts";

class FakeNode {
  connectedTo = [];
  disconnected = false;
  connect(node) { this.connectedTo.push(node); return node; }
  disconnect() { this.disconnected = true; }
}

class FakeOscillator extends FakeNode {
  frequency = { value: 0 };
  type = "";
  started = false;
  stopped = false;
  start() { this.started = true; }
  stop() { this.stopped = true; }
}

class FakeGain extends FakeNode {
  gain = { value: 0 };
}

test("frequency layers start supported sine oscillators at bounded gain", () => {
  const oscillators = [];
  const context = {
    destination: new FakeNode(),
    createGain() { return new FakeGain(); },
    createOscillator() { const oscillator = new FakeOscillator(); oscillators.push(oscillator); return oscillator; },
  };

  const active = startFrequencyLayers(context, [174, 528, 963]);

  assert.deepEqual(oscillators.map((oscillator) => oscillator.frequency.value), [174, 528, 963]);
  assert.ok(oscillators.every((oscillator) => oscillator.type === "sine" && oscillator.started));
  assert.ok(active.masterGain.gain.value * oscillators.length <= 0.018);
});

test("frequency layer cleanup stops and disconnects every created node", () => {
  const oscillators = [];
  const context = {
    destination: new FakeNode(),
    createGain() { return new FakeGain(); },
    createOscillator() { const oscillator = new FakeOscillator(); oscillators.push(oscillator); return oscillator; },
  };
  const active = startFrequencyLayers(context, [174, 528]);

  stopFrequencyLayers(active);

  assert.ok(oscillators.every((oscillator) => oscillator.stopped && oscillator.disconnected));
  assert.equal(active.masterGain.disconnected, true);
});
