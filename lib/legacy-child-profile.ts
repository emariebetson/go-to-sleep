type D1ChildProfileDatabase = {
  prepare(query: string): {
    bind(...parameters: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
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

export async function upsertLegacyChildProfile(db: D1ChildProfileDatabase, input: LegacyChildProfileInput): Promise<string> {
  const now = input.now.getTime();
  const existing = await db.prepare(`SELECT id FROM child_profiles
    WHERE household_id = ? AND normalized_nickname = ?
    LIMIT 1`).bind(input.householdId, input.normalizedNickname).first<{ id: string }>();

  if (existing) {
    await db.prepare(`UPDATE child_profiles SET
      legacy_child_id = ?,
      nickname = ?,
      age_months = ?,
      bedtime_challenge = ?,
      updated_at = ?
    WHERE id = ? AND household_id = ?`).bind(
      input.legacyChildId,
      input.nickname,
      input.ageMonths,
      input.bedtimeChallenge,
      now,
      existing.id,
      input.householdId,
    ).run();
    return existing.id;
  }

  await db.prepare(`INSERT INTO child_profiles
    (id, household_id, legacy_child_id, nickname, normalized_nickname,
     age_months, bedtime_challenge, created_at, updated_at, archived_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).bind(
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
  return input.id;
}
