import assert from "node:assert/strict";
import test from "node:test";
import { diffSitesD1SchemaManifest } from "../lib/sites-d1-schema-diff.ts";

const hash = "a".repeat(64);

test("reports exact missing, changed, and extra schema identities by type", () => {
  const expected = [
    { type: "index", name: "accounts_email", tableName: "accounts", sqlSha256: "b".repeat(64) },
    { type: "table", name: "accounts", tableName: "accounts", sqlSha256: hash },
    { type: "trigger", name: "accounts_guard", tableName: "accounts", sqlSha256: "c".repeat(64) },
  ];
  const live = [
    { type: "index", name: "accounts_email", tableName: "accounts", sqlSha256: "d".repeat(64) },
    { type: "table", name: "__appgarden_migrations", tableName: "__appgarden_migrations", sqlSha256: "e".repeat(64) },
    { type: "table", name: "accounts", tableName: "accounts", sqlSha256: hash },
  ];

  assert.deepEqual(diffSitesD1SchemaManifest(expected, live), {
    expectedCounts: { index: 1, table: 1, trigger: 1, view: 0 },
    liveCounts: { index: 1, table: 2, trigger: 0, view: 0 },
    missing: [{ type: "trigger", name: "accounts_guard", tableName: "accounts", expectedSqlSha256: "c".repeat(64) }],
    changed: [{ type: "index", name: "accounts_email", tableName: "accounts", expectedSqlSha256: "b".repeat(64), liveSqlSha256: "d".repeat(64) }],
    extra: [{ type: "table", name: "__appgarden_migrations", tableName: "__appgarden_migrations", liveSqlSha256: "e".repeat(64) }],
  });
});

test("rejects duplicate, malformed, or unsorted manifests", () => {
  const row = { type: "table", name: "accounts", tableName: "accounts", sqlSha256: hash };
  assert.throws(() => diffSitesD1SchemaManifest([row, row], [row]), /schema manifest invalid/);
  assert.throws(() => diffSitesD1SchemaManifest([{ ...row, sqlSha256: "bad" }], [row]), /schema manifest invalid/);
  assert.throws(() => diffSitesD1SchemaManifest([{ ...row, type: "trigger" }, row], [row]), /schema manifest invalid/);
});
