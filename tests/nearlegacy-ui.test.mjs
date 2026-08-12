import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LegacyDashboard } from "../app/legacy/LegacyDashboard.tsx";
import { LegacyArchiveWorkbench } from "../app/legacy/LegacyArchiveWorkbench.tsx";

test("NearLegacy dashboard server markup exposes accessible archive controls", () => {
  const markup = renderToStaticMarkup(React.createElement(LegacyDashboard));
  assert.match(markup, /NearLegacy private family archive/);
  assert.match(markup, /<label for="legacy-question">/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /Ask the archive/);
  assert.match(markup, /Guided interviews/);
  const dashboardSource=readFileSync(new URL("../app/legacy/LegacyDashboard.tsx",import.meta.url),"utf8");for(const control of ["Appoint successor","Accept my successor appointment","Transfer primary custody","Report death for review","Complete death review","Revoke my contributor archive","Download recovery codes"])assert.match(dashboardSource,new RegExp(control));
  const workbench=renderToStaticMarkup(React.createElement(LegacyArchiveWorkbench,{householdId:"house",contributors:[{id:"person",display_name:"Grandma",status:"active"}],canManage:true}));
  for(const heading of ["Voice consent","Add an original recording","Correct a transcript","Lifecycle and deletion","Organize the archive","Photos"])assert.match(workbench,new RegExp(heading));
  for (const control of ["legacy-consent-person", "legacy-recording-file", "legacy-corrected-text", "legacy-delete-confirmation", "legacy-metadata-kind","legacy-photo-file"]) assert.match(workbench, new RegExp(`for="${control}"`));
});
