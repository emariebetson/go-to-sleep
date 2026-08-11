import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("0012 dark mode reconciles legacy ready media before Task 2C activation", () => {
  const hooks = fileURLToPath(new URL("./fixtures/cloudflare-test-hooks.mjs", import.meta.url));
  const runner = fileURLToPath(new URL("./fixtures/task2c-storage-reconciliation-runner.mjs", import.meta.url));
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--import", "tsx", "--import", hooks, runner], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", stdio: "pipe", timeout: 60_000 }));
});
