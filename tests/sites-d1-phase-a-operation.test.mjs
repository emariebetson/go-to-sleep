import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { D1_CONVERGENCE_TABLES } from "../lib/private-tester-baseline-gateway.ts";
import {
  SITES_D1_PHASE_A_BOOTSTRAP,
  SitesD1PhaseAOperation,
  captureSitesD1PhaseASchemaCheckpoint,
  captureSitesD1PhaseAShapeSha256,
} from "../lib/sites-d1-phase-a-operation.ts";
class Bound {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Bound(this.db, this.sql, args);
  }
  async all() {
    return {
      results: this.db
        .prepare(this.sql)
        .all(...this.args)
        .map((row) => ({ ...row })),
    };
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.args);
    return row ? { ...row } : null;
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes) } };
  }
}
class D1 {
  constructor(db, lose = -1, beforeBatch) {
    this.db = db;
    this.lose = lose;
    this.beforeBatch = beforeBatch;
    this.calls = 0;
  }
  prepare(sql) {
    return new Bound(this.db, sql);
  }
  async batch(statements) {
    this.beforeBatch?.(this.calls + 1, this.db);
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec("COMMIT");
      this.calls++;
      if (this.calls === this.lose) throw new Error("lost response");
      return out;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
const hash = async (value) =>
    Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ).toString("hex"),
  provider = [
    {
      id: 1,
      name: "0000_nearnight_foundation.sql",
      applied_at: "2026-08-10 00:00:00",
    },
    {
      id: 2,
      name: "0001_google_apple_auth.sql",
      applied_at: "2026-08-10 00:01:00",
    },
    {
      id: 3,
      name: "0002_sharp_shinobi_shaw.sql",
      applied_at: "2026-08-10 00:02:00",
    },
    { id: 4, name: "0003_white_groot.sql", applied_at: "2026-08-10 00:03:00" },
    {
      id: 5,
      name: "0004_salty_sugar_man.sql",
      applied_at: "2026-08-10 00:04:00",
    },
    {
      id: 6,
      name: "0005_pronunciation_frequency_layers.sql",
      applied_at: "2026-08-10 00:05:00",
    },
    {
      id: 7,
      name: "0006_nearyou_shared_foundation.sql",
      applied_at: "2026-08-10 00:06:00",
    },
  ];
async function fixture(lose = -1) {
  const sqlite = new DatabaseSync(":memory:");
  for (const table of D1_CONVERGENCE_TABLES)
    sqlite.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY)`);
  sqlite.exec(
    "CREATE TABLE __appgarden_migrations(id INTEGER,name TEXT,applied_at TEXT);CREATE TABLE _cf_KV(key TEXT,value TEXT)",
  );
  for (const row of provider)
    sqlite
      .prepare("INSERT INTO __appgarden_migrations VALUES(?,?,?)")
      .run(row.id, row.name, row.applied_at);
  const db = new D1(sqlite, lose),
    migrations = await Promise.all(
      [7, 8, 9].map(async (n) => {
        const id = `000${n}_test`,
          sql = `CREATE TABLE phase_a_${n}(id TEXT PRIMARY KEY)`;
        return { id, sql, sha256: await hash(sql) };
      }),
    ),
    predecessorSchema = await captureSitesD1PhaseASchemaCheckpoint(db, "0006"),
    predecessorShapeSha256 = await captureSitesD1PhaseAShapeSha256(db),
    checkpoints = [predecessorSchema];
  for (const sql of SITES_D1_PHASE_A_BOOTSTRAP) sqlite.exec(sql);
  checkpoints.push(
    await captureSitesD1PhaseASchemaCheckpoint(db, "0006+operation"),
  );
  for (const migration of migrations) {
    sqlite.exec(migration.sql);
    checkpoints.push(
      await captureSitesD1PhaseASchemaCheckpoint(db, migration.id.slice(0, 4)),
    );
  }
  sqlite.close();
  return {
    provider,
    migrations,
    predecessorSchema,
    predecessorShapeSha256,
    checkpoints,
    lose,
  };
}
test("phase A is atomic resumable and never mutates provider ledger", async () => {
  const spec = await fixture();
  for (const lose of [-1, 1, 2, 3, 4, 5]) {
    const sqlite = new DatabaseSync(":memory:");
    for (const table of D1_CONVERGENCE_TABLES)
      sqlite.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY)`);
    sqlite.exec(
      "CREATE TABLE __appgarden_migrations(id INTEGER,name TEXT,applied_at TEXT);CREATE TABLE _cf_KV(key TEXT,value TEXT)",
    );
    for (const row of provider)
      sqlite
        .prepare("INSERT INTO __appgarden_migrations VALUES(?,?,?)")
        .run(row.id, row.name, row.applied_at);
    let db = new D1(sqlite, lose),
      input = {
        operationId: "d1-phase-a:test",
        releaseId: "rel_phase_a_test",
        issuedAt: 1787000000000,
        migrations: spec.migrations,
        expectedProviderLedger: provider,
        predecessorSchema: spec.predecessorSchema,
        predecessorShapeSha256: spec.predecessorShapeSha256,
        schemaCheckpoints: spec.checkpoints,
      };
    if (lose > 0) {
      await assert.rejects(
        () => new SitesD1PhaseAOperation(db).run(input),
        /lost response/,
      );
      db = new D1(sqlite);
    }
    const result = await new SitesD1PhaseAOperation(db).run(input);
    assert.equal(result.status, "complete");
    assert.deepEqual(
      sqlite
        .prepare("SELECT * FROM __appgarden_migrations ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      provider,
    );
    assert.equal(
      sqlite
        .prepare("SELECT count(*) n FROM nearyou_d1_phase_a_migrations")
        .get().n,
      3,
    );
  }
});
test("phase A rejects concurrent identity and provider-ledger substitution", async () => {
  const spec = await fixture(),
    sqlite = new DatabaseSync(":memory:");
  for (const table of D1_CONVERGENCE_TABLES)
    sqlite.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY)`);
  sqlite.exec(
    "CREATE TABLE __appgarden_migrations(id INTEGER,name TEXT,applied_at TEXT);CREATE TABLE _cf_KV(key TEXT,value TEXT)",
  );
  for (const row of provider)
    sqlite
      .prepare("INSERT INTO __appgarden_migrations VALUES(?,?,?)")
      .run(row.id, row.name, row.applied_at);
  const db = new D1(sqlite),
    base = {
      operationId: "d1-phase-a:test",
      releaseId: "rel_phase_a_test",
      issuedAt: 1787000000000,
      migrations: spec.migrations,
      expectedProviderLedger: provider,
      predecessorSchema: spec.predecessorSchema,
      predecessorShapeSha256: spec.predecessorShapeSha256,
      schemaCheckpoints: spec.checkpoints,
    };
  await new SitesD1PhaseAOperation(db).run(base);
  await assert.rejects(
    () =>
      new SitesD1PhaseAOperation(db).run({
        ...base,
        operationId: "d1-phase-a:other",
      }),
    /operation conflict/,
  );
  sqlite
    .prepare(
      "UPDATE __appgarden_migrations SET applied_at='changed' WHERE id=7",
    )
    .run();
  await assert.rejects(
    () => new SitesD1PhaseAOperation(db).run(base),
    /provider ledger drift/,
  );
});
test("provider ledger drift immediately before a migration batch aborts that same batch", async () => {
  const spec = await fixture(),
    sqlite = new DatabaseSync(":memory:");
  for (const table of D1_CONVERGENCE_TABLES)
    sqlite.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY)`);
  sqlite.exec(
    "CREATE TABLE __appgarden_migrations(id INTEGER,name TEXT,applied_at TEXT);CREATE TABLE _cf_KV(key TEXT,value TEXT)",
  );
  for (const row of provider)
    sqlite
      .prepare("INSERT INTO __appgarden_migrations VALUES(?,?,?)")
      .run(row.id, row.name, row.applied_at);
  const db = new D1(sqlite, -1, (call, database) => {
      if (call === 2)
        database
          .prepare(
            "UPDATE __appgarden_migrations SET applied_at='concurrent' WHERE id=7",
          )
          .run();
    }),
    input = {
      operationId: "d1-phase-a:test",
      releaseId: "rel_phase_a_test",
      issuedAt: 1787000000000,
      migrations: spec.migrations,
      expectedProviderLedger: provider,
      predecessorSchema: spec.predecessorSchema,
      predecessorShapeSha256: spec.predecessorShapeSha256,
      schemaCheckpoints: spec.checkpoints,
    };
  await assert.rejects(() => new SitesD1PhaseAOperation(db).run(input));
  assert.equal(
    sqlite
      .prepare(
        "SELECT count(*) n FROM sqlite_schema WHERE name='phase_a_7'",
      )
      .get().n,
    0,
  );
  assert.equal(
    sqlite.prepare("SELECT count(*) n FROM nearyou_d1_phase_a_migrations").get()
      .n,
    0,
  );
});
test("phase A route is independently literal-dark and authenticates before parsing", () => {
  const source = readFileSync(
      new URL("../app/api/internal/sites-d1-phase-a/route.ts", import.meta.url),
      "utf8",
    ),
    auth = source.indexOf("createGoogleServiceIdentityAuthenticator"),
    parse = source.indexOf("request.json()"),
    operation = source.indexOf("new SitesD1PhaseAOperation");
  assert.match(source, /ROUTE_ENABLED=false as const/);
  assert.match(source, /TEMPORARY_ACTIVATION_ENABLED=false as const/);
  assert.ok(auth < parse && parse < operation);
  assert.doesNotMatch(source, /sites-d1-forward|0017|0026/);
});
