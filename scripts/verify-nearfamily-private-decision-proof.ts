import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export function requireNearFamilyDecisionProofEnvironment(environment: Record<string, string | undefined>) {
  const databaseUrl = environment.NEARYOU_TEST_POSTGRES16_DATABASE_URL;
  if (environment.NEARYOU_TEST_POSTGRES16_DISPOSABLE !== "true" || !databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error("NearFamily decision PostgreSQL 16 proof prerequisite missing");
  }
  return { databaseUrl, disposable: true as const };
}

export async function verifyNearFamilyPrivateDecisionProof(environment: Record<string, string | undefined> = process.env) {
  const proof = requireNearFamilyDecisionProofEnvironment(environment);
  try {
    const result = await execFile(process.execPath, ["--import", "tsx", "--test", "tests/nearfamily-private-decision.test.mjs"], {
      env: { ...process.env, ...environment, NEARYOU_TEST_POSTGRES16_DATABASE_URL: proof.databaseUrl, NEARYOU_TEST_POSTGRES16_DISPOSABLE: "true" },
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return proof;
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyNearFamilyPrivateDecisionProof().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "NearFamily decision PostgreSQL 16 proof prerequisite missing"}\n`);
    process.stderr.write("NearFamily decision PostgreSQL 16 proof failed\n");
    process.exitCode = 1;
  });
}
