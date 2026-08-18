type D1VoiceDatabase = {
  prepare(query: string): {
    bind(...parameters: unknown[]): {
      run(): Promise<unknown>;
    };
  };
};

type LegacyVoiceInput = {
  id: string;
  userId: string;
  householdId: string;
  providerVoiceId: string;
  name: string;
  status: "processing" | "ready" | "failed" | "deleted";
  consentAttestedAt: Date;
  createdAt: Date;
};

export async function createLegacyVoice(db: D1VoiceDatabase, input: LegacyVoiceInput): Promise<void> {
  await db.prepare(`INSERT INTO voices
    (id, user_id, household_id, current_consent_id, provider_voice_id, name,
     status, consent_attested_at, created_at, deleted_at)
  VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)`).bind(
    input.id,
    input.userId,
    input.householdId,
    input.providerVoiceId,
    input.name,
    input.status,
    input.consentAttestedAt.getTime(),
    input.createdAt.getTime(),
  ).run();
}
