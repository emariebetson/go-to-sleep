import { jsonNoStore } from "./http";
import type { NearFamilySummary } from "./nearfamily-service";

export type NearFamilyGetDependencies = {
  sourceActivated(): boolean;
  requireHousehold(request: Request): Promise<string>;
  authorizeProduct(householdId: string): Promise<boolean>;
  loadSummary(householdId: string): Promise<NearFamilySummary>;
};

type NearFamilyAvailabilityDependencies = Pick<NearFamilyGetDependencies, "sourceActivated" | "requireHousehold" | "authorizeProduct">;

export type NearFamilyAvailability = { available: false } | { available: true; householdId: string };

export type NearFamilyPrivateRouteRollbackDependencies = Readonly<{
  emergencyKillAndRevoke(): Promise<void>;
  confirmDenied(): Promise<void>;
  fencePendingWork(): Promise<void>;
  revokeTestEntitlement(): Promise<void>;
  restorePriorWorker(): Promise<void>;
  verifyRecovery(): Promise<void>;
}>;

export async function runNearFamilyPrivateRouteRollback(dependencies: NearFamilyPrivateRouteRollbackDependencies): Promise<void> {
  await dependencies.emergencyKillAndRevoke();
  await dependencies.confirmDenied();
  await dependencies.fencePendingWork();
  await dependencies.revokeTestEntitlement();
  await dependencies.restorePriorWorker();
  await dependencies.verifyRecovery();
}

export function createNearFamilyAvailability(dependencies: NearFamilyAvailabilityDependencies) {
  return async (request: Request): Promise<NearFamilyAvailability> => {
    if (!dependencies.sourceActivated()) return { available: false };
    const householdId = await dependencies.requireHousehold(request);
    return await dependencies.authorizeProduct(householdId) ? { available: true, householdId } : { available: false };
  };
}

export function createNearFamilyPageAvailability(availability: (request: Request) => Promise<NearFamilyAvailability>) {
  return async (request: Request): Promise<NearFamilyAvailability> => {
    try { return await availability(request); }
    catch (error) { if (error instanceof Response && (error.status === 403 || error.status === 404)) return { available: false }; throw error; }
  };
}

const unavailable = () => jsonNoStore({ error: "NearFamily is not available." }, { status: 404 });

export function createNearFamilyGetHandler(dependencies: NearFamilyGetDependencies) {
  const availability = createNearFamilyAvailability(dependencies);
  return async (request: Request) => {
    const decision = await availability(request);
    if (!decision.available) return unavailable();
    try {
      return jsonNoStore(await dependencies.loadSummary(decision.householdId));
    } catch {
      return unavailable();
    }
  };
}
