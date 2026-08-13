# Task 1 NearFamily implementation report

## Status

Implemented the authenticated, default-dark NearFamily web dashboard and shared source activation gate. No commit, push, deployment, flag activation, migration, or external-system mutation was performed.

## Changed files

- `lib/nearfamily-activation.ts` — single reviewed source constant and default-off helper; runtime environment cannot enable it.
- `lib/nearfamily-route.ts` — testable GET handler enforcing source activation before auth, then household authentication, PostgreSQL product authorization, and exact summary loading.
- `app/api/v1/family/route.ts` — production dependencies wired into the shared handler; PostgreSQL remains household rollout/kill-switch authority.
- `app/family/page.tsx` — authenticated, non-indexed `/family` page guarded by the shared source helper.
- `app/family/FamilyDashboard.tsx` — exact capacity use/limits, restricted-state explanation and remediation links, and adult-managed safety boundaries.
- `components/AppShell.tsx` — conditional Family capacity navigation driven by the shared source helper.
- `tests/nearfamily-web.test.mjs` — executable dark, unauthorized/kill, invited, restricted UI, auth-order, and navigation behavior tests.
- `tests/product-release-readiness.test.mjs` — updated source contract for the shared source helper while retaining PostgreSQL authorization assertions.

The untracked implementation-plan document pre-existed this task and was not edited.

## RED evidence

Command:

`/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --import tsx --test tests/nearfamily-web.test.mjs`

Observed expected failure: `ERR_MODULE_NOT_FOUND` for the not-yet-created `lib/nearfamily-route.ts`. This proved the new behavior test depended on missing production functionality.

## GREEN evidence

Focused command:

`/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --import tsx --test tests/nearfamily-web.test.mjs tests/nearfamily-capacity.test.mjs tests/product-release-readiness.test.mjs`

Result: 44 tests passed, 0 failed.

Additional gates:

- TypeScript: `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node node_modules/typescript/bin/tsc --noEmit --incremental false` — passed.
- Scoped ESLint: `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node node_modules/eslint/bin/eslint.js app/family app/api/v1/family components/AppShell.tsx lib/nearfamily-activation.ts lib/nearfamily-route.ts tests/nearfamily-web.test.mjs tests/nearfamily-capacity.test.mjs tests/product-release-readiness.test.mjs` — passed.
- Diff check: `git diff --check` — passed.
- Production build: `WRANGLER_LOG_PATH=.wrangler/wrangler.log /tmp/nearyou-build-node node_modules/vinext/dist/cli.js build` — passed and emitted `/family` plus `/api/v1/family`.

The first build attempt failed because the bundled ChatGPT Node executable and installed Rolldown native binary had incompatible macOS Team IDs. For verification only, a copy of bundled Node at `/tmp/nearyou-build-node` and the installed dependency binary were ad-hoc signed; no repository source or lockfile changed.

## Remaining concerns

- The source constant intentionally remains `false`; invited/canary behavior cannot be live until a separately reviewed source activation change.
- Runtime PostgreSQL connectivity, signed evidence, exact household invite, D1 migrations, and deployed behavior remain external and unproven here.
- The AppShell link and `/family` page now share exact household-specific PostgreSQL authorization; denied and kill-switched households receive no link and an indistinguishable 404.
- Independent skeptic verdict was requested and is pending at report creation time.

## Fix round 1: page and navigation authorization

Skeptic review correctly identified that a source-bit-only page/navigation decision could expose a successful shell to an unauthorized or kill-switched household after source activation.

RED evidence:

- The new behavior suite first failed because `createNearFamilyPageAvailability` did not exist.
- The non-Family navigation behavior then failed because `resolveFamilyNavigationAvailability` did not exist.

Correction:

- `createNearFamilyAvailability` now combines source activation, authenticated household context, and exact PostgreSQL household authorization.
- `/family` converts membership/rollout denial into `notFound()` and passes its single authorized decision into `AppShell`, avoiding a second rollout sample.
- Other authenticated pages compute the same household-specific decision only when no explicit decision is passed; denied/kill-switched households do not see the link.
- API ordering remains source gate before authentication.

GREEN evidence after correction:

- Focused suite: 47/47 passed before the final non-Family navigation tests were added; the final gate command below supersedes that result.
- TypeScript, scoped ESLint, diff-check, and production build passed; build lists both `/family` and `/api/v1/family`.
