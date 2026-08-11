import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { accountDeletionOperations, householdMembers, task2cActivationState } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { ensureUser } from "@/lib/data";
import { jsonNoStore } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled, roleCan, type HouseholdCapability, type HouseholdRole } from "@/lib/nearyou-foundation";

export async function requireFoundationUser(request: Request) {
  const user = await requireApiUser(request);
  if (!featureFlagsFromEnv(process.env).foundationApi) {
    throw jsonNoStore({ error: "The NearYou v1 API is not enabled." }, { status: 404 });
  }
  const { householdId: personalHouseholdId } = await ensureUser(user);
  if (nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) {
    await requireTask2cActivationReady();
    const deletion = await getDb().select({ id: accountDeletionOperations.id, status: accountDeletionOperations.status })
      .from(accountDeletionOperations).where(and(eq(accountDeletionOperations.userId, user.userId), ne(accountDeletionOperations.status, "completed"), ne(accountDeletionOperations.status, "canceled"))).get();
    if (deletion) {
      throw jsonNoStore({ error: "Account deletion is in progress. New household work and playback are disabled.", code: "account_deletion_fenced" }, { status: 423 });
    }
  }
  return { user, personalHouseholdId };
}

export async function requireTask2cActivationReady() {
  const activation = await getDb().select({ status: task2cActivationState.status, unresolved: task2cActivationState.unresolvedReadyMedia, schedulerHeartbeatAt: task2cActivationState.schedulerHeartbeatAt })
    .from(task2cActivationState).where(eq(task2cActivationState.id, "storage")).get();
  if (!activation || activation.status !== "ready" || activation.unresolved !== 0) {
    throw jsonNoStore({ error: "NearSleep library activation is waiting for private media reconciliation.", code: "storage_reconciliation_required" }, { status: 503 });
  }
  if (!activation.schedulerHeartbeatAt || activation.schedulerHeartbeatAt.getTime() < Date.now() - 15 * 60 * 1000) {
    throw jsonNoStore({ error: "NearSleep private jobs are waiting for a healthy reconciliation scheduler.", code: "scheduler_heartbeat_required" }, { status: 503 });
  }
}

export function selectedHouseholdId(request: Request, fallback: string) {
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
  let details = "";
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ("message" in current && typeof current.message === "string") details += ` ${current.message}`;
    current = "cause" in current ? current.cause : null;
  }
  if (details.includes("household_export_snapshot_locked")) return jsonNoStore({ error: "Household library changes are paused while the point-in-time export is built." }, { status: 409 });
  console.error(fallback, error);
  return jsonNoStore({ error: fallback }, { status: 500 });
}

export function badRequest(error: unknown) {
  return jsonNoStore({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
}
