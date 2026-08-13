import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../app/page.tsx";

test("home exposes one main landmark and keeps decorative preview text out of the heading outline", () => {
  const markup = renderToStaticMarkup(React.createElement(Home));
  assert.equal((markup.match(/<main(?:\s|>)/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /<h3>Moonlit Meadow<\/h3>/);
  assert.match(markup, /<span class="step-number" aria-hidden="true">01<\/span>/);
});
