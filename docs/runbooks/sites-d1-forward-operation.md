# Sites D1 forward operation (review-only)

The internal route is committed literal-dark. A separately reviewed release may temporarily change only `ROUTE_ENABLED` to `true`, deploy that exact commit, invoke it with an authenticated readiness-service OIDC token, and immediately redeploy the literal-dark source after the operation receipt is captured.

Sites does not expose its provider-owned `d1_migrations` rows to the Worker runtime. The operation therefore never reads or writes that table. It binds the complete reviewed `0016` `sqlite_schema` checkpoint through `D1_FORWARD_BASELINE_SCHEMA_SHA256`, then records every applied source hash in the app-owned immutable operation ledger.

Run `0017-0025` first. A second deployment and invocation for `0026` additionally requires the exact authorization-object SHA-256 in `D1_0026_AUTHORIZATION_SHA256` and the completed same-release `0017-0025` operation. Never combine the phases. The endpoint returns only bounded success/conflict output; reload its exact app-owned operation ledger and full schema evidence after an uncertain response. Future Sites packages must continue omitting `dist/.openai/drizzle`; these forward migrations are authoritative through the app-owned receipt rather than the inaccessible provider ledger.

No product availability, rollout, canary, scheduler, or infrastructure gate is changed by this operation.
