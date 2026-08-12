type LegacyBucket = {
  put(key: string, value: Uint8Array | ReadableStream<Uint8Array>, options: { httpMetadata: { contentType: string }; customMetadata: { checksum: string; private: string }; sha256?: ArrayBuffer }): Promise<unknown>;
  head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>;
  delete(key: string): Promise<void>;
};

export async function putPrivateLegacyObject(bucket: LegacyBucket, key: string, bytes: Uint8Array, contentType: string, checksum: string) {
  if (!/^legacy\/[A-Za-z0-9:_-]{1,200}\/(recording|evidence|photo|export)\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(key) || !["audio/mp4", "audio/webm", "audio/mpeg", "image/jpeg", "image/png", "application/json"].includes(contentType) || !/^[0-9a-f]{64}$/.test(checksum) || bytes.byteLength < 1 || bytes.byteLength > 50_000_000) throw new Error("Legacy object metadata is invalid.");
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  const actualChecksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actualChecksum !== checksum) throw new Error("Legacy object checksum does not match its bytes.");
  try { await bucket.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { checksum, private: "true" } }); } catch {
    // A provider can commit a put and lose the response. HEAD is the source of truth.
  }
  let head: Awaited<ReturnType<LegacyBucket["head"]>>;
  try { head = await bucket.head(key); } catch {
    await deletePrivateLegacyObject(bucket, key).catch(() => undefined);
    throw new Error("Private Legacy object verification failed.");
  }
  if (!head || head.size !== bytes.byteLength || head.customMetadata?.checksum !== checksum || head.customMetadata?.private !== "true") {
    await deletePrivateLegacyObject(bucket, key).catch(() => undefined);
    throw new Error("Private Legacy object verification failed.");
  }
}

export async function putPrivateLegacyStream(bucket: LegacyBucket, key: string, stream: ReadableStream<Uint8Array>, byteSize: number, contentType: string, checksum: string) {
  if (!/^legacy\/[A-Za-z0-9:_-]{1,200}\/recording\/[0-9a-f-]{36}\.(webm|m4a|mp3)$/.test(key) || !["audio/mp4", "audio/webm", "audio/mpeg"].includes(contentType) || !/^[0-9a-f]{64}$/.test(checksum) || !Number.isSafeInteger(byteSize) || byteSize < 10_000 || byteSize > 50_000_000) throw new Error("Legacy recording metadata is invalid.");
  const sha256 = new Uint8Array(checksum.match(/../g)!.map((value) => Number.parseInt(value, 16))).buffer;
  try { await bucket.put(key, stream, { httpMetadata: { contentType }, customMetadata: { checksum, private: "true" }, sha256 }); } catch { /* verify committed state below */ }
  const head = await bucket.head(key);
  if (!head || head.size !== byteSize || head.customMetadata?.checksum !== checksum || head.customMetadata?.private !== "true") throw new Error("Private Legacy recording verification failed.");
}

export async function putPrivateLegacyExportStream(bucket: LegacyBucket, key: string, stream: ReadableStream<Uint8Array>, byteSize: number, contentType: string, checksum: string) {
  if (!/^legacy\/[A-Za-z0-9:_-]{1,200}\/export\/[0-9a-f-]{36}\.(webm|m4a|mp3|jpg|png|json)$/.test(key) || !["audio/mp4", "audio/webm", "audio/mpeg", "image/jpeg", "image/png", "application/json"].includes(contentType) || !/^[0-9a-f]{64}$/.test(checksum) || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 500_000_000) throw new Error("Legacy export part metadata is invalid.");
  const sha256 = new Uint8Array(checksum.match(/../g)!.map((value) => Number.parseInt(value, 16))).buffer;
  try { await bucket.put(key, stream, { httpMetadata: { contentType }, customMetadata: { checksum, private: "true" }, sha256 }); } catch { /* verify a possibly committed write below */ }
  const head = await bucket.head(key);
  if (!head || head.size !== byteSize || head.customMetadata?.checksum !== checksum || head.customMetadata?.private !== "true") throw new Error("Private Legacy export verification failed.");
}

export async function deletePrivateLegacyObject(bucket: LegacyBucket, key: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await bucket.delete(key); } catch { /* verify the durable state below */ }
    try { if (!await bucket.head(key)) return; } catch { /* retry */ }
  }
  throw new Error("Private Legacy object deletion could not be verified.");
}
