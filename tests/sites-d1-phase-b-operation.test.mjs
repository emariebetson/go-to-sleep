import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import test from "node:test";
import {SITES_D1_PHASE_A_ARTIFACT} from "../lib/sites-d1-phase-a-artifact.generated.ts";
import {SITES_D1_PHASE_A_BOOTSTRAP} from "../lib/sites-d1-phase-a-operation.ts";
import {SITES_D1_PHASE_B_ARTIFACT} from "../lib/sites-d1-phase-b-artifact.generated.ts";
import {SitesD1PhaseBOperation,captureSitesD1PhaseBProbeBinding} from "../lib/sites-d1-phase-b-operation.ts";

class Bound{constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args}bind(...args){return new Bound(this.db,this.sql,args)}async all(){return{results:this.db.prepare(this.sql).all(...this.args).map(x=>({...x}))}}async first(){const x=this.db.prepare(this.sql).get(...this.args);return x?{...x}:null}async run(){return this.db.prepare(this.sql).run(...this.args)}}
class D1{constructor(db,lose=-1,before){this.db=db;this.lose=lose;this.before=before;this.calls=0}prepare(sql){return new Bound(this.db,sql)}async batch(xs){this.before?.(this.calls+1,this.db);this.db.exec("BEGIN");try{const out=[];for(const x of xs)out.push(await x.run());this.db.exec("COMMIT");this.calls++;if(this.calls===this.lose)throw new Error("lost response");return out}catch(e){if(this.db.isTransaction)this.db.exec("ROLLBACK");throw e}}}

function base(){
 const db=new DatabaseSync(":memory:"),schema=JSON.parse(readFileSync("/tmp/d1-convergence-schema-local.json","utf8")).body.objects;
 db.exec("PRAGMA foreign_keys=OFF");for(const type of["table","index","trigger","view"])for(const x of schema.filter(x=>x.type===type&&x.sql&&!x.name.startsWith("sqlite_")))db.exec(x.sql);
 for(const row of SITES_D1_PHASE_A_ARTIFACT.providerMigrationRows)db.prepare("INSERT INTO __appgarden_migrations VALUES(?,?,?)").run(row.id,row.name,row.applied_at);
 for(const sql of SITES_D1_PHASE_A_BOOTSTRAP)db.exec(sql);for(const m of SITES_D1_PHASE_A_ARTIFACT.migrations)for(const sql of m.statements)db.exec(sql);
 db.prepare("INSERT INTO nearyou_d1_phase_a_operations VALUES('0007-0009',?,?,?,?,'complete',?)").run("phase-a-operation","phase-a-release","a".repeat(64),1787000000000,1787000000000);
 for(const [i,m]of SITES_D1_PHASE_A_ARTIFACT.migrations.entries())db.prepare("INSERT INTO nearyou_d1_phase_a_migrations VALUES(?,?,?,?,?)").run("phase-a-operation",i+1,m.id,m.sha256,1787000000001+i);
 return db;
}
function seedAffected(db){
 db.prepare("INSERT INTO children(id,user_id,nickname,created_at,updated_at,pronunciation,household_id) VALUES('child-1','user-1','Kid',1,1,'alpha','house-1')").run();
 db.prepare("INSERT INTO child_profiles(id,household_id,legacy_child_id,nickname,normalized_nickname,created_at,updated_at,archived_at) VALUES('profile-1','house-1','child-1','Kid','kid',1,1,1)").run();
 db.prepare("INSERT INTO entitlements(id,household_id,plan_id,source,status,allowance_milliunits,remaining_milliunits,external_ref,valid_from,created_at,updated_at) VALUES('ent-1','house-1','nearsleep_free','test','active',1,1,'ref-1',1000,1,1)").run();
 db.prepare("INSERT INTO media_assets(id,household_id,owner_user_id,kind,status,byte_size,checksum,created_at,updated_at) VALUES('media-1','house-1','user-1','audio','ready',10,?,1,1)").run("a".repeat(64));
}
const digest=async value=>Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)))).toString("hex");
async function makeInput(sqlite){const probeBinding=await captureSitesD1PhaseBProbeBinding(new D1(sqlite));return{operationId:"phase-b-operation",releaseId:"phase-b-release",issuedAt:1787000001000,phaseAOperationId:"phase-a-operation",phaseAManifestSha256:"a".repeat(64),expectedProviderLedger:[...SITES_D1_PHASE_A_ARTIFACT.providerMigrationRows],phaseAMigrations:SITES_D1_PHASE_A_ARTIFACT.migrations.map(({id,sha256})=>({id,sha256})),phaseAPredecessor:SITES_D1_PHASE_B_ARTIFACT.phaseAPredecessor,probeContentSha256:await digest(probeBinding),probeAffectedSetSha256:await digest(probeBinding.stages),probeBinding,bootstrap:[...SITES_D1_PHASE_B_ARTIFACT.bootstrap],migrations:SITES_D1_PHASE_B_ARTIFACT.migrations.map(({id,sha256,sql})=>({id,sha256,sql})),schemaCheckpoints:[...SITES_D1_PHASE_B_ARTIFACT.schemaCheckpoints]}}

test("Phase B is atomic, resumable, and preserves provider and Phase A ledgers",async()=>{for(const lose of[-1,1,2,3,4,5]){const sqlite=base(),input=await makeInput(sqlite),provider=sqlite.prepare("SELECT * FROM __appgarden_migrations ORDER BY id").all(),phaseA=sqlite.prepare("SELECT * FROM nearyou_d1_phase_a_migrations ORDER BY ordinal").all();let db=new D1(sqlite,lose);if(lose>0){await assert.rejects(()=>new SitesD1PhaseBOperation(db).run(input),/lost response/);db=new D1(sqlite)}assert.equal((await new SitesD1PhaseBOperation(db).run(input)).status,"complete");assert.deepEqual(sqlite.prepare("SELECT * FROM __appgarden_migrations ORDER BY id").all(),provider);assert.deepEqual(sqlite.prepare("SELECT * FROM nearyou_d1_phase_a_migrations ORDER BY ordinal").all(),phaseA);assert.equal(sqlite.prepare("SELECT count(*) n FROM nearyou_d1_phase_b_migrations").get().n,3)}});

test("Phase B rejects identity substitution and immediate Phase A ledger drift",async()=>{const sqlite=base(),input=await makeInput(sqlite),db=new D1(sqlite,-1,(call,s)=>{if(call===2)s.prepare("UPDATE nearyou_d1_phase_a_operations SET manifest_sha256=? WHERE phase='0007-0009'").run("b".repeat(64))});await assert.rejects(()=>new SitesD1PhaseBOperation(db).run(input));assert.equal(sqlite.prepare("SELECT count(*) n FROM nearyou_d1_phase_b_migrations").get().n,0)});

test("Phase B reruns and rejects an ordered probe affected-set mismatch before writes",async()=>{const sqlite=base(),input=await makeInput(sqlite);input.probeBinding={...input.probeBinding,stages:input.probeBinding.stages.map((x,i)=>i?x:{...x,rowCount:x.rowCount+1})};await assert.rejects(()=>new SitesD1PhaseBOperation(new D1(sqlite)).run(input),/probe drift/);assert.equal(sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='nearyou_d1_phase_b_operations'").get().n,0)});

for(const scenario of[
 {name:"0010",call:2,inject:db=>db.prepare("UPDATE children SET pronunciation='changed' WHERE id='child-1'").run(),absent:"pronunciation",table:"child_profiles",ledger:0},
 {name:"0011",call:3,inject:db=>db.prepare("UPDATE entitlements SET valid_from=2000 WHERE id='ent-1'").run(),absent:"billing_period_start",table:"entitlements",ledger:1},
 {name:"0012",call:4,inject:db=>db.prepare("UPDATE media_assets SET byte_size=11 WHERE id='media-1'").run(),absent:"deletion_status",table:"sleep_sessions",ledger:2},
])test(`${scenario.name} exact in-batch affected-set assertion aborts injected projection drift`,async()=>{const sqlite=base();seedAffected(sqlite);const input=await makeInput(sqlite),db=new D1(sqlite,-1,(call,database)=>{if(call===scenario.call)scenario.inject(database)});await assert.rejects(()=>new SitesD1PhaseBOperation(db).run(input));assert.equal(sqlite.prepare(`SELECT count(*) n FROM pragma_table_info('${scenario.table}') WHERE name=?`).get(scenario.absent).n,0);assert.equal(sqlite.prepare("SELECT count(*) n FROM nearyou_d1_phase_b_migrations").get().n,scenario.ledger)});

test("Phase B route is independently literal-dark and authenticates before parsing",()=>{const source=readFileSync(new URL("../app/api/internal/sites-d1-phase-b/route.ts",import.meta.url),"utf8"),auth=source.indexOf("createGoogleServiceIdentityAuthenticator"),parse=source.indexOf("request.json()"),op=source.indexOf("new SitesD1PhaseBOperation");assert.match(source,/ROUTE_ENABLED=false as const/);assert.match(source,/TEMPORARY_ACTIVATION_ENABLED=false as const/);assert.ok(auth<parse&&parse<op);assert.doesNotMatch(source,/sites-d1-forward|0017|0026/)});
