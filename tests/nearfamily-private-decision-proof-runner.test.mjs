import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { promisify } from "node:util";
import { requireNearFamilyDecisionProofEnvironment } from "../scripts/verify-nearfamily-private-decision-proof.ts";

const execFile = promisify(execFileCallback);

test("the NearFamily decision proof runner rejects a missing disposable PostgreSQL 16 target", () => {
  assert.throws(
    () => requireNearFamilyDecisionProofEnvironment({}),
    /NearFamily decision PostgreSQL 16 proof prerequisite missing/,
  );
});

test("the NearFamily decision proof runner requires an explicit disposable declaration", () => {
  assert.throws(
    () => requireNearFamilyDecisionProofEnvironment({ NEARYOU_TEST_POSTGRES16_DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/nearyou" }),
    /NearFamily decision PostgreSQL 16 proof prerequisite missing/,
  );
});

test("the NearFamily decision proof runner reports the missing environment prerequisite", async () => {
  await assert.rejects(
    execFile(process.execPath, ["--import", "tsx", "scripts/verify-nearfamily-private-decision-proof.ts"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, NEARYOU_TEST_POSTGRES16_DATABASE_URL: undefined, NEARYOU_TEST_POSTGRES16_DISPOSABLE: undefined },
    }),
    (error) => error.code === 1 && /NearFamily decision PostgreSQL 16 proof prerequisite missing/.test(error.stderr),
  );
});

test("controlled disposable CI runs the required NearFamily decision proof before operational evidence", () => {
  const workflow = readFileSync(new URL("../.github/workflows/production-evidence.yml", import.meta.url), "utf8");
  assert.match(workflow, /nearfamily-decision-proof:/);
  assert.match(workflow, /NEARYOU_TEST_POSTGRES16_DATABASE_URL: "postgres:\/\/postgres:postgres@localhost:5432\/nearyou"/);
  assert.match(workflow, /NEARYOU_TEST_POSTGRES16_DISPOSABLE: "true"/);
  assert.match(workflow, /node --import tsx scripts\/verify-nearfamily-private-decision-proof\.ts \| tee evidence\/nearfamily-private-decision-proof\.log/);
  assert.match(workflow, /name: nearfamily-private-decision-proof-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /path: evidence\/nearfamily-private-decision-proof\.log/);
  assert.match(workflow, /needs: \[postgres-contract, nearfamily-decision-proof\]/);
});
