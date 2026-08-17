# Sites D1 forward operation (review-only)

The internal route is committed literal-dark. A separately reviewed release may temporarily change only `ROUTE_ENABLED` to `true`, deploy that exact commit, invoke it with an authenticated readiness-service OIDC token, and immediately redeploy the literal-dark source after the operation receipt is captured.

Run `0017-0025` first with the exact reviewed live `d1_migrations` rows and their deployment-owned SHA-256 in `D1_FORWARD_LEDGER_SHA256`. A second deployment and invocation for `0026` additionally requires the exact authorization-object SHA-256 in `D1_0026_AUTHORIZATION_SHA256`. Never combine the phases. The endpoint returns only bounded success/conflict output; reload its exact D1 ledger and schema evidence after an uncertain response.

No product availability, rollout, canary, scheduler, or infrastructure gate is changed by this operation.
