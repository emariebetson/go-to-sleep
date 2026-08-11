# Task 2C privacy reconciliation operations

Sites owns this application's production D1 and R2 bindings, but its hosting manifest does not declare cron schedules. The `scheduled()` worker hook and `wrangler.local.jsonc` cron are therefore local/development behavior only.

After applying 0012, keep product routes dark and enable only `NEARYOU_ENABLE_NEARSLEEP_LIBRARY_RECONCILIATION`. Generate a 32-byte-or-longer random base64url value, configure it as `NEARYOU_RECONCILIATION_SECRET`, and configure the production HTTPS scheduler to send this request every five minutes:

```text
POST https://<production-host>/api/internal/task2c-reconcile
Authorization: Bearer <NEARYOU_RECONCILIATION_SECRET>
```

In migration-only mode the endpoint processes at most two legacy ready-media objects per call, hashes at most 32 MiB per object, restores exact R2 checksum metadata, and atomically creates the storage reservation before marking readiness. Require `storageReconciliation.ready=true` and `unresolvedReadyMedia=0`; larger or missing objects need an explicit assisted reconciliation and keep activation blocked. Then enable `NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY`. In full mode the endpoint also processes bounded slices of export jobs, session tombstones, generic provider/R2 cleanup records, and account-deletion sagas. Alert on non-200 responses and on repeated retry-required rows. Rotate the secret by updating the hosted value and scheduler credential together. Never place it in a URL.

Configure a request timeout of at least 120 seconds and allow retries with jitter. Account cleanup performs at most two 30-second provider actions and generic cleanup performs at most two 25-second actions per lease, leaving DB/R2 margin inside the two-minute lease; overlapping scheduler invocations safely observe the active lease or repeat idempotent provider/R2 deletion after a lease expires.

Rollout order: deploy the migration-dark compatible application, apply 0012, enable only the reconciliation flag, run the bounded worker until the zero-unresolved readiness canary is stable, configure and verify the continuing scheduler endpoint, disable the migration-only flag, and only then enable the Task 2C product flag. Story and Legacy generation flags remain off.
