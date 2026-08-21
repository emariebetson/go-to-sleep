/* eslint-disable @typescript-eslint/no-explicit-any -- runtime pg module */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { collectRestore } from "./collect-operational-gate";
import { collectLiveCatalog } from "./postgres-catalog";
import { operationalArtifact } from "./evidence-artifact";
import { uploadImmutableObject } from "./immutable-object-upload";

async function main() {
  const output = process.argv[2], dsn = process.env.RESTORED_DATABASE_URL, project = process.env.RESTORE_GCP_PROJECT, operationId = process.env.CLOUD_SQL_RESTORE_OPERATION, token = process.env.GOOGLE_OAUTH_ACCESS_TOKEN, expected = process.env.RESTORE_EXPECTED_CHECKSUM, catalogExpected = process.env.RESTORE_EXPECTED_CATALOG_CHECKSUM, bucket = process.env.RESTORE_EVIDENCE_BUCKET, object = process.env.RESTORE_EVIDENCE_OBJECT;
  if (!output || !dsn || !project || !operationId || !token || !expected || !catalogExpected || !bucket || !object) throw new Error("restore configuration missing");
  const name = "pg", { Pool } = await import(name) as any, pool = new Pool({ connectionString: dsn, ssl: false });
  try {
    const result = await collectRestore({ project, operationId, token, expectedChecksum: expected, expectedCatalogChecksum: catalogExpected, fetch, verifyRestoredDatabase: async () => {
      const rows = (await pool.query("SELECT id,checksum FROM nearyou.schema_migrations ORDER BY id COLLATE \"C\"")).rows, catalog = await collectLiveCatalog(pool), rowChecksum = createHash("sha256").update(JSON.stringify(rows)).digest("hex"), catalogChecksum = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
      return { rowChecksum, catalogChecksum, rowCount: rows.length };
    } });
    const raw = JSON.stringify(operationalArtifact(result)) + "\n";
    await writeFile(output, raw, { flag: "wx" });
    await uploadImmutableObject({ bucket, object, raw, accessToken: token });
  } finally { await pool.end(); }
}
main().catch(() => { process.stderr.write("restore evidence failed\n"); process.exitCode = 1; });
