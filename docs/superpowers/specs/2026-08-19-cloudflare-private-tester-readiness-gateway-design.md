# Cloudflare private-tester readiness gateway

**Status:** Revised after independent skeptical review on 2026-08-19
**Scope:** A Cloudflare Worker to private Cloud SQL control plane for invitation-only NearFamily testing. NearStory is explicitly out of the first activation release.

## Goal

Enable exactly one invited household to reach NearFamily while the public rollout remains zero. The deployment must not expose Cloud SQL, put database credentials in Cloudflare, or let an application-user request create, extend, revoke, or kill a tester authorization.

## Non-goals

- Public NearFamily or NearStory rollout.
- A creator-email, browser-session, Free-plan, or self-service entitlement override.
- A general SQL proxy, arbitrary query API, raw household-ID API, or a Worker-initiated controller mutation.
- Replacing current `READINESS_PG` consumers for NearStory, NearLegacy, canary entitlement, or operational evidence in this release.

## Trust domains

The rollout uses separate decision and controller planes. Their identities, Cloud Run services, database IAM users, PostgreSQL roles, signing keys, audiences, nonce stores, rate limits, and logs must not overlap.

```text
NearFamily Worker request
  -> decision client
  -> readiness-decision Cloud Run service
  -> PostgreSQL execute-only decision role

Reviewed Cloud Build controller job
  -> Google IAM ID token, exact controller audience
  -> readiness-controller Cloud Run service
  -> PostgreSQL controller-only role
```

Cloud SQL remains private-IP-only. Both Cloud Run services use VPC egress and the Cloud SQL IAM connector; neither has a database password or public IP dependency.

## Decision plane

`readiness-decision` has one operation:

```text
POST /v1/nearfamily/decision
input:  { version: 1, releaseId, householdHash, issuedAt, nonce, bodySha256, keyVersion, signature }
output: { version: 1, allowed: boolean, expiresAt? }
```

The Worker derives `householdHash = SHA-256(householdId)` locally and never transmits the raw ID. The Cloudflare Worker signs canonical UTF-8 JSON using a decision-only HMAC-SHA-256 key held as an encrypted Worker secret and in Google Secret Manager. Cloud Run is publicly reachable only for this decision endpoint because Cloudflare cannot present a Google IAM token; it has a maximum of one instance, concurrency of ten, a 4 KiB request limit, a two-second timeout, and no sensitive error response. The Worker rate-limits decision calls per authenticated household before it sends a request. Application authentication is mandatory before any database work.

The decision service atomically creates a nonce record keyed by `{issuer,keyVersion,nonce}` in PostgreSQL before processing. It retains the record for ten minutes, rejects duplicate/uncertain nonce writes, accepts `issuedAt` only from five minutes before to one minute after its database clock, and rejects every unknown field or noncanonical body. It has current and draining key versions with explicit `notBefore`, `notAfter`, and rollback compatibility; a Worker rollback may use only an unexpired draining key. Decision logs contain only status class, key version, release digest, and sampled aggregate counters—never household hashes, nonces, headers, or bodies.

Its Cloud SQL IAM user has only execute permission on one fixed function that returns the invitation state for `nearfamily`, a supplied household hash, and the exact release. It cannot mutate controller state or call other application functions.

## Controller plane

`readiness-controller` exposes only strict controller actions: activate, revoke, and terminal kill. It is Cloud Run IAM-authenticated with `allUsers` denied. Only the reviewed Cloud Build service account can obtain an exact-audience Google ID token and invoke it. The Cloudflare Worker has neither route, credential, nor network contract for this service.

The controller service verifies the Google token issuer, audience, subject, expiry, and a canonical request digest before it opens a transaction. PostgreSQL independently verifies the mapped controller principal and uses a controller-only IAM user/role. Every operation contains the existing immutable `operationId`, exact release/evidence digest, expected controller version, and explicit invite hashes/expiry. Its audit rows store only operation/release/product/action/request digest and timestamp. It has no generic SQL operation and retries may reuse an operation ID only with byte-identical data.

The emergency kill service account is distinct from the ordinary controller account and has only terminal kill/revoke permissions. It remains callable even if the Worker, decision service, or ordinary controller service is unhealthy.

## Activation and rollback state machine

1. **Dark evidence release.** Worker route gate is false, public percentage is zero, controller endpoint is unavailable from the Worker, and a Cloudflare-native baseline is signed.
2. **Private-route release.** A separately deployed and signed Worker release enables only the NearFamily invitation check. It still denies every non-invited household; public percentage remains zero. Its evidence schema records `privateRouteEnabled: true`, `publicPercent: 0`, and the exact decision-service revision.
3. **Synthetic release proof.** Activate only a synthetic household through the controller service, verify invited/denied decisions, capacity remediation, privacy boundaries, deletion paths, and decision-service denial on failure. Revoke it and prove immediate denial.
4. **24-hour synthetic canary.** Record 96 valid samples no more than 15 minutes apart, finalize with the trusted signer, verify the exact release/build/deployment binding, and execute the independent kill/revocation recheck.
5. **First real invitation.** Issue a seven-day NearFamily invitation and an audited `nearyou_family` entitlement for the exact first household. Read back invited access and a non-invited denial before delivering the invitation.

Rollback order is mandatory: emergency kill/revoke, authorization-denial readback, fence pending work, revoke test entitlement, deploy the attested prior Worker version, then verify recovery/deletion/remediation paths. Database migrations remain forward-only unless a separately reviewed recovery operation is authorized.

## Cloudflare-native evidence

Every receipt is canonical JSON, signed by the configured KMS trust tuple, generation-zero written, raw-byte SHA-256 bound, and rejected if mixed with another release.

The deployment receipt contains: Cloudflare account ID, Worker name, active and rollback version IDs, active traffic percentages, exact deployed artifact/build hash, custom-domain mapping, D1 database ID/schema/ledger digest, R2 bucket identity/smoke result, decision-service URL/revision/image digest/traffic, Cloud Run IAM policy digest, VPC connector identity, Cloud SQL instance and each database identity/role digest, secret resource names plus pinned numeric versions, and source-gate/public-percent state. Collection brackets pre/post deployment reads and rejects a deployment or traffic change.

The promoted baseline, synthetic proof, canary receipt, controller readback, denial probe, and go/no-go record reference the receipt SHA-256 rather than copying private evidence into Git.

## Migration and configuration prerequisites

- Correct the PostgreSQL catalog/Terraform migration-head and forced-RLS predicate, then prove controller and decision identities in a disposable PostgreSQL 16 target before production.
- Redesign and prove the D1 canary-entitlement migration with the supported Cloudflare executor before it is required by any canary path.
- Create `wrangler.production.jsonc` only from dashboard-readback bindings: Worker `nearyoustill-production`, account `20bb6d9ba33266b8cd7d9d15211986ef`, D1 `d79629bb-0c1b-4bb4-8c84-6833debdabfb`, R2 `nearyoustill-production-audio`, current compatibility behavior, and `keep_vars`. It does not declare secrets, domains, routes, controller bindings, or guessed network identifiers.
- Add the decision-service configuration only after its Cloud Run URL, key version, and deployment identity are independently created and recorded.

## Verification

- Unit tests: envelope canonicalization and vectors; timestamp/key-window handling; atomic nonce replay; decision/controller credential separation; unknown fields; failure-closed behavior; controller identity forwarding; kill-first rollback order.
- Integration tests: NearFamily private-route activation build admits one exact household and denies all others; decision service cannot mutate; controller service cannot be invoked by Worker credentials; revoked/expired/mismatched releases deny; rollback fences access before deployment restore.
- Infrastructure checks: Cloud Run IAM policy, service account, VPC egress, Cloud SQL IAM connector, DB roles, instance limits, secret version pinning, firewall/Cloud Armor controls, and exact Cloudflare binding/version/traffic/domain readback.
- Release checks: full suite, typecheck, lint, build, migration/artifact checks, security-diff and public-copy/IP review, immutable evidence verification, synthetic smoke/rollback, and completed canary before a real invitation.
