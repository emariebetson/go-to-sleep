import { createHash } from "node:crypto";
import { applyPostgresMigrations, loadPostgresMigrations, type MigrationFile } from "./migrate";

const DISPOSABLE_INSTANCE = "nearnight:us-central1:nearyou-evidence-20260820";
type Pg = { query<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }> };
type Connection = Pg & { transaction<T>(run: (tx: Pg) => Promise<T>): Promise<T>; close(): Promise<void> };
type Input = Readonly<{ instance: string; databaseUrl: string; disposable: boolean }>;
type Dependencies = Readonly<{
  files?: MigrationFile[];
  connect?(databaseUrl: string): Promise<Connection>;
  apply?(pg: Connection, files: MigrationFile[], checksum: string): Promise<{ migrationLedgerChecksum: string }>;
}>;

function checksum(files: readonly Pick<MigrationFile, "id" | "checksum">[]): string {
  return createHash("sha256").update(files.map(({ id, checksum: value }) => `${id}:${value}`).join("\n")).digest("hex");
}

export function requireNearfamilyDecisionHardeningEnvironment(environment: Record<string, string | undefined>) {
  if (environment.NEARYOU_DECISION_HARDENING_DISPOSABLE !== "true") throw new Error("NearFamily decision hardening requires disposable mode");
  if (environment.NEARYOU_DECISION_HARDENING_INSTANCE !== DISPOSABLE_INSTANCE) throw new Error("NearFamily decision hardening instance invalid");
  const databaseUrl = environment.READINESS_CONTROL_DATABASE_URL;
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl) || Buffer.byteLength(databaseUrl) > 8192) throw new Error("NearFamily decision hardening database configuration invalid");
  return Object.freeze({ instance: DISPOSABLE_INSTANCE, databaseUrl, disposable: true as const });
}

async function connect(databaseUrl: string): Promise<Connection> {
  const moduleName = "pg", { Pool } = await import(moduleName) as unknown as { Pool: new (input: { connectionString: string }) => { connect(): Promise<{ query<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>; release(): void }>; end(): Promise<void> } };
  const pool = new Pool({ connectionString: databaseUrl }), client = await pool.connect();
  return {
    query: (sql, args = []) => client.query(sql, args),
    transaction: async (run) => {
      await client.query("BEGIN");
      try { const result = await run({ query: (sql, args = []) => client.query(sql, args) }); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    },
    close: async () => { client.release(); await pool.end(); },
  };
}

export async function runNearfamilyDecisionHardening(input: Input, dependencies: Dependencies = {}) {
  if (!input.disposable || input.instance !== DISPOSABLE_INSTANCE || !/^postgres(?:ql)?:\/\//.test(input.databaseUrl)) throw new Error("NearFamily decision hardening target invalid");
  const files = dependencies.files ?? await loadPostgresMigrations();
  if (files.length !== 13 || files[11]?.id !== "0012_nearfamily_private_tester_decision" || files[12]?.id !== "0013_nearfamily_decision_nonce_and_evidence") throw new Error("NearFamily decision hardening migration set invalid");
  const connection = await (dependencies.connect ?? connect)(input.databaseUrl);
  try {
    const target = (await connection.query<{ database_name: string; server_version: number; database_user: string }>("SELECT current_database()::text AS database_name,current_setting('server_version_num')::integer AS server_version,current_user::text AS database_user", [])).rows[0];
    if (!target || target.database_name !== "nearyou" || target.server_version < 160000 || target.server_version >= 170000 || !/migration|postgres|admin/i.test(target.database_user)) throw new Error("NearFamily decision hardening database target invalid");
    const prior = (await connection.query<{ id: string; checksum: string }>("SELECT id,checksum FROM nearyou.schema_migrations ORDER BY id COLLATE \"C\"", [])).rows;
    if (JSON.stringify(prior) !== JSON.stringify(files.slice(0, 12).map(({ id, checksum }) => ({ id, checksum })))) throw new Error("NearFamily decision hardening predecessor invalid");
    const schemaChecksum = checksum(files);
    const migration = await (dependencies.apply ?? applyPostgresMigrations)(connection, files, schemaChecksum);
    if (migration.migrationLedgerChecksum !== schemaChecksum) throw new Error("NearFamily decision hardening migration result invalid");
    const facts = (await connection.query<{ migration_head: string; nonce_force_rls: boolean; public_execute_count: string; decision_authorize: boolean; decision_nonce: boolean; decision_table_access: boolean }>(`SELECT
      (SELECT id FROM nearyou.schema_migrations ORDER BY id COLLATE "C" DESC LIMIT 1) AS migration_head,
      (SELECT relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nearyou' AND c.relname='nearfamily_decision_nonces') AS nonce_force_rls,
      (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE n.nspname='nearyou' AND p.proname IN('authorize_nearfamily_private_tester','consume_nearfamily_decision_nonce') AND acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute_count,
      has_function_privilege('nearyou_private_tester_decision','nearyou.authorize_nearfamily_private_tester(text,text,timestamptz)','EXECUTE') AS decision_authorize,
      has_function_privilege('nearyou_private_tester_decision','nearyou.consume_nearfamily_decision_nonce(text,integer,text,text,timestamptz)','EXECUTE') AS decision_nonce,
      (has_table_privilege('nearyou_private_tester_decision','nearyou.nearfamily_decision_nonces','SELECT') OR has_table_privilege('nearyou_private_tester_decision','nearyou.nearfamily_decision_nonces','INSERT') OR has_table_privilege('nearyou_private_tester_decision','nearyou.nearfamily_decision_nonces','UPDATE') OR has_table_privilege('nearyou_private_tester_decision','nearyou.nearfamily_decision_nonces','DELETE')) AS decision_table_access`, [])).rows[0];
    if (!facts || facts.migration_head !== files[12].id || facts.nonce_force_rls !== true || facts.public_execute_count !== "0" || facts.decision_authorize !== true || facts.decision_nonce !== true || facts.decision_table_access !== false) throw new Error("NearFamily decision hardening ACL verification failed");
    return Object.freeze({ version: 1, ready: true as const, instance: input.instance, migrationHead: facts.migration_head, schemaChecksum, security: Object.freeze({ nonceForceRls: true, publicExecuteCount: 0, decisionFunctions: 2, directTableAccess: false }) });
  } finally { await connection.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runNearfamilyDecisionHardening(requireNearfamilyDecisionHardeningEnvironment(process.env)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => { process.stderr.write("NearFamily decision hardening failed\n"); process.exitCode = 1; });
}
