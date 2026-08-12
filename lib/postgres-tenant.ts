export type TransactionConnection = {
  readonly checkedOutConnection: true;
  query<T = Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): Promise<{ rows: T[] }>;
};

export async function withPostgresTenant<T>(
  client: TransactionConnection,
  context: { householdId: string; userId: string },
  operation: (client: TransactionConnection) => Promise<T>,
) {
  if (!context.householdId || !context.userId) throw new Error("PostgreSQL tenant context is required.");
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.household_id', $1, true), set_config('app.user_id', $2, true)", [context.householdId, context.userId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function loadPlatformReleaseEvidence(client: TransactionConnection, releaseId: string) {
  const result = await client.query<{ gate: string; status: string; release_id: string; schema_checksum: string; backfill_checksum: string; verified_at: string | null; verified_by: string | null }>(
    "SELECT gate, status, release_id, schema_checksum, backfill_checksum, verified_at, verified_by FROM nearyou.release_evidence WHERE release_id = $1 ORDER BY gate",
    [releaseId],
  );
  if (result.rows.length !== 4 || result.rows.some((row) => row.release_id !== releaseId || !row.verified_at || !row.verified_by)) throw new Error("Durable release evidence is incomplete.");
  const schemaChecksums = new Set(result.rows.map((row) => row.schema_checksum));
  const backfillChecksums = new Set(result.rows.map((row) => row.backfill_checksum));
  if (schemaChecksums.size !== 1 || backfillChecksums.size !== 1) throw new Error("Durable release evidence is inconsistent.");
  const values = Object.fromEntries(result.rows.map((row) => [row.gate, row.status]));
  return {
    releaseId,
    schemaChecksum: result.rows[0].schema_checksum,
    backfillChecksum: result.rows[0].backfill_checksum,
    backfill: values.backfill || "pending",
    shadowReads: values.shadow_reads || "pending",
    rlsNegativeTest: values.rls_negative_test || "pending",
    mediaWorker: values.media_worker || "pending",
  };
}
