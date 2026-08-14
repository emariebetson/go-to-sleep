import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("home exposes one main landmark and keeps decorative preview text out of the heading outline", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/<main(?:\s|>)/g) ?? []).length, 1);
  assert.doesNotMatch(source, /<h3>Moonlit Meadow<\/h3>/);
  assert.match(source, /<span className="step-number" aria-hidden="true">01<\/span>/);
});
