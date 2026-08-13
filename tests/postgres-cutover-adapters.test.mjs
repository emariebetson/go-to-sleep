import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PostgresCutoverStateAdapter, D1CutoverSourceAdapter } from "../lib/postgres-cutover-adapters.ts";
import { runBackfill } from "../lib/postgres-cutover-orchestrator.ts";
import { canonicalCutoverRowTransport, canonicalCutoverStateDigest } from "../lib/postgres-cutover-engine.ts";

const migration = readFileSync(new URL("../postgres/migrations/0003_cutover_runtime.sql", import.meta.url), "utf8");
const d1Migration = readFileSync(new URL("../drizzle/0017_cutover_source_runtime.sql", import.meta.url), "utf8");
const adapterSource = readFileSync(new URL("../lib/postgres-cutover-adapters.ts", import.meta.url), "utf8");

test("cutover runtime SQL exposes narrow atomic operations and release-scoped manifests", () => {
  for (const name of ["acquire_cutover_lease", "initialize_cutover_snapshot", "record_cutover_operation", "transition_cutover", "begin_rollback_capture", "refence_rollback", "record_rollback_manifest", "transition_rollback"]) assert.match(migration, new RegExp(`CREATE FUNCTION nearyou\\.${name}`));
  assert.match(migration, /REVOKE ALL ON FUNCTION nearyou\.transition_cutover[\s\S]*FROM PUBLIC/);
  assert.match(migration, /PRIMARY KEY\(release_id,kind,operation_id\)/);
  assert.doesNotMatch(migration, /UNIQUE \(kind,operation_id\)/);
  assert.match(migration, /release_evidence_audit[\s\S]*release_id=p_release/);
  assert.doesNotMatch(migration, /GRANT (?:INSERT|UPDATE|DELETE).*cutover_runtime_state TO nearyou_cutover_runner/);
});

test("Postgres adapter canonically parses real node-postgres bigint strings", async () => {
  const calls = [];
  const db = { async query(sql, args) { calls.push([sql, args]); if (sql.includes("acquire_cutover_lease")) return { rows: [{ owner: "runner", fence: "3", expires_at_ms: "2000" }] }; if (sql.includes("initialize_cutover_snapshot")) return { rows: [{ high_water: "9", cursor: null, fence: "3" }] }; if (sql.includes("current_cutover_time")) return { rows: [{ now_ms: "1000" }] }; return { rows: [] }; } };
  const adapter = new PostgresCutoverStateAdapter(db, "release-1");
  assert.equal(await adapter.now(), 1000);
  assert.deepEqual(await adapter.acquireLease({ owner: "runner", now: 1000 }), { owner: "runner", fence: 3, expiresAt: 2000 });
  assert.deepEqual(await adapter.initializeSnapshot({ snapshot: { highWater: 9, cursor: null }, lease: { owner: "runner", fence: 3, expiresAt: 2000 } }), { highWater: 9, cursor: null, fence: 3 });
  await assert.rejects(() => new PostgresCutoverStateAdapter({ query: async () => ({ rows: [{ now_ms: "9007199254740992" }] }) }, "release-1").now(), /clock/);
  assert.ok(calls.every(([sql]) => /^SELECT /.test(sql) && sql.includes("nearyou.") && !/\b(?:FROM|UPDATE|INSERT INTO) nearyou\.(?:cutover_runtime_state|cutover_operation_manifests|rollback_runtime_state)\b/.test(sql)));
});

test("Postgres checkpoint and staged page are exact-bound and replay after a lost response", async () => {
  let committed=false,lose=true; const rows=[{tenant:"house-1",table:"items",id:"item-1",sequence:1,deleted:false,payload:{value:"one"}}],base={releaseId:"release-1",fence:3,highWater:9,cursor:0,nextCursor:1,checksum:"ignored"};
  const canonical=[["row","house-1","items","item-1",1,false,["object",[["value",["string","one"]]]]]],rowsChecksum=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(canonical)))).toString("hex"),manifest={releaseId:"release-1",fence:3,highWater:9,cursor:0,nextCursor:1,operationId:"backfill:3:0:1",checksum:rowsChecksum,rowCount:1,rowsChecksum};
  const db={query:async(sql)=>{if(sql.includes("load_cutover_checkpoint"))return{rows:[{high_water:"9",cursor:null,fence:"3"}]};if(sql.includes("apply_cutover_page")){if(!committed){committed=true;if(lose){lose=false;throw new Error("lost response")}}return{rows:[{apply_cutover_page:manifest}]}}return{rows:[]}}};
  const adapter=new PostgresCutoverStateAdapter(db,"release-1"),lease={owner:"runner",fence:3,expiresAt:2000}; assert.deepEqual(await adapter.loadCheckpoint(lease),{highWater:9,cursor:null,fence:3});
  const input={lease,highWater:9,cursor:null,nextCursor:1,operationId:"backfill:3:0:1",rows,manifest:base}; await assert.rejects(()=>adapter.applyPage(input),/lost/); assert.deepEqual(await adapter.applyPage(input),manifest);
  await assert.rejects(()=>adapter.applyPage({...input,rows:[{...rows[0],payload:{value:"changed"}}]}),/conflict/);
});

test("Postgres staging schema scopes rows by release and hashes the exact supplied canonical bytes", () => {
  assert.match(migration, /CREATE TABLE nearyou\.cutover_target_rows\(release_id text NOT NULL/);
  assert.match(migration, /PRIMARY KEY\(release_id,household_id,source_table,source_id\)/);
  assert.match(migration, /canonical_bytes:=decode\(p_canonical_rows,'base64'\)/);
  assert.match(migration, /digest\(canonical_bytes,'sha256'\)/);
  assert.match(migration, /WHERE release_id=p_release AND household_id=/);
  assert.match(migration, /'backfill_page'/);
  assert.doesNotMatch(migration, /digest\(convert_to\(p_rows::text/);
});

test("forward orchestrator reaches the concrete atomic Postgres page adapter", async () => {
  let pageCalls=0;
  const db={query:async(sql,args)=>{if(sql.includes("current_cutover_time"))return{rows:[{now_ms:"1000"}]};if(sql.includes("acquire_cutover_lease")||sql.includes("renew_cutover_lease"))return{rows:[{owner:"runner",fence:"3",expires_at_ms:"120000"}]};if(sql.includes("load_cutover_checkpoint"))return{rows:[{high_water:"1",cursor:null,fence:"3"}]};if(sql.includes("apply_cutover_page")){pageCalls+=1;return{rows:[{apply_cutover_page:{releaseId:args[0],fence:args[2],highWater:args[3],cursor:args[4]??0,nextCursor:args[5],operationId:args[6],checksum:args[10],rowCount:args[9],rowsChecksum:args[10]}}]}}return{rows:[]}}};
  const target=new PostgresCutoverStateAdapter(db,"release-1");
  const row={tenant:"house-1",table:"items",id:"item-1",sequence:1,deleted:false,payload:{value:"one"}};
  const source={acquireSnapshot:async()=>({highWater:1,cursor:null}),page:async({cursor})=>cursor===null?{highWater:1,cursor:null,rows:[row],nextCursor:1}:{highWater:1,cursor:1,rows:[],nextCursor:null}};
  assert.deepEqual(await runBackfill({source,target},{owner:"runner",now:1000,pageSize:10}),{complete:true,highWater:1,cursor:1,pages:2});
  assert.equal(pageCalls,1);
});

class Bound {
  constructor(database, sql, args) { this.database = database; this.sql = sql; this.args = args; }
  async first() { return this.database.prepare(this.sql).get(...this.args) ?? null; }
  async run() { const result = this.database.prepare(this.sql).run(...this.args); return { meta: { changes: result.changes } }; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
}

test("D1 delta pages are release scoped, contiguous, bounded, and preserve tombstones", async () => {
  const database = new DatabaseSync(":memory:"); database.exec(d1Migration);
  database.prepare("INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES(?,'writable',0,0)").run("release-1");
  const insert=database.prepare("INSERT INTO cutover_change_log(sequence,release_id,household_id,source_table,source_id,deleted,payload,created_at) VALUES(?,?,?,?,?,?,?,0)");
  insert.run(1,"release-1","house-1","items","one",0,JSON.stringify({value:"one"}));
  database.prepare("UPDATE cutover_source_state SET high_water=1 WHERE release_id='release-1'").run();
  insert.run(2,"release-1","house-1","items","one",1,null);
  database.prepare("UPDATE cutover_source_state SET high_water=2 WHERE release_id='release-1'").run();
  const adapter=new D1CutoverSourceAdapter(new D1(database),"release-1",()=>"token-fixed");
  const page=await adapter.deltaPage({after:0,highWater:2,limit:10});
  assert.deepEqual(page.rows.map(({sequence,deleted,payload})=>({sequence,deleted,payload})),[{sequence:1,deleted:false,payload:{value:"one"}},{sequence:2,deleted:true,payload:null}]);
  database.prepare("DELETE FROM cutover_change_log WHERE release_id='release-1' AND sequence=1").run();
  await assert.rejects(()=>adapter.deltaPage({after:0,highWater:2,limit:10}),/gap/);
  database.prepare("DELETE FROM cutover_change_log WHERE release_id='release-1'").run();
  await assert.rejects(()=>adapter.deltaPage({after:1,highWater:2,limit:10}),/gap/);
});

test("Postgres final delta is exact-bound and replays a committed lost response", async () => {
  let lose=true; const manifest={releaseId:"release-1",fence:3,freezeToken:"freeze-token",from:0,to:2,finalHighWater:2,operationId:"delta:3:0:2",rowCount:2,rowsChecksum:"a".repeat(64)};
  const db={query:async(sql,args)=>{if(sql.includes("load_cutover_delta"))return{rows:[{freeze_token:"freeze-token",delta_cursor:"0",final_high_water:"2",fence:"3"}]};if(sql.includes("apply_cutover_delta")){if(lose){lose=false;throw new Error("lost response")}return{rows:[{apply_cutover_delta:{...manifest,rowsChecksum:args[11]}}]}}return{rows:[]}}};
  const adapter=new PostgresCutoverStateAdapter(db,"release-1"),lease={owner:"runner",fence:3,expiresAt:9999};
  assert.deepEqual(await adapter.loadDelta({lease,freezeToken:"freeze-token",finalHighWater:2}),{freezeToken:"freeze-token",cursor:0,finalHighWater:2,fence:3});
  const rows=[{tenant:"house-1",table:"items",id:"one",sequence:1,deleted:false,payload:{value:"one"}},{tenant:"house-1",table:"items",id:"two",sequence:2,deleted:true,payload:null}];
  const input={lease,freezeToken:"freeze-token",from:0,to:2,finalHighWater:2,operationId:"delta:3:0:2",rows};
  await assert.rejects(()=>adapter.applyDeltaPage(input),/lost response/);
  assert.equal((await adapter.applyDeltaPage(input)).to,2);
  await assert.rejects(()=>adapter.applyDeltaPage({...input,to:3,operationId:"delta:3:0:3"}),/delta/);
});

test("Postgres delta SQL atomically binds freeze, fence, range, rows and manifest", () => {
  assert.match(migration,/CREATE FUNCTION nearyou\.apply_cutover_delta/);
  assert.match(migration,/delta_freeze_token=p_freeze/);
  assert.match(migration,/delta_cursor=p_from/);
  assert.match(migration,/kind,operation_id,release_id,fence,manifest[\s\S]*'delta'/);
  assert.match(migration,/DELETE FROM nearyou\.cutover_target_rows WHERE release_id=p_release/);
});
class D1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return { bind: (...args) => new Bound(this.database, sql, args) }; }
  async batch(statements) { this.database.exec("BEGIN IMMEDIATE"); try { const results = []; for (const statement of statements) results.push(await statement.run()); this.database.exec("COMMIT"); return results; } catch (error) { this.database.exec("ROLLBACK"); throw error; } }
}
function markDigestReady(database){database.prepare("UPDATE cutover_source_state SET digest_status='ready',digest_index_version=high_water,source_checksum='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',source_row_count=0").run();}

test("SQLite-as-D1 freeze binds authoritative state and rejects a competing operation", async () => {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys=ON"); database.exec(d1Migration);
  database.prepare("INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES ('release-1','writable',4,1)").run();
  markDigestReady(database);
  const adapter = new D1CutoverSourceAdapter(new D1(database), "release-1", () => "token-fixed");
  const first = await adapter.freeze({ expectedHighWater: 3, operationId: "freeze:3:3" });
  assert.deepEqual(first, { operationId: "freeze:3:3", token: "token-fixed", highWater: 4,sourceChecksum:"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",sourceRowCount:0 });
  assert.deepEqual(await adapter.freeze({ expectedHighWater: 3, operationId: "freeze:3:3" }), first);
  await assert.rejects(() => new D1CutoverSourceAdapter(new D1(database), "release-1", () => "token-other").freeze({ expectedHighWater: 3, operationId: "freeze:other" }), /freeze/);
  assert.deepEqual({ ...database.prepare("SELECT write_mode,freeze_operation_id,freeze_token,high_water FROM cutover_source_state").get() }, { write_mode: "frozen", freeze_operation_id: "freeze:3:3", freeze_token: "token-fixed", high_water: 4 });
  assert.equal(database.prepare("SELECT count(*) value FROM cutover_source_operations").get().value, 1);
});

test("D1 ignores an orphan freeze operation that never changed authoritative state", async () => {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys=ON"); database.exec(d1Migration);
  database.prepare("INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES ('release-1','writable',4,1)").run();
  markDigestReady(database);
  database.prepare("INSERT INTO cutover_source_operations(release_id,kind,operation_id,token,expected_high_water,high_water,status,created_at) VALUES ('release-1','freeze','freeze:orphan','token-orphan',4,4,'frozen',1)").run();
  const adapter = new D1CutoverSourceAdapter(new D1(database), "release-1", () => "token-fixed");
  assert.equal(await adapter.loadFreeze("freeze:orphan"), null);
  assert.deepEqual(await adapter.freeze({ expectedHighWater: 4, operationId: "freeze:real" }), { operationId: "freeze:real", token: "token-fixed", highWater: 4,sourceChecksum:"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",sourceRowCount:0 });
  assert.equal(database.prepare("SELECT count(*) value FROM cutover_source_operations").get().value, 2);
});

test("D1 mutation advances the change log atomically and frozen mode rejects the domain write", async () => {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys=ON"); database.exec(d1Migration);
  database.exec("CREATE TABLE example_records(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  database.prepare("INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES ('release-1','writable',0,1)").run();
  const d1 = new D1(database);
  const adapter = new D1CutoverSourceAdapter(d1, "release-1", () => "token-fixed");
  await adapter.guardedMutation({ householdId: "house-1", sourceTable: "example_records", sourceId: "row-1", payload: JSON.stringify({ id: "row-1", value: "first" }), deleted: false, mutation: d1.prepare("INSERT INTO example_records(id,value) VALUES (?,?)").bind("row-1", "first") });
  assert.equal(database.prepare("SELECT high_water FROM cutover_source_state").get().high_water, 1);
  assert.deepEqual({ ...database.prepare("SELECT sequence,household_id,source_table,source_id,deleted,payload FROM cutover_change_log").get() }, { sequence: 1, household_id: "house-1", source_table: "example_records", source_id: "row-1", deleted: 0, payload: JSON.stringify({ id: "row-1", value: "first" }) });
  await adapter.freeze({ expectedHighWater: 1, operationId: "freeze:mutation" });
  await assert.rejects(() => adapter.guardedMutation({ householdId: "house-1", sourceTable: "example_records", sourceId: "row-2", payload: JSON.stringify({ id: "row-2", value: "second" }), deleted: false, mutation: d1.prepare("INSERT INTO example_records(id,value) VALUES (?,?)").bind("row-2", "second") }), /frozen|writable|change/i);
  assert.equal(database.prepare("SELECT count(*) value FROM example_records").get().value, 1);
  assert.equal(database.prepare("SELECT count(*) value FROM cutover_change_log").get().value, 1);
  assert.equal(database.prepare("SELECT high_water FROM cutover_source_state").get().high_water, 1);
});

test("D1 guarded mutation and change log commit atomically and reject frozen writes", async () => {
  const database = new DatabaseSync(":memory:"); database.exec(d1Migration); database.exec("CREATE TABLE items(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  database.prepare("INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES ('release-1','writable',0,1)").run();
  const d1 = new D1(database), adapter = new D1CutoverSourceAdapter(d1, "release-1", () => "token-fixed");
  assert.deepEqual(await adapter.guardedMutation({ mutation: d1.prepare("INSERT INTO items(id,value) VALUES (?,?)").bind("item-1","one"), householdId:"house-1", sourceTable:"items", sourceId:"item-1", payload:'{"value":"one"}', deleted:false }), { sequence: 1 });
  assert.equal(database.prepare("SELECT high_water FROM cutover_source_state").get().high_water, 1); assert.equal(database.prepare("SELECT count(*) value FROM cutover_change_log").get().value, 1);
  await adapter.freeze({ expectedHighWater:1, operationId:"freeze:write-test" });
  await assert.rejects(() => adapter.guardedMutation({ mutation:d1.prepare("INSERT INTO items(id,value) VALUES (?,?)").bind("item-2","two"), householdId:"house-1", sourceTable:"items", sourceId:"item-2", payload:'{"value":"two"}', deleted:false }), /frozen/);
  assert.equal(database.prepare("SELECT count(*) value FROM items").get().value, 1);
});

test("D1 stale pre-read aborts before the domain write when freeze wins the race", async () => {
  const database = new DatabaseSync(":memory:"); database.exec(d1Migration); database.exec("CREATE TABLE items(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  database.prepare("INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES ('release-1','writable',0,1)").run();
  class RacingD1 extends D1 {
    async batch(statements) {
      database.prepare("UPDATE cutover_source_state SET write_mode='frozen',freeze_operation_id='freeze:race',freeze_token='token-race' WHERE release_id='release-1'").run();
      return super.batch(statements);
    }
  }
  const d1 = new RacingD1(database), adapter = new D1CutoverSourceAdapter(d1, "release-1", () => "unused-token");
  await assert.rejects(() => adapter.guardedMutation({ mutation:d1.prepare("INSERT INTO items(id,value) VALUES (?,?)").bind("item-1","one"), householdId:"house-1", sourceTable:"items", sourceId:"item-1", payload:'{"value":"one"}', deleted:false }), /fenced/);
  assert.equal(database.prepare("SELECT count(*) value FROM items").get().value, 0);
  assert.equal(database.prepare("SELECT count(*) value FROM cutover_change_log").get().value, 0);
  assert.equal(database.prepare("SELECT high_water FROM cutover_source_state").get().high_water, 0);
});

test("D1 aborts zero-row and multi-row domain mutations and isolates release sequences", async () => {
  const database = new DatabaseSync(":memory:"); database.exec(d1Migration); database.exec("CREATE TABLE items(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  database.exec("INSERT INTO items VALUES('item-a','one'),('item-b','two'); INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES ('release-1','writable',0,1),('release-2','writable',0,1)");
  const d1 = new D1(database);
  for (const mutation of [d1.prepare("UPDATE items SET value='none' WHERE id='missing'").bind(), d1.prepare("UPDATE items SET value='many'").bind()]) {
    const adapter = new D1CutoverSourceAdapter(d1, "release-1", () => "unused-token");
    await assert.rejects(() => adapter.guardedMutation({ mutation, householdId:"house-1", sourceTable:"items", sourceId:"item-a", payload:'{"value":"changed"}', deleted:false }), /cardinality/);
  }
  assert.deepEqual(database.prepare("SELECT id,value FROM items ORDER BY id").all().map((row) => ({ ...row })), [{ id:"item-a",value:"one" },{ id:"item-b",value:"two" }]);
  assert.equal(database.prepare("SELECT count(*) value FROM cutover_change_log").get().value, 0);
  for (const release of ["release-1","release-2"]) {
    const adapter = new D1CutoverSourceAdapter(d1, release, () => "unused-token");
    await adapter.guardedMutation({ mutation:d1.prepare("UPDATE items SET value=value WHERE id='item-a'").bind(), householdId:"house-1", sourceTable:"items", sourceId:"item-a", payload:'{"value":"one"}', deleted:false });
  }
  assert.deepEqual(database.prepare("SELECT release_id,sequence FROM cutover_change_log ORDER BY release_id").all().map((row) => ({ ...row })), [{ release_id:"release-1",sequence:1 },{ release_id:"release-2",sequence:1 }]);
});

test("D1 commitFreeze and unfreeze are token-bound, durable, and idempotent", async () => {
  const database=new DatabaseSync(":memory:"); database.exec(d1Migration); database.prepare("INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES('release-1','writable',2,1)").run(); markDigestReady(database);
  const adapter=new D1CutoverSourceAdapter(new D1(database),"release-1",()=>"token-fixed"); await adapter.freeze({expectedHighWater:2,operationId:"freeze:commit"});
  await assert.rejects(()=>adapter.commitFreeze("wrong-token"),/freeze/); await adapter.commitFreeze("token-fixed"); await adapter.commitFreeze("token-fixed");
  assert.equal(database.prepare("SELECT write_mode FROM cutover_source_state").get().write_mode,"committed");
  await assert.rejects(()=>adapter.unfreeze("token-fixed"),/committed/);
  const db2=new DatabaseSync(":memory:"); db2.exec(d1Migration); db2.prepare("INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES('release-1','writable',2,1)").run(); markDigestReady(db2); const adapter2=new D1CutoverSourceAdapter(new D1(db2),"release-1",()=>"token-two"); await adapter2.freeze({expectedHighWater:2,operationId:"freeze:undo"}); await adapter2.unfreeze("token-two"); await adapter2.unfreeze("token-two"); assert.equal(db2.prepare("SELECT write_mode FROM cutover_source_state").get().write_mode,"writable");
});

test("D1 rejects orphan and conflicting freeze completion operations", async()=>{
  const database=new DatabaseSync(":memory:"); database.exec(d1Migration); database.prepare("INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES('release-1','writable',2,1)").run(); markDigestReady(database);
  assert.throws(()=>database.prepare("INSERT INTO cutover_source_operations(release_id,kind,operation_id,token,expected_high_water,high_water,status,created_at) VALUES('release-1','freeze_commit','commit:orphan','orphan-token',2,2,'committed',1)").run(),/state|freeze/i);
  assert.throws(()=>database.prepare("INSERT INTO cutover_source_operations(release_id,kind,operation_id,token,expected_high_water,high_water,status,created_at) VALUES('release-1','rollback_apply','unfreeze:orphan','orphan-token',2,2,'applied',1)").run(),/state|freeze/i);
  const adapter=new D1CutoverSourceAdapter(new D1(database),"release-1",()=>"token-fixed"); await adapter.freeze({expectedHighWater:2,operationId:"freeze:real"});
  assert.throws(()=>database.prepare("INSERT INTO cutover_source_operations(release_id,kind,operation_id,token,expected_high_water,high_water,status,created_at) VALUES('release-1','freeze_commit','commit:freeze:real','wrong-token',2,2,'committed',1)").run(),/state|freeze/i);
  await adapter.commitFreeze("token-fixed"); assert.throws(()=>database.prepare("DELETE FROM cutover_source_operations WHERE kind='freeze_commit'").run(),/immutable/); await adapter.commitFreeze("token-fixed");
});

test("D1 unfreeze replay requires authoritative writable state joined to its operation", async()=>{
  const database=new DatabaseSync(":memory:"); database.exec(d1Migration); database.prepare("INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES('release-1','writable',2,1)").run(); markDigestReady(database); const adapter=new D1CutoverSourceAdapter(new D1(database),"release-1",()=>"token-fixed"); await adapter.freeze({expectedHighWater:2,operationId:"freeze:real"}); await adapter.unfreeze("token-fixed");
  database.prepare("UPDATE cutover_source_state SET write_mode='frozen',freeze_operation_id='freeze:other',freeze_token='other-token' WHERE release_id='release-1'").run();
  await assert.rejects(()=>adapter.unfreeze("token-fixed"),/state|unfreeze/);
});

test("Postgres transition adapter only returns server-built shadow, evidence and durable transition", async()=>{
  const hash="a".repeat(64), shadow={sourceChecksum:hash,targetChecksum:hash,sampleCount:5,observedRows:2,mismatchCount:0,startedAt:1000,endedAt:62000};
  const transition={operationId:"transition:3:2",freezeToken:"freeze-token",highWater:2,fence:3,evidenceDigest:hash};
  const db={query:async(sql)=>{if(sql.includes("finalize_cutover_shadow"))return{rows:[{shadow}]};if(sql.includes("load_cutover_evidence"))return{rows:[{evidence:{digest:hash,nonce:"abcdefghijklmnopqrstuv",releaseId:"release-1"}}]};if(sql.includes("transition_cutover_exact"))return{rows:[{manifest:transition}]};if(sql.includes("load_cutover_transition"))return{rows:[{manifest:transition}]};if(sql.includes("cutover_mode"))return{rows:[{mode:"postgres"}]};return{rows:[]}}};
  const adapter=new PostgresCutoverStateAdapter(db,"release-1",async()=>{}); assert.deepEqual(await adapter.shadow({highWater:2,fence:3,owner:"runner",freezeToken:"freeze-token",sourceChecksum:hash,sourceRowCount:2,heartbeat:async()=>{}}),shadow); assert.deepEqual(await adapter.verifyEvidence({freezeHighWater:2,finalHighWater:2,fence:3,shadow}),{digest:hash,nonce:"abcdefghijklmnopqrstuv",releaseId:"release-1"}); assert.equal(await adapter.mode(),"postgres"); assert.deepEqual(await adapter.transitionAtomically({operationId:"transition:3:2",freezeToken:"freeze-token",highWater:2,fence:3,evidenceDigest:hash,evidenceNonce:"abcdefghijklmnopqrstuv",releaseId:"release-1"}),transition); assert.deepEqual(await adapter.loadTransition(),transition);
});

test("transition SQL pins signed projection and terminal delta before atomic mode switch",()=>{
  assert.doesNotMatch(migration,/CREATE FUNCTION nearyou\.load_cutover_shadow/); assert.match(migration,/cutover_shadow_observations o WHERE o\.release_id=p_release AND o\.status='complete'/); assert.match(migration,/o\.evidence_digest=p_digest/); assert.match(migration,/delta_cursor=delta_final_high_water/); assert.match(migration,/nonce_hash=encode\(nearyou_crypto\.digest\(p_nonce/); assert.match(migration,/INSERT INTO nearyou\.cutover_operation_manifests\(kind,operation_id,release_id,fence,manifest\)[\s\S]*'transition'/);
});

test("canonical row digest transport is stable for non-ASCII rows and tombstones",async()=>{
 const live={tenant:"家",table:"évents",id:"ß",sequence:4,deleted:false,payload:{"é":"雪"}}, deleted={...live,id:"deleted",sequence:5,deleted:true,payload:null}; const one=await canonicalCutoverRowTransport(live),two=await canonicalCutoverRowTransport(deleted); assert.match(one.digest,/^[a-f0-9]{64}$/); assert.notEqual(one.digest,two.digest); assert.deepEqual(await canonicalCutoverStateDigest([two,one]),await canonicalCutoverStateDigest([one,two])); assert.equal((await canonicalCutoverStateDigest([two])).checksum,(await canonicalCutoverStateDigest([])).checksum); assert.notEqual((await canonicalCutoverStateDigest([one])).checksum,(await canonicalCutoverStateDigest([])).checksum);
});

test("Postgres stores verified fixed row digests and hashes ordered decoded digest bytes",()=>{assert.match(migration,/canonical_row_digest bytea/);assert.match(migration,/octet_length\(canonical_row_digest\)=32/);assert.match(migration,/digest\(canonical_bytes,'sha256'\)/);assert.match(migration,/digest\(coalesce\(string_agg\(canonical_row_digest,'' ORDER BY/);});
test("page and delta transport contracts reject malformed or swapped rows before DML",()=>{assert.equal((migration.match(/jsonb_typeof\(p_transports\)<>'array'/g)||[]).length,2);assert.equal((migration.match(/canonical_row_digest=excluded\.canonical_row_digest/g)||[]).length,2);assert.match(migration,/HAVING count\(\*\)=count\(canonical_row_digest\)/);assert.match(adapterSource,/apply_cutover_page\([^\n]+\$12::jsonb/);assert.match(adapterSource,/apply_cutover_delta\([^\n]+\$14::jsonb/);});
test("both SQL paths require exact typed transport schema and reconstruct lexical page bytes",()=>{assert.equal((migration.match(/ARRAY\['canonicalBase64','deleted','digest','key'\]::text\[\]/g)||[]).length,2);assert.equal((migration.match(/jsonb_typeof\(transport->'deleted'\)<>'boolean'/g)||[]).length,2);assert.equal((migration.match(/replace\(encode\(row_bytes,'base64'\),E'\\n',''\)<>transport->>'canonicalBase64'/g)||[]).length,2);assert.equal((migration.match(/reconstructed:=reconstructed\|\|CASE WHEN ordinal>1/g)||[]).length,2);assert.match(migration,/IF reconstructed<>canonical_bytes THEN RETURN NULL/);assert.match(migration,/IF reconstructed<>bytes THEN RETURN NULL/);assert.doesNotMatch(migration,/convert_from\(row_bytes,'UTF8'\)::jsonb<>jsonb_build_array/);});
test("shadow uses durable server-timed begin observe finalize operations",()=>{for(const name of ["begin_cutover_shadow","observe_cutover_shadow","finalize_cutover_shadow"])assert.match(migration,new RegExp(`CREATE FUNCTION nearyou\\.${name}`));assert.match(migration,/statement_timestamp\(\)-o\.started_at<interval '60 seconds'/);assert.match(migration,/observation_count<3/);assert.match(migration,/current_checksum<>o\.state_checksum OR current_count<>o\.row_count/);assert.match(migration,/delta_freeze_token=p_freeze/);});
test("Postgres is authoritative for signed inventory page grants and completion",()=>{for(const name of ["record_inventory_verified_claim","consume_inventory_page_grant","consume_inventory_completion"])assert.match(migration,new RegExp(`CREATE FUNCTION nearyou\\.${name}`));assert.match(migration,/canonical_claims text NOT NULL/);assert.match(migration,/octet_length\(p_canonical\)>262144/);assert.match(migration,/digest\(p_canonical,'sha256'\)/);assert.match(migration,/page_ordinal bigint NOT NULL/);assert.match(migration,/string_agg\(claims_digest,'' ORDER BY pass,table_index,page_ordinal\)/);assert.match(migration,/REVOKE ALL ON nearyou\.inventory_verified_claims,nearyou\.inventory_page_grants,nearyou\.inventory_completion_attestations FROM PUBLIC,nearyou_cutover_runner,nearyou_release_verifier/);assert.doesNotMatch(migration,/GRANT SELECT,INSERT ON nearyou\.inventory_verified_claims TO nearyou_release_verifier/);assert.match(migration,/GRANT EXECUTE ON FUNCTION nearyou\.record_inventory_verified_claim[\s\S]*TO nearyou_release_verifier/);});
test("inventory authority tables use executable PostgreSQL ownership statements",()=>{for(const table of ["inventory_verified_claims","inventory_page_grants","inventory_completion_attestations"])assert.match(migration,new RegExp(`ALTER TABLE nearyou\\.${table} OWNER TO nearyou_cutover_policy_owner;`));assert.doesNotMatch(migration,/ALTER TABLE nearyou\.inventory_verified_claims,/);});
test("verified inventory claims recover an exact committed response without admitting nonce conflicts",()=>{assert.match(migration,/ON CONFLICT DO NOTHING; IF FOUND THEN RETURN true; END IF;/);assert.match(migration,/claims_digest=p_digest AND purpose=p_purpose[\s\S]*nonce_hash=p_nonce_hash/);});
test("D1 digest bootstrap is resumable and leaves partial releases fenced",async()=>{
 class CommitThenLoseD1 extends D1 { constructor(db){super(db);this.lose=true} async batch(statements){const value=await super.batch(statements);if(this.lose){this.lose=false;throw new Error("lost response")}return value} }
 const database=new DatabaseSync(":memory:");database.exec(d1Migration);database.exec("CREATE TABLE domain_rows(id TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO domain_rows VALUES('row-1','v1'),('row-2','v2'),('row-3','v3')");database.prepare("INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES('seeded-release','writable',0,1)").run();for(let sequence=1;sequence<=3;sequence++){database.prepare("INSERT INTO cutover_change_log VALUES('seeded-release',?,'house-1','domain_rows',?,0,?,1)").run(sequence,`row-${sequence}`,JSON.stringify({value:`v${sequence}`}));database.prepare("UPDATE cutover_source_state SET high_water=?,digest_status='pending' WHERE release_id='seeded-release'").run(sequence)}const adapter=new D1CutoverSourceAdapter(new D1(database),"seeded-release",()=>"freeze-token");await adapter.beginBootstrap({expectedHighWater:3,operationId:"bootstrap:seeded"});await assert.rejects(()=>adapter.freeze({expectedHighWater:3,operationId:"freeze:blocked"}),/high-water/);await assert.rejects(()=>adapter.guardedMutation({mutation:new D1(database).prepare("INSERT INTO domain_rows VALUES(?,?)").bind("blocked","v"),householdId:"house-1",sourceTable:"domain_rows",sourceId:"blocked",payload:'{"value":"v"}',deleted:false}),/frozen|writable/);
 const rows=[1,2,3].map(sequence=>({tenant:"house-1",table:"domain_rows",id:`row-${sequence}`,sequence,deleted:false,payload:{value:`v${sequence}`}}));const lostPage=new D1CutoverSourceAdapter(new CommitThenLoseD1(database),"seeded-release",()=>"freeze-token");await assert.rejects(()=>lostPage.applyBootstrapNextPage({operationId:"bootstrap:seeded",from:0,limit:2}),/lost response/);assert.equal((await adapter.applyBootstrapNextPage({operationId:"bootstrap:seeded",from:0,limit:2})).cursor,2);
 assert.throws(()=>database.prepare("UPDATE cutover_digest_bootstrap_source SET payload='{}' WHERE release_id='seeded-release' AND sequence=1").run(),/immutable/);assert.throws(()=>database.prepare("DELETE FROM cutover_digest_bootstrap_source WHERE release_id='seeded-release' AND sequence=1").run(),/immutable/);assert.throws(()=>database.prepare("INSERT INTO cutover_digest_bootstrap_source VALUES('seeded-release','bootstrap:seeded',4,'house-1','domain_rows','late',0,'{}')").run(),/sealed/);assert.throws(()=>database.prepare("UPDATE cutover_digest_bootstrap_assertions SET high_water=2 WHERE release_id='seeded-release'").run(),/immutable/);assert.throws(()=>database.prepare("DELETE FROM cutover_digest_bootstrap_assertions WHERE release_id='seeded-release'").run(),/immutable/);
 for(const sql of ["UPDATE cutover_digest_bootstrap SET status='populating' WHERE release_id='seeded-release'","UPDATE cutover_digest_bootstrap SET operation_id='bootstrap:forged' WHERE release_id='seeded-release'","UPDATE cutover_digest_bootstrap SET high_water=4 WHERE release_id='seeded-release'","UPDATE cutover_digest_bootstrap SET source_count=4 WHERE release_id='seeded-release'","UPDATE cutover_digest_bootstrap SET cursor=0 WHERE release_id='seeded-release'"])assert.throws(()=>database.prepare(sql).run(),/immutable|lifecycle/);
 const before={cursor:database.prepare("SELECT cursor FROM cutover_digest_bootstrap WHERE release_id='seeded-release'").get().cursor,count:database.prepare("SELECT count(*) count FROM cutover_source_rows WHERE release_id='seeded-release'").get().count};await assert.rejects(()=>adapter.applyBootstrapNextPage({operationId:"bootstrap:seeded",from:1,limit:2}),/cursor/);assert.deepEqual({cursor:database.prepare("SELECT cursor FROM cutover_digest_bootstrap WHERE release_id='seeded-release'").get().cursor,count:database.prepare("SELECT count(*) count FROM cutover_source_rows WHERE release_id='seeded-release'").get().count},before);await adapter.applyBootstrapNextPage({operationId:"bootstrap:seeded",from:2,limit:2});
 const expected=await canonicalCutoverStateDigest(await Promise.all(rows.map(canonicalCutoverRowTransport)));const lostFinish=new D1CutoverSourceAdapter(new CommitThenLoseD1(database),"seeded-release",()=>"freeze-token");await assert.rejects(()=>lostFinish.finishBootstrap("bootstrap:seeded"),/lost response/);assert.deepEqual(await adapter.finishBootstrap("bootstrap:seeded"),expected);assert.deepEqual({...database.prepare("SELECT write_mode,digest_status,digest_index_version,source_row_count FROM cutover_source_state WHERE release_id='seeded-release'").get()},{write_mode:"writable",digest_status:"ready",digest_index_version:3,source_row_count:3});
 assert.throws(()=>database.prepare("UPDATE cutover_digest_bootstrap SET status='running' WHERE release_id='seeded-release'").run(),/lifecycle/);assert.throws(()=>database.prepare("UPDATE cutover_digest_bootstrap SET manifest_checksum=? WHERE release_id='seeded-release'").run("f".repeat(64)),/lifecycle/);
 await adapter.guardedMutation({mutation:new D1(database).prepare("INSERT INTO domain_rows VALUES(?,?)").bind("row-4","v4"),householdId:"house-1",sourceTable:"domain_rows",sourceId:"row-4",payload:'{"value":"v4"}',deleted:false});database.prepare("INSERT INTO cutover_source_state(release_id,write_mode,high_water,updated_at) VALUES('partial-release','writable',0,1)").run();for(let sequence=1;sequence<=2;sequence++){database.prepare("INSERT INTO cutover_change_log VALUES('partial-release',?,'house-1','domain_rows',?,0,?,1)").run(sequence,`partial-${sequence}`,JSON.stringify({value:`p${sequence}`}));database.prepare("UPDATE cutover_source_state SET high_water=?,digest_status='pending' WHERE release_id='partial-release'").run(sequence)}const partial=new D1CutoverSourceAdapter(new D1(database),"partial-release",()=>"x");await partial.beginBootstrap({expectedHighWater:2,operationId:"bootstrap:partial"});await partial.applyBootstrapNextPage({operationId:"bootstrap:partial",from:0,limit:1});await assert.rejects(()=>partial.finishBootstrap("bootstrap:partial"),/incomplete/);assert.equal(database.prepare("SELECT write_mode FROM cutover_source_state WHERE release_id='partial-release'").get().write_mode,"bootstrapping");
});
