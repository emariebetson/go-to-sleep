# Product Card Waitlist Hover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an animated “Join the waitlist →” hover and keyboard-focus layer to the NearStory, NearFamily, and NearLegacy buttons on the NearYou Still company homepage.

**Architecture:** Keep each CTA as one link to its existing product hub. Render two text layers only for catalog entries marked `coming_soon`, then use CSS transforms inside the clipped button boundary to reveal the decorative waitlist layer without layout shift.

**Tech Stack:** React server components, Next-compatible Link wrapper, CSS, Node test runner, TypeScript, Vinext/Sites.

## Global Constraints

- NearSleep remains unchanged.
- Coming-soon links continue to target their existing product hubs.
- The accessible name remains the default “Meet…” label.
- Hover and keyboard focus receive equivalent visual behavior.
- Touch devices retain the default label.
- Reduced-motion users receive an immediate state change.
- No product, canary, scheduler, or readiness gate is enabled.

---

### Task 1: Coming-soon card CTA

**Files:**
- Modify: `components/ProductFamily.tsx`
- Modify: `app/globals.css`
- Modify: `tests/nearyoustill-public.test.mjs`

**Interfaces:**
- Consumes: `NearYouProduct.availability`, `NearYouProduct.path`, and `NearYouProduct.name`.
- Produces: a single `.product-waitlist-cta` link with `.product-waitlist-cta-default` and decorative `.product-waitlist-cta-hover` text layers.

- [ ] **Step 1: Write the failing test**

Add assertions that the public product-family component renders the two CTA layers only for `coming_soon` products, keeps the hub path, and marks the hover layer `aria-hidden="true"`. Assert CSS includes hover, `:focus-visible`, `(hover: hover) and (pointer: fine)`, and `prefers-reduced-motion: reduce`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run the NearYou Still public test file. Expected: failure because the layered CTA classes and styles do not exist.

- [ ] **Step 3: Implement the minimal component and styles**

For each coming-soon card, render:

```tsx
<Link className="btn btn-secondary product-waitlist-cta" href={product.path}>
  <span className="product-waitlist-cta-default">{`Meet ${product.name}`}</span>
  <span aria-hidden="true" className="product-waitlist-cta-hover">Join the waitlist <span>→</span></span>
</Link>
```

Keep the existing NearSleep link unchanged. Clip the link, stack both labels, and translate the hover layer into view only for fine-pointer hover and `:focus-visible`. Disable transition timing under reduced motion.

- [ ] **Step 4: Verify the focused and regression gates**

Run the focused tests, full test suite, TypeScript, scoped ESLint, production build, and `git diff --check`. Expected: every command exits successfully.

- [ ] **Step 5: Commit and publish**

Commit the exact validated source, merge through the private repository, build an existing-schema Sites archive with no migration payload, save a new Sites version, deploy it, and verify the three public cards plus all dark-product API denials.
