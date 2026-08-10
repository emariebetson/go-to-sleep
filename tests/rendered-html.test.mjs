import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    DB: { prepare() { return { bind() { return this; }, run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }; }, batch: async () => [] },
    AUDIO: { get: async () => null, put: async () => undefined },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the Nearnight landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Nearnight/);
  assert.match(html, /Your voice/);
  assert.match(html, /Create tonight/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("server-renders public trust and pricing pages", async () => {
  for (const path of ["/pricing", "/safety", "/privacy", "/terms"]) {
    const response = await render(path);
    assert.equal(response.status, 200, path);
  }
});

test("private product pages require an authenticated parent", async () => {
  for (const path of ["/studio", "/library", "/account", "/admin"]) {
    const response = await render(path);
    assert.ok([302, 303, 307, 308].includes(response.status), `${path}: ${response.status}`);
    assert.match(response.headers.get("location") || "", /^\/sign-in\?returnTo=/);
  }
});

test("offers Google as the only account sign-in choice", async () => {
  const response = await render("/sign-in");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Continue with Google/);
  assert.doesNotMatch(html, /Continue with Apple/);
  assert.doesNotMatch(html, /Sign in with ChatGPT/i);
});

test("private generation APIs reject anonymous requests", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/api/scripts", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ childName: "Junie", ageMonths: "6", challenge: "settling", theme: "moonlit-meadow", duration: "5", style: "slow-story", scriptMode: "curated" }),
  }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    DB: { prepare() { return { bind() { return this; }, run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }; }, batch: async () => [] },
    AUDIO: { get: async () => null, put: async () => undefined },
  }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 401);
});
