# NearYou Still custom-domain cutover

Status: source-ready, deployment approval required. The canonical redirect is default-off. NearStory, NearFamily, NearLegacy, canary, scheduler, and infrastructure-readiness gates must remain dark throughout this website release.

## Fixed public contract

- Canonical origin: `https://nearyoustill.com`
- `www.nearyoustill.com`: redirect to apex only after both certificates are active and apex acceptance passes.
- Former Sites hostname: continue serving authentication and API traffic for seven days; redirect only GET/HEAD page traffic after apex acceptance.
- Public routes: `/`, `/nearsleep`, `/nearstory`, `/nearfamily`, `/nearlegacy`.
- Application routes remain `/studio`, `/library`, `/stories`, `/family`, and `/legacy`.
- NearSleep is the only product described as available.

## Evidence to capture before any mutation

Record the operator, America/Chicago timestamp, repository commit/tag, Sites version and public URL, current D1 migration ledger, R2 bucket health, configured environment names (never secret values), Google OAuth redirect list, PostHog project identity, Porkbun DNS export, and rollback Sites version. Save screenshots or exported records with the private release evidence; do not paste credentials into tickets or logs.

## Release order

1. Confirm a clean reviewed commit and all source gates: tests, type checking, linting, production build, redirect tests, and `git diff --check`.
2. Obtain Elizabeth's approval of the exact public copy and social-preview asset after legal, privacy, trademark, and pre-publication IP review. Do not disclose potentially unfiled technical mechanisms.
3. In Google OAuth, add `https://nearyoustill.com/api/auth/callback/google`. Keep the former callback for seven days.
4. In Sites, add `nearyoustill.com` and `www.nearyoustill.com`. Copy the exact validation, apex, and `www` records Sites returns.
5. In Porkbun, add only those records. Preserve MX, SPF, DKIM, DMARC, forwarding, DNSSEC, and unrelated records.
6. Wait until Sites reports active ownership and SSL for both names. Keep `CANONICAL_HOST_REDIRECT_ENABLED=false`.
7. Set production `PUBLIC_APP_URL=https://nearyoustill.com` and `BETTER_AUTH_URL=https://nearyoustill.com`. Configure only the already-approved PostHog project via `POSTHOG_PROJECT_KEY` and `POSTHOG_HOST`; leave unset to disable measurement.
8. Save and deploy the exact reviewed Sites version. Test the apex directly before enabling redirects.
9. Enable the `www` redirect. Re-run acceptance. Then separately enable `CANONICAL_HOST_REDIRECT_ENABLED=true` for old-host page traffic.
10. Observe for at least 24 hours. After seven clean days, remove the former Google callback and separately review denial or redirection of remaining old-host API traffic.

## Apex acceptance

- All five public routes and the umbrella 404 render on mobile and desktop with correct canonical metadata, sitemap, robots, social preview, structured data, keyboard focus, and landmarks.
- Google sign-in, sign-out, and safe return to `/library` work. A one-time new-domain sign-in is expected because cookies do not migrate between hosts.
- Account, NearSleep creation, My Nights, audio/R2 playback, Stripe checkout success/cancel, and billing portal return work on the apex.
- Each future-product waitlist persists encrypted email, explicit consent, exact product source, idempotent replay, and unsubscribe state.
- PostHog receives only approved anonymous `landing_view`, `creation_started`, and `expansion_interest_confirmed` properties. Missing analytics configuration does not affect any user flow.
- `/stories`, `/family`, `/legacy`, internal canary routes, schedulers, and product APIs retain their reviewed dark/denied behavior.
- `www` and former-host redirect tests show no loops and never forward OAuth code, state, tokens, credentials, or unsafe query fields.

## Rollback

1. Set `CANONICAL_HOST_REDIRECT_ENABLED=false` first.
2. Restore the immediately previous Sites version if needed.
3. Keep the new DNS records unless certificate or routing failure requires removal.
4. Do not roll back D1/R2 data and do not change any product rollout state as part of a website rollback.
5. Record the incident, affected URLs/timestamps, restored version, and whether any public disclosure differed from the approved release.

## Seven-day drain closeout

Remove the obsolete OAuth callback only after seven clean days and a fresh sign-in smoke test. Preserve the final redirect/OAuth/DNS evidence and log the public deployment URL, timestamp, release commit, disclosed copy/assets, and confirmed natural-person contributors in the NearYou IP record.
