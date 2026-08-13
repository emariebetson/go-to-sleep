import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { verifyPrivateCanaryRuntimeSource } from "../scripts/verify-private-canary-runtime.ts";

test("private canary runtime declares exact non-secret and service bindings while remaining dark", () => {
  const result = verifyPrivateCanaryRuntimeSource();
  assert.equal(result.readyForProvisioning, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.productActivation, false);
  assert.equal(result.internalRouteActivation, false);
  assert.equal(result.migration, "0026_canary_entitlements.sql");
});

test("hosting metadata never embeds OIDC values, database credentials, or product activation", () => {
  const hosting = readFileSync(new URL("../.openai/hosting.json", import.meta.url), "utf8");
  const bindings = JSON.parse(readFileSync(new URL("../.openai/worker-bindings.json", import.meta.url), "utf8"));
  assert.deepEqual(bindings.required_worker_bindings.vars.filter(value => value.startsWith("CANARY_OIDC_")), ["CANARY_OIDC_ISSUER", "CANARY_OIDC_AUDIENCE", "CANARY_OIDC_SUBJECT", "CANARY_OIDC_JWKS_URL"]);
  assert.ok(bindings.required_worker_bindings.services.includes("READINESS_PG"));
  assert.doesNotMatch(hosting, /password|secret|token|NEARYOU_ENABLE|ROUTE_ENABLED/i);
});

test("release runbook has exact migration and private binding verification with no activation step", () => {
  const runbook = readFileSync(new URL("../docs/runbooks/private-canary-runtime.md", import.meta.url), "utf8");
  for (const item of ["0026_canary_entitlements.sql", "READINESS_PG", "CANARY_OIDC_ISSUER", "CANARY_OIDC_AUDIENCE", "CANARY_OIDC_SUBJECT", "CANARY_OIDC_JWKS_URL", "ROUTE_ENABLED = false", "NEARFAMILY_SOURCE_ACTIVATED = false"]) assert.match(runbook, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(runbook, /Do not deploy|No product activation/i);
});

test("the new Sites migration keeps every deployment statement on one physical line", () => {
  const migration = readFileSync(new URL("../drizzle/0026_canary_entitlements.sql", import.meta.url), "utf8");
  const statements = migration
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean);

  assert.ok(statements.length > 1);
  for (const statement of statements) assert.doesNotMatch(statement, /\r?\n/);
});
