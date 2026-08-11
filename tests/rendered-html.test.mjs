import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

let workerPromise;
function loadWorker() {
  if (!workerPromise) {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
    workerPromise = import(workerUrl.href).then((module) => module.default);
  }
  return workerPromise;
}

async function render(path = "/") {
  const worker = await loadWorker();
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

test("navigation uses deployment-safe native links", async () => {
  const files = [
    "../app/page.tsx",
    "../app/account/page.tsx",
    "../app/library/page.tsx",
    "../app/pricing/page.tsx",
    "../app/sign-in/page.tsx",
    "../app/studio/SleepStudio.tsx",
    "../components/AppShell.tsx",
    "../components/Brand.tsx",
    "../components/SiteFooter.tsx",
    "../components/SiteHeader.tsx",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["']next\/link["']/, file);
    if (source.startsWith('"use client"')) assert.doesNotMatch(source, /components\/Link/, file);
  }
});

test("saved audio authenticates with the incoming request", async () => {
  const source = await readFile(new URL("../app/api/audio/[id]/route.ts", import.meta.url), "utf8");
  assert.match(source, /GET\(request: Request/);
  assert.match(source, /requireApiUser\(request\)/);
  assert.doesNotMatch(source, /GET\(_request: Request/);
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

test("private billing routes enforce origin and authentication before database access", async () => {
  for (const path of ["../app/api/billing/checkout/route.ts", "../app/api/billing/portal/route.ts"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    const originCheck = source.indexOf("assertSameOrigin(request)");
    const authCheck = source.indexOf("requireApiUser(request)");
    const databaseLoad = source.indexOf('await import("@/db")');
    assert.ok(originCheck >= 0 && authCheck > originCheck && databaseLoad > authCheck, path);
  }
});

test("Stripe webhook rejects invalid signatures and oversized payloads", async () => {
  const worker = await loadWorker();
  const runtime = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, DB: { prepare() { return { bind() { return this; }, run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }; }, batch: async () => [] } };
  const context = { waitUntil() {}, passThroughOnException() {} };
  const invalid = await worker.fetch(new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": "bad" }, body: "{}" }), runtime, context);
  assert.equal(invalid.status, 400);
  const oversized = await worker.fetch(new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "content-length": "1000001" }, body: "x" }), runtime, context);
  assert.equal(oversized.status, 413);
});
