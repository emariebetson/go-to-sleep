type D1ChildProfileDatabase = {
  prepare(query: string): {
    bind(...parameters: unknown[]): {
      run(): Promise<unknown>;
    };
  };
};

type LegacyChildProfileInput = {
  id: string;
  householdId: string;
  legacyChildId: string;
  nickname: string;
  normalizedNickname: string;
  ageMonths: number | null;
  bedtimeChallenge: string | null;
  now: Date;
};

export async function upsertLegacyChildProfile(db: D1ChildProfileDatabase, input: LegacyChildProfileInput): Promise<void> {
  const now = input.now.getTime();
  await db.prepare(`INSERT INTO child_profiles
    (id, household_id, legacy_child_id, nickname, normalized_nickname,
     age_months, bedtime_challenge, created_at, updated_at, archived_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  ON CONFLICT (household_id, normalized_nickname) DO UPDATE SET
    legacy_child_id = excluded.legacy_child_id,
    nickname = excluded.nickname,
    age_months = excluded.age_months,
    bedtime_challenge = excluded.bedtime_challenge,
    updated_at = excluded.updated_at`).bind(
    input.id,
    input.householdId,
    input.legacyChildId,
    input.nickname,
    input.normalizedNickname,
    input.ageMonths,
    input.bedtimeChallenge,
    now,
    now,
  ).run();
}
