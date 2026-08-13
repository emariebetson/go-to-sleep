import { jsonNoStore } from "@/lib/http";

const ROUTE_ENABLED = false as const;

export async function POST(request: Request) {
  if (!ROUTE_ENABLED) return jsonNoStore({ error: "Not found." }, { status: 404 });
  const { privateCanaryEntitlementService } = await import("@/lib/canary-entitlement");
  const authorization = await privateCanaryEntitlementService.authorize(request);
  const body = await request.json() as Record<string, unknown>;
  if (body.action === "verify") return jsonNoStore(await privateCanaryEntitlementService.verify(authorization, body as never));
  return jsonNoStore(await privateCanaryEntitlementService.mutate(authorization, body as never));
}
