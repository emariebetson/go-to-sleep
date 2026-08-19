import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { validatePrivateTesterActivationRequest } from "../lib/private-tester-activation";

function invalid(): never { throw new Error("private tester activation CLI invalid"); }

export async function inspectPrivateTesterActivationCli(raw: string) {
  if (typeof raw !== "string" || raw.length < 2 || Buffer.byteLength(raw) > 128_000) invalid();
  let request: unknown;
  try { request = JSON.parse(raw); } catch { invalid(); }
  try { validatePrivateTesterActivationRequest(request); } catch { invalid(); }
  if ((request as { action: string }).action !== "activate") invalid();
  return Object.freeze({ mode: "controller-only" as const, requestSha256: createHash("sha256").update(raw).digest("hex") });
}

async function readRequest(path: string): Promise<string> {
  if (typeof path !== "string" || path.length < 1 || path.length > 4_096) invalid();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 128_000) invalid();
    const raw = await handle.readFile("utf8");
    if (Buffer.byteLength(raw) !== stat.size) invalid();
    return raw;
  } catch { return invalid(); } finally { await handle?.close(); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--request") invalid();
  process.stdout.write(`${JSON.stringify(await inspectPrivateTesterActivationCli(await readRequest(args[1] ?? "")))}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => { process.stderr.write("private tester activation validation failed\n"); process.exitCode = 1; });
