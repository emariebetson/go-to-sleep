import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("canary route is literal dark before authentication, parsing, or mutation", async () => {
  const source = readFileSync(new URL("../app/api/internal/canary-entitlement/route.ts", import.meta.url), "utf8");
  assert.match(source, /const ROUTE_ENABLED = false as const/);
  const guard = source.indexOf("if (!ROUTE_ENABLED)");
  for (const operation of ["privateCanaryEntitlementService.authorize", "request.json()", "privateCanaryEntitlementService.verify", "privateCanaryEntitlementService.mutate"]) assert.ok(guard >= 0 && guard < source.indexOf(operation), operation);
  assert.ok(source.indexOf("privateCanaryEntitlementService.authorize") < source.indexOf("request.json()"));
  const route = await import("../app/api/internal/canary-entitlement/route.ts");
  const request = new Request("https://app.test/api/internal/canary-entitlement", { method: "POST", body: "not-json" });
  const response = await route.POST(request);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found." });
});

test("production canary module exports only its runtime-bound service", () => {
  const source = readFileSync(new URL("../lib/canary-entitlement.ts", import.meta.url), "utf8");
  assert.match(source, /function createPrivateCanaryEntitlementService/);
  assert.doesNotMatch(source, /export function createPrivateCanaryEntitlementService|export async function verifyCanary|export type .*Capability/);
  assert.match(source, /import \{ env \} from "cloudflare:workers"/);
  assert.match(source, /export const privateCanaryEntitlementService = createPrivateCanaryEntitlementService\(runtime\)/);
});

test("private route keeps verification behind the same pinned OIDC boundary", () => {
  const service = readFileSync(new URL("../lib/canary-entitlement.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/internal/canary-entitlement/route.ts", import.meta.url), "utf8");
  assert.match(service, /createServiceOidcAuthenticator/);
  assert.match(service, /READINESS_PG/);
  assert.match(service, /product='nearfamily'/);
  assert.match(route, /body.action === "verify"/);
  assert.doesNotMatch(route, /READINESS_PG|CANARY_OIDC_|createServiceOidcAuthenticator/);
});
