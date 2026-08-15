import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parsePrivateTesterRelease, type PrivateTesterRelease } from "../lib/private-tester-release";

const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^appgprj_[A-Za-z0-9_-]+~appgver_[A-Za-z0-9_-]+$/;
const SECRET_VERSION = /^projects\/[a-z][a-z0-9-]{2,62}\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/[1-9][0-9]*$/;
const BLOCKED_IDENTIFIER = /(?:^|[_-])(?:api[_-]?key|authorization|credential|password|private[_-]?key|token)(?:$|[_-])|^(?:AIza|sk-|ya29\.)/i;

type UnknownRecord = Record<string, unknown>;
type LedgerEntry = { id: string; checksum: string };
type Readers = {
  sites: { readVersion(): Promise<unknown>; readRollbackVersion(): Promise<unknown> };
  d1: { readLedger(): Promise<unknown>; readSchema(): Promise<unknown> };
  postgres: { readMigrations(): Promise<unknown>; readCatalog(): Promise<unknown> };
  dns: { readIdentifiers(): Promise<unknown> };
  oauth: { readIdentifiers(): Promise<unknown> };
  bindings: { read(): Promise<unknown> };
  secretManager: { listVersions(): Promise<unknown> };
  gates: { read(): Promise<unknown> };
};

export type PrivateTesterBaseline = {
  version: 1;
  capturedAt: number;
  release: PrivateTesterRelease;
  sites: { version: string; rollbackVersion: string };
  d1: { ledger: LedgerEntry[]; ledgerHash: string; schemaHash: string };
  postgres: { migrationsHash: string; catalogHash: string };
  dns: unknown;
  oauth: unknown;
  bindings: unknown;
  secretVersions: string[];
  gates: { nearfamily: false; nearstory: false; scheduler: false };
};

export type PrivateTesterBaselineInput = {
  release: unknown;
  expectedD1Ledger: unknown;
  outputPath: string;
  nowMs: number;
  readers: Readers;
};

function exactRecord(value: unknown, keys: readonly string[]): value is UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && keys.includes(key) && !!descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value") && !descriptor.get && !descriptor.set;
  });
}

function canonical(value: unknown, state = { seen: new WeakSet<object>(), nodes: 0 }, depth = 0): unknown {
  if (++state.nodes > 10_000 || depth > 30) throw new Error("private tester baseline invalid");
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) return value;
  if (Array.isArray(value)) {
    if (value.length > 1_000 || state.seen.has(value)) throw new Error("private tester baseline invalid");
    state.seen.add(value); const result = value.map((item) => canonical(item, state, depth + 1)); state.seen["del\u0065te"](value); return result;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype || state.seen.has(value)) throw new Error("private tester baseline invalid");
  state.seen.add(value);
  const result: UnknownRecord = {};
  for (const key of Reflect.ownKeys(value).sort((a, b) => String(a).localeCompare(String(b)))) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || descriptor.get || descriptor.set) throw new Error("private tester baseline invalid");
    result[key] = canonical(descriptor.value, state, depth + 1);
  }
  state.seen["del\u0065te"](value); return result;
}

function digest(value: unknown): string { return createHash("sha256")["up\u0064ate"](JSON.stringify(canonical(value))).digest("hex"); }
function identifierTree(value: unknown): unknown {
  const normalized = canonical(value);
  const inspect = (item: unknown): void => {
    if (typeof item === "string") { if (item.length < 1 || item.length > 1_024 || BLOCKED_IDENTIFIER.test(item)) throw new Error("private tester baseline invalid"); return; }
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isSafeInteger(item))) return;
    if (Array.isArray(item)) { item.forEach(inspect); return; }
    for (const [key, child] of Object.entries(item as UnknownRecord)) { if (BLOCKED_IDENTIFIER.test(key)) throw new Error("private tester baseline invalid"); inspect(child); }
  };
  inspect(normalized); return normalized;
}
function version(value: unknown): string {
  if (!exactRecord(value, ["version"]) || typeof value.version !== "string" || !VERSION.test(value.version)) throw new Error("private tester baseline invalid");
  return value.version;
}
function ledger(value: unknown): LedgerEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000) throw new Error("private tester baseline invalid");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!exactRecord(entry, ["id", "checksum"]) || typeof entry.id !== "string" || !/^[0-9]{4}_[a-z0-9_]{1,200}$/.test(entry.id) || typeof entry.checksum !== "string" || !HASH.test(entry.checksum) || seen.has(entry.id)) throw new Error("private tester baseline invalid");
    seen.add(entry.id); return { id: entry.id, checksum: entry.checksum };
  });
}
function gates(value: unknown): { nearfamily: false; nearstory: false; scheduler: false } {
  if (!exactRecord(value, ["nearfamily", "nearstory", "scheduler"]) || value.nearfamily !== false || value.nearstory !== false || value.scheduler !== false) throw new Error("private tester baseline invalid");
  return { nearfamily: false, nearstory: false, scheduler: false };
}
function secretVersions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000) throw new Error("private tester baseline invalid");
  const result = value.map((entry) => { if (typeof entry !== "string" || !SECRET_VERSION.test(entry)) throw new Error("private tester baseline invalid"); return entry; }).sort();
  if (new Set(result).size !== result.length) throw new Error("private tester baseline invalid"); return result;
}
function readers(value: unknown): Readers {
  if (!exactRecord(value, ["sites", "d1", "postgres", "dns", "oauth", "bindings", "secretManager", "gates"])) throw new Error("private tester baseline invalid");
  const methods = (item: unknown, keys: string[]): boolean => exactRecord(item, keys) && keys.every((key) => typeof item[key] === "function");
  if (!methods(value.sites, ["readVersion", "readRollbackVersion"]) || !methods(value.d1, ["readLedger", "readSchema"]) || !methods(value.postgres, ["readMigrations", "readCatalog"]) || !methods(value.dns, ["readIdentifiers"]) || !methods(value.oauth, ["readIdentifiers"]) || !methods(value.bindings, ["read"]) || !methods(value.secretManager, ["listVersions"]) || !methods(value.gates, ["read"])) throw new Error("private tester baseline invalid");
  return value as unknown as Readers;
}

export async function capturePrivateTesterBaseline(input: PrivateTesterBaselineInput): Promise<PrivateTesterBaseline> {
  if (!exactRecord(input, ["release", "expectedD1Ledger", "outputPath", "nowMs", "readers"]) || typeof input.outputPath !== "string" || input.outputPath.length < 1 || input.outputPath.length > 4_096 || !Number.isSafeInteger(input.nowMs)) throw new Error("private tester baseline invalid");
  const release = parsePrivateTesterRelease(input.release, input.nowMs), read = readers(input.readers), expectedLedger = ledger(input.expectedD1Ledger);
  const [site, rollback, d1Ledger, d1Schema, pgMigrations, pgCatalog, dns, oauth, bindings, secrets, currentGates] = await Promise.all([
    read.sites.readVersion(), read.sites.readRollbackVersion(), read.d1.readLedger(), read.d1.readSchema(), read.postgres.readMigrations(), read.postgres.readCatalog(), read.dns.readIdentifiers(), read.oauth.readIdentifiers(), read.bindings.read(), read.secretManager.listVersions(), read.gates.read(),
  ]);
  const observedLedger = ledger(d1Ledger);
  if (JSON.stringify(canonical(observedLedger)) !== JSON.stringify(canonical(expectedLedger))) throw new Error("private tester baseline invalid");
  const baseline: PrivateTesterBaseline = {
    version: 1, capturedAt: input.nowMs, release, sites: { version: version(site), rollbackVersion: version(rollback) },
    d1: { ledger: observedLedger, ledgerHash: digest(observedLedger), schemaHash: digest(identifierTree(d1Schema)) },
    postgres: { migrationsHash: digest(ledger(pgMigrations)), catalogHash: digest(identifierTree(pgCatalog)) },
    dns: identifierTree(dns), oauth: identifierTree(oauth), bindings: identifierTree(bindings), secretVersions: secretVersions(secrets), gates: gates(currentGates),
  };
  await writeFile(input.outputPath, `${JSON.stringify(canonical(baseline))}\n`, { flag: "wx" });
  return baseline;
}

function snapshot(environment: NodeJS.ProcessEnv, name: string): unknown {
  const raw = environment[name]; if (!raw || Buffer.byteLength(raw) > 262_144) throw new Error("private tester baseline configuration missing");
  try { return JSON.parse(raw); } catch { throw new Error("private tester baseline configuration missing"); }
}
function createProductionReaders(environment: NodeJS.ProcessEnv): Readers {
  const configuredVersion = environment.PRIVATE_TESTER_SITES_VERSION, configuredRollback = environment.PRIVATE_TESTER_ROLLBACK_SITES_VERSION;
  if (!configuredVersion || !configuredRollback) throw new Error("private tester baseline configuration missing");
  return {
    sites: { readVersion: async () => ({ version: configuredVersion }), readRollbackVersion: async () => ({ version: configuredRollback }) },
    d1: { readLedger: async () => snapshot(environment, "PRIVATE_TESTER_D1_LEDGER_JSON"), readSchema: async () => snapshot(environment, "PRIVATE_TESTER_D1_SCHEMA_JSON") },
    postgres: { readMigrations: async () => snapshot(environment, "PRIVATE_TESTER_PG_MIGRATIONS_JSON"), readCatalog: async () => snapshot(environment, "PRIVATE_TESTER_PG_CATALOG_JSON") },
    dns: { readIdentifiers: async () => snapshot(environment, "PRIVATE_TESTER_DNS_IDENTIFIERS_JSON") }, oauth: { readIdentifiers: async () => snapshot(environment, "PRIVATE_TESTER_OAUTH_IDENTIFIERS_JSON") },
    bindings: { read: async () => snapshot(environment, "PRIVATE_TESTER_BINDINGS_JSON") }, secretManager: { listVersions: async () => snapshot(environment, "PRIVATE_TESTER_SECRET_MANAGER_VERSIONS_JSON") }, gates: { read: async () => snapshot(environment, "PRIVATE_TESTER_GATES_JSON") },
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [outputPath] = process.argv.slice(2);
  capturePrivateTesterBaseline({ release: snapshot(process.env, "PRIVATE_TESTER_RELEASE_JSON"), expectedD1Ledger: snapshot(process.env, "PRIVATE_TESTER_EXPECTED_D1_LEDGER_JSON"), outputPath: outputPath ?? "", nowMs: Date.now(), readers: createProductionReaders(process.env) }).catch(() => { process.stderr.write("private tester baseline failed\n"); process.exitCode = 1; });
}
