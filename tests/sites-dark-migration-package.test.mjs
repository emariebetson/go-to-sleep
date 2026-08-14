import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageDarkSitesRelease, stageDarkSitesRelease } from "../scripts/package-sites-dark-release.ts";

test("Sites dark release packages only the live D1 migration prefix and preserves later source migrations", async () => {
  const root = new URL("../", import.meta.url);
  const temp = await mkdtemp(join(tmpdir(), "nearyou-sites-dark-"));
  try {
    const result = await stageDarkSitesRelease({ root, stageDirectory: temp });
    assert.equal(result.deployedHead, "0016_marketing_waitlist.sql");
    assert.deepEqual(result.deployedMigrations.map((name) => name.slice(0, 4)), Array.from({ length: 17 }, (_, index) => String(index).padStart(4, "0")));
    assert.deepEqual(result.deferredMigrations.map((name) => name.slice(0, 4)), Array.from({ length: 9 }, (_, index) => String(index + 17).padStart(4, "0")));
    assert.deepEqual((await readdir(join(temp, "drizzle"))).sort(), result.deployedMigrations);
    await assert.rejects(readdir(join(temp, "dist/.openai/drizzle")), /ENOENT/);
    assert.match(await readFile(join(temp, "drizzle/0016_marketing_waitlist.sql"), "utf8"), /marketing_waitlist_contacts/);
    await assert.rejects(readFile(join(temp, "drizzle/0017_cutover_source_runtime.sql"), "utf8"), /ENOENT/);
    assert.match(await readFile(new URL("../lib/nearfamily-activation.ts", import.meta.url), "utf8"), /NEARFAMILY_SOURCE_ACTIVATED = false/);
    assert.match(await readFile(new URL("../app/api/internal/product-readiness/route.ts", import.meta.url), "utf8"), /ROUTE_ENABLED=false/);
    assert.match(await readFile(new URL("../infra/production/main.tf", import.meta.url), "utf8"), /services_ready = false[\s\S]*scheduler_ready = false/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Sites dark release refuses a reused stage containing a deferred migration", async () => {
  const temp = await mkdtemp(join(tmpdir(), "nearyou-sites-stale-"));
  try {
    await writeFile(join(temp, "0017_cutover_source_runtime.sql"), "stale");
    await assert.rejects(stageDarkSitesRelease({ root: new URL("../", import.meta.url), stageDirectory: temp }), /must be empty/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("official Sites archive contains the exact 0000 through 0016 byte-identical migration set", async () => {
  const temp = await mkdtemp(join(tmpdir(), "nearyou-sites-archive-"));
  const archive = join(temp, "site.tar.gz");
  try {
    const result = await packageDarkSitesRelease({
      root: new URL("../", import.meta.url),
      archive,
      officialHelper: "/Users/elizabethbetson/.codex/plugins/cache/openai-bundled/sites/0.1.34/scripts/package-site.sh",
    });
    assert.equal(result.deployedMigrations.length, 17);
    assert.equal(result.deferredMigrations.length, 9);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
