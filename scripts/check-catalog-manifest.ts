import { readdir, readFile } from "node:fs/promises";

export const PENDING_CATALOG_CHECKSUM = "0".repeat(64);
export const REQUIRED_CATALOG_KINDS = ["schema", "table", "column", "constraint", "index", "trigger", "policy", "function", "sequence", "extension", "role", "membership"] as const;
export async function currentPostgresMigrationHead() {
  const files = (await readdir(new URL("../postgres/migrations", import.meta.url))).filter(file => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
  if (!files.length) throw new Error("catalog manifest drift");
  return files.at(-1)!.replace(/\.sql$/, "");
}
export async function checkCatalogManifest(options: { requireReviewed?: boolean } = {}) {
  const manifest = JSON.parse(await readFile(new URL("../postgres/catalog-manifest.json", import.meta.url), "utf8")) as Record<string, unknown>, migrationHead = await currentPostgresMigrationHead();
  const checksum = manifest.catalogChecksum;
  if (manifest.version !== 1 || manifest.schema !== "nearyou" || manifest.migrationHead !== migrationHead || !Array.isArray(manifest.requiredKinds) || JSON.stringify(manifest.requiredKinds) !== JSON.stringify(REQUIRED_CATALOG_KINDS) || !Array.isArray(manifest.requireForcedRls) || !(manifest.requireForcedRls as string[]).includes("household_members") || !(manifest.requireForcedRls as string[]).includes("tenant_records") || manifest.forbidPublicExecute !== true || typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error("catalog manifest drift");
  if (options.requireReviewed && (checksum === PENDING_CATALOG_CHECKSUM || manifest.generatedFrom !== "reviewed-supported-postgresql-16")) throw new Error("catalog manifest pending review");
  return manifest;
}
if (import.meta.url === `file://${process.argv[1]}`) checkCatalogManifest({ requireReviewed: process.argv.includes("--require-reviewed") }).catch(() => { process.exitCode = 1; });
