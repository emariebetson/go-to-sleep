import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_EXACT = new RegExp(`^${UUID}$`);
const SHA256_EXACT = /^[0-9a-f]{64}$/;
const COMMIT_EXACT = /^[0-9a-f]{40}$/;
const PROJECT_EXACT = /^appgprj_([0-9a-f]{32})$/;
const VERSION_EXACT = /^appgprj_[0-9a-f]{32}~appgver_[A-Za-z0-9_-]{3,160}$/;
const DEPLOYMENT_EXACT = /^appgdep_[A-Za-z0-9_-]{8,152}$/;
const execFile = promisify(execFileCallback);

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function exactBuildIds(value: string, field: "buildId" | "deploymentVersion") {
  const expression = new RegExp(`${field}[\\"'\\s:]*[\\"'\x60](${UUID})[\\"'\x60]`, "g");
  return [...value.matchAll(expression)].map((match) => match[1]!);
}

export async function readSitesBuildIdentity(input: {
  root: string;
  commitSha: string;
  archiveSha256: string;
}) {
  if (!COMMIT_EXACT.test(input.commitSha) || !SHA256_EXACT.test(input.archiveSha256)) {
    throw new Error("Sites build identity input invalid");
  }
  const buildId = (await readFile(join(input.root, "dist/server/BUILD_ID"), "utf8")).trim();
  const runtime = await readFile(join(input.root, "dist/server/index.js"), "utf8");
  const observed = new Set([
    ...exactBuildIds(runtime, "buildId"),
    ...exactBuildIds(runtime, "deploymentVersion"),
  ]);
  if (!UUID_EXACT.test(buildId) || observed.size !== 1 || !observed.has(buildId)) {
    throw new Error("Sites runtime build identity invalid");
  }
  return Object.freeze({
    version: 1 as const,
    commitSha: input.commitSha,
    archiveSha256: input.archiveSha256,
    buildId,
    runtimeSha256: sha256(runtime),
  });
}

export async function readSitesArchiveBuildIdentity(input: { archive: string; commitSha: string; expectedArchiveSha256: string }) {
  if (typeof input.archive !== "string" || !input.archive.startsWith("/") || !COMMIT_EXACT.test(input.commitSha) || !SHA256_EXACT.test(input.expectedArchiveSha256)) throw new Error("Sites archive identity invalid");
  const archive = await readFile(input.archive);
  if (sha256(archive) !== input.expectedArchiveSha256) throw new Error("Sites archive identity invalid");
  const extracted = await mkdtemp(join(tmpdir(), "nearyou-sites-build-identity-"));
  try {
    await execFile("tar", ["-xzf", input.archive, "-C", extracted]);
    return await readSitesBuildIdentity({ root: extracted, commitSha: input.commitSha, archiveSha256: input.expectedArchiveSha256 });
  } catch (error) {
    if (error instanceof Error && error.message === "Sites runtime build identity invalid") throw error;
    throw new Error("Sites archive identity invalid");
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}

export function runtimeBuildIdFromHtml(html: string) {
  if (typeof html !== "string" || html.length < 1 || html.length > 8_388_608) {
    throw new Error("Sites runtime build observation invalid");
  }
  const normalized = html.replaceAll("\\\"", "\"").replaceAll("&quot;", "\"");
  const ids = new Set(exactBuildIds(normalized, "deploymentVersion"));
  if (ids.size !== 1) throw new Error("Sites runtime build observation invalid");
  return [...ids][0]!;
}

export function verifyStableRuntimeBuild(input: {
  beforeHtml: string;
  afterHtml: string;
  expectedBuildId: string;
}) {
  if (!UUID_EXACT.test(input.expectedBuildId)) throw new Error("Sites runtime build changed");
  const before = runtimeBuildIdFromHtml(input.beforeHtml);
  const after = runtimeBuildIdFromHtml(input.afterHtml);
  if (before !== input.expectedBuildId || after !== input.expectedBuildId || before !== after) {
    throw new Error("Sites runtime build changed");
  }
  return Object.freeze({ buildId: before });
}

export function createSitesBuildReceipt(input: {
  projectId: string;
  versionId: string;
  deploymentId: string;
  commitSha: string;
  archiveSha256: string;
  buildId: string;
  beforeHtml: string;
  afterHtml: string;
  providerScriptName: string;
  providerScriptVersion: string;
  observedAt: number;
}) {
  const project = PROJECT_EXACT.exec(input.projectId);
  if (
    !project || !VERSION_EXACT.test(input.versionId) || !input.versionId.startsWith(`${input.projectId}~`) ||
    !DEPLOYMENT_EXACT.test(input.deploymentId) || !COMMIT_EXACT.test(input.commitSha) ||
    !SHA256_EXACT.test(input.archiveSha256) ||
    !UUID_EXACT.test(input.buildId) || !UUID_EXACT.test(input.providerScriptVersion) ||
    input.providerScriptName !== `site---${project[1]}` || !Number.isSafeInteger(input.observedAt) || input.observedAt < 1
  ) throw new Error("Sites build receipt invalid");
  verifyStableRuntimeBuild({ beforeHtml: input.beforeHtml, afterHtml: input.afterHtml, expectedBuildId: input.buildId });
  return Object.freeze({
    version: 1 as const,
    projectId: input.projectId,
    versionId: input.versionId,
    deploymentId: input.deploymentId,
    commitSha: input.commitSha,
    archiveSha256: input.archiveSha256,
    runtimeSha256: sha256(input.beforeHtml),
    buildId: input.buildId,
    providerScriptName: input.providerScriptName,
    providerScriptVersion: input.providerScriptVersion,
    observedAt: input.observedAt,
  });
}
