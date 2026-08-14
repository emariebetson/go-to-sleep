# Product-card waitlist hover design

## Scope

Enhance only the three coming-soon product buttons on the NearYou Still company homepage: NearStory, NearFamily, and NearLegacy. NearSleep remains unchanged.

## Interaction

- Default label: `Meet NearStory`, `Meet NearFamily`, or `Meet NearLegacy`.
- Hover and keyboard focus reveal an accent-colored layer that moves upward within the button and reads `Join the waitlist →`.
- The whole control remains one link to the existing product hub. No nested control, direct submission, or gated application destination is added.
- Touch devices retain the default label because they do not have a dependable hover state.
- `prefers-reduced-motion: reduce` removes the transition and swaps the layer immediately.

## Visual behavior

The moving layer is clipped to the existing rounded button boundary. It uses the product card's restrained accent treatment, preserves the current button size, and does not move surrounding layout. Text remains legible at every state.

## Accessibility

The accessible name remains the visible default “Meet…” destination so screen readers receive a stable link label. The animated prompt is decorative and hidden from assistive technology. Keyboard focus triggers the same visual invitation as pointer hover, while the existing visible focus treatment remains intact.

## Verification

- A component contract test proves only coming-soon cards receive the two-layer CTA.
- The test proves the default label, decorative waitlist label, unchanged product-hub destination, and accessible-hidden animation.
- Styles are checked for hover, focus-visible, touch-safe behavior, and reduced-motion handling.
- Existing company-page, product-catalog, accessibility, type, lint, build, and deployment checks remain green.

## Guardrails

This is a public marketing interaction only. It does not enable NearStory, NearFamily, NearLegacy, canary, scheduler, or readiness gates, and it does not change waitlist persistence or consent.
