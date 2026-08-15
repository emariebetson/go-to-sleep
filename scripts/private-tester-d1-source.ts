import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import reviewedManifest from "../infra/production/private-tester-d1-schema-baseline.json";

const execFileAsync = promisify(execFile);
const HASH = /^[a-f0-9]{64}$/;
const MANIFEST_KEYS = Object.freeze([
  "migration_range",
  "migration_sources_sha256",
  "provider_internal_schema_objects",
  "sqlite_schema_source_definitions_sha256",
  "sqlite_schema_source_object_count",
  "version",
  "wrangler_version",
]);
export const PRIVATE_TESTER_D1_SOURCE_IDS = Object.freeze([
  "0000_nearnight_foundation",
  "0001_google_apple_auth",
  "0002_sharp_shinobi_shaw",
  "0003_white_groot",
  "0004_salty_sugar_man",
  "0005_pronunciation_frequency_layers",
  "0006_nearyou_shared_foundation",
  "0007_nearsleep_production_upgrade",
  "0008_nearsleep_live_integration",
  "0009_nearsleep_audio_atomic",
  "0010_child_profile_pronunciation",
  "0011_household_billing_accounts",
  "0012_nearsleep_library_privacy",
  "0013_nearstory_parent_beta",
  "0014_nearlegacy_archive",
  "0015_platform_release_foundation",
  "0016_marketing_waitlist",
]);
export const PRIVATE_TESTER_D1_PROVIDER_INTERNAL_OBJECTS = Object.freeze([
  Object.freeze({ type: "index", name: "sqlite_autoindex_d1_migrations_1", tableName: "d1_migrations" }),
  Object.freeze({ type: "table", name: "_cf_METADATA", tableName: "_cf_METADATA" }),
  Object.freeze({ type: "table", name: "d1_migrations", tableName: "d1_migrations" }),
  Object.freeze({ type: "table", name: "sqlite_sequence", tableName: "sqlite_sequence" }),
  Object.freeze({ type: "table", name: "sqlite_stat1", tableName: "sqlite_stat1" }),
]);
const PROVIDER_INTERNAL_IDENTITIES = new Set(PRIVATE_TESTER_D1_PROVIDER_INTERNAL_OBJECTS.map(({ type, name, tableName }) => `${type}\u0000${name}\u0000${tableName}`));

type Source = { id: string; checksum: string };
type SchemaRow = { type: string; name: string; tableName: string; rootPage: number; sql: string | null };
type Manifest = {
  version: 1;
  migration_range: "0000-0016";
  wrangler_version: string;
  migration_sources_sha256: string;
  sqlite_schema_source_object_count: number;
  sqlite_schema_source_definitions_sha256: string;
  provider_internal_schema_objects: { type: string; name: string; table_name: string }[];
};

function invalid(): never { throw new Error("private tester D1 source baseline invalid"); }
function canonical(value: unknown): string { return JSON.stringify(value); }
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && canonical(Reflect.ownKeys(value).sort()) === canonical([...keys].sort());
}
function manifest(value: unknown): Manifest {
  const providerObjects = PRIVATE_TESTER_D1_PROVIDER_INTERNAL_OBJECTS.map(({ type, name, tableName }) => ({ type, name, table_name: tableName }));
  if (!exactObject(value, MANIFEST_KEYS) || value.version !== 1 || value.migration_range !== "0000-0016" || typeof value.wrangler_version !== "string" || !/^4\.[0-9]+\.[0-9]+$/.test(value.wrangler_version) || typeof value.migration_sources_sha256 !== "string" || !HASH.test(value.migration_sources_sha256) || !Number.isSafeInteger(value.sqlite_schema_source_object_count) || Number(value.sqlite_schema_source_object_count) < 1 || Number(value.sqlite_schema_source_object_count) > 1_000 || typeof value.sqlite_schema_source_definitions_sha256 !== "string" || !HASH.test(value.sqlite_schema_source_definitions_sha256) || canonical(value.provider_internal_schema_objects) !== canonical(providerObjects)) invalid();
  return value as unknown as Manifest;
}
function schemaRows(value: unknown): SchemaRow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000) invalid();
  let previous = "";
  return value.map((row) => {
    if (!exactObject(row, ["type", "name", "tableName", "rootPage", "sql"]) || typeof row.type !== "string" || !/^(?:table|index|trigger|view)$/.test(row.type) || typeof row.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.name) || typeof row.tableName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.tableName) || !Number.isSafeInteger(row.rootPage) || Number(row.rootPage) < 0 || (row.sql !== null && (typeof row.sql !== "string" || row.sql.length < 1 || row.sql.length > 1_048_576))) invalid();
    const key = `${row.type}\u0000${row.name}\u0000${row.tableName}`;
    if (key <= previous) invalid();
    previous = key;
    return { type: row.type, name: row.name, tableName: row.tableName, rootPage: Number(row.rootPage), sql: row.sql };
  });
}
async function wrangler(args: string[], cwd: string): Promise<string> {
  const environment: NodeJS.ProcessEnv = { ...process.env, CI: "true", NO_COLOR: "1", WRANGLER_LOG_PATH: join(cwd, "wrangler.log") };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_API_KEY;
  delete environment.CLOUDFLARE_EMAIL;
  const executable = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
  try {
    const result = await execFileAsync(process.execPath, [executable, ...args], { cwd, encoding: "utf8", env: environment, maxBuffer: 2_097_152 });
    return String(result.stdout);
  } catch { invalid(); }
}

export async function verifyPrivateTesterD1SourceBaseline(dependencies: { manifest?: unknown } = {}): Promise<{ sources: Source[]; sourceHash: string; schemaObjectCount: number; schemaDefinitionHash: string; providerInternalSchemaObjects: { type: string; name: string; tableName: string }[]; completeSchemaObjects: SchemaRow[] }> {
  const expected = manifest(dependencies.manifest ?? reviewedManifest);
  const wranglerPackage = JSON.parse(await readFile(new URL("../node_modules/wrangler/package.json", import.meta.url), "utf8")) as unknown;
  if (!exactObject(wranglerPackage, Reflect.ownKeys(wranglerPackage as object).filter((key): key is string => typeof key === "string")) || (wranglerPackage as Record<string, unknown>).version !== expected.wrangler_version) invalid();
  const migrationsDirectory = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(migrationsDirectory)).filter((name) => /^00(?:0[0-9]|1[0-6])_[a-z0-9_]+\.sql$/.test(name)).sort();
  const expectedNames = PRIVATE_TESTER_D1_SOURCE_IDS.map((id) => `${id}.sql`);
  if (canonical(names) !== canonical(expectedNames)) invalid();
  const sourceFiles = await Promise.all(names.map(async (name) => ({ name, checksum: createHash("sha256").update(await readFile(new URL(name, migrationsDirectory))).digest("hex") })));
  const sourceHash = hash(sourceFiles);
  if (sourceHash !== expected.migration_sources_sha256) invalid();

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "private-tester-d1-source-"));
  try {
    const temporaryMigrations = join(temporaryDirectory, "drizzle"), state = join(temporaryDirectory, "state"), config = join(temporaryDirectory, "wrangler.jsonc");
    await mkdir(temporaryMigrations);
    await Promise.all(names.map((name) => copyFile(new URL(name, migrationsDirectory), join(temporaryMigrations, name))));
    await writeFile(config, canonical({ name: "private-tester-d1-source", compatibility_date: "2026-08-10", d1_databases: [{ binding: "DB", database_name: "private-tester-d1-source", database_id: "00000000-0000-4000-8000-000000000000", migrations_dir: "drizzle" }] }), { flag: "wx" });
    await wrangler(["d1", "migrations", "apply", "private-tester-d1-source", "--local", "--config", config, "--persist-to", state], temporaryDirectory);
    const output = await wrangler(["d1", "execute", "private-tester-d1-source", "--local", "--config", config, "--persist-to", state, "--json", "--command", "SELECT type,name,tbl_name AS tableName,rootpage AS rootPage,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name,tbl_name"], temporaryDirectory);
    let parsed: unknown;
    try { parsed = JSON.parse(output); } catch { invalid(); }
    if (!Array.isArray(parsed) || parsed.length !== 1 || !exactObject(parsed[0], ["results", "success", "meta"]) || parsed[0].success !== true) invalid();
    const allObjects = schemaRows(parsed[0].results);
    const identity = (row: { type: string; name: string; tableName: string }) => `${row.type}\u0000${row.name}\u0000${row.tableName}`;
    const providerObjects = allObjects.filter((row) => PROVIDER_INTERNAL_IDENTITIES.has(identity(row)));
    const sourceObjects = allObjects.filter((row) => !PROVIDER_INTERNAL_IDENTITIES.has(identity(row)));
    if (canonical(providerObjects.map(({ type, name, tableName }) => ({ type, name, tableName }))) !== canonical(PRIVATE_TESTER_D1_PROVIDER_INTERNAL_OBJECTS) || sourceObjects.length !== expected.sqlite_schema_source_object_count) invalid();
    const schemaDefinitionHash = hash(sourceObjects.map(({ type, name, tableName, sql }) => ({ type, name, tableName, sql })));
    if (schemaDefinitionHash !== expected.sqlite_schema_source_definitions_sha256) invalid();
    return { sources: sourceFiles.map(({ name, checksum }) => ({ id: name.slice(0, -4), checksum })), sourceHash, schemaObjectCount: sourceObjects.length, schemaDefinitionHash, providerInternalSchemaObjects: PRIVATE_TESTER_D1_PROVIDER_INTERNAL_OBJECTS.map((item) => ({ ...item })), completeSchemaObjects: allObjects.map((item) => ({ ...item })) };
  } finally {
    if (dirname(temporaryDirectory) === tmpdir() && temporaryDirectory.startsWith(join(tmpdir(), "private-tester-d1-source-"))) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
