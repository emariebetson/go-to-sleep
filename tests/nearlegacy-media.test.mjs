import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deletePrivateLegacyObject, putPrivateLegacyObject } from "../lib/nearlegacy-media.ts";

class Bucket {
  objects = new Map(); lostPut = true; lostDelete = true;
  async put(key, bytes, options) { this.objects.set(key, { bytes, metadata: options.customMetadata }); if (this.lostPut) { this.lostPut = false; throw new Error("lost response"); } }
  async head(key) { const item = this.objects.get(key); return item ? { size: item.bytes.byteLength, customMetadata: item.metadata } : null; }
  async delete(key) { this.objects.delete(key); if (this.lostDelete) { this.lostDelete = false; throw new Error("lost response"); } }
}

test("private Legacy R2 puts and deletes converge after lost responses", async () => {
  const bucket = new Bucket(); const bytes = new TextEncoder().encode("private family recording");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await putPrivateLegacyObject(bucket, "legacy/h1/recording/12345678-1234-4234-8234-123456789abc.m4a", bytes, "audio/mp4", checksum);
  assert.equal(bucket.objects.size, 1);
  await deletePrivateLegacyObject(bucket, "legacy/h1/recording/12345678-1234-4234-8234-123456789abc.m4a");
  assert.equal(bucket.objects.size, 0);
});

test("private Legacy R2 verification rejects checksum mismatch", async () => {
  const bucket = new Bucket(); bucket.lostPut = false;
  const originalHead = bucket.head.bind(bucket); bucket.head = async (key) => { const value = await originalHead(key); return value && { ...value, customMetadata: { checksum: "b".repeat(64) } }; };
  const bytes = new Uint8Array([1, 2]); const checksum = createHash("sha256").update(bytes).digest("hex");
  await assert.rejects(() => putPrivateLegacyObject(bucket, "legacy/h1/evidence/12345678-1234-4234-8234-123456789abc.webm", bytes, "audio/webm", checksum), /verification/);
});
