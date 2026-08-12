type Db = { query<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ rows: T[] }> };
export class PostgresNonceStore {
  constructor(private db: Db) {}
  async consume(input: { nonce: string; claimsDigest: string; principal: string; keyId: string; keyVersion: number; releaseId: string; expiresAt: number; canonicalClaims?: string }) {
    if(typeof input.canonicalClaims!=="string") throw new Error("evidence claims projection required");
    const result = await this.db.query<{ consumed: boolean }>("SELECT nearyou.consume_release_evidence($1,$2,$8,$3,$4,$5,$6,to_timestamp($7/1000.0)) AS consumed", [input.nonce, input.claimsDigest, input.principal, input.keyId, input.keyVersion, input.releaseId, input.expiresAt,input.canonicalClaims]);
    return result.rows.length === 1 && result.rows[0].consumed === true;
  }
}
export class PostgresNonceMaintenance {
  constructor(private db: Db) {}
  async cleanup(limit = 1000) { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("cleanup limit invalid"); const result = await this.db.query<{ removed: number }>("SELECT nearyou.cleanup_evidence_nonces($1) AS removed", [limit]); return result.rows[0]?.removed ?? 0; }
}
const ID = /^[A-Za-z0-9_-]{1,255}$/;
const CLAIM_ID = /^[A-Za-z0-9_:/.@-]{3,200}$/;
const bytes = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (value) => value.toString(16).padStart(2, "0")).join("");
const exactBuffer = (value: Uint8Array) => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
const crc32c = (value: string) => {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(value)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0x82f63b78 & -(crc & 1));
  }
  return String((crc ^ 0xffffffff) >>> 0);
};
export class CloudKmsPublicKeyClient {
  constructor(private options: { project: string; location: string; keyRing: string; key: string; principal: string; keyId: string; accessToken(): Promise<string>; fetch?: typeof fetch }) { for (const value of [options.project, options.location, options.keyRing, options.key]) if (!ID.test(value)) throw new Error("KMS resource invalid"); if (!CLAIM_ID.test(options.principal) || !CLAIM_ID.test(options.keyId)) throw new Error("KMS mapping invalid"); }
  async lookup(principal: string, keyId: string, version: number) {
    if (principal !== this.options.principal || keyId !== this.options.keyId) throw new Error("KMS mapping invalid"); if (!Number.isSafeInteger(version) || version < 1) throw new Error("KMS version invalid");
    const keyName = `projects/${this.options.project}/locations/${this.options.location}/keyRings/${this.options.keyRing}/cryptoKeys/${this.options.key}`;
    const name = `${keyName}/cryptoKeyVersions/${version}`;
    let token: string; try { token = await this.options.accessToken(); } catch { throw new Error("KMS identity failed"); } if (!/^[A-Za-z0-9._~-]{20,4096}$/.test(token)) throw new Error("KMS identity failed");
    const request = async (resource: string) => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000); let response: Response;
      try { response = await (this.options.fetch || fetch)(`https://cloudkms.googleapis.com/v1/${resource}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: controller.signal }); } catch { throw new Error("KMS public key request failed"); } finally { clearTimeout(timer); }
      if (!response.ok) throw new Error(`KMS public key request failed (${response.status})`); const contentType = response.headers.get("content-type") || ""; const rawLength = response.headers.get("content-length"); const contentLength = rawLength === null ? 0 : Number(rawLength); if (!/^application\/json(?:;|$)/i.test(contentType) || !Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > 65_536) throw new Error("KMS public key response invalid");
      const text = await response.text(); if (new TextEncoder().encode(text).byteLength > 65_536) throw new Error("KMS public key response too large"); try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new Error("KMS public key response invalid"); }
    };
    const keyMetadata = await request(keyName);
    const versionMetadata = await request(name);
    const value = await request(`${name}/publicKey`);
    if (keyMetadata.name !== keyName || keyMetadata.purpose !== "ASYMMETRIC_SIGN" || versionMetadata.name !== name || versionMetadata.state !== "ENABLED" || versionMetadata.algorithm !== "RSA_SIGN_PSS_3072_SHA256" || versionMetadata.protectionLevel !== "HSM") throw new Error("KMS public key response invalid");
    if (value.name !== name || value.algorithm !== "RSA_SIGN_PSS_3072_SHA256" || value.protectionLevel !== "HSM" || typeof value.pem !== "string" || typeof value.pemCrc32c !== "string" || !/^(?:0|[1-9][0-9]{0,9})$/.test(value.pemCrc32c) || Number(value.pemCrc32c) > 0xffffffff || value.pemCrc32c !== crc32c(value.pem)) throw new Error("KMS public key response invalid");
    const match = value.pem.match(/^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]{500,8192})\n-----END PUBLIC KEY-----\n?$/); if (!match) throw new Error("KMS public key response invalid"); const encoded = match[1].replace(/\n/g, ""); let der: Uint8Array; try { const binary = atob(encoded); der = Uint8Array.from(binary, (entry) => entry.charCodeAt(0)); if (btoa(String.fromCharCode(...der)) !== encoded || der.byteLength < 384 || der.byteLength > 8192) throw new Error(); } catch { throw new Error("KMS public key response invalid"); }
    const spki = exactBuffer(der);
    let key: CryptoKey; try { key = await crypto.subtle.importKey("spki", spki, { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"]); } catch { throw new Error("KMS public key response invalid"); } const algorithm = key.algorithm as RsaHashedKeyAlgorithm; if (algorithm.name !== "RSA-PSS" || algorithm.hash.name !== "SHA-256" || algorithm.modulusLength !== 3072 || algorithm.publicExponent.length !== 3 || algorithm.publicExponent[0] !== 1 || algorithm.publicExponent[1] !== 0 || algorithm.publicExponent[2] !== 1 || key.usages.length !== 1 || key.usages[0] !== "verify") throw new Error("KMS public key response invalid");
    return { principal, keyId, version, fingerprint: bytes(await crypto.subtle.digest("SHA-256", spki)), key };
  }
}
