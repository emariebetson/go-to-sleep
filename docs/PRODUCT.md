# Nearnight product and launch plan

## 1. Positioning and name

**Working name:** Nearnight

**Promise:** Your familiar voice, close through the night.

**Category:** personalized parent-voice bedtime audio for babies.

The name expresses proximity and nighttime without making a sleep guarantee. A preliminary web search found no obvious sleep-product collision, but this is not trademark clearance. Before investing in the brand, run USPTO and international trademark searches, check app stores and social handles, and have counsel review the mark.

Shortlist for structured testing:

| Name | Strength | Risk |
|---|---|---|
| Nearnight | Warm, distinctive, benefit-led | Needs explanation on first exposure |
| Lullaby You | Immediately clear and personal | Descriptive; harder to protect |
| Closeby | Captures parental presence | Broad and likely crowded |
| Moonmurmur | Beautiful, memorable sound | Less obviously parent-voice technology |
| Hushnote | Short and audio-oriented | “Hush” can feel command-like |

Test comprehension, warmth, memorability, spelling, and “would you trust this with your voice?” with 8–12 parents before final selection.

## 2. Core parent journey

1. Land on a clear non-medical promise and see trust controls before being asked to sign up.
2. Sign in as an adult and acknowledge the parent-operated product boundary.
3. Add a baby nickname, age in months, and current bedtime context.
4. Record 60–120 seconds of the parent's own voice and attest consent.
5. Choose story world, length, background sound, narration style, and curated vs personalized writing.
6. Review and edit every word before voice generation.
7. Generate, play from a safe distance, save privately, and replay without extra credits.
8. Delete a session, voice, or account with visible confirmation of provider deletion.

## 3. UX principles

- **Designed for 3 a.m.:** large touch targets, one decision per section, plain language, progress preserved, no dark patterns.
- **Warm, not childish:** parchment, dusk periwinkle, muted peach, sage, editorial type, minimal illustration.
- **Parent agency:** scripts are reviewable; no automatic audio generation from unreviewed text.
- **Progressive trust:** explain why voice data is needed at the moment of recording, not in an unreadable wall of legal copy.
- **Accessible:** semantic fields, keyboard focus, contrast-aware colors, reduced-motion support, captions/transcripts, and no meaning conveyed by color alone.

## 4. Roadmap

### Phase 0 — founder validation (2 weeks)

- Interview 12–15 parents of babies, including families with frequent waking and separation challenges.
- Test the promise, five names, willingness to record a voice, and $9/$12/$15 price anchors.
- Concierge-produce 10 sessions with explicit consent; measure first-play completion, repeat playback, and qualitative comfort.
- Engage privacy and child-safety counsel before collecting production voice data.

**Gate:** at least 60% of testers replay a session within seven days and at least 5 of 10 say they would pay $10+ monthly.

### Phase 1 — private web beta (4–6 weeks)

- Adult authentication, onboarding, consent ledger, one voice, sleep recipe, curated and personalized scripts, parent review, generation queue, private library, deletion.
- Stripe Checkout and customer portal; 1 free session, Plus plan, credits, provider-cost telemetry.
- Error monitoring, product analytics, rate limits, backups, deletion audit, support inbox, and incident runbook.
- Invite-only cohort of 50 families.

**Gate:** generation success >98%, week-one retained families >40%, support burden <10 minutes/family/week, zero unresolved deletion failures.

### Phase 2 — public web launch (4 weeks)

- Referral credit, gift subscriptions, multilingual testing, stronger onboarding sample coaching, downloadable offline sessions, content CMS, SEO library.
- A/B test one free generation vs a 7-day trial.
- Add post-play feedback and safe, aggregated outcome language such as “played again,” never guaranteed sleep.

### Phase 3 — iOS and Android (6–10 weeks)

- Expo/React Native client against the existing API boundaries.
- Replace preview identity with mobile-compatible OIDC using passkeys, Apple, and Google.
- Encrypted local download, background audio, lock-screen controls, timer, AirPlay/Cast, and push only for parent-configured reminders.
- Use Apple/Google in-app purchases for native digital subscriptions; reconcile entitlements server-side with Stripe web subscriptions.

### Phase 4 — expansion

- Multiple caregivers with separate explicit voice consent.
- Age-appropriate toddler product as a separate content and compliance surface.
- Pediatric sleep-consultant partnerships without medicalizing product claims.
- Employer/family-benefit distribution and gift bundles.

## 5. Monetization and unit economics

Recommended launch model:

- **Free:** one lifetime 5-minute personalized session; unlimited replays.
- **Plus — $12/month:** 12 new sessions, 5–20 minutes, one voice, unlimited replays.
- **Session pack — $7:** five additional sessions that do not expire while the account remains active.
- **Annual — $99/year:** introduce only after three months of retention data.

Do not offer unlimited generation initially. Voice TTS has a variable character cost, long sessions magnify it, and abusive or accidental regeneration can erase margin. Credits provide a parent-friendly ceiling. Keep internal usage by characters and provider cost, but do not send parents metered invoices.

Cost controls:

- Generate the script first and audio only after explicit parent approval.
- Cache finished voice audio forever until deletion; replays are storage/egress, not new TTS.
- Mix rain/noise locally rather than baking multiple background variants into new voice files.
- Prevent duplicate submit, use idempotency keys, and retry only retryable provider errors.
- Compare Flash v2.5 and Multilingual v2 in blinded parent tests; use the cheapest model that clears quality.
- Alert when provider cost exceeds 25% of net revenue or per-family generation exceeds the plan envelope.

## 6. SEO and acquisition

### Search strategy

Focus on high-intent, non-medical parent questions:

- personalized bedtime story for baby
- bedtime story in mom's or dad's voice
- record my voice for baby bedtime
- calming bedtime audio for baby
- bedtime routine when parent is traveling
- safe volume for baby sleep sounds

Build useful editorial clusters around bedtime routines, parental presence while traveling or working nights, voice-recording quality, white/brown noise basics, and age-appropriate story rhythm. Every safety article requires qualified review and source dates. Avoid “cure,” “treat,” “sleep through the night guaranteed,” and comparable health claims.

### Technical SEO

- Unique metadata and canonical URLs for public pages; noindex all account, studio, library, audio, and admin routes.
- Generate `sitemap.xml`, `robots.txt`, Article/FAQ structured data only where visible content supports it.
- Optimize Core Web Vitals, self-host or subset fonts, compress social assets, and avoid blocking provider scripts.
- Use privacy-respecting first-party analytics with conversion events: CTA, onboarding start, consent completion, script approval, first generation, first replay, paid conversion.

### Founder-led channels

- Short demos showing a parent recording and reviewing, never footage implying a baby is unsupervised.
- Partnerships with postpartum doulas, newborn photographers, parental-leave communities, travel nurses, and military families.
- Referral reward after a referred parent completes their first session, with fraud limits.

## 7. Admin dashboard

MVP operator views:

- active families, trial-to-paid, week-one and month-one retention, generation success, median generation time;
- characters, TTS cost, storage, and gross margin by cohort;
- voice creation failures, deletion reconciliation, webhook failures, and stuck jobs;
- support and safety reports with immutable audit events;
- subscription and entitlement state sourced from verified webhooks.

Never expose raw voice samples in admin. Support tools should use short-lived, logged impersonation or scoped metadata views only.

## 8. Deployment and launch checklist

1. Install dependencies and pass typecheck, lint, tests, migration generation, and production build in CI.
2. Create D1 and R2 bindings; apply the reviewed migration before serving application traffic.
3. Configure OpenAI, ElevenLabs, Stripe, webhook, price, and admin secrets in the deployment secret store—not source control.
4. Set production authentication and ensure user identity is validated server-side on every private API.
5. Configure provider timeouts, exponential retry with jitter, circuit breakers, rate limits, and idempotency.
6. Add Sentry-compatible error reporting, uptime checks, structured logs without scripts or voice data, and cost alerts.
7. Run deletion integration tests against sandbox provider accounts.
8. Complete privacy, biometric-consent, child-directed product, subscription, app-store, and marketing-claims legal review.
9. Complete threat modeling, dependency and secret scanning, backup/restore tests, and an incident-response exercise.
10. Deploy privately, run a 10-family production pilot, then expand access deliberately.

## 9. Known launch blockers

- ElevenLabs API key, paid commercial eligibility, data-processing terms, and deletion behavior need confirmation.
- Stripe products, prices, portal, tax posture, refund rules, and live webhook secret are not configured.
- The current Sites identity adapter is suitable for the hosted preview but must be validated for the intended public consumer launch and replaced before native apps.
- Legal entity/contact details and jurisdiction-specific privacy/biometric consent language are missing.
- Admin aggregates are live; retention, latency, cost, and deletion-reconciliation metrics still need event instrumentation before the private pilot.
- Background sound synthesis/playback and an asynchronous job queue need production implementation and device testing.
