# Task 7 report — durable private tester canary contract

## Delivered

- Replaced the networked canary CLI path with a local-only, generation-zero evidence store. It records one exact 15-minute slot per release/build/deployment identity and resumes only byte-identical retries.
- Added a fail-closed 96-slot / 24-hour validator. It rejects missing, late, duplicate, identity-changed, authorization-leaking, integrity-failing, worker-failing, error-spiking, DLQ, and stale-heartbeat evidence.
- Finalization requires a Task 6-shaped rollback recheck, a supplied signer, and an immutable final receipt. Any invalid observation or final rollback/signature/receipt conflict calls only the injected proof adapter's `requestKill` seam before failing; this task provides no production kill implementation.
- Reworked the sampler workflow into a manually dispatched local contract check. It has no scheduler, production environment, credentials, OIDC, deploy, database, network sampler, or kill-switch action. The production-evidence workflow no longer invokes the canary CLI; it rejects an unsupplied canary artifact until a separately reviewed receipt is available.

## TDD evidence

- RED: the new focused suite initially failed because `canary-evidence-cli.ts` did not export the local store or sampling/finalization interfaces.
- GREEN: the focused suite now covers the complete 96-sample window, byte-identical resume, final signed receipt, missing intervals, late and duplicate intervals, release/build/deployment changes, authorization leak, integrity failure, worker failure, error spike, DLQ, stale heartbeat, storage failure, and failed rollback recheck.

## Verification

- Bundled Node focused test: 5 passed, 0 failed (`tests/private-tester-canary-window.test.mjs`).
- `npm run typecheck`: passed.
- Scoped ESLint: passed.
- `git diff --check`: passed.

## Scope and safety

No 24-hour monitor was scheduled or run. No deployment, production request, database mutation, rollout change, invitation, or kill switch was invoked. The only kill calls exercised were test-provided in-memory adapters.
