import assert from "node:assert/strict";
import test from "node:test";
import {createPostgresInventoryEvidenceVerifier} from "../lib/inventory-evidence.ts";

const b64=value=>Buffer.from(value).toString("base64url");
async function fixture(overrides={}){
 const keys=await crypto.subtle.generateKey({name:"RSA-PSS",modulusLength:overrides.modulusLength??3072,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
 const fingerprint=Buffer.from(await crypto.subtle.digest("SHA-256",await crypto.subtle.exportKey("spki",keys.publicKey))).toString("hex");
 const pg={calls:[],async query(sql,args){this.calls.push([sql,args]);return{rows:[{accepted:true}]}}};
 const trust={principal:"ci@example.test",keyId:"inventory-key",version:1,fingerprint,status:"active",validFrom:1,validUntil:5000,revokedAt:null,usage:"inventory-evidence"};
 const verifier=createPostgresInventoryEvidenceVerifier({pg,clock:{now:async()=>1000},trust:overrides.trust??[trust],lookupKey:async()=>({principal:trust.principal,keyId:trust.keyId,version:1,fingerprint,key:keys.publicKey})});
 const page={version:1,purpose:"d1-inventory-page",principal:trust.principal,keyId:trust.keyId,keyVersion:1,operationId:"inventory:test",registryChecksum:"a".repeat(64),pass:1,tableIndex:0,pageOrdinal:0,table:"users",fromCursor:"[]",toCursor:"[[\"text\",\"u1\"]]",rowCount:1,eventFrom:1,eventTo:1,pageChecksum:"b".repeat(64),eventsDigest:"c".repeat(64),nonce:"abcdefghijklmnopqrstuv",notBefore:900,issuedAt:900,expiresAt:1100};
 const sign=async claims=>({claims,signature:b64(await crypto.subtle.sign({name:"RSA-PSS",saltLength:32},keys.privateKey,new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.entries(claims).sort(([a],[b])=>a<b?-1:a>b?1:0))))))});
 return{verifier,page,sign,pg,keys,fingerprint,trust};
}

test("RSA-PSS inventory page evidence is verified before exact PostgreSQL nonce/audit consumption",async()=>{const f=await fixture(),envelope=await f.sign(f.page),digest=await f.verifier.verifyPage(envelope,f.page);assert.match(digest,/^[a-f0-9]{64}$/);assert.equal(f.pg.calls.length,1);assert.match(f.pg.calls[0][0],/record_inventory_verified_claim/);assert.equal(f.pg.calls[0][1][1],"d1-inventory-page");});

test("inventory evidence rejects tamper, weak keys, malformed trust and provider errors without leaking details",async()=>{const f=await fixture(),envelope=await f.sign(f.page);await assert.rejects(()=>f.verifier.verifyPage({...envelope,claims:{...f.page,rowCount:2}},f.page),/inventory evidence invalid/);const weak=await fixture({modulusLength:2048});await assert.rejects(async()=>weak.verifier.verifyPage(await weak.sign(weak.page),weak.page),/inventory evidence key invalid/);const malformed=await fixture({trust:[f.trust,f.trust]});await assert.rejects(()=>malformed.verifier.verifyPage(envelope,f.page),/inventory trust invalid/);});

test("inventory completion binds the ordered page digest and rejects PostgreSQL conflicts",async()=>{const f=await fixture(),claims={version:1,purpose:"d1-inventory-complete",principal:f.trust.principal,keyId:f.trust.keyId,keyVersion:1,operationId:"inventory:test",registryChecksum:"a".repeat(64),inventoryChecksum:"d".repeat(64),rowCount:4,pageCount:2,orderedPageDigest:"e".repeat(64),nonce:"bcdefghijklmnopqrstuvw",notBefore:900,issuedAt:900,expiresAt:1100},envelope=await f.sign(claims);assert.match(await f.verifier.verifyCompletion(envelope,claims),/^[a-f0-9]{64}$/);f.pg.query=async()=>({rows:[{accepted:false}]});await assert.rejects(()=>f.verifier.verifyCompletion(envelope,claims),/inventory evidence rejected/);});

test("inventory evidence rejects wrong signer, stale claims, noncanonical signatures and redacts stores",async()=>{const f=await fixture(),wrong={...f.page,principal:"attacker@example.test"};await assert.rejects(async()=>f.verifier.verifyPage(await f.sign(wrong),wrong),/signer untrusted/);const stale={...f.page,expiresAt:999};await assert.rejects(async()=>f.verifier.verifyPage(await f.sign(stale),stale),/freshness/);const signed=await f.sign(f.page);await assert.rejects(()=>f.verifier.verifyPage({...signed,signature:signed.signature+"="},f.page),/signature invalid/);f.pg.query=async()=>{throw new Error("postgres password leaked")};await assert.rejects(()=>f.verifier.verifyPage(signed,f.page),error=>error.message==="inventory evidence store failed");});
