import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Task 2C actual routes enforce tenant state and converge after lost R2 responses", () => {
  const hooks = fileURLToPath(new URL("./fixtures/cloudflare-test-hooks.mjs", import.meta.url));
  const runner = fileURLToPath(new URL("./fixtures/task2c-route-state-runner.mjs", import.meta.url));
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--import", "tsx", "--import", hooks, runner], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", stdio: "pipe", timeout: 60_000,
  }));
});
