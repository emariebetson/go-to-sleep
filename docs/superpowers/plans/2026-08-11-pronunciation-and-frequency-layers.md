# Pronunciation and Frequency Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically suggest an editable child-name pronunciation, apply it only at the TTS boundary, and add up to three persistent, locally generated Solfeggio playback layers.

**Architecture:** Pure domain helpers validate pronunciation and frequency inputs, prepare narration-only text, and safely parse stored layer data. An authenticated pronunciation endpoint reuses the existing OpenAI Responses integration, while the session route owns child upsert, pronunciation substitution, and setting snapshots. `SleepPlayer` synthesizes optional tones in Web Audio so generated MP3 files and ElevenLabs costs remain unchanged.

**Tech Stack:** TypeScript, React 19, Vinext/Next-compatible route handlers, Drizzle ORM with Cloudflare D1, Web Audio API, OpenAI Responses API, ElevenLabs TTS, Node's built-in test runner.

## Global Constraints

- Preserve the correctly spelled nickname in every visible and stored script; phonetic spelling is narration-only.
- Never overwrite a pronunciation the parent manually edited.
- Allow only 174, 285, 396, 417, 528, 639, 741, 852, and 963 Hz, with zero to three distinct selections.
- Describe each tone only as “traditionally associated with” its theme and state that the descriptions are not proven medical or sleep benefits.
- Keep tones optional, locally generated, and conservatively normalized; do not mix them into the stored narration MP3.
- Preview failures, unavailable Web Audio, and pronunciation-guess failures must not block the rest of the bedtime workflow.
- Validate all client input server-side before a paid ElevenLabs request.
- Reuse `.env.local` without reading, printing, or committing its values.
- Follow red-green-refactor for each production behavior and run the complete verification suite before release.

---

### Task 1: Add pronunciation and frequency domain helpers

**Files:**
- Create: `lib/pronunciation.ts`
- Create: `lib/frequency-layers.ts`
- Create: `tests/pronunciation-frequency.test.mjs`

**Interfaces:**
- Produces: `cleanNickname(value: unknown): string`
- Produces: `normalizeNickname(value: unknown): string`
- Produces: `cleanPronunciation(value: unknown): string`
- Produces: `applyPronunciation(text: string, childName: string, pronunciation: string): string`
- Produces: `SOLFEGGIO_FREQUENCIES`, `SolfeggioFrequency`, and `SOLFEGGIO_OPTIONS`
- Produces: `validateFrequencyLayers(value: unknown): SolfeggioFrequency[]`
- Produces: `parseStoredFrequencyLayers(value: unknown): SolfeggioFrequency[]`
- Produces: `frequencyGainPerOscillator(layerCount: number): number`

- [ ] **Step 1: Write the failing behavior tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { applyPronunciation, cleanPronunciation, normalizeNickname } from "../lib/pronunciation.ts";
import { frequencyGainPerOscillator, parseStoredFrequencyLayers, validateFrequencyLayers } from "../lib/frequency-layers.ts";

test("pronunciation substitution changes standalone nickname occurrences only", () => {
  assert.equal(
    applyPronunciation("Lachy rests. LACHY's blanket is here. Lachyland stays visible.", "Lachy", "LOCK-ee"),
    "LOCK-ee rests. LOCK-ee's blanket is here. Lachyland stays visible.",
  );
  assert.equal(applyPronunciation("A.J. rests beside A.J.!", "A.J.", "AY-jay"), "AY-jay rests beside AY-jay!");
});

test("pronunciation cleanup and nickname normalization are bounded", () => {
  assert.equal(cleanPronunciation("  LOCK-ee <script>  "), "LOCK-ee script");
  assert.equal(normalizeNickname("  LaCHy  "), "lachy");
});

test("frequency validation accepts only three distinct supported layers", () => {
  assert.deepEqual(validateFrequencyLayers([174, 528, 963]), [174, 528, 963]);
  assert.throws(() => validateFrequencyLayers([174, 174]), /duplicate/i);
  assert.throws(() => validateFrequencyLayers([174, 285, 396, 417]), /three/i);
  assert.throws(() => validateFrequencyLayers([440]), /unsupported/i);
});

test("stored layers fail closed and per-oscillator gain bounds the sum", () => {
  assert.deepEqual(parseStoredFrequencyLayers("[174,528]"), [174, 528]);
  assert.deepEqual(parseStoredFrequencyLayers("not json"), []);
  assert.equal(frequencyGainPerOscillator(0), 0);
  assert.ok(frequencyGainPerOscillator(3) * 3 <= 0.018);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
node --test tests/pronunciation-frequency.test.mjs
```

Expected: FAIL because `lib/pronunciation.ts` and `lib/frequency-layers.ts` do not exist.

- [ ] **Step 3: Implement the focused helpers**

`applyPronunciation` must escape regex metacharacters, use Unicode letter/number boundaries, replace case-insensitively, and return the original text when any required input is empty. `cleanNickname` removes angle brackets/control characters, collapses whitespace, and caps output at 32 characters. `cleanPronunciation` applies compatible cleanup with a 64-character cap. `normalizeNickname` lowercases `cleanNickname(value)` for the user-scoped lookup key.

`validateFrequencyLayers` requires an array, rejects a fourth entry, duplicates, non-integers, and values outside the enumerated list. `parseStoredFrequencyLayers` catches JSON/validation errors and returns `[]`. `frequencyGainPerOscillator` returns `0` for no layers and `0.018 / clampedCount` for one to three layers.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test tests/pronunciation-frequency.test.mjs
```

Expected: all pronunciation/frequency helper tests pass.

- [ ] **Step 5: Commit the domain layer**

```bash
git add lib/pronunciation.ts lib/frequency-layers.ts tests/pronunciation-frequency.test.mjs
git commit -m "feat: add pronunciation and frequency rules"
```

---

### Task 2: Add additive persistence and request validation

**Files:**
- Modify: `db/schema.ts`
- Create: `drizzle/0005_pronunciation_frequency_layers.sql` through `drizzle-kit generate`
- Modify: `lib/sleep-session.ts`
- Create: `tests/sleep-session-input.test.mjs`

**Interfaces:**
- Consumes: `cleanPronunciation` and `validateFrequencyLayers` from Task 1.
- Extends: `SessionInput` with `pronunciation: string` and `frequencies: SolfeggioFrequency[]`.
- Extends: `children` with `normalizedNickname` and `pronunciation`.
- Extends: `sleepSessions` with `pronunciation` and `frequencyLayers` snapshot columns.

- [ ] **Step 1: Write failing request-contract tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { validateSessionInput } from "../lib/sleep-session.ts";

const valid = {
  requestId: "12345678-1234-4123-8123-123456789abc",
  childName: "Lachy",
  pronunciation: "LOCK-ee",
  ageMonths: 6,
  challenge: "settling",
  theme: "moonlit-meadow",
  duration: "10",
  sound: "soft-rain",
  frequencies: [174, 528],
  style: "slow-story",
  scriptMode: "personalized",
  contentType: "story",
  sourceUrl: "",
  sourceTitle: "",
  script: "Hello, sweet Lachy. The room grows quiet while the moonlight rests softly nearby for a peaceful bedtime story.",
  voiceId: "voice_12345678",
  narrationKind: "parent_clone",
  generationMode: "preview",
};

test("session input carries a cleaned pronunciation and validated layers", () => {
  const result = validateSessionInput(valid);
  assert.equal(result.pronunciation, "LOCK-ee");
  assert.deepEqual(result.frequencies, [174, 528]);
});

test("session input rejects a fourth or unsupported layer", () => {
  assert.throws(() => validateSessionInput({ ...valid, frequencies: [174, 285, 396, 417] }), /three/i);
  assert.throws(() => validateSessionInput({ ...valid, frequencies: [440] }), /unsupported/i);
});
```

- [ ] **Step 2: Run the request-contract test and verify RED**

Run:

```bash
node --test tests/sleep-session-input.test.mjs
```

Expected: FAIL because the current parser drops pronunciation and frequencies.

- [ ] **Step 3: Extend the schema and validator**

Use these Drizzle fields and indexes:

```ts
normalizedNickname: text("normalized_nickname"),
pronunciation: text("pronunciation"),
// children table indexes
uniqueIndex("children_user_normalized_nickname_idx").on(table.userId, table.normalizedNickname),

// sleepSessions fields
pronunciation: text("pronunciation").notNull().default(""),
frequencyLayers: text("frequency_layers").notNull().default("[]"),
```

Add `pronunciation_guess` to the TypeScript `usageEvents.type` enum so the authenticated guess endpoint can enforce per-user limits. Parse `body.pronunciation` with `cleanPronunciation` and `body.frequencies` with `validateFrequencyLayers` inside `validateSessionInput`.

- [ ] **Step 4: Generate and inspect the additive migration**

Run:

```bash
node_modules/.bin/drizzle-kit generate --name pronunciation_frequency_layers
```

The generated SQL must add the four columns and user-scoped unique index without dropping or rebuilding existing tables. Existing children may keep a null normalized nickname; new writes populate it. Existing sleep sessions receive `''` and `'[]'` defaults.

- [ ] **Step 5: Run the focused tests and typecheck**

Run:

```bash
node --test tests/pronunciation-frequency.test.mjs tests/sleep-session-input.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
```

Expected: focused tests and typecheck pass.

- [ ] **Step 6: Commit persistence and validation**

```bash
git add db/schema.ts drizzle lib/sleep-session.ts tests/sleep-session-input.test.mjs
git commit -m "feat: persist pronunciation and frequency settings"
```

---

### Task 3: Add the automated pronunciation-guess endpoint

**Files:**
- Create: `lib/pronunciation-guess.ts`
- Create: `app/api/pronunciation/route.ts`
- Create: `tests/pronunciation-guess.test.mjs`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Produces: `requestPronunciationGuess(nickname: string, apiKey: string, fetcher?: typeof fetch): Promise<string>`.
- Route: `POST /api/pronunciation` with `{ nickname: string }`, returning `{ pronunciation: string }` or a no-store 4xx/503 error.

- [ ] **Step 1: Write failing provider-boundary tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { requestPronunciationGuess } from "../lib/pronunciation-guess.ts";

test("pronunciation guessing returns one cleaned readable respelling", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ output_text: "LOCK-ee\n" }), { status: 200 });
  assert.equal(await requestPronunciationGuess("Lachy", "test-key", fakeFetch), "LOCK-ee");
});

test("pronunciation guessing rejects empty or malformed provider output", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ output_text: "<script>" }), { status: 200 });
  await assert.rejects(() => requestPronunciationGuess("Lachy", "test-key", fakeFetch), /valid pronunciation/i);
});
```

- [ ] **Step 2: Run the provider test and verify RED**

Run:

```bash
node --test tests/pronunciation-guess.test.mjs
```

Expected: FAIL because `lib/pronunciation-guess.ts` does not exist.

- [ ] **Step 3: Implement the provider helper**

Send a bounded request to `https://api.openai.com/v1/responses` using `OPENAI_MODEL || "gpt-5-mini"`, `max_output_tokens: 32`, and instructions that request exactly one plain-English phonetic respelling, prohibit IPA/explanations, and treat the nickname as untrusted data. Parse `output_text` or the first `output_text` content item, run it through `cleanPronunciation`, and reject empty output, HTML-like provider output, multi-line explanations, or output longer than 64 characters.

- [ ] **Step 4: Implement the authenticated route**

The route order is:

```ts
assertSameOrigin(request);
const user = await requireApiUser(request);
const body = await readJsonObject(request, 1_000);
const nickname = cleanNickname(body.nickname);
await ensureUser(user);
```

Insert a `pronunciation_guess` usage event, count the signed-in user's events in the last hour, delete the just-inserted event and return 429 when the count exceeds 20, and only then call OpenAI. If `OPENAI_API_KEY` is absent or the provider fails, return a generic no-store 503 without provider details or secrets. The client will treat this as non-blocking.

- [ ] **Step 5: Add an unauthenticated route-boundary test**

Extend the built-worker test to send a same-origin POST without a session:

```js
const response = await worker.fetch(
  new Request("http://localhost/api/pronunciation", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ nickname: "Lachy" }),
  }),
  runtime,
  context,
);
assert.equal(response.status, 401);
```

- [ ] **Step 6: Run focused tests and production build**

Run:

```bash
node --test tests/pronunciation-guess.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
node_modules/.bin/vinext build
node --test tests/rendered-html.test.mjs
```

Expected: helper tests, typecheck, build, and route boundary test pass.

- [ ] **Step 7: Commit automated pronunciation guessing**

```bash
git add lib/pronunciation-guess.ts app/api/pronunciation/route.ts tests/pronunciation-guess.test.mjs tests/rendered-html.test.mjs
git commit -m "feat: suggest nickname pronunciation"
```

---

### Task 4: Apply pronunciation at TTS and save child settings

**Files:**
- Create: `lib/session-narration.ts`
- Modify: `app/api/sessions/route.ts`
- Create: `tests/session-narration.test.mjs`

**Interfaces:**
- Consumes: `applyPronunciation`, `normalizeNickname`, and validated `SessionInput` from Tasks 1–2.
- Produces: `prepareNarration(input: Pick<SessionInput, "script" | "childName" | "pronunciation">): { full: string; preview: string }`.
- Produces: saved `children` row linked by `sleep_sessions.child_id` for full generations.

- [ ] **Step 1: Add a failing narration-boundary test**

Create `tests/session-narration.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { prepareNarration } from "../lib/session-narration.ts";

test("preview and full narration apply pronunciation without changing the stored script", () => {
  const script = "Hello Lachy. Lachy can rest beside the moon while the familiar voice continues softly for bedtime.";
  const result = prepareNarration({ script, childName: "Lachy", pronunciation: "LOCK-ee" });
  assert.equal(result.full, "Hello LOCK-ee. LOCK-ee can rest beside the moon while the familiar voice continues softly for bedtime.");
  assert.match(result.preview, /LOCK-ee/);
  assert.equal(script.includes("Lachy"), true);
});
```

Run:

```bash
node --test tests/session-narration.test.mjs
```

Expected: FAIL because `lib/session-narration.ts` does not exist.

- [ ] **Step 2: Wire one server-owned narration string**

Implement `prepareNarration` with `applyPronunciation` and `previewExcerpt`, then immediately after request validation derive:

```ts
const narration = prepareNarration(input);
```

Use `narration.preview` for preview TTS and `narration.full` for full TTS. Continue storing `input.script`, never either narration-only value, in `sleep_sessions.script`.

- [ ] **Step 3: Upsert the user's child for full saves**

Before inserting a full sleep session, upsert by `[children.userId, children.normalizedNickname]` using `normalizeNickname(input.childName)`. Write nickname, pronunciation or null, age, bedtime challenge, and timestamps; return the child ID and set `sleep_sessions.childId`. Also snapshot `input.pronunciation` and `JSON.stringify(input.frequencies)` on the session. The conflict target and every lookup include the authenticated user ID.

- [ ] **Step 4: Run focused tests, typecheck, and build**

Run:

```bash
node --test tests/pronunciation-frequency.test.mjs tests/sleep-session-input.test.mjs tests/session-narration.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
node_modules/.bin/vinext build
```

Expected: tests, typecheck, and build pass.

- [ ] **Step 5: Commit the TTS and persistence wiring**

```bash
git add lib/session-narration.ts app/api/sessions/route.ts tests/session-narration.test.mjs
git commit -m "feat: apply saved pronunciation to narration"
```

---

### Task 5: Add race-safe studio controls and local tone synthesis

**Files:**
- Create: `lib/studio-pronunciation.ts`
- Create: `tests/studio-pronunciation.test.mjs`
- Modify: `app/studio/SleepStudio.tsx`
- Modify: `components/SleepPlayer.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Produces: `shouldApplyPronunciationGuess(requestedNickname, currentNickname, manualVersionAtRequest, currentManualVersion): boolean`.
- Extends: `StudioData` with `pronunciation: string` and `frequencies: SolfeggioFrequency[]`.
- Extends: `SleepPlayerProps` with `frequencies?: readonly number[]`.

- [ ] **Step 1: Write failing race-condition tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { shouldApplyPronunciationGuess } from "../lib/studio-pronunciation.ts";

test("a guess applies only to the unchanged nickname and edit version", () => {
  assert.equal(shouldApplyPronunciationGuess("Lachy", "Lachy", 0, 0), true);
  assert.equal(shouldApplyPronunciationGuess("Lachy", "Lou", 0, 0), false);
  assert.equal(shouldApplyPronunciationGuess("Lachy", "Lachy", 0, 1), false);
});
```

- [ ] **Step 2: Run the race test and verify RED**

Run:

```bash
node --test tests/studio-pronunciation.test.mjs
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the helper and nickname-blur automation**

Track a pronunciation manual-edit version in a ref and the active request in an `AbortController` ref. Nickname changes clear only an automatically supplied guess; pronunciation input changes increment the manual version. On nickname blur, abort the older request, record nickname/version, show “Finding our best guess…”, POST to `/api/pronunciation`, and apply the returned value only when `shouldApplyPronunciationGuess` returns true. Failure clears the loading text without blocking Continue. Provide a “Guess again” button that clears the manual state and explicitly repeats the request.

- [ ] **Step 4: Add the accessible fields and frequency choices**

Place **Pronounced like** next to **Baby’s nickname**, with `maxLength={64}`, `placeholder="LOCK-ee"`, helper copy, and a polite live region. Render the nine `SOLFEGGIO_OPTIONS` as native checkboxes with the approved descriptions. Disable unselected boxes at three selections, leave selected boxes enabled, and show: “Choose up to three. These descriptions reflect traditional associations, not proven medical or sleep benefits. Keep the volume comfortable.”

Changing pronunciation or frequency selection calls `clearGeneratedAudio()` so a parent must regenerate the preview before saving changed settings.

- [ ] **Step 5: Extend `SleepPlayer` with robust oscillator lifecycle**

On audio play, start the existing base sound plus one sine oscillator per validated frequency. Each oscillator uses `frequencyGainPerOscillator(count)`, connects through a shared gain node, and is stored in a ref. `stopSound` stops/disconnects the noise source, all oscillators, and all gain nodes. A failed/unavailable AudioContext leaves the HTML audio narration playing. Effects clean up on unmount and when `src`, `sound`, or `frequencies` change.

- [ ] **Step 6: Pass layers into both studio players and add responsive styles**

Use:

```tsx
<SleepPlayer src={previewAudioUrl} sound={data.sound} frequencies={data.frequencies} />
<SleepPlayer src={savedAudioUrl} sound={data.sound} frequencies={data.frequencies} />
```

Add compact checkbox-card, selected, disabled, helper-row, and two-column pronunciation-field styles to `app/globals.css`, collapsing to one column at the existing mobile breakpoint.

- [ ] **Step 7: Run focused tests, lint, typecheck, and build**

Run:

```bash
node --test tests/studio-pronunciation.test.mjs tests/pronunciation-frequency.test.mjs
node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next
node_modules/.bin/tsc --noEmit --incremental false
node_modules/.bin/vinext build
```

Expected: focused tests, lint, typecheck, and build pass.

- [ ] **Step 8: Commit the studio and player UI**

```bash
git add lib/studio-pronunciation.ts tests/studio-pronunciation.test.mjs app/studio/SleepStudio.tsx components/SleepPlayer.tsx app/globals.css
git commit -m "feat: add pronunciation and tone controls"
```

---

### Task 6: Restore saved layers in My nights and complete release verification

**Files:**
- Modify: `app/library/page.tsx`
- Modify: `tests/pronunciation-frequency.test.mjs`
- Modify: `docs/superpowers/plans/2026-08-11-pronunciation-and-frequency-layers.md` only to check completed steps during execution.

**Interfaces:**
- Consumes: `parseStoredFrequencyLayers` and the session snapshot from Tasks 1–4.
- Produces: `formatFrequencyLabel(layers: readonly SolfeggioFrequency[]): string` in `lib/frequency-layers.ts`.

- [ ] **Step 1: Add failing storage and presentation assertions**

Add cases showing `null`, `"[]"`, malformed JSON, a fourth frequency, duplicates, and unsupported values all return `[]` without throwing. Add these label assertions:

```js
assert.equal(formatFrequencyLabel([]), "");
assert.equal(formatFrequencyLabel([174]), "174 Hz");
assert.equal(formatFrequencyLabel([174, 528]), "174 + 528 Hz");
```

Run the test and verify RED because `formatFrequencyLabel` does not exist, then implement it with the validated numeric values.

- [ ] **Step 2: Restore layers in My nights**

For every session, parse `session.frequencyLayers` with `parseStoredFrequencyLayers`, pass the result to `SleepPlayer`, and include a concise label such as `174 + 528 Hz` only when layers exist. Legacy/malformed values render voice/base-sound playback without tones.

- [ ] **Step 3: Apply the migration to the isolated local D1 database**

Run:

```bash
node_modules/.bin/wrangler d1 migrations apply site-creator-d1 --local --config wrangler.local.jsonc
```

Expected: migration 0005 applies successfully without touching the remote database.

- [ ] **Step 4: Run the complete automated verification suite**

Run:

```bash
node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next
node_modules/.bin/tsc --noEmit --incremental false
node_modules/.bin/vinext build
node --test tests/*.test.mjs
git diff --check
```

Expected: lint, typecheck, production build, every test, and whitespace validation pass with zero failures.

- [ ] **Step 5: Run a signed-in browser smoke test**

Start the local app and verify this exact flow without exposing credentials:

1. Enter `Lachy`, blur the nickname, and confirm a best guess appears.
2. Change it to `LOCK-ee`, then trigger another stale/slow guess and confirm the manual value remains.
3. Select 174, 528, and 963 Hz; confirm a fourth option is disabled.
4. Generate a 30-second preview and confirm narration plus subtle layers start and stop together.
5. Save the bedtime, open My nights, and confirm the selected frequency label and replay behavior persist.
6. Confirm browser console and network panels show no unhandled errors or secret values.

- [ ] **Step 6: Commit library restoration and verification updates**

```bash
git add app/library/page.tsx tests/pronunciation-frequency.test.mjs docs/superpowers/plans/2026-08-11-pronunciation-and-frequency-layers.md
git commit -m "feat: restore saved bedtime tone layers"
```

- [ ] **Step 7: Prepare the branch for integration**

Use `superpowers:finishing-a-development-branch` to rerun verification, review the complete diff against the approved design, and integrate only after the verified option is selected. Remote D1 migration and Sites publication remain explicit deployment steps after integration.
