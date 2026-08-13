import { readFile, writeFile } from "node:fs/promises";

const HASH=/^[a-f0-9]{64}$/,ID=/^rel_[A-Za-z0-9_-]{8,100}$/;
const top=["accessibility","artifact","canary","endedAt","load","media","releaseId","restore","schemaChecksum","security","startedAt"];
const exact=(value:unknown,keys:string[])=>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join()!==[...keys].sort().join())throw new Error("evidence invalid");return value as Record<string,unknown>};
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const artifact=(v:unknown,keys:string[])=>{const o=exact(v,["artifact",...keys]);if(!HASH.test(String(o.artifact)))throw new Error("evidence invalid");return o};
export function validateCanaryWindow(startedAt:number,endedAt:number,heartbeats:number){return integer(startedAt)&&integer(endedAt)&&endedAt-startedAt>=86_400_000&&integer(heartbeats,1440,2000)}
export function buildOperationalEvidence(input:unknown){
 const o=exact(input,top);if(!ID.test(String(o.releaseId))||!HASH.test(String(o.artifact))||!HASH.test(String(o.schemaChecksum))||!integer(o.startedAt)||!integer(o.endedAt)||Number(o.endedAt)<=Number(o.startedAt))throw new Error("evidence invalid");
 for(const name of ["load","restore","accessibility","security","media","canary"])if(!o[name])throw new Error("evidence incomplete");
 const load=artifact(o.load,["requests","p95Ms","maxP95Ms","errorRateBps","maxErrorRateBps"]),restore=artifact(o.restore,["targetTime","restoredAt","checksum","rowCount"]),accessibility=artifact(o.accessibility,["pages","violations"]),security=artifact(o.security,["dependencyFindings","secretFindings","sastFindings"]),media=artifact(o.media,["story","legacy","workerOidc"]),canary=artifact(o.canary,["heartbeatCount","deadLetters","completedJobs","failedJobs"]);
 if(![load.requests,load.p95Ms,load.maxP95Ms,load.errorRateBps,load.maxErrorRateBps].every(v=>integer(v))||Number(load.requests)<1||Number(load.p95Ms)>Number(load.maxP95Ms)||Number(load.errorRateBps)>Number(load.maxErrorRateBps))throw new Error("evidence threshold failed");
 if(!HASH.test(String(restore.checksum))||![restore.targetTime,restore.restoredAt,restore.rowCount].every(v=>integer(v))||Number(restore.rowCount)<1)throw new Error("evidence invalid");
 if(!integer(accessibility.pages,1,100)||accessibility.violations!==0||![security.dependencyFindings,security.secretFindings,security.sastFindings].every(v=>v===0)||media.story!==true||media.legacy!==true||media.workerOidc!==true)throw new Error("evidence threshold failed");
 if(!validateCanaryWindow(Number(o.startedAt),Number(o.endedAt),Number(canary.heartbeatCount))||canary.deadLetters!==0||!integer(canary.completedJobs,1)||canary.failedJobs!==0)throw new Error("evidence threshold failed");
 return{kind:"nearyou-operational-evidence-v1" as const,...o} as const;
}

async function main(){const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error("operational evidence input/output required");const raw=await readFile(input,"utf8");if(Buffer.byteLength(raw)>262144)throw new Error("evidence invalid");const evidence=buildOperationalEvidence(JSON.parse(raw));await writeFile(output,`${JSON.stringify(evidence)}\n`,{flag:"wx"});}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(()=>{process.stderr.write("operational evidence failed\n");process.exitCode=1});
