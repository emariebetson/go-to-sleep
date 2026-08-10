# Nearnight

Nearnight is a parent-operated SaaS product that creates personalized baby bedtime narration in a parent's own voice. Parents choose a baby nickname, bedtime context, story world, duration, background sound, and narration style; review a constrained script; and generate private audio through ElevenLabs.

> **Launch status:** production-oriented MVP foundation. Provider secrets, legal review, pricing IDs, monitoring, and real-family validation are required before accepting customers.

## Product decisions

- **Audience:** adult parents of babies, initially 0–24 months. Children never create accounts or operate the product.
- **Writing:** reviewed templates or personalized OpenAI-generated scripts with strict baby-safe constraints and mandatory parent review.
- **Voice:** ElevenLabs Instant Voice Cloning with explicit adult attestation. Raw samples are transferred directly and are not stored by Nearnight.
- **Pricing:** one free lifetime generation; $12/month for 12 new sessions; unlimited replays; optional $7 five-session packs. This is more predictable than unlimited usage and simpler than metered invoices.
- **Storage:** D1 for relational metadata and R2 for generated MP3 files. Background sounds should be mixed on-device so the same voice track can be reused cheaply.
- **Identity:** Sites' dispatch-owned sign-in is isolated behind `lib/auth.ts`. Replace that adapter with a mobile-compatible OIDC provider before native app launch.

## Local setup

1. Install Node.js 22.13 or newer and run `npm install`.
2. Copy `.env.example` to `.env.local` and add development secrets.
3. Run `npm run db:generate` after schema changes and inspect the SQL.
4. Run `npm run dev` and open the local URL.
5. Run `npm test`, `npm run lint`, and `npm run build` before publishing.

The repository intentionally never commits `.env.local`.

## Required provider setup

### OpenAI

`OPENAI_API_KEY` powers only personalized script writing. Curated scripts work without it. `OPENAI_MODEL` defaults to `gpt-5-mini` and can be changed without code.

### ElevenLabs

Create a paid commercial account, add `ELEVENLABS_API_KEY`, and confirm current cloning eligibility and commercial terms. The app uses Instant Voice Cloning for onboarding and `eleven_multilingual_v2` for stable long-form narration. Test Flash v2.5 as a lower-cost preview model before launch.

### Stripe

Create a recurring product called **Nearnight Plus**, create a $12 monthly Price, and save its ID as `STRIPE_PRICE_PLUS_MONTHLY`. Add `/api/webhooks/stripe` as a webhook destination and subscribe at minimum to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Save the signing secret as `STRIPE_WEBHOOK_SECRET`. Configure Stripe's customer portal for payment-method updates and cancellation.

## Data and security model

- Every generated audio object uses a user-scoped R2 key and is served only after server-side ownership verification.
- Voice creation requires an explicit consent checkbox; deletion first checks ownership, then deletes at ElevenLabs, then tombstones the local record.
- Stripe webhooks use timestamped HMAC verification and an idempotency table.
- API routes require server-injected identity in production. The local preview identity is never enabled in production.
- Admin access must use `ADMIN_EMAILS`; production must never trust an admin flag supplied by the browser.
- Full names, exact birth dates, photos, health details, and child accounts are intentionally out of scope.

## Architecture

```text
Browser / future native apps
        │
        ├── identity adapter ─────────────── adult account
        │
        ├── /api/scripts ────────────────── OpenAI Responses API
        ├── /api/voices ─────────────────── ElevenLabs voice API
        ├── /api/sessions ───────────────── ElevenLabs TTS API
        └── /api/billing/* ──────────────── Stripe Checkout + Portal
                    │
             D1 metadata + R2 audio
```

Provider calls are kept behind route boundaries so iOS and Android can use the same APIs without exposing provider keys.

## Documentation

See [`docs/PRODUCT.md`](docs/PRODUCT.md) for naming, roadmap, UX, mobile strategy, SEO, monetization, and launch gates. The account-owner sequence is in [`docs/FOUNDER_SETUP.md`](docs/FOUNDER_SETUP.md).
