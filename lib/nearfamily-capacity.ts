import { PLAN_CATALOG, type PlanId } from "./nearyou-foundation";

export type HouseholdCapacityUsage = {
  members: number;
  children: number;
  voices: number;
  storageBytes: number;
};

export type HouseholdCapacityDecision = {
  state: "within_limit" | "restricted";
  exceeded: (keyof HouseholdCapacityUsage)[];
  limits: HouseholdCapacityUsage;
};

const DIMENSIONS = ["members", "children", "voices", "storageBytes"] as const;
const REMEDIATION_OPERATIONS = ["delete", "export", "revoke", "billing", "member_departure"] as const;
type CapacityOperation = "consume" | typeof REMEDIATION_OPERATIONS[number];

function exactUsage(value: HouseholdCapacityUsage) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(",") !== [...DIMENSIONS].sort().join(",")) throw new Error("capacity usage invalid");
  for (const dimension of DIMENSIONS) if (!Number.isSafeInteger(value[dimension]) || value[dimension] < 0) throw new Error("capacity usage invalid");
}

export function decideHouseholdCapacity(planId: PlanId, usage: HouseholdCapacityUsage): HouseholdCapacityDecision {
  if (!(planId in PLAN_CATALOG)) throw new Error("capacity plan invalid");
  exactUsage(usage);
  const plan = PLAN_CATALOG[planId];
  const limits = Object.freeze({
    members: plan.limits.members,
    children: plan.limits.children,
    voices: plan.limits.voices,
    storageBytes: plan.limits.storageBytes,
  });
  const exceeded = Object.freeze(DIMENSIONS.filter((dimension) => usage[dimension] > limits[dimension]));
  return Object.freeze({ state: exceeded.length ? "restricted" : "within_limit", exceeded, limits }) as HouseholdCapacityDecision;
}

export function capacityMutationAllowed(decision: HouseholdCapacityDecision, operation: CapacityOperation): boolean {
  if (operation !== "consume" && !(REMEDIATION_OPERATIONS as readonly string[]).includes(operation)) throw new Error("capacity operation invalid");
  return decision.state === "within_limit" || operation !== "consume";
}
