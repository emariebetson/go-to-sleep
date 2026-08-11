# Pronunciation and Solfeggio Frequency Layers Design

**Date:** 2026-08-11
**Status:** Approved in conversation; awaiting written-spec review
**Scope:** The bedtime creation flow, saved bedtime playback, and the minimum persistence needed for those features

## Goals

- Help ElevenLabs say a child's nickname the way the parent intends without changing how the name appears in the editable script or saved UI.
- Offer optional Solfeggio tones as locally generated background layers during previews and saved playback.
- Let a parent combine up to three tones while keeping playback gentle and avoiding unsupported health claims.
- Persist both choices so a saved bedtime sounds the same when replayed from My nights.

## Non-goals

- This work does not claim that a frequency heals, treats, diagnoses, guarantees sleep, or produces a medical outcome.
- This work does not mix tones into the stored ElevenLabs MP3. The browser generates them during playback.
- This work does not introduce NearStory, interactive story branching, generated sound effects, or a new paid tier.
- The NearSleep rename follows this creation-flow release and will be handled as a separate, repository-wide change.

## User experience

### Pronunciation input

The first studio step places an editable **Pronounced like** field beside **Baby's nickname**. Its helper text says: “Type it how it sounds. We’ll use this only for narration.” An example may show `Lachy → LOCK-ee`.

When the nickname field loses focus after its value changed, the client requests a pronunciation guess. The response fills the field only when the parent has not manually edited it since the nickname changed. A visible loading state avoids making the delayed fill look accidental. If guessing fails, the field remains editable and the bedtime flow remains usable.

Changing the nickname invalidates the previous automatic guess and permits a new guess on the next blur. It never overwrites a manual pronunciation. A small reset action lets the parent request a fresh guess deliberately.

The pronunciation is a best-effort aid, not a guarantee. The existing 30-second voice preview remains the final confirmation step before saving the full bedtime.

### Frequency selection

The sound section keeps the existing base-background choices—Soft rain, Brown noise, or Voice only—and adds an optional **Solfeggio layers** multi-select. The parent may select zero to three tones. Once three are selected, the remaining unselected options are disabled until one is removed; the UI explains the three-layer limit.

Each option uses evidence-safe language:

| Tone | Short description |
| --- | --- |
| 174 Hz | Traditionally associated with grounding and deep rest |
| 285 Hz | Traditionally associated with restoration and renewal |
| 396 Hz | Traditionally associated with releasing fear and tension |
| 417 Hz | Traditionally associated with change and new beginnings |
| 528 Hz | Traditionally associated with transformation and positive energy |
| 639 Hz | Traditionally associated with connection and harmony |
| 741 Hz | Traditionally associated with clarity and self-expression |
| 852 Hz | Traditionally associated with intuition and inner awareness |
| 963 Hz | Traditionally associated with wholeness and peace |

Supporting copy says: “These descriptions reflect traditional associations, not proven medical or sleep benefits. Keep the volume comfortable.”

Selections immediately apply to both the 30-second preview player and the full saved-bedtime player.

## Pronunciation architecture

### Guessing

Add an authenticated, same-origin pronunciation-guess endpoint. It accepts only a nickname, applies strict length and character cleanup, and returns one short phonetic respelling. It uses the project's existing server-side language-model integration; credentials never reach the browser. The prompt asks for plain, readable phonetic spelling rather than IPA, and treats the nickname as untrusted data.

The endpoint is best-effort and rate-limited per authenticated user. When the model is unavailable or cannot produce a valid guess, it returns no guess; the client leaves the field editable and does not block bedtime creation. Client requests are abortable so an older response cannot replace a guess for a newer nickname.

### Narration substitution

The visible and stored script remains human-readable and contains the correctly spelled nickname. Immediately before preview or full TTS generation, the server derives a narration-only script by replacing standalone, case-insensitive occurrences of the child's nickname with the validated phonetic respelling. The implementation escapes the nickname before building a boundary-aware regular expression and does not replace substrings inside other words.

Both preview excerpting and full generation use this narration-only script. The API never trusts a second client-supplied “TTS script,” which prevents disagreement between the reviewed script and generated narration. If the pronunciation field is empty or normalizes to the nickname, no substitution occurs.

### Validation and persistence

Add `pronunciation` to the session input contract with a conservative maximum length and the same control-character/markup cleanup used for other text inputs. Add a nullable pronunciation column to `children` for the parent's reusable preference and a non-null/default-empty pronunciation snapshot to `sleep_sessions` so old recordings and historical settings remain understandable even if the child's preference later changes.

When a full bedtime is saved, upsert the signed-in user's child by normalized nickname, update that child's pronunciation and current age/challenge, and attach the resulting child ID to the sleep session. The upsert must be scoped by user ID; one user can never read or update another user's child. Preview generation does not persist child data.

## Audio-layer architecture

Extend `SleepPlayer` with a validated `frequencies` array. On narration play, it creates one sine oscillator per selected frequency in the existing Web Audio context. Each oscillator passes through its own gain node into a shared master gain, then to the destination. All oscillators stop and disconnect on pause, end, source change, unmount, or playback failure.

The server accepts only the nine enumerated values and rejects duplicates or more than three selections. The browser applies the same validation for immediate feedback, but server validation is authoritative.

The tone master gain decreases as layers are added, keeping total tone energy bounded instead of summing three full-volume oscillators. The exact gain values will be tuned conservatively during implementation and covered by unit tests for the calculation. Web Audio tones remain independent of the stored narration file, so they add no ElevenLabs generation cost or R2 storage cost.

Persist the selection as JSON text in a new `sleep_sessions.frequency_layers` column with `[]` as the default. My nights parses this value defensively; malformed or legacy values become an empty array. The library passes the validated selection back to `SleepPlayer`, reproducing the chosen layers locally.

## Data migration

Create the next additive Drizzle migration:

- `children.pronunciation` — nullable text.
- A user-scoped normalized child-name key or index sufficient for safe upsert semantics.
- `sleep_sessions.pronunciation` — non-null text with an empty-string default.
- `sleep_sessions.frequency_layers` — non-null text with a `[]` default.

Existing users and sessions remain valid without backfill. The migration must be applied to local/test and Sites D1 before deploying code that writes the new columns.

## API and failure behavior

- Pronunciation guessing requires authentication, same-origin requests, a small JSON body, and per-user throttling.
- Session preview/save validates pronunciation and frequency layers before any paid ElevenLabs request.
- A failed pronunciation guess never blocks manual entry or progression through the studio.
- Unsupported, duplicated, or excessive frequencies return a clear 400-level validation error.
- Web Audio unavailability does not prevent narration playback; the player shows voice-only playback with unobtrusive explanatory text.
- Existing preview credit, rate-limit, ownership, and idempotency protections remain unchanged.

## Accessibility and content safety

- The frequency options use native checkbox semantics, keyboard focus, and a programmatically associated explanation.
- Disabled choices announce why they are disabled after the third selection.
- The pronunciation loading and error states use non-disruptive live-region text.
- Frequency copy consistently uses “traditionally associated with” and includes the evidence disclaimer near the choices.
- The UI recommends comfortable volume and makes every layer optional.

## Verification

Automated tests must cover:

- A guess fills after nickname blur when the field is untouched.
- A delayed guess cannot overwrite a manual edit or a newer nickname.
- Guess failure leaves the workflow usable.
- Standalone, repeated, punctuated, and case-varied nicknames are replaced only in the narration-bound script.
- Regex metacharacters in a nickname cannot alter matching behavior.
- Empty pronunciation leaves narration unchanged.
- Only enumerated frequencies are accepted; duplicates and a fourth layer are rejected.
- Tone gain remains bounded for one, two, and three layers.
- Player cleanup stops every oscillator on pause, end, source change, and unmount.
- Pronunciation and frequencies survive save, database read, and My nights replay.
- Legacy sessions without stored layers play normally.

Before release, run the full lint, typecheck, test, and production-build suite, then complete a browser smoke test covering nickname blur, manual correction to `LOCK-ee`, preview narration, three-layer selection, fourth-layer prevention, save, and My nights replay.

## Rollout order

1. Add schema and validation with tests.
2. Add pronunciation guessing and narration-bound substitution.
3. Add studio fields and race-safe auto-fill behavior.
4. Add local frequency synthesis and persistence.
5. Apply the migration, run the full verification suite, and deploy the Sites preview.
6. Verify production-like playback before beginning the separate NearSleep rename.
