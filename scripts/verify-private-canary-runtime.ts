import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const requiredVars = ["CANARY_OIDC_ISSUER", "CANARY_OIDC_AUDIENCE", "CANARY_OIDC_SUBJECT", "CANARY_OIDC_JWKS_URL"];

export function verifyPrivateCanaryRuntimeSource() {
  const bindings = JSON.parse(readFileSync(new URL(".openai/worker-bindings.json", root), "utf8")) as { required_worker_bindings?: { vars?: string[]; services?: string[] } };
  const route = readFileSync(new URL("app/api/internal/canary-entitlement/route.ts", root), "utf8");
  const activation = readFileSync(new URL("lib/nearfamily-activation.ts", root), "utf8");
  const migration = "0026_canary_entitlements.sql";
  const missing = [
    ...requiredVars.filter(value => !bindings.required_worker_bindings?.vars?.includes(value)),
    ...(!bindings.required_worker_bindings?.services?.includes("READINESS_PG") ? ["READINESS_PG"] : []),
    ...(!existsSync(new URL(`drizzle/${migration}`, root)) ? [migration] : []),
  ];
  const internalRouteActivation = !/const ROUTE_ENABLED = false as const/.test(route);
  const productActivation = !/NEARFAMILY_SOURCE_ACTIVATED = false as const/.test(activation);
  return Object.freeze({ readyForProvisioning: missing.length === 0 && !internalRouteActivation && !productActivation, missing: Object.freeze(missing), productActivation, internalRouteActivation, migration });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyPrivateCanaryRuntimeSource();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.readyForProvisioning) process.exitCode = 1;
}
