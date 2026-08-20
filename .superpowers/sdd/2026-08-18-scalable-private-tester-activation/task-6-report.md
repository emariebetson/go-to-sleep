# Task 6 report — synthetic private tester smoke and rollback proof

## Delivered

- Added a dependency-injected, synthetic NearStory and NearFamily smoke proof. It uses deterministic non-personal household hashes and a release-scoped R2 prefix; it verifies create, process, persist, play, outcome delivery, deletion, identity, member access, invitation entitlement, privacy isolation, and capacity remediation.
- Added a synthetic rollback drill. It proves the Task 5 invitation-controller authorization changes from allowed to denied after a kill, rejects new work, fences an already queued item, retains deletion and remediation, and permits the supplied prior Sites version.
- Both proofs fail closed unless literal-dark gates remain off, both products allow only the invited household and deny the other, D1 has both immutable audit triggers, the DLQ is empty, R2 remains in the exact synthetic household scope, and no cross-household read is possible.
- Every returned proof includes a deterministic SHA-256 result hash. Persisted synthetic media is cleaned up in a `finally` path, including when outcome delivery validation fails.

## Scope and safety

The existing `private-canary-live.ts` wrapper was intentionally not invoked or changed: it is an authenticated production-observation wrapper. Task 6 adds only local, supplied-dependency proof code and never deploys, calls a service, creates a real invitation, or mutates/deletes product data.

## TDD evidence

- RED: the focused rollback suite failed with `ERR_MODULE_NOT_FOUND` because `scripts/private-tester-rollback-drill.ts` did not exist.
- GREEN: implemented the minimal synthetic runners and the focused proof suite passed.

## Verification

- Bundled Node focused suites: 30 passed, 0 failed (`private-canary-smoke`, `private-tester-rollback-drill`, and `private-tester-activation`).
- `npm run typecheck`: passed.
- Scoped ESLint for the changed TypeScript and test files: passed.
- `git diff --check`: passed.

## Fix round 1

- Replaced the permissive injected authorization stub with a synthetic session built from the actual Task 5 activation controller and the product-access adapter. The PostgreSQL fallback is deliberately an unreachable test guard: invitation authorization must resolve before any rollout query.
- The rollback drill now invokes the Task 5 NearStory kill and NearFamily revoke operations, then proves both products deny the synthetic invited household through the product-access seam.
- Synthetic fixture hashes must now be derived from the exact Task 6 namespace and release marker; arbitrary household hashes are rejected.
- Proof hashes now cover captured authorization, story creation/processing/persistence/play/outcome/cleanup, family and D1/DLQ/R2 observations, queue disposition, Task 5 state transitions, recovery, and prior-Sites redeploy result.
- The live wrapper now evaluates invited and denied NearStory/NearFamily authorization through the Task 5 PostgreSQL invitation evaluator before accepting the combined canary observation. It was not run in this task.

### Fix-round verification

- Bundled Node focused suites: 39 passed, 0 failed (`private-canary-smoke`, `private-tester-rollback-drill`, `private-tester-activation`, and `private-canary-live-cli`).
- `npm run typecheck`, scoped ESLint, and `git diff --check`: passed.
