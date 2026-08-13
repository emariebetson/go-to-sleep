import type { HouseholdCapacityUsage } from "./nearfamily-capacity";

type CapacityState = "within_limit" | "restricted";
type CapacityDimension = keyof HouseholdCapacityUsage;

type CapacityRow = {
  plan_id: string;
  state: string;
  exceeded_json: string;
  members: number;
  children: number;
  voices: number;
  storage_bytes: number;
  member_limit: number;
  child_limit: number;
  voice_limit: number;
  storage_limit: number;
};

export type NearFamilyDb = {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null> };
  };
};

export type NearFamilySummary = {
  planId: "nearyou_family";
  capacity: {
    state: CapacityState;
    usage: HouseholdCapacityUsage;
    limits: HouseholdCapacityUsage;
    exceeded: CapacityDimension[];
  };
  features: {
    nearsleep: true;
    nearstoryParentControlled: true;
    childAccounts: false;
    childMicrophone: false;
    posthumousSynthesis: false;
  };
};

const DIMENSIONS = ["members", "children", "voices", "storageBytes"] as const;

function safeCount(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("NearFamily capacity invalid");
  return Number(value);
}

export function createNearFamilySummaryService(db: NearFamilyDb) {
  return async (householdId: string): Promise<NearFamilySummary> => {
    if (!/^[-A-Za-z0-9_]{1,200}$/.test(householdId)) throw new Error("NearFamily household invalid");
    const row = await db.prepare(`SELECT p.plan_id,p.members,p.children,p.voices,p.storage_bytes,p.member_limit,p.child_limit,p.voice_limit,p.storage_limit,s.state,s.exceeded_json
      FROM household_capacity_projection p JOIN household_capacity_state s ON s.household_id=p.household_id AND s.plan_id=p.plan_id AND s.state=p.state AND s.exceeded_json=p.exceeded_json
      WHERE p.household_id=? LIMIT 1`).bind(householdId).first<CapacityRow>();
    if (!row || row.plan_id !== "nearyou_family") throw new Error("NearFamily entitlement required");
    if (row.state !== "within_limit" && row.state !== "restricted") throw new Error("NearFamily capacity invalid");
    let parsed: unknown;
    try { parsed = JSON.parse(row.exceeded_json); } catch { throw new Error("NearFamily capacity invalid"); }
    if (!Array.isArray(parsed) || parsed.some((value) => !DIMENSIONS.includes(value as CapacityDimension)) || new Set(parsed).size !== parsed.length) throw new Error("NearFamily capacity invalid");
    const usage = Object.freeze({ members: safeCount(row.members), children: safeCount(row.children), voices: safeCount(row.voices), storageBytes: safeCount(row.storage_bytes) });
    const limits = Object.freeze({ members: safeCount(row.member_limit), children: safeCount(row.child_limit), voices: safeCount(row.voice_limit), storageBytes: safeCount(row.storage_limit) });
    return Object.freeze({
      planId: "nearyou_family" as const,
      capacity: Object.freeze({ state: row.state, usage, limits, exceeded: Object.freeze([...parsed]) as CapacityDimension[] }),
      features: Object.freeze({ nearsleep: true as const, nearstoryParentControlled: true as const, childAccounts: false as const, childMicrophone: false as const, posthumousSynthesis: false as const }),
    });
  };
}
