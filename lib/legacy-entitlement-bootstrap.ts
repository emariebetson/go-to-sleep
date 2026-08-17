type D1EntitlementDatabase = {
  prepare(query: string): {
    bind(...parameters: unknown[]): {
      run(): Promise<unknown>;
    };
  };
};

type LegacyFreeEntitlementInput = {
  id: string;
  householdId: string;
  now: Date;
};

export async function createLegacyFreeEntitlement(db: D1EntitlementDatabase, input: LegacyFreeEntitlementInput): Promise<void> {
  const now = input.now.getTime();
  await db.prepare(`INSERT INTO entitlements
    (id, household_id, plan_id, source, status, allowance_milliunits,
     remaining_milliunits, legacy_credits_remaining, external_ref,
     valid_from, valid_until, created_at, updated_at)
  VALUES (?, ?, 'nearsleep_free', 'legacy', 'active', 1000,
          1000, 1, NULL, ?, NULL, ?, ?)
  ON CONFLICT DO NOTHING`).bind(input.id, input.householdId, now, now, now).run();
}
