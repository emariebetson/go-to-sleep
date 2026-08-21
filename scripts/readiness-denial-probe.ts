import {
  canonicalDecisionBody,
  canonicalDecisionEnvelope,
  sha256Hex,
  signDecisionEnvelope,
} from "../services/readiness-decision/src/envelope";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

type ProbeFetch = typeof fetch;

async function post(request: ProbeFetch, url: string, body: string, authorization?: string): Promise<number> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  return (await request(url, { method: "POST", redirect: "error", headers, body })).status;
}

export async function runReadinessDenialProbe(input: Readonly<{
  gatewayUrl: string;
  directDecisionUrl: string;
  controllerUrl: string;
  key: Uint8Array;
  now: number;
  nonce: string;
  fetch?: ProbeFetch;
}>): Promise<Record<string, number>> {
  if (![input.gatewayUrl, input.directDecisionUrl, input.controllerUrl].every((url) => /^https:\/\//.test(url)) || !(input.key instanceof Uint8Array) || input.key.byteLength !== 32 || !Number.isSafeInteger(input.now) || !/^[A-Za-z0-9_-]{22,128}$/.test(input.nonce)) throw new Error("readiness denial probe configuration invalid");
  const request = input.fetch ?? fetch;
  const releaseId = "rel_20260819_readiness_gateway_01";
  const householdHash = "a".repeat(64);
  const claims = {
    version: 1 as const,
    releaseId,
    householdHash,
    issuedAt: input.now,
    nonce: input.nonce,
    bodySha256: await sha256Hex(canonicalDecisionBody({ releaseId, householdHash })),
    keyVersion: 1,
  };
  const valid = canonicalDecisionEnvelope({ ...claims, signature: await signDecisionEnvelope(claims, input.key) });
  const invalid = canonicalDecisionEnvelope({ ...claims, nonce: `${input.nonce.slice(0, -1)}z`, signature: "A".repeat(43) });
  const missingHmac = await post(request, input.gatewayUrl, "{}");
  const invalidHmac = await post(request, input.gatewayUrl, invalid);
  const accepted = await post(request, input.gatewayUrl, valid);
  if (accepted !== 200) throw new Error("readiness denial probe valid control failed");
  const replayedHmac = await post(request, input.gatewayUrl, valid);
  const directCloudRun = await post(request, input.directDecisionUrl, "{}");
  const wrongAudience = await post(request, input.controllerUrl, "{}", "Bearer invalid-decision-audience");
  const controllerEscalation = await post(request, input.controllerUrl, valid);
  return { missingHmac, invalidHmac, replayedHmac, directCloudRun, wrongAudience, controllerEscalation };
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`readiness denial probe requires ${name}`);
  return value;
}

async function main(): Promise<void> {
  if (process.env.READINESS_GATEWAY_DISPOSABLE !== "true") throw new Error("readiness denial probe requires disposable mode");
  const rawKey = (await readFile(option("--key-file"), "utf8")).trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(rawKey)) throw new Error("readiness denial probe key invalid");
  const result = await runReadinessDenialProbe({
    gatewayUrl: option("--gateway-url"),
    directDecisionUrl: option("--direct-decision-url"),
    controllerUrl: option("--controller-url"),
    key: new Uint8Array(Buffer.from(rawKey, "base64")),
    now: Date.now(),
    nonce: randomBytes(18).toString("base64url"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => { process.stderr.write("readiness denial probe failed\n"); process.exitCode = 1; });
