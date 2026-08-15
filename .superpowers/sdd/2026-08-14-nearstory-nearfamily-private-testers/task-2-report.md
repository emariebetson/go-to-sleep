# Task 2 Report: Private Tester Baseline

## RED evidence

Before the collector existed, the focused test was run with:

```sh
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
$NODE --import tsx --test tests/private-tester-baseline.test.mjs
```

It failed with `ERR_MODULE_NOT_FOUND` for `scripts/capture-private-tester-baseline.ts`, which is the expected missing-feature failure.

## Implementation

- Added `capturePrivateTesterBaseline`, which accepts only dependency-injected readers and a descriptor-checked input object.
- It validates the Task 1 release descriptor; strictly checks Sites and rollback versions, exact D1 ledger equality, PG migration ledger, numeric Secret Manager version resource names, and dark product/scheduler gates.
- All adapter evidence is canonicalized with own-key and data-descriptor checks before hashing or serialization. D1 ledger/schema and PG migration/catalog SHA-256 values are recorded.
- The evidence file is created with exclusive creation (`wx`); an existing path fails without overwriting its content.
- The CLI builds the distinct Sites, D1, PostgreSQL, Secret Manager, DNS, OAuth, bindings, and gate reader set from the production-owned evidence environment. It emits only a fixed failure message and does not print inputs.
- Added the package command `platform:capture-private-tester-baseline`.

## Verification

```sh
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
$NODE --import tsx --test tests/private-tester-baseline.test.mjs
```

Result: 7 passing, 0 failing.

```sh
$NODE node_modules/typescript/bin/tsc --noEmit --incremental false
```

Result: exit 0.

```sh
$NODE node_modules/eslint/bin/eslint.js scripts/capture-private-tester-baseline.ts tests/private-tester-baseline.test.mjs
```

Result: exit 0.

```sh
rg -n "deploy|apply|insert|update|delete|secret versions access" scripts/capture-private-tester-baseline.ts
```

Result: no matches.

```sh
git diff --check
```

Result: exit 0.

## Commit

`7c5866b feat: capture private tester rollback baseline`

## Self-review

- The collector has no activation, rollout, or provider-write operation. Its only filesystem write is immutable evidence creation.
- Exact own-key and data-descriptor validation prevents accessors, symbols, inherited values, and extra fields from silently entering trusted structures.
- Secret values are neither requested by the reader interface nor printed. Only exact Secret Manager version resource names are accepted in output.
- The focused tests cover each required rejection and a hostile accessor case, and exercise exclusive output creation.

## Concerns

The CLI intentionally consumes production-owned read snapshots as its adapter sources so it remains credential-free and non-authoritative. The release environment must supply those snapshots from authenticated read/list/describe/query collection; this task does not add provider credentials or any state-changing integration.

## Fix Round 1

The snapshot-backed CLI path was removed. The production path now obtains short-lived metadata-server access tokens, uses authenticated Google provider APIs for Secret Manager, DNS, and OAuth configuration, uses the existing Cloud SQL IAM-proxy posture and live PostgreSQL catalog query, and sends the short-lived identity to the dedicated read-only Cloudflare control gateway for Sites, D1, worker bindings, and gates. The CLI derives the expected D1 0001–0016 ledger from reviewed migration files and reads the release descriptor from an explicit file; it no longer accepts evidence JSON through environment variables.

Every reader now returns a descriptor-checked observation envelope containing provider, identity, observation timestamp, and body. The collector rejects observations more than five minutes old or more than 30 seconds in the future, binds the observed Sites version to the release, requires a distinct rollback version, and records observation metadata in the immutable evidence artifact.

The output schemas are now explicit and nonempty for D1 ledger/schema, PG migration/catalog, DNS, OAuth, bindings, secret-version names, and gates. Recursive generic serialization and denylisting were removed. Arrays must be ordinary, dense arrays with data descriptors only; accessors, sparse arrays, exotic prototypes, arbitrary fields, and missing envelopes fail closed. Secret values are not accepted by any output schema; the test sentinel is attached as an actual extra `clientSecret` field and the test proves no output file is created.

Commands run:

```sh
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
$NODE --import tsx --test tests/private-tester-baseline.test.mjs
$NODE node_modules/typescript/bin/tsc --noEmit --incremental false
$NODE node_modules/eslint/bin/eslint.js scripts/capture-private-tester-baseline.ts tests/private-tester-baseline.test.mjs
rg -n "deploy|apply|insert|update|delete|secret versions access" scripts/capture-private-tester-baseline.ts
git diff --check
```

Results: 6 focused tests passing; TypeScript, lint, read-only scan, and diff check exit 0.

## Fix Round 2

The Cloudflare reader is now pinned to the committed `https://private-tester-read.nearyoustill.com` origin. It mints an audience-bound metadata identity token solely for that origin and sends it only to a fixed no-query, no-fragment gateway path. The gateway must return an exact identity/audience/timestamp/body envelope; response identity or audience drift is rejected. General metadata OAuth access tokens are used only for Google provider APIs and are never sent to the Cloudflare gateway.

The PostgreSQL reader now validates the exact Cloud SQL instance connection name, loopback-only IAM-proxy URL, committed proxy-argument checksum, and the required `--auto-iam-authn` proxy argument. Each read verifies `session_user` and `current_user` against the configured IAM database user while taking its timestamp from PostgreSQL.

Provider list parsing projects only allowlisted fields. Secret Manager and Cloud DNS follow bounded pagination (ten pages maximum), retain no raw response, and only serialize exact secret-version names or DNS identifier projections. Array validation now examines `Reflect.ownKeys` and rejects symbol keys as well as sparse, accessor, and exotic arrays.

Commands run:

```sh
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
$NODE --import tsx --test tests/private-tester-baseline.test.mjs
$NODE node_modules/typescript/bin/tsc --noEmit --incremental false
$NODE node_modules/eslint/bin/eslint.js scripts/capture-private-tester-baseline.ts tests/private-tester-baseline.test.mjs
rg -n "deploy|apply|insert|update|delete|secret versions access" scripts/capture-private-tester-baseline.ts
git diff --check
```

Results: 7 focused tests passing; TypeScript, lint, read-only scan, and diff check exit 0.


Follow-up: OAuth evidence is now read through the same pinned, audience-authenticated control gateway instead of synthesizing an issuer or project-derived audience in the local collector. The gateway response must satisfy the exact OAuth identifier schema before it can enter the evidence artifact.

## Fix Round 3

The Cloud SQL path now materializes the reviewed proxy argument template with the exact pinned instance connection name `nearnight:us-central1:nearyou-production` before comparing its SHA-256 checksum. It requires `--auto-iam-authn`, loopback-only connection details, the exact `nearyou` database, and the production-shaped Cloud SQL IAM service-account database identity `nearyou-readiness-ctl@nearnight.iam.gserviceaccount.com` for both `session_user` and `current_user`.

The array hardening test now includes a symbol-keyed array. The production-reader test uses the materialized proxy arguments and production-shaped IAM principal.

Commands run:

```sh
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
$NODE --import tsx --test tests/private-tester-baseline.test.mjs
$NODE node_modules/typescript/bin/tsc --noEmit --incremental false
$NODE node_modules/eslint/bin/eslint.js scripts/capture-private-tester-baseline.ts tests/private-tester-baseline.test.mjs
rg -n "deploy|apply|insert|update|delete|secret versions access" scripts/capture-private-tester-baseline.ts
git diff --check
```

Results: 7 focused tests passing; TypeScript, lint, read-only scan, and diff check exit 0.

## Fix Round 4

The invented `private-tester-read.nearyoustill.com` dependency is gone. The repository now owns an authenticated `GET /api/internal/private-tester-baseline/[kind]` Sites route on the deployed `https://nearyoustill.com` origin, its runtime implementation, and its deployment contract. The route verifies a Google standard service-identity JWT before reading the request URL or loading evidence. Verification is RS256 against Google's fixed JWKS endpoint and exact-binds `iss=https://accounts.google.com`, `aud=https://nearyoustill.com`, and the numeric server-configured `sub`. The gateway derives `service:<sub>` and the observation time on the server; it accepts no caller release, identity, timestamp, query, request body, or arbitrary reader kind.

The route imports both `.openai/worker-bindings.json` and `.openai/hosting.json` and fails closed if their Sites project, D1/R2 binding names, version-metadata binding, route, trust tuple, release bindings, live binding list, or default-dark binding list drift. The runtime then exact-binds the server-held release to the configured Sites project and requires `VERSION_METADATA.tag === release.commitSha`. It reads the D1 migration table and schema through the deployed `DB` binding, projects the deployed `DB`/`AUDIO`/`VERSION_METADATA` bindings, and returns gates only when the product and scheduler bindings are literal `false` and the NearFamily source gate remains dark. Only the seven fixed evidence kinds are available and there is no mutation method.

OAuth evidence is no longer synthesized from a project name. The runtime requires the exact client ID and canonical URLs observed from the Sites environment and performs a fresh read-only authorization request to Google. It accepts only Google's 302 response to the exact `https://nearyoustill.com/api/auth/callback/google` URI with the server nonce/state and `interaction_required`, then returns that provider-accepted client ID, origin, and redirect URI. The collector requires the exact issuer/client/audience/origin/redirect schema.

The Google Secret Manager reader now enumerates the four explicit reviewed parents `nearyou-prod-app`, `nearyou-prod-legacy`, `nearyou-prod-pad`, and `nearyou-prod-migration-admin`, follows at most 100 pages per parent with loop detection and `pageSize=1000`, and retains only exact enabled numeric version resource names under that parent. It never uses `secrets/-/versions` or requests secret payloads. The Cloud DNS reader likewise follows the complete bounded `maxResults=1000` zone pagination, including NS and SOA, while retaining only name, type, and a SHA-256 identifier derived from the exact record data.

### Live authoritative read evidence

Read-only Sites control-plane calls on 2026-08-14 confirmed project `appgprj_6a79f8a66eb4819198bb42a2b26addea`, live version 25 `appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_637b4f553f988191b1b1ef5c41a8ea9a` at commit `ae0c1867ee7fdf94a30cb72a633b416ed23b4e8e`, and rollback candidate version 24 `appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_396d7cb171dc8191b8f2a35dd246f70b` at commit `a299305a3d78165666182fd572d6c3d41da51ae7`. The same provider reads confirmed environment revision 8, exact `GOOGLE_CLIENT_ID=619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com`, `BETTER_AUTH_URL=https://nearyoustill.com`, `PUBLIC_APP_URL=https://nearyoustill.com`, redacted secret values, live D1 binding `DB`, and active apex/www custom domains. No control-plane write or deployment was performed.

The exact public OAuth probe was:

```sh
curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}\n%{redirect_url}\n' 'https://accounts.google.com/o/oauth2/v2/auth?client_id=619793096923-2hspnuckl0j99p3jrfb6qd21aatb0pep.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fnearyoustill.com%2Fapi%2Fauth%2Fcallback%2Fgoogle&response_type=code&scope=openid%20email%20profile&state=private-tester-live-probe&nonce=private-tester-live-probe&prompt=none'
```

Result: Google returned 302 to the exact callback with the exact state and `error=interaction_required`; it returned no authorization code.

### RED evidence

```sh
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
$NODE --import tsx --test tests/private-tester-baseline-gateway.test.mjs
```

Initial result: failed with `ERR_MODULE_NOT_FOUND` because the repository-owned gateway did not exist. The staged runtime and authenticator tests subsequently failed on their missing exports. The collector expansion initially produced 5 passing and 4 failing tests because it still expected the opaque gateway response, omitted exact OAuth/Sites runtime fields, and did not implement explicit Secret Manager or complete DNS pagination.

After the implementation was green, a deployment-contract test was added and observed failing with:

```text
SyntaxError: ... does not provide an export named 'assertPrivateTesterDeploymentContract'
```

It passed only after the route began validating the actual worker and hosting manifests.

### GREEN evidence

```sh
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
$NODE --import tsx --test tests/private-tester-baseline-gateway.test.mjs tests/private-tester-baseline.test.mjs
$NODE node_modules/typescript/bin/tsc --noEmit --incremental false
$NODE node_modules/eslint/bin/eslint.js lib/private-tester-baseline-gateway.ts 'app/api/internal/private-tester-baseline/[kind]/route.ts' scripts/capture-private-tester-baseline.ts tests/private-tester-baseline-gateway.test.mjs tests/private-tester-baseline.test.mjs cloudflare-env.d.ts
$NODE --import tsx --test --test-reporter=dot tests/*.test.mjs
git diff --check
rg -n "private-tester-read\.nearyoustill\.com|/secrets/-/versions|secret versions access" scripts/capture-private-tester-baseline.ts lib/private-tester-baseline-gateway.ts 'app/api/internal/private-tester-baseline/[kind]/route.ts' .openai/worker-bindings.json
rg -n "methods?\s*[:=]\s*['\"](?:POST|PUT|PATCH|DELETE)|\b(?:INSERT|UPDATE|DELETE)\b" lib/private-tester-baseline-gateway.ts 'app/api/internal/private-tester-baseline/[kind]/route.ts'
```

Results: 17/17 focused tests and 538/538 repository tests passed; TypeScript, scoped lint, and `git diff --check` exited 0. Both negative scans returned no matches.

```sh
PATH=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH npm run build
```

Result: the build stopped before application compilation with `ERR_DLOPEN_FAILED`: the installed `@rolldown/binding-darwin-x64` native binary is unsigned and macOS refused to load it. No dependency tree or lockfile was destructively replaced to work around this existing host issue.

### Commit

`bbc7191 fix: own private tester baseline provenance`

### Self-review

- Authentication completes before request URL parsing and before any D1, binding, gate, release, or OAuth evidence read. Exact issuer, audience, and subject drift returns a generic 401 without reading evidence.
- The server derives the principal and timestamp. Release and rollback data come only from deployment bindings, and runtime version metadata must exact-bind the release commit. Request methods other than GET, unknown kinds, alternate origins, query strings, and fragments never reach a reader.
- All runtime reads are read-only. The route exposes no POST/PUT/PATCH/DELETE implementation, D1 uses only SELECT, provider OAuth uses an authorization probe that cannot return a code under `prompt=none`, and the collector retains `flag: "wx"` for immutable evidence creation.
- Secret values are not fetched, accepted by the evidence schema, logged, or written. Secret inventory uses only explicit reviewed parents and numeric enabled version resource names. DNS pagination is complete and the evidence projection includes NS/SOA without retaining raw record data.
- Product and scheduler evidence remains default-dark and fails closed on binding/configuration drift. The gateway does not activate NearStory, NearFamily, the legacy archive, or any scheduler.

### Concerns

This change intentionally does not deploy or mutate the production Sites project. Until an authorized release deploy supplies the exact subject, release JSON, rollback version, explicit false gate values, and version-metadata binding, the new route is absent from the current live version or returns 503; it cannot produce self-asserted evidence. The source, deployment contract, and executable tests are complete, but a production baseline still requires that separately authorized exact deployment. The repository build also remains blocked by the pre-existing unsigned Rolldown native binary described above.

