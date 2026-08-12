import assert from "node:assert/strict";
import test from "node:test";
import { base32, protectTotpSecret, revealTotpSecret, totpCode, verifyTotp } from "../lib/legacy-mfa.ts";

test("Legacy TOTP secrets are encrypted and codes are one-time per counter",async()=>{
  const secret=new Uint8Array(20).map((_,index)=>index+1),key="ab".repeat(32),protectedSecret=await protectTotpSecret(secret,key);
  assert.notEqual(protectedSecret.ciphertext,Buffer.from(secret).toString("hex"));
  assert.deepEqual(await revealTotpSecret(protectedSecret.ciphertext,protectedSecret.iv,key),secret);
  assert.match(base32(secret),/^[A-Z2-7]+$/);
  const now=1_800_000_000_000,counter=Math.floor(now/30000),code=await totpCode(secret,counter);
  assert.equal(await verifyTotp(secret,code,now,-1),counter);
  assert.equal(await verifyTotp(secret,code,now,counter),null);
  assert.equal(await verifyTotp(secret,"00000x",now,-1),null);
});
