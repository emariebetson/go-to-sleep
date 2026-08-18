import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,readdirSync,writeFileSync} from "node:fs";
import {SITES_D1_OPERATION_BOOTSTRAP,splitD1Migration} from "../lib/sites-d1-forward-operation";
import {SITES_D1_PHASE_A_BOOTSTRAP} from "../lib/sites-d1-phase-a-operation";
import {SITES_D1_PHASE_A_ARTIFACT} from "../lib/sites-d1-phase-a-artifact.generated";
import {SITES_D1_PHASE_B_ARTIFACT} from "../lib/sites-d1-phase-b-artifact.generated";
import {SITES_D1_PHASE_C_ARTIFACT} from "../lib/sites-d1-phase-c-artifact.generated";

const root=new URL("../",import.meta.url);
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const canonical=(value:unknown)=>JSON.stringify(value);
const prefixFiles=readdirSync(new URL("drizzle",root)).filter(file=>/^00(?:0[0-9]|1[0-6])_.*\.sql$/.test(file)).sort();
const sourceFiles=readdirSync(new URL("drizzle",root)).filter(file=>/^00(?:1[7-9]|2[0-5])_.*\.sql$/.test(file)).sort();
const parseDb=new DatabaseSync(":memory:");
for(const file of prefixFiles)parseDb.exec(readFileSync(new URL(`drizzle/${file}`,root),"utf8"));

function completeStatements(sql:string){
 const statements:string[]=[];let buffer="";
 for(const line of sql.split(/\r?\n/)){
  if(/^\s*-->\s*statement-breakpoint\s*$/.test(line))continue;
  buffer+=`${line}\n`;
  if(!buffer.trimEnd().endsWith(";"))continue;
  try{parseDb.prepare(buffer);const statement=buffer.trim();if(statement){parseDb.exec(statement);statements.push(statement)}buffer=""}
  catch(error){const message=error instanceof Error?error.message:"";if(message==="incomplete input"||message==="statement has been finalized")continue;throw error}
 }
 if(buffer.trim())throw new Error("incomplete migration source");
 return statements;
}

const normalizedSources=sourceFiles.map(file=>{
 const url=new URL(`drizzle/${file}`,root),original=readFileSync(url,"utf8"),statements=completeStatements(original),sql=`${statements.join("\n--> statement-breakpoint\n")}\n`;
 if(process.argv.includes("--normalize-breakpoints"))writeFileSync(url,sql);
 else if(original!==sql)throw new Error(`migration breakpoints stale: ${file}`);
 return{id:file.replace(/\.sql$/, ""),sql};
});
const pending=readFileSync(new URL("docs/pending/0026_canary_entitlements.sql.disabled",root),"utf8").trim();
const source0026=`${pending}\n--> statement-breakpoint\nCREATE TRIGGER canary_entitlement_audit_update_guard BEFORE UPDATE ON canary_entitlement_audit BEGIN SELECT RAISE(ABORT,'canary entitlement audit immutable'); END;\n--> statement-breakpoint\nCREATE TRIGGER canary_entitlement_audit_delete_guard BEFORE DELETE ON canary_entitlement_audit BEGIN SELECT RAISE(ABORT,'canary entitlement audit immutable'); END;`;
const migrations=[...normalizedSources,{id:"0026_canary_entitlements",sql:source0026}].map(value=>({...value,sha256:hash(value.sql),statements:splitD1Migration(value.sql)}));

const schemaPath=process.env.D1_PHASE_A_SCHEMA_EVIDENCE;if(!schemaPath)throw new Error("forward schema evidence missing");
const raw=JSON.parse(readFileSync(schemaPath,"utf8")) as {body:{objects:{type:string;name:string;tableName:string;sql:string|null}[]}};
const providerObjects=[{type:"index",name:"sqlite_autoindex___appgarden_migrations_1",tableName:"__appgarden_migrations"},{type:"table",name:"__appgarden_migrations",tableName:"__appgarden_migrations"},{type:"table",name:"_cf_KV",tableName:"_cf_KV"},{type:"table",name:"sqlite_sequence",tableName:"sqlite_sequence"},{type:"table",name:"sqlite_stat1",tableName:"sqlite_stat1"}];
const providerIdentities=new Set(providerObjects.map(x=>`${x.type}\0${x.name}\0${x.tableName}`)),db=new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys=OFF");
for(const type of["table","index","trigger","view"])for(const x of raw.body.objects.filter(x=>x.type===type&&x.sql&&!providerIdentities.has(`${x.type}\0${x.name}\0${x.tableName}`)))db.exec(x.sql!);
for(const sql of SITES_D1_PHASE_A_BOOTSTRAP)db.exec(sql);for(const m of SITES_D1_PHASE_A_ARTIFACT.migrations)for(const sql of m.statements)db.exec(sql);
for(const sql of SITES_D1_PHASE_B_ARTIFACT.bootstrap)db.exec(sql);for(const m of SITES_D1_PHASE_B_ARTIFACT.migrations)for(const sql of m.statements)db.exec(sql);
for(const sql of SITES_D1_PHASE_C_ARTIFACT.bootstrap)db.exec(sql);for(const m of SITES_D1_PHASE_C_ARTIFACT.migrations)for(const sql of m.statements)db.exec(sql);
const checkpoints:Array<{head:string;objectCount:number;definitionsSha256:string;providerObjects:typeof providerObjects}>=[];
const capture=(head:string)=>{const rows=db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') ORDER BY type,name,tbl_name").all().filter(row=>!providerIdentities.has(`${row.type}\0${row.name}\0${row.tableName}`));checkpoints.push({head,objectCount:rows.length,definitionsSha256:hash(canonical(rows)),providerObjects})};
capture("0016");for(const sql of SITES_D1_OPERATION_BOOTSTRAP)db.exec(sql);capture("0016+operation");
for(const migration of migrations){for(const statement of migration.statements)db.exec(statement);capture(migration.id.slice(0,4))}
const artifact={version:1,migrations:migrations.map(({id,sha256,sql,statements})=>({id,sha256,sql,statements})),schemaCheckpoints:checkpoints};
const output=`// Generated by scripts/generate-sites-d1-forward-artifact.ts. Do not edit.\nexport const SITES_D1_FORWARD_ARTIFACT=${JSON.stringify(artifact)} as const;\n`;
const target=new URL("lib/sites-d1-forward-artifact.generated.ts",root);
if(process.argv.includes("--check")){if(readFileSync(target,"utf8")!==output)throw new Error("Sites D1 forward artifact stale")}else writeFileSync(target,output);
