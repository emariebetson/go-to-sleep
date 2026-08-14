import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("company home exposes one main landmark and a single descriptive page heading", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/<main(?:\s|>)/g) ?? []).length, 1);
  assert.equal((source.match(/<h1(?:\s|>)/g) ?? []).length, 1);
  assert.match(source, /<h1 className="company-display">Near you, <em>still\.<\/em><\/h1>/);
  assert.match(source, /aria-labelledby="company-purpose"/);
});
