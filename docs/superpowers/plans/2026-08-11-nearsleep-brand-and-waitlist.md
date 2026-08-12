# NearSleep Brand and Waitlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the public product to NearSleep and add a durable, privacy-safe waitlist for NearStory, NearFamily, and NearLegacy with a private Google Sheets marketing mirror.

**Architecture:** Public React components submit bounded JSON to a dark-independent marketing API. D1 is authoritative; encrypted email records and product interests are committed atomically with a fenced synchronization outbox. A bounded authenticated continuation route mirrors rows to a private Google Sheet, while all unfinished product application routes stay disabled.

**Tech Stack:** React 19, Vinext/Next-compatible routes, Cloudflare D1, Drizzle/SQLite migrations, Web Crypto AES-GCM/HMAC, Google Sheets API, Node test runner.

## Global Constraints

- Every user-visible NearNight/Nearnight/Near Night occurrence becomes NearSleep; compatibility identifiers remain unchanged when renaming would break deployed state.
- NearStory, NearFamily, and NearLegacy are labeled Coming soon / Join waitlist and never link to disabled application routes.
- D1 is authoritative; the private Google Sheet in the founder's main Drive is a marketing mirror.
- Email plaintext never appears in logs, URLs, analytics, idempotency keys, or unencrypted D1 columns.
- Marketing consent is explicit, unchecked by default, versioned, and independently revocable.
- Existing expansion rollout flags remain absent/false.

---

### Task 1: Public Brand and Product-Family Contract

**Files:**
- Create: `tests/brand-waitlist-ui.test.mjs`
- Create: `components/ProductFamily.tsx`
- Modify: `components/Brand.tsx`, `components/SiteHeader.tsx`, `components/SiteFooter.tsx`
- Modify: `app/page.tsx`, `app/pricing/page.tsx`, `app/layout.tsx`, `app/sign-in/page.tsx`, `app/account/page.tsx`, `app/safety/page.tsx`, `app/privacy/page.tsx`, `app/terms/page.tsx`, `app/studio/SleepStudio.tsx`
- Modify: `components/SleepVisualizer.tsx`, `lib/sleep-session.ts`, `lib/nearsleep-audio.ts`, `lib/elevenlabs.ts`, `lib/oauth.ts`

**Interfaces:**
- Produces: `ProductFamily` with `source: "home" | "pricing"` and product cards for NearSleep plus three waitlists.

- [ ] Write rendered/source tests asserting NearSleep public copy, all four product labels, waitlist actions, and no public NearNight variants.
- [ ] Run `tsx --test tests/brand-waitlist-ui.test.mjs` and confirm RED on old copy/missing family cards.
- [ ] Implement the visible rename and product-family presentation without changing compatibility keys or enabling product routes.
- [ ] Run the focused test and existing rendered tests to GREEN.
- [ ] Commit the independently reviewable UI contract.

### Task 2: Waitlist Schema and Privacy Primitives

**Files:**
- Create: `drizzle/0016_marketing_waitlist.sql`
- Create: `lib/marketing-waitlist.ts`
- Create: `tests/marketing-waitlist.test.mjs`
- Modify: `db/schema.ts`, `drizzle/meta/_journal.json`, add chained `drizzle/meta/0016_snapshot.json`

**Interfaces:**
- Produces: `normalizeWaitlistInput`, `emailLookupHash`, `encryptWaitlistEmail`, `decryptWaitlistEmail`, `buildWaitlistUpsertBatch`, and typed product/source/consent constants.

- [ ] Write failing domain and real-SQLite tests for keyed lookup, AES-GCM roundtrip/tamper failure, additive schema, unique interests, and durable sync outbox.
- [ ] Run focused tests and confirm RED because the schema/helpers do not exist.
- [ ] Add the 0016 tables, indexes, Drizzle parity, and minimal privacy helpers.
- [ ] Run focused tests plus migration drift checks to GREEN.
- [ ] Commit schema and privacy primitives.

### Task 3: Public Signup and Unsubscribe APIs

**Files:**
- Create: `app/api/v1/marketing/waitlist/route.ts`
- Create: `app/api/v1/marketing/unsubscribe/route.ts`
- Create: `lib/marketing-waitlist-route.ts`
- Create: `tests/marketing-waitlist-route.test.mjs`
- Create: `tests/fixtures/marketing-waitlist-route-runner.mjs`

**Interfaces:**
- Consumes: Task 2 helpers and D1 schema.
- Produces: bounded `POST /api/v1/marketing/waitlist` and token-based `POST /api/v1/marketing/unsubscribe`.

- [ ] Write actual migrated-handler tests for validation, origin/size bounds, consent version, encryption-at-rest, duplicate merging, re-consent, rate limits, idempotency, and unsubscribe during worker/billing outages.
- [ ] Run the route runner and confirm RED because handlers are missing.
- [ ] Implement atomic D1 handlers with generic errors and no plaintext PII logging.
- [ ] Run the actual route suite to GREEN.
- [ ] Commit the API slice.

### Task 4: Accessible Waitlist UI

**Files:**
- Create: `components/WaitlistForm.tsx`
- Modify: `components/ProductFamily.tsx`, `app/globals.css`
- Modify: `tests/brand-waitlist-ui.test.mjs`

**Interfaces:**
- Consumes: `POST /api/v1/marketing/waitlist`.
- Produces: inline accessible form with preselected/editable products, explicit consent, status announcement, retry-safe request ID, and 320px layout.

- [ ] Add failing rendered/source tests for unchecked consent, product checkboxes, email autocomplete, live status, keyboard-safe inline behavior, stable request ID, and legal links.
- [ ] Run focused tests and confirm RED.
- [ ] Implement the minimal client form and responsive styles.
- [ ] Run UI and lint/type tests to GREEN.
- [ ] Commit the accessible signup experience.

### Task 5: Google Sheets Mirror and Main-Drive Sheet

**Files:**
- Create: `lib/marketing-waitlist-google.ts`
- Create: `app/api/internal/marketing-waitlist-sync/route.ts`
- Create: `tests/marketing-waitlist-google.test.mjs`
- Modify: `.env.example`, deployment runbook documentation
- Create externally: private native Google Sheet `NearYou Waitlist` in My Drive root.

**Interfaces:**
- Consumes: pending `marketing_waitlist_sync` rows and encrypted contact email.
- Produces: fenced upsert by hidden contact ID into columns Email, Product interests, Signup source, Consent version, Consented at, Status, Last synced at.

- [ ] Write failing contract tests for bounded claims, token fencing, lost response replay, exact row updates, dead-letter, unsubscribe, timeout, and PII-safe errors.
- [ ] Run focused tests and confirm RED.
- [ ] Implement the Google API adapter and authenticated continuation route with fail-closed configuration.
- [ ] Create/import and visually verify the private `NearYou Waitlist` Google Sheet in the main Drive root.
- [ ] Record only the observed Sheet ID/URL in deployment configuration guidance; never commit credentials.
- [ ] Run focused tests to GREEN and commit.

### Task 6: Privacy Copy, Release Gates, and Full Verification

**Files:**
- Modify: `app/privacy/page.tsx`, `app/terms/page.tsx`, deployment runbook
- Modify: `tests/task1-release-gates.test.mjs`, `tests/rendered-html.test.mjs`, `tests/platform-migration-drift.test.mjs`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: explicit Google Sheets processor/mirror disclosure and a launch checklist that keeps waitlist unavailable until encryption, Google credentials, scheduler heartbeat, and canary pass.

- [ ] Add failing release tests for public copy, dark product APIs, secret absence, migration apply/FK/integrity, and Google configuration/readiness.
- [ ] Run focused tests and confirm RED for missing release evidence.
- [ ] Update privacy/terms/runbook and readiness checks.
- [ ] Run lint, typecheck, build, complete tests, isolated Drizzle no-drift, blank 0000–0016 apply, FK/integrity, and diff/secret scans.
- [ ] Keep waitlist fail-closed if hosted secrets/scheduler are not configured; do not activate unfinished products.
- [ ] Commit the verified release slice.

### Task 7: Publish and Live Smoke

**Files:**
- No source files unless a live-smoke defect first receives a failing regression test.

**Interfaces:**
- Produces: updated Sites release at the existing URL and verified Google Sheet canary.

- [ ] Publish the validated existing Sites project without enabling NearStory, NearFamily, NearLegacy, or platform flags.
- [ ] Verify home/pricing show NearSleep and coming-soon cards; protected pages still redirect; expansion APIs remain 404.
- [ ] Submit a canary waitlist signup, confirm one encrypted D1 contact and one Google Sheet row, then exercise unsubscribe synchronization.
- [ ] If hosted credentials or the external scheduler are unavailable, report the exact activation hold and leave the form fail-closed rather than weakening the design.
- [ ] Record rollback version and final evidence.

