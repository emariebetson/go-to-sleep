import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  createPostgresDecisionAuthority,
  createPostgresDecisionClock,
  createPostgresDecisionNonceStore,
  createReadinessDecisionServer,
} from "../../readiness-decision/src/server";

type Mode = "decision" | "controller" | "kill";
type Pg = { query<T>(sql: string, args: unknown[]): Promise<{ rows: T[] }> };

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
  if (mode === "decision" && process.env.READINESS_GATEWAY_DATABASE_BACKED === "true") {
    const instanceConnectionName = process.env.READINESS_GATEWAY_CLOUD_SQL_INSTANCE ?? "";
    const user = process.env.READINESS_GATEWAY_DATABASE_USER ?? "";
    const database = process.env.READINESS_GATEWAY_DATABASE_NAME ?? "";
    const keyNotBefore = Number(process.env.READINESS_GATEWAY_KEY_NOT_BEFORE);
    const keyNotAfter = Number(process.env.READINESS_GATEWAY_KEY_NOT_AFTER);
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z]+(?:-[a-z]+)+[0-9]:[a-z][a-z0-9-]{2,97}$/.test(instanceConnectionName) || !/^[a-z0-9-]{3,30}@[a-z][a-z0-9-]{4,28}\.iam$/.test(user) || !/^[a-z][a-z0-9_]{2,62}$/.test(database)) throw new Error("database-backed readiness gateway configuration invalid");
    const connectorName = "@google-cloud/cloud-sql-connector", pgName = "pg";
    const connectorModule = await import(connectorName) as unknown as { Connector: new () => { getOptions(input: Record<string, unknown>): Promise<Record<string, unknown>>; close(): void }; AuthTypes: { IAM: string }; IpAddressTypes: { PRIVATE: string } };
    const pgModule = await import(pgName) as unknown as { Pool: new (input: Record<string, unknown>) => Pg & { end(): Promise<void> } };
    const connector = new connectorModule.Connector();
    const options = await connector.getOptions({ instanceConnectionName, authType: connectorModule.AuthTypes.IAM, ipType: connectorModule.IpAddressTypes.PRIVATE });
    const pool = new pgModule.Pool({ ...options, user, database, max: 1, connectionTimeoutMillis: 750, idleTimeoutMillis: 60_000 });
    handler = createDatabaseBackedDecisionHandler({ disposable, key, keyNotBefore, keyNotAfter, pg: pool });
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
      if (size > 4096) {
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
