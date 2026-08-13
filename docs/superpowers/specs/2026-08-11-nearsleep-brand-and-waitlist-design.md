# NearSleep Brand and Product Waitlist Design

**Status:** Approved design, pending user review of this written specification
**Date:** August 11, 2026

## Goal

Make the public product family understandable without exposing unfinished services: NearSleep is available now, while NearStory, NearFamily, and NearLegacy are clearly presented as coming soon with a simple email waitlist. Replace every user-visible NearNight/Nearnight reference with NearSleep. Persist every waitlist signup in the application database and mirror it to a private Google Sheet in the founder's main Google Drive for marketing use.

## Product presentation

The umbrella brand is **NearYou**. The public product cards are:

| Product | Public status | Public description | Action |
|---|---|---|---|
| NearSleep | Available now | Personalized sleep and calming audio in a familiar adult voice | Create a bedtime |
| NearStory | Coming soon | Parent-controlled personalized stories that make the child the protagonist | Join waitlist |
| NearFamily | Coming soon | More children, loved-one voices, household members, and shared family capacity | Join waitlist |
| NearLegacy | Coming soon | A consent-based archive of original family recordings, memories, and provenance-grounded search | Join waitlist |

NearStory and NearLegacy generation routes, navigation destinations, worker routes, and rollout flags remain disabled. A coming-soon card never links to a disabled application screen.

## Brand migration

All user-visible occurrences of **NearNight**, **Nearnight**, or **Near Night** become **NearSleep**, including:

- header, footer, sign-in, account, Studio, Library, player, visualizer, pricing, safety, privacy, and terms copy;
- page titles, descriptions, Open Graph text, image alt text, application name, and structured metadata;
- validation and safety messages shown to users.

Internal compatibility identifiers that are not visible to users remain unchanged when renaming them would break stored preferences, OAuth callbacks, database records, URLs, or event listeners. This includes the existing public hostname, environment-variable names, database identifiers, storage keys, CSS hooks, and browser-storage/event keys. New user-visible copy must use NearSleep.

## Public UI

### Header

The brand reads **NearSleep** with the existing NearYou family treatment. Navigation adds **What's next**, linking to the product-family section on the home page. Disabled product application routes are not added to the navigation.

### Home page

Add a section titled **The NearYou family**, with the four product cards above. NearSleep has an **Available now** badge. The other cards have a **Coming soon** badge and a **Join waitlist** button.

The existing hero and pricing summary are updated to NearSleep language. The public summary no longer advertises the grandfathered $12 plan to new customers. It shows NearSleep as available and points visitors to the full pricing page.

### Pricing page

The dark-release pricing page must remain honest:

- NearSleep available-now pricing and grandfathering language remain accurate to the currently enabled checkout.
- NearStory is shown as included in the future $14.99/month or $149.99/year first paid tier, but its action is **Join waitlist** while disabled.
- NearFamily is shown at $24.99/month or $249.99/year with **Join waitlist**.
- NearLegacy is shown at $39.99/month or $399.99/year with **Join waitlist**.
- Archive Builder and Archive Care may be described inside the NearLegacy card, but must not present active checkout while NearLegacy is disabled.

No inactive product button posts to Stripe or implies immediate access.

## Waitlist interaction

The same accessible form is used from home and pricing. Selecting **Join waitlist** opens an inline panel or modal containing:

- email address;
- the preselected product, editable as checkboxes for NearStory, NearFamily, and NearLegacy;
- an unchecked marketing-consent checkbox with concise consent copy;
- links to Privacy and Terms;
- submit and cancel controls.

The form requires at least one product and explicit marketing consent. It validates and normalizes email addresses server-side. Success copy states which products were saved and that the user can unsubscribe at any time. A duplicate email merges product interests instead of creating duplicate contacts.

The form is usable without an account. It is keyboard accessible, traps and restores focus when modal presentation is used, announces errors and success through an `aria-live` region, and remains usable at 320 CSS pixels.

## Application data model

Add two additive D1 tables:

### `marketing_waitlist_contacts`

- `id`: opaque UUID primary key;
- `email_lookup_hash`: unique keyed HMAC of the normalized email, used for duplicate detection without storing a second plaintext copy;
- `email_ciphertext`: encrypted original email;
- `email_iv`: AES-GCM initialization vector;
- `consent_version`: exact marketing consent copy version;
- `consented_at`: server timestamp;
- `unsubscribed_at`: nullable server timestamp;
- `created_at` and `updated_at`.

### `marketing_waitlist_interests`

- `id`: opaque UUID primary key;
- `contact_id`: foreign key to the contact;
- `product`: one of `nearstory`, `nearfamily`, or `nearlegacy`;
- `signup_source`: bounded allowlist such as `home` or `pricing`;
- `joined_at`: server timestamp;
- unique constraint on `(contact_id, product)`.

### `marketing_waitlist_sync`

- one row per contact version requiring Google synchronization;
- state: `pending`, `processing`, `completed`, or `dead_letter`;
- attempt token, lease expiry, attempt count, next attempt time, last safe error code, and timestamps;
- unique version/idempotency key so lost responses cannot create duplicate Sheet rows.

Email plaintext must not appear in logs, analytics, URLs, query strings, idempotency keys, or error messages. The encryption key is a new server-only secret and must be present before the waitlist API can accept submissions.

## API behavior

`POST /api/v1/marketing/waitlist` accepts bounded JSON containing email, products, source, consent boolean, and consent version.

The route:

1. enforces trusted mutation origin and a strict JSON byte limit;
2. rate-limits by privacy-safe IP hash and keyed normalized-email hash;
3. validates the email and product allowlist;
4. requires the current consent version and affirmative consent;
5. encrypts the email;
6. atomically upserts the contact, merges interests, and creates a sync job;
7. returns the selected products without returning internal identifiers or email plaintext.

Repeated identical requests are successful and idempotent. Changed product selections merge interests. An unsubscribed contact may rejoin only through a new affirmative consent timestamp.

`POST /api/v1/marketing/unsubscribe` consumes a single-use, expiring, hashed token delivered in marketing messages. It records `unsubscribed_at`, creates a Google sync job, and immediately excludes the contact from marketing exports. Unsubscribe does not depend on login, billing, worker health, or a product rollout flag.

## Google Drive and marketing access

Create a private Google Sheet named **NearYou Waitlist** in the founder's main Google Drive. The marketing-access worksheet has these columns:

- Email
- Product interests
- Signup source
- Consent version
- Consented at
- Status (`subscribed` or `unsubscribed`)
- Last synced at

The application database is authoritative. Google Sheets is a marketing mirror, not the only copy.

A bounded background synchronizer calls the Google Sheets API using a least-privilege service account. The founder shares only the **NearYou Waitlist** Sheet with that service-account email. The application stores the Sheet ID, service-account client email, and private key as server-only runtime configuration. The synchronizer updates rows by opaque contact ID stored in a hidden protected column; it does not search by email and does not append duplicates.

Synchronization requirements:

- exponential backoff with jitter and a maximum attempt count;
- attempt-token fencing and lease expiry;
- Google request timeout and response-size bounds;
- idempotent update after ambiguous/lost responses;
- dead-letter visibility without logging email addresses;
- an authenticated internal continuation endpoint because Sites does not provide production cron configuration;
- a readiness heartbeat and alert if pending jobs exceed the service objective.

Public launch of the waitlist is blocked until the Sheet exists, is shared with the service account, runtime secrets are configured, the external one-minute scheduler is active, and a canary signup is visible in both D1 and the Sheet.

## Privacy and marketing rules

- The waitlist is adult-directed and collects only an email address, product interests, source, and consent evidence.
- Marketing consent is separate from product terms and is unchecked by default.
- Privacy copy identifies Google Sheets as a marketing operations processor/mirror.
- Marketing users receive access through Google Drive sharing; the Sheet is not public or link-shared.
- Sheet editors must not add sensitive family, child, voice, payment, or archive data.
- An unsubscribe updates both the authoritative database and the Sheet.
- Retention: dead-letter operational metadata may be retained without email plaintext; unsubscribed email data follows the documented suppression/retention policy and applicable legal review.

## Failure handling

- Google outage: signup succeeds after the atomic database write; sync remains pending and retries.
- Database write failure: signup fails and no Google write is attempted.
- Lost Google response: the same contact/version is retried and updates the same row.
- Missing or malformed encryption/Google configuration: the public form fails closed with a generic temporary-unavailability message.
- Scheduler outage: the UI may accept signups only while the sync backlog remains below the configured safety ceiling; otherwise it fails closed to avoid an unbounded unsynchronized queue.

## Testing and release gates

Required automated coverage:

- brand-copy scan proving no user-visible NearNight variants remain;
- rendered home, header, footer, metadata, sign-in, Studio, pricing, account, legal, and player assertions;
- accessible waitlist form keyboard, focus, validation, and 320-pixel layout tests;
- actual D1 route tests for validation, encryption, duplicate merging, re-consent, unsubscribe, cross-request behavior, rate limits, and lost-response idempotency;
- fake Google Sheets contract tests for create/update, ambiguous responses, retries, dead-letter, unsubscribe, and no duplicate rows;
- secret/PII log scans;
- dark-gate tests proving NearStory/NearLegacy APIs remain unavailable;
- lint, typecheck, production build, complete test suite, migration apply/FK/integrity, and schema-drift checks;
- live smoke tests for home, pricing, waitlist submission, Google Sheet canary, unsubscribe, sign-in redirect, and disabled-product routes.

The prior Sites version remains the rollback target. Deployment must preserve the existing public URL and Stripe test mode.

## Acceptance criteria

1. A visitor sees NearSleep everywhere instead of NearNight/Nearnight.
2. NearStory, NearFamily, and NearLegacy are discoverable as coming soon without exposing unfinished application routes.
3. A visitor can join one or more product waitlists without signing in.
4. A signup is durably stored once in D1 and mirrored once to the private **NearYou Waitlist** Google Sheet.
5. Marketing can filter the Sheet by product and subscription status.
6. Unsubscribe immediately suppresses marketing and synchronizes to Google.
7. No plaintext email or infrastructure secret appears in logs, URLs, source control, or analytics.
8. Existing NearSleep creation, sign-in, library, Stripe test checkout, and playback continue to work.
