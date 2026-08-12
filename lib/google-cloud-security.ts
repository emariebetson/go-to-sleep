export type GoogleCloudSecurityOptions = {
  projectId: string;
  keyLocation: string;
  keyRing: string;
  keyName: string;
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
};

export type EncryptedEnvelope = {
  version: 1;
  algorithm: "AES-256-GCM";
  kmsKeyVersion: string;
  purposeHash: string;
  wrappedDek: string;
  iv: string;
  ciphertext: string;
};

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,254}$/;
const encoder = new TextEncoder();
const maximumGoogleResponseBytes = 1024 * 1024;
const maximumSecretBytes = 64 * 1024;
const maximumKmsPlaintextBytes = 64 * 1024;
const maximumPurposeBytes = 8 * 1024;
const maximumEnvelopePlaintextBytes = 64 * 1024;
const maximumEnvelopeBase64Characters = 96 * 1024;
const maximumWrappedDekCharacters = 16 * 1024;

function assertIdentifier(value: string) {
  if (!identifierPattern.test(value)) throw new Error("Google Cloud resource identifier is invalid.");
}

function bytesToBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Google Cloud response encoding is invalid.");
  const binary = atob(value);
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64(decoded) !== value) throw new Error("Google Cloud response encoding is invalid.");
  return decoded;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class GoogleCloudSecurityClient {
  readonly #options: GoogleCloudSecurityOptions;
  readonly #fetch: typeof fetch;

  constructor(options: GoogleCloudSecurityOptions) {
    for (const value of [options.projectId, options.keyLocation, options.keyRing, options.keyName]) assertIdentifier(value);
    this.#options = options;
    this.#fetch = options.fetch || fetch;
  }

  get keyResource() {
    const { projectId, keyLocation, keyRing, keyName } = this.#options;
    return `projects/${projectId}/locations/${keyLocation}/keyRings/${keyRing}/cryptoKeys/${keyName}`;
  }

  async #request(url: string, init: RequestInit, service: string) {
    const token = await this.#options.accessToken();
    if (!token) throw new Error("Google Cloud workload identity did not provide an access token.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
      });
    } catch (error) {
      throw new Error(`${service} request failed.`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`${service} request failed (${response.status}).`);
    const declaredLength = Number(response.headers.get("content-length") || "0");
    if (declaredLength > maximumGoogleResponseBytes) throw new Error(`${service} response is too large.`);
    const text = await response.text();
    if (encoder.encode(text).byteLength > maximumGoogleResponseBytes) throw new Error(`${service} response is too large.`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${service} returned an invalid response.`);
    }
  }

  async accessSecret(secretId: string, version = "latest") {
    assertIdentifier(secretId);
    assertIdentifier(version);
    const resource = `projects/${this.#options.projectId}/secrets/${secretId}/versions/${version}:access`;
    const result = await this.#request(`https://secretmanager.googleapis.com/v1/${resource}`, { method: "GET" }, "Google Secret Manager");
    const data = (result.payload as Record<string, unknown> | undefined)?.data;
    if (typeof data !== "string") throw new Error("Google Secret Manager returned an invalid response.");
    const secret = base64ToBytes(data);
    if (secret.byteLength > maximumSecretBytes) throw new Error("Google Secret Manager secret is too large.");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(secret); }
    catch { throw new Error("Google Secret Manager secret has invalid UTF-8."); }
  }

  async encrypt(plaintext: Uint8Array, additionalAuthenticatedData: string) {
    if (plaintext.byteLength === 0) throw new Error("Cloud KMS plaintext cannot be empty.");
    if (plaintext.byteLength > maximumKmsPlaintextBytes) throw new Error("Cloud KMS plaintext is too large.");
    const result = await this.#request(
      `https://cloudkms.googleapis.com/v1/${this.keyResource}:encrypt`,
      { method: "POST", body: JSON.stringify({ plaintext: bytesToBase64(plaintext), additionalAuthenticatedData: bytesToBase64(encoder.encode(additionalAuthenticatedData)) }) },
      "Google Cloud KMS",
    );
    if (typeof result.ciphertext !== "string" || typeof result.name !== "string" || !new RegExp(`^${this.keyResource}/cryptoKeyVersions/[1-9][0-9]*$`).test(result.name)) throw new Error("Google Cloud KMS returned an invalid response.");
    base64ToBytes(result.ciphertext);
    return { ciphertext: result.ciphertext, keyVersion: result.name };
  }

  async decrypt(ciphertext: string, additionalAuthenticatedData: string) {
    const result = await this.#request(
      `https://cloudkms.googleapis.com/v1/${this.keyResource}:decrypt`,
      { method: "POST", body: JSON.stringify({ ciphertext, additionalAuthenticatedData: bytesToBase64(encoder.encode(additionalAuthenticatedData)) }) },
      "Google Cloud KMS",
    );
    if (typeof result.plaintext !== "string") throw new Error("Google Cloud KMS returned an invalid response.");
    return base64ToBytes(result.plaintext);
  }
}

export async function encryptEnvelope(client: GoogleCloudSecurityClient, plaintext: Uint8Array, purpose: string): Promise<EncryptedEnvelope> {
  if (!purpose) throw new Error("Envelope encryption purpose is required.");
  if (encoder.encode(purpose).byteLength > maximumPurposeBytes) throw new Error("Envelope encryption purpose is too large.");
  if (plaintext.byteLength > maximumEnvelopePlaintextBytes) throw new Error("Envelope plaintext is too large.");
  const aad = `nearyou-envelope:v1:${purpose}`;
  const dek = crypto.getRandomValues(new Uint8Array(32));
  try {
    const key = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const [encryptedData, encryptedDek] = await Promise.all([
      crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, key, new Uint8Array(plaintext).buffer),
      client.encrypt(dek, aad),
    ]);
    return {
      version: 1,
      algorithm: "AES-256-GCM",
      kmsKeyVersion: encryptedDek.keyVersion,
      purposeHash: await sha256(purpose),
      wrappedDek: encryptedDek.ciphertext,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encryptedData)),
    };
  } finally {
    dek.fill(0);
  }
}

export async function decryptEnvelope(client: GoogleCloudSecurityClient, envelope: EncryptedEnvelope, purpose: string) {
  if (encoder.encode(purpose).byteLength > maximumPurposeBytes) throw new Error("Encrypted envelope purpose is too large.");
  if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM" || envelope.purposeHash !== await sha256(purpose)) throw new Error("Encrypted envelope purpose does not match.");
  if (!new RegExp(`^${client.keyResource}/cryptoKeyVersions/[1-9][0-9]*$`).test(envelope.kmsKeyVersion)) throw new Error("Encrypted envelope KMS key does not match.");
  if (envelope.ciphertext.length > maximumEnvelopeBase64Characters || envelope.wrappedDek.length > maximumWrappedDekCharacters) throw new Error("Encrypted envelope is too large.");
  const iv = base64ToBytes(envelope.iv);
  if (iv.byteLength !== 12) throw new Error("Encrypted envelope IV is invalid.");
  const ciphertext = base64ToBytes(envelope.ciphertext);
  if (ciphertext.byteLength > maximumEnvelopePlaintextBytes + 16) throw new Error("Encrypted envelope is too large.");
  const wrappedDek = base64ToBytes(envelope.wrappedDek);
  if (wrappedDek.byteLength === 0 || wrappedDek.byteLength > maximumWrappedDekCharacters * 3 / 4) throw new Error("Encrypted envelope wrapped DEK is invalid.");
  const aad = `nearyou-envelope:v1:${purpose}`;
  const dek = await client.decrypt(envelope.wrappedDek, aad);
  if (dek.byteLength !== 32) { dek.fill(0); throw new Error("Encrypted envelope DEK is invalid."); }
  try {
    const key = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, key, ciphertext);
    return new Uint8Array(plaintext);
  } finally {
    dek.fill(0);
  }
}
