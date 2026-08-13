/* eslint-disable @typescript-eslint/no-explicit-any -- runtime pg module */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { collectRestore } from "./collect-operational-gate";
import { collectLiveCatalog } from "./postgres-catalog";
import { operationalArtifact } from "./evidence-artifact";

async function main() {
  const output = process.argv[2], dsn = process.env.RESTORED_DATABASE_URL, project = process.env.RESTORE_GCP_PROJECT, operationId = process.env.CLOUD_SQL_RESTORE_OPERATION, token = process.env.GOOGLE_OAUTH_ACCESS_TOKEN, expected = process.env.RESTORE_EXPECTED_CHECKSUM, catalogExpected = process.env.RESTORE_EXPECTED_CATALOG_CHECKSUM;
  if (!output || !dsn || !project || !operationId || !token || !expected || !catalogExpected) throw new Error("restore configuration missing");
  const name = "pg", { Pool } = await import(name) as any, pool = new Pool({ connectionString: dsn, ssl: { rejectUnauthorized: true } });
  try {
    const result = await collectRestore({ project, operationId, token, expectedChecksum: expected, expectedCatalogChecksum: catalogExpected, fetch, verifyRestoredDatabase: async () => {
      const rows = (await pool.query("SELECT id,checksum FROM nearyou.schema_migrations ORDER BY id COLLATE \"C\"")).rows, catalog = await collectLiveCatalog(pool), rowChecksum = createHash("sha256").update(JSON.stringify(rows)).digest("hex"), catalogChecksum = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
      return { rowChecksum, catalogChecksum, rowCount: rows.length };
    } });
    await writeFile(output, JSON.stringify(operationalArtifact(result)) + "\n", { flag: "wx" });
  } finally { await pool.end(); }
}
main().catch(() => { process.stderr.write("restore evidence failed\n"); process.exitCode = 1; });
