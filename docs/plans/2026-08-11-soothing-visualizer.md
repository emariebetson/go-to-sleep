# Soothing visualizer implementation plan

## Product behavior

- Add an optional full-viewport visualizer to every generated-audio player.
- Offer three palettes: Moonlit, Ocean, and Aurora.
- Offer three effects: Breathing glow, Drifting orbs, and Gentle ripples.
- Offer Still, Subtle, and Flowing motion levels; honor the operating-system reduced-motion preference.
- Animate only while the narration is playing and never interrupt playback when the visualizer opens or closes.
- Save visualizer choices in local storage on the parent’s device.
- Keep controls keyboard accessible, label decorative visuals for assistive technology, support Escape to close, and restore focus to the launcher.

## Implementation

1. Add a pure visualizer configuration module with bounded preference parsing.
2. Add unit tests for defaults, untrusted stored settings, and animation state.
3. Build a client-only `SleepVisualizer` overlay used by `SleepPlayer`.
4. Connect player events and elapsed playback time without routing protected audio through a second media source.
5. Add responsive CSS and reduced-motion overrides.
6. Run lint, typecheck, production build, focused tests, full tests, and browser playback checks.
7. Request a hyper-critical review and address any verified blockers.
