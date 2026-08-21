import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  createPostgresDecisionAuthority,
  createPostgresDecisionClock,
  createPostgresDecisionNonceStore,
  createReadinessDecisionServer,
} from "../../readiness-decision/src/server";
import { createReadinessControllerServer } from "../../readiness-controller/src/server";
import { createPostgresPrivateTesterActivationController } from "../../../lib/private-tester-activation";

type Mode = "decision" | "controller" | "kill";
type Pg = { query<T>(sql: string, args: unknown[]): Promise<{ rows: T[] }> };
type ControllerPg = Pg & { transaction<T>(run: (tx: Pg) => Promise<T>): Promise<T> };
type PoolPg = Pg & { connect(): Promise<Pg & { release(): void }> };
type ControllerIdentity = Readonly<{ issuer: string; audience: string; subject: string }>;
type VerifiedControllerIdentity = Readonly<{ issuer: string; audience: string; subject: string; expiresAt: number }>;
type GoogleIdTokenClient = { verifyIdToken(input: Readonly<{ idToken: string; audience: string }>): Promise<{ getPayload(): Record<string, unknown> | undefined }> };

export function createGoogleIdTokenVerifier(client: GoogleIdTokenClient) {
  if (!client || typeof client.verifyIdToken !== "function") throw new Error("Google identity verifier invalid");
  return async (input: Readonly<{ token: string; audience: string }>): Promise<VerifiedControllerIdentity> => {
    if (!input || typeof input.token !== "string" || !/^[A-Za-z0-9._~-]{8,8192}$/.test(input.token) || typeof input.audience !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_./-]*)?$/.test(input.audience)) throw new Error("Google identity invalid");
    const payload = (await client.verifyIdToken({ idToken: input.token, audience: input.audience })).getPayload();
    if (!payload || payload.iss !== "https://accounts.google.com" || payload.aud !== input.audience || payload.email_verified !== true || typeof payload.email !== "string" || !/^[a-z0-9-]{3,100}@[a-z0-9-]{3,100}\.iam\.gserviceaccount\.com$/.test(payload.email) || !Number.isSafeInteger(payload.exp) || Number(payload.exp) < 1) throw new Error("Google identity invalid");
    return Object.freeze({ issuer: payload.iss, audience: payload.aud, subject: payload.email, expiresAt: Number(payload.exp) * 1000 });
  };
}

export function createTransactionalPostgresPool(pool: PoolPg): ControllerPg {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") throw new Error("controller PostgreSQL pool invalid");
  return Object.freeze({
    query: <T>(sql: string, args: unknown[]) => pool.query<T>(sql, args),
    transaction: async <T>(run: (tx: Pg) => Promise<T>): Promise<T> => {
      if (typeof run !== "function") throw new Error("controller PostgreSQL transaction invalid");
      const client = await pool.connect();
      try {
        await client.query("BEGIN", []);
        const result = await run(client);
        await client.query("COMMIT", []);
        return result;
      } catch (error) {
        try { await client.query("ROLLBACK", []); } catch { /* fail with the original operation error */ }
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

export function createDisposableGatewayHandler(input: Readonly<{
  mode: Mode;
  disposable: boolean;
  key: Uint8Array;
  now(): number;
}>): (request: Request) => Promise<Response> {
  if (!input.disposable) throw new Error("readiness gateway runtime requires disposable mode");
  if (!(["decision", "controller", "kill"] as const).includes(input.mode) || !(input.key instanceof Uint8Array) || input.key.byteLength < 32) throw new Error("readiness gateway runtime invalid");
  if (input.mode !== "decision") return async () => new Response('{"version":1,"allowed":false}', { status: 403, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const consumed = new Set<string>();
  const startedAt = input.now();
  const server = createReadinessDecisionServer({
    issuer: "cloudflare:nearfamily-disposable",
    now: async () => input.now(),
    keys: [{ version: 1, status: "current", notBefore: startedAt - 300_000, notAfter: startedAt + 172_800_000, key: input.key }],
    nonceStore: {
      consume: async ({ issuer, keyVersion, nonce }) => {
        const id = `${issuer}:${keyVersion}:${nonce}`;
        if (consumed.has(id)) return false;
        consumed.add(id);
        return true;
      },
    },
    authority: { authorize: async () => Object.freeze({ allowed: false }) },
  });
  return (request) => server.handle(request);
}

export function createDatabaseBackedDecisionHandler(input: Readonly<{
  disposable: boolean;
  key: Uint8Array;
  keyNotBefore: number;
  keyNotAfter: number;
  pg: Pg;
}>): (request: Request) => Promise<Response> {
  if (!input.disposable || !(input.key instanceof Uint8Array) || input.key.byteLength !== 32 || !Number.isSafeInteger(input.keyNotBefore) || !Number.isSafeInteger(input.keyNotAfter) || input.keyNotBefore >= input.keyNotAfter || !input.pg || typeof input.pg.query !== "function") throw new Error("database-backed readiness gateway invalid");
  const server = createReadinessDecisionServer({
    issuer: "cloudflare:nearfamily-disposable",
    now: createPostgresDecisionClock(input.pg),
    keys: [{ version: 1, status: "current", notBefore: input.keyNotBefore, notAfter: input.keyNotAfter, key: input.key }],
    nonceStore: createPostgresDecisionNonceStore(input.pg),
    authority: createPostgresDecisionAuthority(input.pg),
  });
  return (request) => server.handle(request);
}

export function createDatabaseBackedControllerHandler(input: Readonly<{
  mode: "controller" | "kill";
  disposable: boolean;
  pg: ControllerPg;
  ordinaryIdentity: ControllerIdentity;
  emergencyIdentity: ControllerIdentity;
  verifyIdToken(input: Readonly<{ token: string; audience: string }>): Promise<VerifiedControllerIdentity>;
}>): (request: Request) => Promise<Response> {
  if (!input.disposable || !(input.mode === "controller" || input.mode === "kill") || !input.pg || typeof input.pg.query !== "function" || typeof input.pg.transaction !== "function" || typeof input.verifyIdToken !== "function") throw new Error("database-backed readiness controller invalid");
  const apply = createPostgresPrivateTesterActivationController(input.pg);
  const executor = Object.freeze({ apply: (request: Parameters<typeof apply>[0]) => apply(request) });
  const server = createReadinessControllerServer({
    now: createPostgresDecisionClock(input.pg),
    ordinaryIdentity: input.ordinaryIdentity,
    emergencyIdentity: input.emergencyIdentity,
    verifyIdToken: input.verifyIdToken,
    ordinaryController: executor,
    emergencyController: executor,
  });
  const allowedPath = input.mode === "kill" ? "/v1/nearfamily/emergency" : "/v1/nearfamily/controller";
  return (request) => new URL(request.url).pathname === allowedPath
    ? server.handle(request)
    : Promise.resolve(new Response('{"version":1,"accepted":false}', { status: 404, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }));
}

function decodeKey(path: string): Uint8Array {
  const raw = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw new Error("readiness gateway key invalid");
  const key = new Uint8Array(Buffer.from(raw, "base64"));
  if (key.byteLength !== 32) throw new Error("readiness gateway key invalid");
  return key;
}

async function start(): Promise<void> {
  const mode = process.env.READINESS_GATEWAY_MODE as Mode;
  const disposable = process.env.READINESS_GATEWAY_DISPOSABLE === "true";
  const key = mode === "decision" ? decodeKey(process.env.READINESS_GATEWAY_HMAC_KEY_FILE ?? "") : new Uint8Array(32);
  let handler: (request: Request) => Promise<Response>;
  if ((["decision", "controller", "kill"] as const).includes(mode) && process.env.READINESS_GATEWAY_DATABASE_BACKED === "true") {
    const instanceConnectionName = process.env.READINESS_GATEWAY_CLOUD_SQL_INSTANCE ?? "";
    const user = process.env.READINESS_GATEWAY_DATABASE_USER ?? "";
    const database = process.env.READINESS_GATEWAY_DATABASE_NAME ?? "";
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z]+(?:-[a-z]+)+[0-9]:[a-z][a-z0-9-]{2,97}$/.test(instanceConnectionName) || !/^[a-z0-9-]{3,30}@[a-z][a-z0-9-]{4,28}\.iam$/.test(user) || !/^[a-z][a-z0-9_]{2,62}$/.test(database)) throw new Error("database-backed readiness gateway configuration invalid");
    const connectorName = "@google-cloud/cloud-sql-connector", pgName = "pg";
    const connectorModule = await import(connectorName) as unknown as { Connector: new () => { getOptions(input: Record<string, unknown>): Promise<Record<string, unknown>>; close(): void }; AuthTypes: { IAM: string }; IpAddressTypes: { PRIVATE: string } };
    const pgModule = await import(pgName) as unknown as { Pool: new (input: Record<string, unknown>) => PoolPg & { end(): Promise<void> } };
    const connector = new connectorModule.Connector();
    const options = await connector.getOptions({ instanceConnectionName, authType: connectorModule.AuthTypes.IAM, ipType: connectorModule.IpAddressTypes.PRIVATE });
    const pool = new pgModule.Pool({ ...options, user, database, max: 1, connectionTimeoutMillis: 750, idleTimeoutMillis: 60_000 });
    if (mode === "decision") {
      const keyNotBefore = Number(process.env.READINESS_GATEWAY_KEY_NOT_BEFORE);
      const keyNotAfter = Number(process.env.READINESS_GATEWAY_KEY_NOT_AFTER);
      handler = createDatabaseBackedDecisionHandler({ disposable, key, keyNotBefore, keyNotAfter, pg: pool });
    } else {
      const ordinaryIdentity = { issuer: "https://accounts.google.com", audience: process.env.READINESS_GATEWAY_ORDINARY_AUDIENCE ?? "", subject: process.env.READINESS_GATEWAY_ORDINARY_CALLER ?? "" } as const;
      const emergencyIdentity = { issuer: "https://accounts.google.com", audience: process.env.READINESS_GATEWAY_EMERGENCY_AUDIENCE ?? "", subject: process.env.READINESS_GATEWAY_EMERGENCY_CALLER ?? "" } as const;
      const authName = "google-auth-library";
      const authModule = await import(authName) as unknown as { OAuth2Client: new () => GoogleIdTokenClient };
      handler = createDatabaseBackedControllerHandler({ mode, disposable, pg: createTransactionalPostgresPool(pool), ordinaryIdentity, emergencyIdentity, verifyIdToken: createGoogleIdTokenVerifier(new authModule.OAuth2Client()) });
    }
  } else {
    handler = createDisposableGatewayHandler({ mode, disposable, key, now: Date.now });
  }
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("readiness gateway port invalid");
  createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      const maximumBodyBytes = mode === "decision" ? 4096 : 128_000;
      if (size > maximumBodyBytes) {
        outgoing.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
        outgoing.end('{"version":1,"allowed":false}');
        return;
      }
      chunks.push(bytes);
    }
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
      const request = new Request(`http://runtime${incoming.url ?? "/"}`, { method: incoming.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      outgoing.end('{"version":1,"allowed":false}');
    }
  }).listen(port, "0.0.0.0");
}

if (import.meta.url === `file://${process.argv[1]}`) start().catch(() => { process.stderr.write("readiness gateway failed\n"); process.exitCode = 1; });
