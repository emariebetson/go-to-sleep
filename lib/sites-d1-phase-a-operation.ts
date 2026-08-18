import {
  D1_CONVERGENCE_SHAPE_QUERIES,
  D1_CONVERGENCE_TABLES,
} from "./private-tester-baseline-gateway";
import {
  splitD1Migration,
  type ForwardMigration,
  type SchemaCheckpoint,
} from "./sites-d1-forward-operation";
type S = {
  bind(...v: unknown[]): S;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
};
type DB = { prepare(sql: string): S; batch(s: S[]): Promise<unknown[]> };
type Ledger = { id: number; name: string; applied_at: string };
const HASH = /^[a-f0-9]{64}$/,
  ID = /^[A-Za-z0-9:_-]{8,128}$/,
  canonical = (v: unknown) => JSON.stringify(v),
  provider = new Set([
    "index\0sqlite_autoindex___appgarden_migrations_1\0__appgarden_migrations",
    "table\0__appgarden_migrations\0__appgarden_migrations",
    "table\0_cf_KV\0_cf_KV",
    "table\0sqlite_sequence\0sqlite_sequence",
    "table\0sqlite_stat1\0sqlite_stat1",
  ]),
  sha = async (v: string) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)),
      ),
    ]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
export const SITES_D1_PHASE_A_BOOTSTRAP = [
  "CREATE TABLE nearyou_d1_phase_a_operations(phase TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,release_id TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,issued_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('running','complete')),completed_at INTEGER)",
  "CREATE TABLE nearyou_d1_phase_a_migrations(operation_id TEXT NOT NULL,ordinal INTEGER NOT NULL,migration_id TEXT NOT NULL,source_sha256 TEXT NOT NULL,applied_at INTEGER NOT NULL,PRIMARY KEY(operation_id,ordinal),UNIQUE(operation_id,migration_id))",
  "CREATE TRIGGER nearyou_d1_phase_a_migrations_update_guard BEFORE UPDATE ON nearyou_d1_phase_a_migrations BEGIN SELECT RAISE(ABORT,'phase a ledger immutable'); END",
  "CREATE TRIGGER nearyou_d1_phase_a_migrations_delete_guard BEFORE DELETE ON nearyou_d1_phase_a_migrations BEGIN SELECT RAISE(ABORT,'phase a ledger immutable'); END",
  "CREATE TRIGGER nearyou_d1_phase_a_operations_delete_guard BEFORE DELETE ON nearyou_d1_phase_a_operations BEGIN SELECT RAISE(ABORT,'phase a operation immutable'); END",
  "CREATE TRIGGER nearyou_d1_phase_a_operations_update_guard BEFORE UPDATE ON nearyou_d1_phase_a_operations WHEN NOT(OLD.operation_id=NEW.operation_id AND OLD.release_id=NEW.release_id AND OLD.phase=NEW.phase AND OLD.manifest_sha256=NEW.manifest_sha256 AND OLD.issued_at=NEW.issued_at AND OLD.status='running' AND NEW.status='complete' AND OLD.completed_at IS NULL AND NEW.completed_at=OLD.issued_at) BEGIN SELECT RAISE(ABORT,'phase a operation immutable'); END",
];
export async function captureSitesD1PhaseASchemaCheckpoint(
  db: DB,
  head: string,
): Promise<SchemaCheckpoint> {
  const rows = (
    await db
      .prepare(
        "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name,tbl_name",
      )
      .all<{
        type: string;
        name: string;
        tableName: string;
        sql: string | null;
      }>()
  ).results.filter(
    (r) => !provider.has(`${r.type}\0${r.name}\0${r.tableName}`),
  );
  return {
    head,
    objectCount: rows.length,
    definitionsSha256: await sha(canonical(rows)),
    providerObjects: [],
  };
}
export async function captureSitesD1PhaseAShapeSha256(db: DB) {
  const read = async (sql: string, max: number) => {
      const rows = (await db.prepare(sql).all()).results;
      if (rows.length > max) throw new Error("phase a shape invalid");
      return rows;
    },
    tables = await read(D1_CONVERGENCE_SHAPE_QUERIES.table_xinfo, 1000),
    foreignKeys = await read(
      D1_CONVERGENCE_SHAPE_QUERIES.foreign_key_list,
      1000,
    ),
    indexes = await read(D1_CONVERGENCE_SHAPE_QUERIES.index_list, 1000),
    indexColumns = await read(D1_CONVERGENCE_SHAPE_QUERIES.index_xinfo, 2000),
    foreignKeyViolations = await read(
      D1_CONVERGENCE_SHAPE_QUERIES.foreign_key_check,
      101,
    ),
    rowCounts = [];
  for (const tableName of D1_CONVERGENCE_TABLES) {
    const rows = await read(
      `/* row_counts:${tableName} */ SELECT COUNT(*) AS "rowCount" FROM "${tableName}"`,
      1,
    );
    if (rows.length !== 1) throw new Error("phase a shape invalid");
    rowCounts.push({
      tableName,
      rowCount: (rows[0] as Record<string, unknown>).rowCount,
    });
  }
  return sha(
    canonical({
      tables,
      foreignKeys,
      indexes,
      indexColumns,
      rowCounts,
      foreignKeyViolations,
    }),
  );
}
export type SitesD1PhaseAInput = {
  operationId: string;
  releaseId: string;
  issuedAt: number;
  migrations: ForwardMigration[];
  expectedProviderLedger: Ledger[];
  predecessorSchema: SchemaCheckpoint;
  predecessorShapeSha256: string;
  schemaCheckpoints: SchemaCheckpoint[];
};
export class SitesD1PhaseAOperation {
  constructor(private db: DB) {}
  private providerLedgerGuard(input: SitesD1PhaseAInput) {
    const clauses = input.expectedProviderLedger
      .map(
        () =>
          "EXISTS(SELECT 1 FROM __appgarden_migrations WHERE id=? AND name=? AND applied_at=?)",
      )
      .join(" AND ");
    const values = input.expectedProviderLedger.flatMap((row) => [
      row.id,
      row.name,
      row.applied_at,
    ]);
    return this.db
      .prepare(
        `SELECT CASE WHEN (SELECT COUNT(*) FROM __appgarden_migrations)=? AND ${clauses} THEN 1 ELSE abs(-9223372036854775808) END`,
      )
      .bind(input.expectedProviderLedger.length, ...values);
  }
  private async schema(input: SitesD1PhaseAInput, head: string) {
    const actual = await captureSitesD1PhaseASchemaCheckpoint(this.db, head),
      expected =
        input.schemaCheckpoints.find((x) => x.head === head) ??
        (head === "0006" ? input.predecessorSchema : undefined);
    if (
      !expected ||
      actual.objectCount !== expected.objectCount ||
      actual.definitionsSha256 !== expected.definitionsSha256
    )
      throw new Error(`phase a schema drift:${head}`);
  }
  private async ledger(input: SitesD1PhaseAInput) {
    const rows = (
      await this.db
        .prepare(
          "SELECT id,name,applied_at FROM __appgarden_migrations ORDER BY id",
        )
        .all<Ledger>()
    ).results;
    if (canonical(rows) !== canonical(input.expectedProviderLedger))
      throw new Error("phase a provider ledger drift");
  }
  async run(input: SitesD1PhaseAInput) {
    if (
      !ID.test(input.operationId) ||
      !ID.test(input.releaseId) ||
      !Number.isSafeInteger(input.issuedAt) ||
      input.migrations.length !== 3 ||
      input.expectedProviderLedger.length !== 7 ||
      !HASH.test(input.predecessorShapeSha256) ||
      input.migrations.some(
        (m, i) => !m.id.startsWith(`000${i + 7}_`) || !HASH.test(m.sha256),
      )
    )
      throw new Error("phase a input invalid");
    for (const m of input.migrations)
      if ((await sha(m.sql)) !== m.sha256)
        throw new Error("phase a source drift");
    await this.ledger(input);
    let boot = false,
      applied: { migration_id: string; source_sha256: string }[] = [];
    try {
      await this.schema(input, "0006");
      if (
        (await captureSitesD1PhaseAShapeSha256(this.db)) !==
        input.predecessorShapeSha256
      )
        throw new Error("phase a shape drift");
    } catch {
      boot = true;
      try {
        applied = (
          await this.db
            .prepare(
              "SELECT migration_id,source_sha256 FROM nearyou_d1_phase_a_migrations ORDER BY ordinal",
            )
            .all<{ migration_id: string; source_sha256: string }>()
        ).results;
      } catch {
        throw new Error("phase a predecessor drift");
      }
      const prefix = input.migrations
        .slice(0, applied.length)
        .map((m) => ({ migration_id: m.id, source_sha256: m.sha256 }));
      if (canonical(applied) !== canonical(prefix))
        throw new Error("phase a ledger conflict");
      await this.schema(
        input,
        applied.at(-1)?.migration_id.slice(0, 4) ?? "0006+operation",
      );
    }
    const manifest = await sha(
        canonical({
          operationId: input.operationId,
          releaseId: input.releaseId,
          issuedAt: input.issuedAt,
          migrations: input.migrations.map(({ id, sha256 }) => ({
            id,
            sha256,
          })),
        }),
      ),
      insert = this.db
        .prepare(
          "INSERT INTO nearyou_d1_phase_a_operations(phase,operation_id,release_id,manifest_sha256,issued_at,status) VALUES('0007-0009',?,?,?,?,'running') ON CONFLICT(phase) DO NOTHING",
        )
        .bind(input.operationId, input.releaseId, manifest, input.issuedAt);
    await this.db.batch(
      boot
        ? [this.providerLedgerGuard(input), insert]
        : [
            this.providerLedgerGuard(input),
            ...SITES_D1_PHASE_A_BOOTSTRAP.map((s) => this.db.prepare(s)),
            insert,
          ],
    );
    const op = await this.db
      .prepare(
        "SELECT operation_id,release_id,manifest_sha256,status FROM nearyou_d1_phase_a_operations WHERE phase='0007-0009'",
      )
      .first<{
        operation_id: string;
        release_id: string;
        manifest_sha256: string;
        status: string;
      }>();
    if (
      !op ||
      op.operation_id !== input.operationId ||
      op.release_id !== input.releaseId ||
      op.manifest_sha256 !== manifest
    )
      throw new Error("phase a operation conflict");
    await this.schema(
      input,
      boot
        ? (applied.at(-1)?.migration_id.slice(0, 4) ?? "0006+operation")
        : "0006+operation",
    );
    for (const [i, m] of input.migrations.entries()) {
      const prior = await this.db
        .prepare(
          "SELECT migration_id,source_sha256 FROM nearyou_d1_phase_a_migrations WHERE operation_id=? AND ordinal=?",
        )
        .bind(input.operationId, i + 1)
        .first<{ migration_id: string; source_sha256: string }>();
      if (prior) {
        if (prior.migration_id !== m.id || prior.source_sha256 !== m.sha256)
          throw new Error("phase a ledger conflict");
        continue;
      }
      await this.db.batch([
        this.providerLedgerGuard(input),
        ...splitD1Migration(m.sql).map((s) => this.db.prepare(s)),
        this.db
          .prepare(
            "INSERT INTO nearyou_d1_phase_a_migrations VALUES(?,?,?,?,?)",
          )
          .bind(
            input.operationId,
            i + 1,
            m.id,
            m.sha256,
            input.issuedAt + i + 1,
          ),
      ]);
      await this.schema(input, m.id.slice(0, 4));
      await this.ledger(input);
    }
    const rows = (
      await this.db
        .prepare(
          "SELECT migration_id,source_sha256 FROM nearyou_d1_phase_a_migrations WHERE operation_id=? ORDER BY ordinal",
        )
        .bind(input.operationId)
        .all<{ migration_id: string; source_sha256: string }>()
    ).results;
    if (
      canonical(rows) !==
      canonical(
        input.migrations.map((m) => ({
          migration_id: m.id,
          source_sha256: m.sha256,
        })),
      )
    )
      throw new Error("phase a incomplete");
    if (op.status !== "complete")
      await this.db.batch([
        this.providerLedgerGuard(input),
        this.db
          .prepare(
            "UPDATE nearyou_d1_phase_a_operations SET status='complete',completed_at=issued_at WHERE phase='0007-0009' AND operation_id=? AND status='running'",
          )
          .bind(input.operationId),
      ]);
    await this.ledger(input);
    return {
      operationId: input.operationId,
      status: "complete" as const,
      manifestSha256: manifest,
      migrations: rows,
    };
  }
}
