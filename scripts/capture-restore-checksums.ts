/* eslint-disable @typescript-eslint/no-explicit-any -- runtime pg module */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { collectLiveCatalog } from "./postgres-catalog";
import { uploadImmutableObject } from "./immutable-object-upload";

function safeFailure(stage: string, error: unknown) {
  const message = error instanceof Error ? error.message : "unknown";
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgres-url-redacted").replace(/[\r\n]/g, " ").slice(0, 240);
}

async function main() {
  const output = process.argv[2], dsn = process.env.RESTORED_DATABASE_URL, bucket = process.env.CAPTURE_EVIDENCE_BUCKET, object = process.env.CAPTURE_EVIDENCE_OBJECT;
  if (!output || !dsn || !bucket || !object) throw new Error("capture configuration missing");
  let stage = "pg-load";
  try {
    const name = "pg", { Pool } = await import(name) as any;
    stage = "pg-connect";
    const pool = new Pool({ connectionString: dsn, ssl: false, connectionTimeoutMillis: 20_000 });
    try {
      stage = "migration-query";
      const rows = (await pool.query("SELECT id,checksum FROM nearyou.schema_migrations ORDER BY id COLLATE \"C\"")).rows;
      stage = "catalog-query";
      const catalog = await collectLiveCatalog(pool);
      const rowChecksum = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
      const catalogChecksum = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
      const raw = JSON.stringify({ version: 1, rowChecksum, catalogChecksum, rowCount: rows.length }) + "\n";
      await writeFile(output, raw, { flag: "wx" });
      stage = "immutable-upload";
      const tokenResponse = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
      if (!tokenResponse.ok) throw new Error("metadata token unavailable");
      const token = (await tokenResponse.json() as { access_token?: unknown }).access_token;
      if (typeof token !== "string") throw new Error("metadata token invalid");
      await uploadImmutableObject({ bucket, object, raw, accessToken: token });
      process.stdout.write(`capture:complete rows=${rows.length}\n`);
    } finally { await pool.end(); }
  } catch (error) {
    process.stderr.write(`capture:failed stage=${stage} reason=${safeFailure(stage, error)}\n`);
    process.exitCode = 1;
  }
}
main();
