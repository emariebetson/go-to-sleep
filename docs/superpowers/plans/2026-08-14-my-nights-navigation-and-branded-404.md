# My Nights Navigation and Branded 404 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every public My nights action session-aware and add the approved branded NearSleep global 404 page.

**Architecture:** Add one pure navigation helper that maps an authenticated user to `/library` and an unauthenticated user to the existing safe sign-in return path. Convert the public header into an async server component that uses this helper, and reuse the same helper in the framework-level 404 page so behavior cannot drift.

**Tech Stack:** TypeScript, React Server Components, Vinext/Next-compatible App Router, Node test runner, existing NearSleep CSS design tokens.

## Global Constraints

- Preserve `/library` authentication and authorization at the destination.
- Reuse existing brand, button, type, color, spacing, and responsive systems.
- Add no dependencies, client state, imagery, fonts, or production feature flags.
- Keep NearStory, NearFamily, internal routes, schedulers, and infrastructure dark.
- Do not deploy or publish before review.

---

### Task 1: Session-aware My nights destination

**Files:**
- Create: `lib/my-nights-navigation.ts`
- Modify: `components/SiteHeader.tsx`
- Create: `tests/my-nights-navigation.test.mjs`

**Interfaces:**
- Consumes: `AppUser | null` from `lib/auth.ts` and `signInPath(returnTo: string)`.
- Produces: `myNightsHref(user: AppUser | null): string` returning exactly `/library` or `/sign-in?returnTo=%2Flibrary`.

- [ ] **Step 1: Write the failing behavior test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { myNightsHref } from "../lib/my-nights-navigation.ts";

test("My nights opens the private dashboard for an authenticated user", () => {
  assert.equal(myNightsHref({ userId: "u", email: "p@example.test", displayName: "Parent", fullName: "Parent" }), "/library");
});

test("My nights sends an unauthenticated user through sign in and back to the library", () => {
  assert.equal(myNightsHref(null), "/sign-in?returnTo=%2Flibrary");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run the bundled Node test command for `tests/my-nights-navigation.test.mjs`.

Expected: FAIL because `lib/my-nights-navigation.ts` does not exist.

- [ ] **Step 3: Add the minimal pure helper**

```ts
import type { AppUser } from "@/lib/auth";
import { signInPath } from "@/lib/auth";

export function myNightsHref(user: AppUser | null) {
  return user ? "/library" : signInPath("/library");
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Expected: both behavior tests PASS.

- [ ] **Step 5: Add a failing header integration assertion**

Extend the test to read `components/SiteHeader.tsx` and assert that it imports `getAppUser` and `myNightsHref`, awaits the current user, and supplies the resolved href to the visible My nights link.

Expected before implementation: FAIL because the header still hardcodes `/library`.

- [ ] **Step 6: Convert the header to a server-resolved link**

```tsx
export async function SiteHeader() {
  const user = await getAppUser();
  const nightsHref = myNightsHref(user);
  // Existing header markup remains unchanged except href={nightsHref}.
}
```

- [ ] **Step 7: Run the focused tests and verify GREEN**

Expected: helper behavior and header integration assertions PASS.

- [ ] **Step 8: Commit the independently working navigation change**

```bash
git add lib/my-nights-navigation.ts components/SiteHeader.tsx tests/my-nights-navigation.test.mjs
git commit -m "fix: route My nights through sign in when needed"
```

### Task 2: Branded global 404

**Files:**
- Create: `app/not-found.tsx`
- Modify: `app/globals.css`
- Create: `tests/branded-not-found.test.mjs`

**Interfaces:**
- Consumes: `getAppUser()`, `myNightsHref(user)`, `Brand`, `Link`, and existing `.btn`, `.btn-primary`, `.btn-secondary`, `.display`, `.eyebrow`, and `.muted` styles.
- Produces: the App Router global not-found component used for unmatched pages and `notFound()` responses.

- [ ] **Step 1: Write the failing 404 contract test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("global 404 uses approved NearSleep copy and safe destinations", () => {
  const page = readFileSync(new URL("../app/not-found.tsx", import.meta.url), "utf8");
  assert.match(page, /404 · A quiet detour/);
  assert.match(page, /This page wandered off to sleep\./);
  assert.match(page, /Nothing was changed or deleted\./);
  assert.match(page, /href="\/studio"/);
  assert.match(page, /href="\/"/);
  assert.match(page, /myNightsHref\(user\)/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Expected: FAIL because `app/not-found.tsx` does not exist.

- [ ] **Step 3: Implement the approved server-rendered page**

Create an async `NotFound` component that awaits `getAppUser()`, resolves `myNightsHref(user)`, renders `Brand`, the approved copy, and three semantic links. Use `Open My nights` for authenticated users and `Sign in to My nights` otherwise.

- [ ] **Step 4: Add narrowly scoped responsive styles**

Add `.not-found-page`, `.not-found-card`, `.not-found-moon`, `.not-found-actions`, and `.not-found-note` rules using the existing CSS variables. Stack actions at the existing mobile breakpoint and preserve `prefers-reduced-motion` behavior.

- [ ] **Step 5: Run both focused test files and verify GREEN**

Expected: all navigation and 404 contract tests PASS.

- [ ] **Step 6: Run repository verification**

Run TypeScript without incremental output, scoped ESLint for the changed files/tests, the production build, and `git diff --check`.

Expected: all commands exit successfully with no new warnings or generated build metadata left in the worktree.

- [ ] **Step 7: Verify locally in the browser**

With the retained local server, open an unknown route and confirm the approved 404 appearance at desktop and mobile widths. Verify the public header and 404 My nights actions have the expected signed-out destination; use existing automated behavior coverage for authenticated destination resolution without weakening local or production authentication.

- [ ] **Step 8: Commit the independently working 404 change**

```bash
git add app/not-found.tsx app/globals.css tests/branded-not-found.test.mjs
git commit -m "feat: add branded NearSleep 404 page"
```
