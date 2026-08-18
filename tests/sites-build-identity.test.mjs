import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSitesBuildReceipt,
  readSitesBuildIdentity,
  runtimeBuildIdFromHtml,
  verifyStableRuntimeBuild,
} from "../scripts/read-sites-build-identity.ts";

const buildId = "12345678-1234-4123-8123-123456789abc";
const commitSha = "a".repeat(40);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sites-build-identity-"));
  await mkdir(join(root, "dist/server"), { recursive: true });
  await writeFile(join(root, "dist/server/BUILD_ID"), buildId);
  await writeFile(join(root, "dist/server/index.js"), `const runtime={deploymentVersion:${JSON.stringify(buildId)},buildId:${JSON.stringify(buildId)}};`);
  return root;
}

test("binds the exact packaged BUILD_ID to the exact runtime and release commit", async () => {
  const root = await fixture();
  try {
    const archiveSha256 = sha256("reviewed archive bytes");
    const receipt = await readSitesBuildIdentity({ root, commitSha, archiveSha256 });
    assert.deepEqual(receipt, {
      version: 1,
      commitSha,
      archiveSha256,
      buildId,
      runtimeSha256: sha256(`const runtime={deploymentVersion:${JSON.stringify(buildId)},buildId:${JSON.stringify(buildId)}};`),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an archive identity that is not embedded in its runtime", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "dist/server/index.js"), "export default {};");
    await assert.rejects(
      readSitesBuildIdentity({ root, commitSha, archiveSha256: sha256("archive") }),
      /runtime build identity invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extracts the Vinext deployment version and rejects deployment swaps", () => {
  const html = `<script>self.__next_f.push([1,"{\\"deploymentVersion\\":\\"${buildId}\\"}"])</script>`;
  assert.equal(runtimeBuildIdFromHtml(html), buildId);
  assert.deepEqual(verifyStableRuntimeBuild({ beforeHtml: html, afterHtml: html, expectedBuildId: buildId }), { buildId });
  const swapped = html.replace(buildId, "87654321-4321-4321-8321-cba987654321");
  assert.throws(() => verifyStableRuntimeBuild({ beforeHtml: html, afterHtml: swapped, expectedBuildId: buildId }), /runtime build changed/);
});

test("rejects ambiguous, malformed, or substituted build observations", () => {
  assert.throws(() => runtimeBuildIdFromHtml("<html></html>"), /runtime build observation invalid/);
  assert.throws(
    () => runtimeBuildIdFromHtml(`{"deploymentVersion":"${buildId}"}{"deploymentVersion":"87654321-4321-4321-8321-cba987654321"}`),
    /runtime build observation invalid/,
  );
  assert.throws(
    () => verifyStableRuntimeBuild({
      beforeHtml: `{\\"deploymentVersion\\":\\"${buildId}\\"}`,
      afterHtml: `{\\"deploymentVersion\\":\\"${buildId}\\"}`,
      expectedBuildId: "87654321-4321-4321-8321-cba987654321",
    }),
    /runtime build changed/,
  );
});

test("creates one exact receipt across saved version, deployment, archive, runtime, and provider log", () => {
  const html = `{\\"deploymentVersion\\":\\"${buildId}\\"}`;
  const receipt = createSitesBuildReceipt({
    projectId: "appgprj_6a79f8a66eb4819198bb42a2b26addea",
    versionId: "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_example",
    deploymentId: "appgdep_example123",
    commitSha,
    archiveSha256: "b".repeat(64),
    runtimeSha256: "c".repeat(64),
    buildId,
    beforeHtml: html,
    afterHtml: html,
    providerScriptName: "site---6a79f8a66eb4819198bb42a2b26addea",
    providerScriptVersion: "87654321-4321-4321-8321-cba987654321",
    observedAt: 1_787_000_000_000,
  });
  assert.equal(receipt.buildId, buildId);
  assert.equal(receipt.providerScriptVersion, "87654321-4321-4321-8321-cba987654321");
  assert.equal(receipt.versionId.startsWith(`${receipt.projectId}~`), true);
});

test("rejects same-project wrong-version and malformed provider bindings", () => {
  const html = `{\\"deploymentVersion\\":\\"${buildId}\\"}`;
  const base = {
    projectId: "appgprj_6a79f8a66eb4819198bb42a2b26addea",
    versionId: "appgprj_ffffffffffffffffffffffffffffffff~appgver_example",
    deploymentId: "appgdep_example123",
    commitSha,
    archiveSha256: "b".repeat(64),
    runtimeSha256: "c".repeat(64),
    buildId,
    beforeHtml: html,
    afterHtml: html,
    providerScriptName: "site---6a79f8a66eb4819198bb42a2b26addea",
    providerScriptVersion: "87654321-4321-4321-8321-cba987654321",
    observedAt: 1_787_000_000_000,
  };
  assert.throws(() => createSitesBuildReceipt(base), /Sites build receipt invalid/);
  assert.throws(() => createSitesBuildReceipt({ ...base, versionId: `${base.projectId}~appgver_example`, providerScriptName: "site---attacker" }), /Sites build receipt invalid/);
});
