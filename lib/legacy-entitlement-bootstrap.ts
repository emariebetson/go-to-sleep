type D1EntitlementDatabase = {
  prepare(query: string): {
    bind(...parameters: unknown[]): {
      run(): Promise<unknown>;
      all(): Promise<{ results?: unknown[] }>;
    };
  };
  batch(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown>;
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
  VALUES (?, ?, 'nearsleep_free', 'legacy', 'active', 3000,
          3000, 3, NULL, ?, NULL, ?, ?)
  ON CONFLICT DO NOTHING`).bind(input.id, input.householdId, now, now, now).run();
}

export async function grantLegacyFreeGenerationCredits(db: D1EntitlementDatabase, input: {
  userId: string;
  householdId: string;
  entitlementId: string;
  now: Date;
}): Promise<void> {
  const markerId = `free-generation-grant:v2:${input.userId}`;
  const eligible = await db.prepare(`SELECT id FROM users
    WHERE id = ? AND subscription_status NOT IN ('active', 'trialing')
      AND NOT EXISTS (SELECT 1 FROM usage_events WHERE id = ? AND user_id = ?)`)
    .bind(input.userId, markerId, input.userId).all();
  if (!eligible.results?.length) return;
  const claimToken = crypto.randomUUID();
  const now = input.now.getTime();
  const metadata = JSON.stringify({ kind: "free_generation_credit_grant", version: 2, claimToken });
  const markerMatchesClaim = `EXISTS (
    SELECT 1 FROM usage_events
    WHERE id = ? AND user_id = ? AND json_extract(metadata, '$.claimToken') = ?
  )`;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO usage_events
      (id, user_id, household_id, ledger_entry_id, session_id, type, units, metadata, created_at)
      SELECT ?, ?, ?, NULL, NULL, 'free_generation_credit_grant', 2, ?, ?
      FROM users WHERE id = ? AND subscription_status NOT IN ('active', 'trialing')`)
      .bind(markerId, input.userId, input.householdId, metadata, now, input.userId),
    db.prepare(`UPDATE users SET credits_remaining = credits_remaining + 2, updated_at = ?
      WHERE id = ? AND subscription_status NOT IN ('active', 'trialing') AND ${markerMatchesClaim}`)
      .bind(now, input.userId, markerId, input.userId, claimToken),
    db.prepare(`UPDATE entitlements SET
        allowance_milliunits = MAX(allowance_milliunits, 3000),
        remaining_milliunits = remaining_milliunits + MAX(0, 3000 - allowance_milliunits),
        legacy_credits_remaining = COALESCE(legacy_credits_remaining, 0) + (MAX(0, 3000 - allowance_milliunits) / 1000),
        updated_at = ?
      WHERE id = ? AND household_id = ? AND plan_id = 'nearsleep_free' AND ${markerMatchesClaim}`)
      .bind(now, input.entitlementId, input.householdId, markerId, input.userId, claimToken),
  ]);
}
