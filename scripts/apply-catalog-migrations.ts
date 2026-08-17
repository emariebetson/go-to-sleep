import { createHash } from "node:crypto";
import { applyPostgresMigrations, loadPostgresMigrations, type MigrationFile } from "./migrate";

type QueryResult<T> = { rows: T[] };
type Transaction = { query<T>(sql: string, args?: unknown[]): Promise<QueryResult<T>> };
type AdminPg = { transaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> };

export const migrationLedgerChecksum = (files: MigrationFile[]) => createHash("sha256")
  .update(files.map((file) => `${file.id}:${file.checksum}`).join("\n"))
  .digest("hex");

export async function applyCatalogMigrations(input: {
  databaseUrl: string;
  disposable: boolean;
  connect?: (url: string) => Promise<{ pg: AdminPg; query<T>(sql: string, args?: unknown[]): Promise<QueryResult<T>>; close(): Promise<void> }>;
}) {
  if (!input.disposable || !/^postgres(?:ql)?:\/\//.test(input.databaseUrl)) throw new Error("catalog migration target invalid");
  const connect = input.connect ?? (async (connectionString: string) => {
    const moduleName = "pg";
    const { Pool } = await import(moduleName) as { Pool: new (options: { connectionString: string }) => {
      connect(): Promise<{ query<T>(sql: string, args?: unknown[]): Promise<QueryResult<T>>; release(): void }>;
      end(): Promise<void>;
    } };
    const pool = new Pool({ connectionString });
    const client = await pool.connect();
    const pg: AdminPg = { transaction: async run => {
      await client.query("BEGIN");
      try {
        const result = await run({ query: (sql, args = []) => client.query(sql, args) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } };
    return { pg, query: (sql, args = []) => client.query(sql, args), close: async () => { client.release(); await pool.end(); } };
  });
  const connection = await connect(input.databaseUrl);
  try {
    const target = (await connection.query<{ database_name: string; server_version: number; pristine: boolean; vector_available: boolean }>(
      "SELECT current_database()::text AS database_name,current_setting('server_version_num')::integer AS server_version,to_regnamespace('nearyou') IS NULL AS pristine,EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='vector') AS vector_available",
    )).rows[0];
    if (!target || target.server_version < 160000 || target.server_version >= 170000 || !target.pristine || !target.vector_available) throw new Error("catalog migration target invalid");
    const files = await loadPostgresMigrations();
    const result = await applyPostgresMigrations(connection.pg, files, migrationLedgerChecksum(files));
    const ledger = (await connection.query<{ id: string; checksum: string }>("SELECT id,checksum FROM nearyou.schema_migrations ORDER BY id COLLATE \"C\"")).rows;
    if (JSON.stringify(ledger) !== JSON.stringify(files.map(({ id, checksum }) => ({ id, checksum })))) throw new Error("catalog migration ledger invalid");
    return { ...result, databaseName: target.database_name, migrationHead: files.at(-1)!.id };
  } finally {
    await connection.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.READINESS_CONTROL_DATABASE_URL;
  applyCatalogMigrations({ databaseUrl: databaseUrl ?? "", disposable: process.env.NEARYOU_CATALOG_DATABASE_DISPOSABLE === "true" })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => { process.stderr.write("catalog migration failed\n"); process.exitCode = 1; });
}
