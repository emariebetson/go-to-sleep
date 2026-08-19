/* eslint-disable @typescript-eslint/no-explicit-any -- runtime pg module is optional */
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { collectLiveCatalog, PRIVATE_TESTER_ACTIVATION_FORCED_RLS, verifyLiveCatalogSecurity } from "./postgres-catalog";
import { currentPostgresMigrationHead, REQUIRED_CATALOG_KINDS } from "./check-catalog-manifest";

export async function generateCatalogCandidate(input: { databaseUrl: string; output: string; connect?: (url: string) => Promise<any> }) {
  if (!/^postgres(?:ql)?:\/\//.test(input.databaseUrl) || !input.output.endsWith("catalog-manifest.candidate.json")) throw new Error("catalog candidate invalid");
  const connect = input.connect ?? (async url => { const name = "pg", { Pool } = await import(name) as any, pool = new Pool({ connectionString: url }); return { query: (sql: string, args?: unknown[]) => pool.query(sql, args), close: () => pool.end() }; }), pg = await connect(input.databaseUrl);
  try {
    const rows = await collectLiveCatalog(pg), security = await verifyLiveCatalogSecurity(pg, PRIVATE_TESTER_ACTIVATION_FORCED_RLS), canonical = JSON.stringify(rows), catalogChecksum = createHash("sha256").update(canonical).digest("hex"), kinds = new Set(rows.map((row: { kind: string }) => row.kind));
    if (REQUIRED_CATALOG_KINDS.some(kind => !kinds.has(kind))) throw new Error("catalog candidate incomplete");
    const artifact = { version: 1, reviewRequired: true, generatedFrom: "supported-postgresql-16", migrationHead: await currentPostgresMigrationHead(), schema: "nearyou", catalogChecksum, requiredKinds: REQUIRED_CATALOG_KINDS, requireForcedRls: security.forcedRls, forbidPublicExecute: security.publicExecuteCount === 0, security, rows };
    await writeFile(input.output, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx" }); return artifact;
  } finally { await pg.close(); }
}
export function catalogCandidateFailureCode(error: unknown) {
  if (error instanceof Error && error.message === "catalog candidate incomplete") return "catalog-candidate-incomplete";
  if (error instanceof Error && error.message === "catalog security invariant failed") return "catalog-security-invariant";
  if (error instanceof Error && /^catalog security invariant failed:forced-rls:(?:none|unknown|[a-z_]{1,63}(?:,[a-z_]{1,63})*)$/.test(error.message)) return error.message.replace("catalog security invariant failed:forced-rls:", "catalog-forced-rls:");
  if (error instanceof Error && /^catalog security invariant failed:public-execute:(?:unknown|nearyou\.[A-Za-z0-9_]+\([^\r\n;]{0,500}\)(?:;nearyou\.[A-Za-z0-9_]+\([^\r\n;]{0,500}\))*)$/.test(error.message)) return error.message.replace("catalog security invariant failed:public-execute:", "catalog-public-execute:");
  if (error instanceof Error && error.message.startsWith("catalog security invariant failed:public-execute:")) return "catalog-security-invariant";
  return "catalog-query-failed";
}
if (import.meta.url === `file://${process.argv[1]}`) { const output = process.argv[2], url = process.env.READINESS_CONTROL_DATABASE_URL; if (!url || !output) throw new Error("catalog candidate configuration missing"); generateCatalogCandidate({ databaseUrl: url, output }).catch((error) => { process.stderr.write(`${catalogCandidateFailureCode(error)}\n`); process.exitCode = 1; }); }
