# Production Terraform

This tree is intentionally not self-applying. Bootstrap a dedicated GCS state bucket with public-access prevention, uniform access, versioning, retention, audit logging, and least-privilege IAM. Initialize with `terraform init -backend-config=bucket=... -backend-config=prefix=production`; GCS generation preconditions provide state locking.

Use Application Default Credentials or CI workload identity federation only. Static service-account keys are prohibited. Supply the required issuer, audience, repository/account condition, immutable container digest, billing account, residency, and region variables from reviewed external configuration. The configured issuer must actually mint verifiable OIDC tokens with the mapped claims.

The existing application worker routes currently authenticate fixed bearer secrets. Do not enable the scheduler jobs until the application OIDC verifier for the configured audience and scheduler principal is deployed and tested. Keep every product feature flag disabled. An authorized operator must review a saved plan and explicitly set `deployment_approved=true`; the database and Cloud Run preconditions otherwise block creation.

## Runtime launch boundary

Cloud Run services and scheduler jobs are deliberately hard-disabled in this source tree. Terraform input objects are not trusted release evidence and cannot enable them. A later reviewed change must connect the gates to a durable, authenticated evidence authority with signature verification, nonce/replay protection, freshness, exact principal, release, schema, artifact digest, secret-version, and migration-execution bindings.

Before that change, publish separate immutable Legacy, PAD, and migration images. The CI identity is the only repository writer; runtime identities are readers only. Each digest requires a signed provenance predicate from the approved builder and an SBOM retained with the release evidence. `provenance_evidence` is documentation/reference metadata only and cannot unlock resources.

Cloudflare R2 and Queues are created only for US residency. Cloudflare's placement hints are not treated as a Canadian residency guarantee; Canadian deployments create none of those resources until an enforceable Canadian storage/queue backend is implemented.
