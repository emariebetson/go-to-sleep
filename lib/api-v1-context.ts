import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdMembers } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { ensureUser } from "@/lib/data";
import { jsonNoStore } from "@/lib/http";
import { featureFlagsFromEnv, roleCan, type HouseholdCapability, type HouseholdRole } from "@/lib/nearyou-foundation";

export async function requireFoundationUser(request: Request) {
  const user = await requireApiUser(request);
  if (!featureFlagsFromEnv(process.env).foundationApi) {
    throw jsonNoStore({ error: "The NearYou v1 API is not enabled." }, { status: 404 });
  }
  const { householdId: personalHouseholdId } = await ensureUser(user);
  return { user, personalHouseholdId };
}

function selectedHouseholdId(request: Request, fallback: string) {
  const selectedHeader = request.headers.get("x-nearyou-household-id")?.trim();
  if (selectedHeader) return selectedHeader;
  const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("nearyou_active_household="));
  if (!cookie) return fallback;
  try { return decodeURIComponent(cookie.slice("nearyou_active_household=".length)) || fallback; } catch { return fallback; }
}

export async function requireHouseholdContext(request: Request, capability: HouseholdCapability) {
  const { user, personalHouseholdId } = await requireFoundationUser(request);
  const householdId = selectedHouseholdId(request, personalHouseholdId);
  const membership = await getDb().select({ role: householdMembers.role })
    .from(householdMembers)
    .where(and(
      eq(householdMembers.householdId, householdId),
      eq(householdMembers.userId, user.userId),
      eq(householdMembers.status, "active"),
    ))
    .get();
  if (!membership) throw jsonNoStore({ error: "An active adult household membership is required." }, { status: 403 });
  if (!roleCan(membership.role as HouseholdRole, capability)) {
    throw jsonNoStore({ error: "Your household role does not allow this action." }, { status: 403 });
  }
  return { user, householdId, role: membership.role };
}

export function apiV1Failure(error: unknown, fallback: string) {
  if (error instanceof Response) return error;
  console.error(fallback, error);
  return jsonNoStore({ error: fallback }, { status: 500 });
}

export function badRequest(error: unknown) {
  return jsonNoStore({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
}
