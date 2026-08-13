import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const allowed=new Set(["load","restore","accessibility","security","media","canary"]);
async function main(){const [gate,input,output]=process.argv.slice(2);if(!gate||!allowed.has(gate)||!input||!output)throw new Error("gate configuration missing");for(const required of ["RELEASE_ID","EVIDENCE_PRINCIPAL"])if(!process.env[required])throw new Error("gate credentials missing");const raw=await readFile(input,"utf8");if(Buffer.byteLength(raw)>262144)throw new Error("gate input invalid");const result=JSON.parse(raw),artifact=createHash("sha256").update(raw).digest("hex");await writeFile(output,JSON.stringify({gate,releaseId:process.env.RELEASE_ID,principal:process.env.EVIDENCE_PRINCIPAL,artifact,result})+"\n",{flag:"wx"});}
main().catch(()=>{process.stderr.write("operational gate failed\n");process.exitCode=1});
