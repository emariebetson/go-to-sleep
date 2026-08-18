type SchemaType = "index" | "table" | "trigger" | "view";
type SchemaManifestRow = { type: SchemaType; name: string; tableName: string; sqlSha256: string };
type Counts = Record<SchemaType, number>;

const HASH = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TYPES = new Set<SchemaType>(["index", "table", "trigger", "view"]);
const keys = ["name", "sqlSha256", "tableName", "type"];
const identity = ({ type, name, tableName }: Pick<SchemaManifestRow, "type" | "name" | "tableName">) => `${type}\u0000${name}\u0000${tableName}`;

function invalid(): never { throw new Error("Sites D1 schema manifest invalid"); }
function rows(value: unknown): SchemaManifestRow[] {
  if (!Array.isArray(value) || value.length > 1_000) invalid();
  let previous = "";
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || Object.getPrototypeOf(candidate) !== Object.prototype || JSON.stringify(Reflect.ownKeys(candidate).sort()) !== JSON.stringify(keys)) invalid();
    const row = candidate as Record<string, unknown>;
    if (typeof row.type !== "string" || !TYPES.has(row.type as SchemaType) || typeof row.name !== "string" || !IDENTIFIER.test(row.name) || typeof row.tableName !== "string" || !IDENTIFIER.test(row.tableName) || typeof row.sqlSha256 !== "string" || !HASH.test(row.sqlSha256)) invalid();
    const parsed = row as unknown as SchemaManifestRow;
    const current = identity(parsed);
    if (current <= previous) invalid();
    previous = current;
    return { ...parsed };
  });
}
function counts(value: readonly SchemaManifestRow[]): Counts {
  const result: Counts = { index: 0, table: 0, trigger: 0, view: 0 };
  for (const row of value) result[row.type]++;
  return result;
}

export function diffSitesD1SchemaManifest(expectedValue: unknown, liveValue: unknown) {
  const expected = rows(expectedValue), live = rows(liveValue);
  const expectedByIdentity = new Map(expected.map((row) => [identity(row), row]));
  const liveByIdentity = new Map(live.map((row) => [identity(row), row]));
  const missing = expected.filter((row) => !liveByIdentity.has(identity(row))).map(({ type, name, tableName, sqlSha256 }) => ({ type, name, tableName, expectedSqlSha256: sqlSha256 }));
  const changed = expected.filter((row) => liveByIdentity.has(identity(row)) && liveByIdentity.get(identity(row))!.sqlSha256 !== row.sqlSha256).map(({ type, name, tableName, sqlSha256 }) => ({ type, name, tableName, expectedSqlSha256: sqlSha256, liveSqlSha256: liveByIdentity.get(identity({ type, name, tableName }))!.sqlSha256 }));
  const extra = live.filter((row) => !expectedByIdentity.has(identity(row))).map(({ type, name, tableName, sqlSha256 }) => ({ type, name, tableName, liveSqlSha256: sqlSha256 }));
  return { expectedCounts: counts(expected), liveCounts: counts(live), missing, changed, extra };
}
