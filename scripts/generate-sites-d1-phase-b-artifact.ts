import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,writeFileSync} from "node:fs";
import {SITES_D1_PHASE_A_ARTIFACT} from "../lib/sites-d1-phase-a-artifact.generated";
import {SITES_D1_PHASE_A_BOOTSTRAP} from "../lib/sites-d1-phase-a-operation";

const root=new URL("../",import.meta.url);
const canonical=(value:unknown)=>JSON.stringify(value);
const sha256=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const splitMigration=(sql:string)=>sql.split(/\s*-->\s*statement-breakpoint\s*/g).map(value=>value.trim()).filter(Boolean);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const exactKeys=(value:Record<string,unknown>,keys:string[])=>canonical(Object.keys(value).sort())===canonical([...keys].sort());
const provider=new Set(["index\0sqlite_autoindex___appgarden_migrations_1\0__appgarden_migrations","table\0__appgarden_migrations\0__appgarden_migrations","table\0_cf_KV\0_cf_KV","table\0sqlite_sequence\0sqlite_sequence","table\0sqlite_stat1\0sqlite_stat1"]);
const bootstrap=[
  "CREATE TABLE nearyou_d1_phase_b_operations (operation_id TEXT PRIMARY KEY NOT NULL, release_id TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, probe_content_sha256 TEXT NOT NULL, probe_affected_set_sha256 TEXT NOT NULL, status TEXT DEFAULT 'running' NOT NULL CHECK(status IN ('running','complete')), created_at INTEGER NOT NULL, completed_at INTEGER)",
  "CREATE TABLE nearyou_d1_phase_b_migrations (migration_id TEXT PRIMARY KEY NOT NULL, operation_id TEXT NOT NULL, source_sha256 TEXT NOT NULL, schema_sha256 TEXT NOT NULL, object_count INTEGER NOT NULL, applied_at INTEGER NOT NULL, FOREIGN KEY(operation_id) REFERENCES nearyou_d1_phase_b_operations(operation_id))",
  "CREATE TRIGGER nearyou_d1_phase_b_operations_immutable BEFORE UPDATE ON nearyou_d1_phase_b_operations WHEN NOT (OLD.status='running' AND NEW.status='complete' AND NEW.operation_id IS OLD.operation_id AND NEW.release_id IS OLD.release_id AND NEW.manifest_sha256 IS OLD.manifest_sha256 AND NEW.probe_content_sha256 IS OLD.probe_content_sha256 AND NEW.probe_affected_set_sha256 IS OLD.probe_affected_set_sha256 AND NEW.created_at IS OLD.created_at AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'phase_b_operation_immutable'); END",
  "CREATE TRIGGER nearyou_d1_phase_b_migrations_immutable BEFORE UPDATE ON nearyou_d1_phase_b_migrations BEGIN SELECT RAISE(ABORT,'phase_b_migration_immutable'); END",
  "CREATE TRIGGER nearyou_d1_phase_b_operations_delete_guard BEFORE DELETE ON nearyou_d1_phase_b_operations BEGIN SELECT RAISE(ABORT,'phase_b_operation_immutable'); END",
  "CREATE TRIGGER nearyou_d1_phase_b_migrations_delete_guard BEFORE DELETE ON nearyou_d1_phase_b_migrations BEGIN SELECT RAISE(ABORT,'phase_b_migration_immutable'); END",
] as const;

const schemaPath=process.env.D1_PHASE_A_SCHEMA_EVIDENCE,probePath=process.env.D1_PHASE_B_PROBE_EVIDENCE;
if(!schemaPath||!probePath)throw new Error("Phase B evidence paths missing");
const schema=JSON.parse(readFileSync(schemaPath,"utf8")) as unknown,probeBytes=readFileSync(probePath),probe=JSON.parse(probeBytes.toString("utf8")) as unknown;
if(!plain(schema)||!plain(schema.body)||!Array.isArray(schema.body.objects))throw new Error("Phase A schema evidence invalid");
if(!plain(probe)||!exactKeys(probe,["audience","body","issuer","observedAt","principal","release","subject"])||!plain(probe.body)||!exactKeys(probe.body,["stages","version"])||probe.body.version!==1||!Array.isArray(probe.body.stages)||probe.body.stages.length!==13)throw new Error("Phase B probe evidence invalid");
const stages=probe.body.stages.map(row=>{
  if(!plain(row)||!exactKeys(row,["stage","rowCount","violationCount","projectionSha256"])||typeof row.stage!=="string"||!Number.isSafeInteger(row.rowCount)||!Number.isSafeInteger(row.violationCount)||typeof row.projectionSha256!=="string"||!/^[a-f0-9]{64}$/.test(row.projectionSha256))throw new Error("Phase B probe stage invalid");
  return row as {stage:string;rowCount:number;violationCount:number;projectionSha256:string};
});
const db=new DatabaseSync(":memory:");db.exec("PRAGMA foreign_keys=OFF");
type ObjectRow={type:string;name:string;tableName:string;sql:string|null};
const objects=(schema.body.objects as unknown[]).map(value=>value as ObjectRow);
for(const type of["table","index","trigger","view"])for(const value of objects.filter(row=>row.type===type&&row.sql!==null&&!provider.has(`${row.type}\0${row.name}\0${row.tableName}`)))db.exec(value.sql!);
for(const statement of SITES_D1_PHASE_A_BOOTSTRAP)db.exec(statement);
for(const migration of SITES_D1_PHASE_A_ARTIFACT.migrations)for(const statement of migration.statements)db.exec(statement);
const definitions=()=>db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name,tbl_name").all().map(row=>({...row})).filter(row=>!provider.has(`${row.type}\0${row.name}\0${row.tableName}`));
const checkpoint=()=>{const rows=definitions();return{objectCount:rows.length,definitionsSha256:sha256(canonical(rows))}};
const phaseAPredecessor=SITES_D1_PHASE_A_ARTIFACT.schemaCheckpoints.at(-1)!;
if(canonical(checkpoint())!==canonical({objectCount:phaseAPredecessor.objectCount,definitionsSha256:phaseAPredecessor.definitionsSha256}))throw new Error("Phase A 0009 checkpoint mismatch");
const schemaCheckpoints=[{head:"0009",...checkpoint()}];for(const statement of bootstrap)db.exec(statement);schemaCheckpoints.push({head:"0009+phase-b-operation",...checkpoint()});
const ids=["0010_child_profile_pronunciation","0011_household_billing_accounts","0012_nearsleep_library_privacy"] as const;
const migrations=ids.map(id=>{const source=readFileSync(new URL(`drizzle/${id}.sql`,root),"utf8"),statements=splitMigration(source),sql=`${statements.join("\n--> statement-breakpoint\n")}\n`;for(const statement of statements)db.exec(statement);schemaCheckpoints.push({head:id.slice(0,4),...checkpoint()});return{id,sha256:sha256(sql),sql,statements}});
const artifact={version:1,privateInputSha256:{probes:sha256(probeBytes)},phaseAPredecessor,probeContentSha256:sha256(canonical(probe.body)),probeAffectedSetSha256:sha256(canonical(stages)),probeBinding:{version:1,stages},bootstrap,migrations,schemaCheckpoints};
const output=`// Generated by scripts/generate-sites-d1-phase-b-artifact.ts from exact Phase A and private probe hashes. Do not edit.\nexport const SITES_D1_PHASE_B_ARTIFACT=${canonical(artifact)} as const;\n`,target=new URL("lib/sites-d1-phase-b-artifact.generated.ts",root);
if(process.argv.includes("--check")){if(readFileSync(target,"utf8")!==output)throw new Error("Sites D1 Phase B artifact stale")}else writeFileSync(target,output);
