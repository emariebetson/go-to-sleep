# Private tester rollout

This runbook is a controlled handoff, not deployment or activation authorization. NearFamily, NearStory, internal mutation routes, and schedulers remain dark until separate reviewed activation work explicitly changes them.

## Baseline stop conditions

Do not collect or accept a baseline when any of these is true:

- PostgreSQL migration `0007_private_tester_deployment_manifest.sql` has not been authorized, applied, and attested against a fresh PostgreSQL 16 catalog;
- the deployment operation did not emit the exact canonical live version/commit, explicit rollback version/commit, and account-qualified D1/R2 resources;
- the deployment manifest is unsigned, stale, untrusted, expired, replayed, or does not use the pinned exact KMS key version;
- the Cloudflare D1/R2 inventory, Sites runtime commit, D1 ledger/schema, PostgreSQL identity/catalog, OAuth proof, secret versions, DNS, or dark gates are missing, stale, or unequal;
- the requested output path already exists.

The current reviewed live catalog is `0006_private_canary_observation`. Migration `0007` is intentionally source-only at this handoff. Never relabel the `0006` checksum or catalog artifact as `0007`; an authorized migration and a new independently reviewed catalog candidate are required first.

## Deployment-owned manifest

The authorized deployment operation writes one bounded canonical JSON fact file. It must contain no secret, token, household, tester, or personal data. Compose the signed manifest with:

```sh
node --import tsx scripts/compose-private-tester-deployment-manifest.ts <deployment-operation.json> <new-signed-manifest.json>
```

The composer uses the configured exact Cloud KMS version and creates the output with exclusive-create semantics. It does not deploy or change a product gate.

## Baseline collection

After `0007` and the fresh catalog are separately approved, configure the existing Cloud SQL IAM proxy connection, exact readiness database user, KMS coordinates and signer mapping, `EVIDENCE_TRUST_JSON`, private reader identity, Google project/DNS zone, and a least-privilege `CLOUDFLARE_API_TOKEN`. Then run:

```sh
node --import tsx scripts/capture-private-tester-baseline.ts <release.json> <signed-manifest.json> <new-baseline.json>
```

The collector verifies KMS signature/trust and consumes the dedicated PostgreSQL nonce before it performs baseline reads. A lost nonce-store response fails closed; retrying the same manifest is rejected as replay. A mismatch after nonce consumption also fails closed and requires a newly observed, newly signed deployment manifest. The collector never falls back to environment facts, gateway release JSON, binding labels, or saved-version order.

Keep the resulting artifact private. It contains identifiers and hashes but no secret values or tester data. The command creates a new file only and must never overwrite prior evidence.

## After capture

Source completion and even a valid baseline do not invite a tester or activate a product. Continue only through separately approved runtime proof, migration, backup/recovery, rehearsal, security/IP review, invitation, revocation, rollback, and go/no-go tasks. Any unknown or failed observation is no-go, and the literal dark gates remain unchanged.
