# NearFamily private-tester rollout — fresh-chat handoff

**Prepared:** 2026-08-19 (America/Chicago)
**Working branch:** `codex/scalable-private-tester-activation-20260819`
**Worktree:** `/Users/elizabethbetson/Documents/ChatGPT/let/.worktrees/scalable-private-tester-activation-20260819`
**Goal:** Admit one release-bound NearFamily tester household only after all required evidence is green. NearStory must remain dark; public NearFamily rollout remains zero.

## Start here

Read these in order:

1. `docs/superpowers/plans/2026-08-19-nearfamily-cloudflare-private-tester-rollout.md` — authoritative six-task implementation plan.
2. `docs/superpowers/specs/2026-08-19-cloudflare-private-tester-readiness-gateway-design.md` — gateway design and constraints.
3. `.superpowers/sdd/2026-08-19-nearfamily-cloudflare-private-tester-rollout/task-1-report.md`
4. `.superpowers/sdd/2026-08-19-nearfamily-cloudflare-private-tester-rollout/task-1-rereview.md`
5. `.superpowers/sdd/2026-08-19-nearfamily-cloudflare-private-tester-rollout/task-2-report.md`

The plan file is currently uncommitted but intentional. Do not lose it when staging Task 3.

## Current branch state

Committed work (newest first):

| Commit | State | What it contains |
| --- | --- | --- |
| `af4010e` | implemented | Strict split decision/controller gateway contracts and tests (Task 2). |
| `6355fe9` | implemented, evidence still pending | Task 1 reviewer remediation: a fail-closed PostgreSQL 16 proof job and unsafe pre-existing role rejection. |
| `24943da` | implemented, evidence still pending | Fixed execute-only PostgreSQL NearFamily decision authority (Task 1). |
| `fa74749` | design | Cloudflare readiness-gateway design. |
| `9310cf2` | reviewed | Earlier private-tester canary receipt: recomputed Task 6 rollback hash and exact release/build/deployment binding. |

There is unfinished, uncommitted Task 3 work:

- `infra/production/readiness-gateway.tf`
- `infra/production/variables.tf` (modified)
- `infra/disposable/readiness-gateway.tfvars.example`
- `scripts/verify-readiness-gateway.ts`
- `tests/readiness-gateway-infrastructure.test.mjs`
- this handoff and the plan file

`/.local-node/` is an untracked private Node runtime used only for local checks. Do **not** stage or commit it.

## What is implemented and verified locally

### Task 1 — fixed PostgreSQL decision authority

The migration `0012_nearfamily_private_tester_decision.sql` creates a dedicated NOLOGIN role and a fixed security-definer decision function. It denies release/hash mismatches, expiry, revocation, and terminal kill. It rejects any pre-existing decision role rather than attempting to normalize unknown privilege state.

Local contract/type/catalog checks passed. The real PostgreSQL 16 + pgvector semantic proof has **not** run locally because no explicitly disposable database URL is available. This remains a P1 rollout gate; the CI job correctly fails rather than treating a skipped integration test as proof.

Run once a pristine disposable target is available:

```sh
NEARYOU_TEST_POSTGRES16_DISPOSABLE=true \
NEARYOU_TEST_POSTGRES16_DATABASE_URL='postgresql://…' \
node --import tsx scripts/verify-nearfamily-private-decision-proof.ts
```

Preserve the resulting `nearfamily-private-decision-proof-*` artifact before advancing to any production migration.

### Task 2 — split decision/controller contracts

Implemented and locally verified (13/13 focused tests):

- strict canonical HMAC envelope, byte-size, clock, nonce, and key-window constraints;
- decision endpoint can call only the fixed database decision function;
- separate ordinary and emergency controller Google-ID-token identities;
- byte-identical controller retries only;
- decision credentials cannot invoke controller actions;
- independent emergency kill path.

This is code/contract evidence only. It is not Cloud Run, Cloud SQL, or external identity evidence.

### Earlier private-tester work

The branch also contains reviewed commits for signed Task 6 rollback bindings and canary receipt identity. These should not be treated as permission to activate: the new NearFamily plan still requires Tasks 3–6 and the independent evidence gates below.

## Task 3 status — in progress, do not claim complete

The uncommitted Terraform separates decision, controller, and emergency-kill service accounts; uses internal ingress, private VPC ranges, Cloud SQL IAM users, immutable images, and secret **name/version** references. Tests currently pass locally:

```sh
./.local-node/bin/node --import tsx --test \
  tests/readiness-gateway-infrastructure.test.mjs \
  tests/readiness-gateway-contract.test.mjs
# 21 pass, 0 fail

PATH="$PWD/.local-node/bin:$PATH" npm run typecheck
# pass
```

Before committing Task 3:

1. Correct the example disposable project identifier in `infra/disposable/readiness-gateway.tfvars.example`; it must satisfy the repository project-ID validation (the current example is too long).
2. Remove duplicate assertions in `tests/readiness-gateway-infrastructure.test.mjs`.
3. Upgrade `scripts/verify-readiness-gateway.ts` from source/template inspection to a read-only verifier of an explicitly named disposable Cloud Run target. It must return canonical revision/image/IAM/VPC/identity digests, never secret values or user content. Do not infer or hard-code a production project.
4. Add mock-command tests for public IAM, wrong audience, shared identity, missing private VPC configuration, and malformed outputs.
5. Run Terraform validation/plan only with real, reviewed disposable identifiers. Never apply against production from this branch.
6. Apply only to a disposable project, then preserve a generation-zero proof that wrong-audience, Worker-decision-credential, replay, and controller-escalation attempts are denied.

The current static verifier is not sufficient to call Task 3 proved; it has not accessed a cloud target.

## Non-negotiable release gates

Do not create an entitlement, invite, production migration, public route, or deployment until every applicable item is green:

1. Successful immutable Task 1 PostgreSQL 16/pgvector proof artifact.
2. Task 3 disposable Cloud Run/Cloud SQL apply plus immutable live verification proof.
3. Task 4 Cloudflare private-route client tests and release evidence.
4. Task 5 Cloudflare-native immutable receipt that binds worker versions/traffic, build, custom domain, D1/R2, gateway revision, Cloud SQL identities, and private/public gate facts.
5. Task 6 dark release and separately evidenced private route; invited/denied/capacity/deletion/revocation/rollback proof; 96 valid canary samples over 24 continuous hours; signed final receipt; final security and denial readback.

NearStory stays dark and NearFamily public rollout stays zero throughout. The first action after every operational failure is kill/revoke and denial readback—not retrying an activation.

## Do not do

- Do not put Cloud SQL passwords/connection strings in Cloudflare, Terraform variables, source files, logs, artifacts, or chat.
- Do not guess Cloudflare, Cloud Run, Cloud SQL, KMS, D1, R2, project, domain, service-account, route, or secret identifiers.
- Do not treat a local test skip, static Terraform check, or historical canary commit as production evidence.
- Do not enable NearStory, public NearFamily access, a percentage rollout, or an allUsers Cloud Run invoker binding.
- Do not stage `.local-node/` or any real secret.

## Exact resume prompt for a new chat

> Continue the NearFamily private-tester rollout in `/Users/elizabethbetson/Documents/ChatGPT/let/.worktrees/scalable-private-tester-activation-20260819` on branch `codex/scalable-private-tester-activation-20260819`. Read `docs/runbooks/nearfamily-private-tester-rollout-handoff-2026-08-19.md` first, then execute the uncommitted Task 3 work safely. Preserve the fail-closed gates: NearStory dark, public NearFamily zero, no guessed identifiers or secret values, and no production apply/invite until the required immutable evidence exists.
