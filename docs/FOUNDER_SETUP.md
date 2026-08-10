# Founder setup checklist

This document separates what the repository already handles from the provider and legal choices that require the account owner. Never paste secret values into issues, chat, screenshots, or committed files.

## Already prepared

- OpenAI and ElevenLabs environment-variable integration
- adult-only authenticated studio, library, account, and admin pages
- private, ownership-checked audio delivery
- parent voice consent and deletion flows
- idempotent credit charging and Stripe webhook processing
- D1 schema, R2 object layout, and Sites bindings
- Google and Apple OAuth routes, session handling, and account tables
- a static product preview in `work/local-preview/index.html`

## 1. First network-enabled development run

Open a new Codex task with network access for this same repository and ask it to:

> Continue Nearnight setup: install dependencies, run lint/test/build, verify SSH, configure the GitHub remote, commit and push the initial build, then publish a private Sites preview.

The task should run these checks before publishing:

```sh
npm install
npm run lint
npm test
git remote add origin git@github.com:emariebetson/go-to-sleep.git
git push -u origin main
```

If `origin` already exists, verify it rather than adding it again. Use the repository-specific SSH key at `work/github-ssh/id_ed25519`; do not copy the private key into GitHub or any environment variable.

## 2. Google and Apple sign-in owner steps

1. Generate and store a stable `BETTER_AUTH_SECRET`.
2. In Google Cloud, create a web OAuth client and add `https://YOUR_HOST/api/auth/callback/google` as an authorized redirect URI.
3. Store its values as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. In Apple Developer, create a Services ID associated with a Sign in with Apple-enabled App ID.
5. Register `YOUR_HOST` and `https://YOUR_HOST/api/auth/callback/apple` for web authentication.
6. Create the Apple client-secret JWT and store the Services ID and JWT as `APPLE_CLIENT_ID` and `APPLE_CLIENT_SECRET`.
7. Set `BETTER_AUTH_URL=https://YOUR_HOST`, and schedule Apple secret rotation before the JWT expires.

Keep all credential values in `.env.local` and the deployment secret store only.

## 3. Stripe owner steps

Use Stripe test mode until the complete checkout and cancellation flow passes.

1. Create **Nearnight Plus** as a recurring product.
2. Add a **$12 USD monthly** recurring price.
3. Put the resulting `price_...` identifier in `STRIPE_PRICE_PLUS_MONTHLY`.
4. Enable payment-method updates and cancellation in the customer portal.
5. After the private preview has a stable HTTPS URL, add `https://YOUR_HOST/api/webhooks/stripe` as a webhook destination.
6. Subscribe it to the events listed in the README and save its `whsec_...` value as `STRIPE_WEBHOOK_SECRET`.
7. Store the test secret key as `STRIPE_SECRET_KEY`; replace test values with live values only after the launch gates pass.

Stripe secrets must be stored in the deployment secret store and `.env.local`, never committed.

## 4. Values the founder must choose

- `ADMIN_EMAILS`: comma-separated email addresses allowed to view `/admin`
- legal entity or individual operator name
- support and privacy contact email
- operating country and state/province
- refund policy and support response target
- final product name after trademark and app-store screening

These choices are required before final privacy policy, terms, consent language, and production billing can be approved.

## 5. Private pilot launch gate

Do not accept paying families until all of the following are true:

- production build, lint, and tests pass from a clean checkout
- D1 migration and R2 bindings are verified in the deployed environment
- OpenAI, ElevenLabs, Stripe, and admin secrets are present only in the deployment store
- sign-in, voice creation, script review, audio generation, replay, cancellation, and deletion pass end-to-end
- webhook retries do not duplicate credits
- provider timeouts and failure messages are tested
- legal/privacy review covers voice consent, babies' information, subscriptions, and marketing claims
- error monitoring, uptime monitoring, cost alerts, backups, and an incident contact are active
- a small invite-only pilot completes successfully before public access
