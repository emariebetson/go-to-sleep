import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("production Stripe events converge through executable D1 state transitions", () => {
  const hooks = fileURLToPath(new URL("./fixtures/cloudflare-test-hooks.mjs", import.meta.url));
  const runner = fileURLToPath(new URL("./fixtures/task2b-stripe-state-runner.mjs", import.meta.url));
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--import", "tsx", "--import", hooks, runner], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
  }));
});
