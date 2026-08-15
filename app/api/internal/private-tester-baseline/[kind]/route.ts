import { env } from "cloudflare:workers";
import gatewayBindings from "@/.openai/worker-bindings.json";
import hosting from "@/.openai/hosting.json";
import {
  assertPrivateTesterDeploymentContract,
  createGoogleServiceIdentityAuthenticator,
  createPrivateTesterBaselineGateway,
  createPrivateTesterBaselineRuntime,
} from "@/lib/private-tester-baseline-gateway";

type Runtime = Record<string, unknown> & {
  PRIVATE_TESTER_BASELINE_OIDC_SUBJECT?: string;
};

export async function GET(request: Request): Promise<Response> {
  const runtime = env as unknown as Runtime;
  const contract = gatewayBindings.private_tester_baseline_gateway;
  const subject = runtime.PRIVATE_TESTER_BASELINE_OIDC_SUBJECT ?? "";
  const trust = { issuer: contract.oidc.issuer, audience: contract.oidc.audience, subject };
  let authenticate: ReturnType<typeof createGoogleServiceIdentityAuthenticator>;
  try {
    assertPrivateTesterDeploymentContract(gatewayBindings, hosting);
    authenticate = createGoogleServiceIdentityAuthenticator(trust);
  } catch {
    return new Response("Unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
  return createPrivateTesterBaselineGateway({
    trust,
    authenticate,
    load: async () => createPrivateTesterBaselineRuntime(runtime),
    now: Date.now,
  })(request);
}
