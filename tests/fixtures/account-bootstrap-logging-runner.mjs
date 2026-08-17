import assert from "node:assert/strict";
import { inspect } from "node:util";

const sessionId = "11111111-1111-4111-8111-111111111111";
const rawDatabaseDetail = "synthetic-bound-database-detail";

class FailingD1Statement {
  constructor(source, parameters = []) {
    this.source = source;
    this.parameters = parameters;
  }
  bind(...parameters) { return new FailingD1Statement(this.source, parameters); }
  async run() { throw new Error(`${rawDatabaseDetail}: ${this.parameters.join(" | ")}`); }
  async all() { return this.run(); }
  async raw() { return this.run(); }
}

globalThis.__TASK2B_CLOUDFLARE_ENV__ = {
  DB: { prepare(source) { return new FailingD1Statement(source); } },
};
process.env.ELEVENLABS_API_KEY = "elevenlabs-test-key";
delete process.env.NEARYOU_ENABLE_NEARSLEEP_PRODUCTION;

const logs = [];
console.error = (...args) => { logs.push(args); };

const { POST } = await import("../../app/api/sessions/route.ts");
const response = await POST(new Request("https://example.test/api/sessions", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://example.test" },
  body: JSON.stringify({
    requestId: sessionId,
    childName: "Moon",
    pronunciation: "",
    ageMonths: 6,
    challenge: "settling",
    theme: "moonlit-meadow",
    duration: "5",
    sound: "none",
    frequencies: [],
    style: "slow-story",
    scriptMode: "curated",
    contentType: "story",
    sourceUrl: "",
    sourceTitle: "",
    script: "The moon glows softly above the quiet meadow while every little star settles gently into the calm night sky.",
    voiceId: "",
    narrationKind: "demo_narrator",
    generationMode: "save",
  }),
}));

assert.equal(response.status, 500);
assert.deepEqual(logs, [[JSON.stringify({ stage: "upsertUser", cause: "DrizzleQueryError" })]]);
const renderedLogs = inspect(logs, { depth: null });
for (const sensitiveValue of [sessionId, rawDatabaseDetail, "local-preview", "preview@nearnight.local", "Preview Parent"]) {
  assert.doesNotMatch(renderedLogs, new RegExp(sensitiveValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
