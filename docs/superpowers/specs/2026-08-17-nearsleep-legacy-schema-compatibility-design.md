# NearSleep Legacy Schema Compatibility Design

## Context

NearSleep production runs with the modern production feature gates disabled and an existing D1 schema that predates migration `0011_household_billing_accounts.sql`. The live `entitlements` table therefore has no `billing_period_start` column. Current Drizzle metadata includes that column and emits it, as `NULL`, even when the application omits the property from a new free-entitlement value. New accounts fail during `createEntitlement` before any provider request.

The Studio also unconditionally requests production-only onboarding and child-profile endpoints. Those endpoints correctly return 404 while their gates are disabled, but the requests create avoidable console errors in legacy mode.

## Approved approach

Preserve the production database and its disabled feature gates. Add a narrowly scoped legacy entitlement writer that uses a prepared D1 statement listing only the columns present since migration `0006_nearyou_shared_foundation.sql`. Keep deterministic IDs, the Free plan values, foreign-key behavior, and conflict tolerance unchanged. `ensureUser` will use that writer only for its legacy Free bootstrap.

Pass the server-evaluated NearSleep production-mode flag into the Studio. The client will load all production datasets only when that flag is true; in legacy mode it will load only `/api/voices`. The existing production responses and the legacy voice response retain their current parsing and UI behavior.

## Alternatives rejected

1. Applying migrations `0007` through `0011` directly to production would expand the database and activate unreviewed schema assumptions. It is disproportionate to this compatibility incident.
2. Skipping entitlement creation entirely in legacy mode would make account state incomplete and could break later allowance or upgrade behavior.
3. Catching and ignoring the failed Drizzle insert would hide a real invariant violation and leave the same incomplete account state.

## Safety and invariants

- No production migration or environment-variable change.
- No provider-key, provider-credit, voice-consent, or audio-upload change.
- The entitlement insert remains idempotent with `ON CONFLICT DO NOTHING`.
- The insert names every legacy column explicitly and binds no user data into SQL text.
- Production mode continues to fetch onboarding, children, and voices; legacy mode fetches only voices.
- Errors from the one required mode-specific bootstrap request keep the existing user-facing behavior.

## Verification

Use a real in-memory SQLite database with the exact migration `0000` through `0006` schema and a D1-compatible prepared-statement adapter. The regression must fail with the current Drizzle-wide insert behavior and pass when the compatibility writer creates the expected Free entitlement. A second behavior test will assert the exact endpoint set selected for legacy and production Studio bootstraps. Run focused tests, the full typecheck/build/test suite, an independent task review, and a final branch review before publishing an existing-schema Sites archive with no migrations.
