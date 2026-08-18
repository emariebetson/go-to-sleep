import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const FILES = Object.freeze([
  ["0000_nearnight_foundation.sql", "9c9ea219b5086353388752d5d9c551c76e78ff70a4c258d47c2dad2db8b53007"],
  ["0001_google_apple_auth.sql", "a072ad0d44adf87c8976f4c87c28348063ab8cd420cc49c34d5c28a503075e91"],
  ["0002_sharp_shinobi_shaw.sql", "40c572af9e3aca3ce0ac755a8788df19121887e588712a58eb44bb423e5f5d0e"],
  ["0003_white_groot.sql", "362f90ce36cde716715f38d8baabe908d9552d89f552ace9e00e869fdb22431b"],
  ["0004_salty_sugar_man.sql", "bfdaf19606d77010edcd5344efc4019e3ec2c9bdae41eff1f34fbd22cf9157e8"],
  ["0005_pronunciation_frequency_layers.sql", "c37fc59a0c92b14b64e71f25f8785fb64da642083427b1981e6e8779881328b9"],
  ["0006_nearyou_shared_foundation.sql", "0da4384b9444995b41dd0bfb57f70ca1117a9ec7894fe2ef1110a0c7a39a5eb3"],
  ["0007_nearsleep_production_upgrade.sql", "5319bd8c1c378c90d1be09fb7458cbafd773d5f748fe28a08de59d32cbe24055"],
  ["0008_nearsleep_live_integration.sql", "e20baef4d0afa565791ee27d55137d172a863c25ac34f00d31d51e2b23597549"],
  ["0009_nearsleep_audio_atomic.sql", "81644666644ca8fc9648dcf539a0e4cc26a16caee147170e1572360f4b02dedc"],
  ["0010_child_profile_pronunciation.sql", "7e531ef1600ac930f5ea7a6d649f11b78c8bdb7ba25c82f555b44863d9ca6e41"],
  ["0011_household_billing_accounts.sql", "8339773ad4f521880737f05f2e4a0066d5f327fccf25cafac6f425dcd214dc42"],
  ["0012_nearsleep_library_privacy.sql", "91799e96d5cde8fe695bada23778f1877838144defe233674fc742d009817cf6"],
  ["0013_nearstory_parent_beta.sql", "232a7f19e08a3e769c2cf89ec7027313dfabb636e229a0499d209cc3c9a2ff5f"],
  ["0014_nearlegacy_archive.sql", "864b124ebf0c215f6ab4a56619e6f8c4af964ef942467d29a8974592c2dbb5e1"],
  ["0015_platform_release_foundation.sql", "e0de08e54add3a4276f8b50f017a92a8fb6a9443bd400a40676f5f5a91219cef"],
  ["0016_marketing_waitlist.sql", "d559c5b5f760d974f071d1f64d481519fb25a78b209213bf90a77090c4b987d1"],
  ["0017_cutover_source_runtime.sql", "2161df74e3ee4ef4e4b5ac60e1750742ff4beb7ae168983e9585b5b2c966c5fb"],
  ["0018_cutover_inventory_fence.generated.sql", "f5309f824976f10487274a2742bcc930217908c9415b5b6ad929e4a422be102c"],
  ["0019_mobile_entitlement_runtime.sql", "44d27949aa48d02c11828b7687daab443c9e225bdfd87a8adeae37c54791d8f1"],
  ["0020_product_release_readiness.sql", "546abbb1677b320358178d855963030259c4f74f18eea99386f750d0e9f1b719"],
  ["0021_story_rollout_telemetry.sql", "d12d8cea8688d7eadb4b72de35995ccf1b30a03e8a740cd6056fd79ba9960800"],
  ["0022_operational_outcome_outbox.sql", "d5cbdf52271e0728eb9b8849316078c66f64183efedeb94b7047bb954ec76353"],
  ["0023_nearfamily_capacity.sql", "30251bccf66675f376203d7624f4bc3d398152009b73853c2383291e0b82de21"],
  ["0024_nearfamily_capacity_authority.sql", "2b89edfb6e76db6d8abac9477cf2f89b8ee71597c7eb845d06f1824f8876b083"],
  ["0025_nearfamily_tenant_binding.sql", "869ae219a5a998f2e58de18c27891d97ec6dd4fe9c90d573b7d6cd9a5efb90d7"],
] as const);
const DEPLOYED = FILES.slice(0, 17);
const DEFERRED = FILES.slice(17);

async function sha256(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function validateSourceMigrations(root: string) {
  const actualNames = (await readdir(join(root, "drizzle"))).filter((name) => name.endsWith(".sql")).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(FILES.map(([name]) => name))) throw new Error("Sites migration source set invalid");
  for (const [name, expected] of FILES) {
    const path = join(root, "drizzle", name);
    if (!(await stat(path)).isFile() || await sha256(path) !== expected) throw new Error("Sites migration source checksum invalid");
  }
}

export async function stageDarkSitesRelease(input: { root: URL; stageDirectory: string }) {
  if ((await readdir(input.stageDirectory)).length !== 0) throw new Error("Sites stage must be empty");
  const root = fileURLToPath(input.root);
  await validateSourceMigrations(root);

  await mkdir(join(input.stageDirectory, "drizzle"), { recursive: true });
  for (const [name] of DEPLOYED) await cp(join(root, "drizzle", name), join(input.stageDirectory, "drizzle", name));
  await cp(join(root, "dist"), join(input.stageDirectory, "dist"), { recursive: true });
  await rm(join(input.stageDirectory, "dist/.openai/drizzle"), { recursive: true, force: true });
  await mkdir(join(input.stageDirectory, ".openai"), { recursive: true });
  await cp(join(root, ".openai/hosting.json"), join(input.stageDirectory, ".openai/hosting.json"));

  return Object.freeze({
    deployedHead: DEPLOYED.at(-1)![0],
    deployedMigrations: Object.freeze(DEPLOYED.map(([name]) => name)),
    deferredMigrations: Object.freeze(DEFERRED.map(([name]) => name)),
  });
}

export async function packageExistingSitesRelease(input: { root: URL; archive: string; officialHelper: string }) {
  if (!input.archive.startsWith("/") || !input.officialHelper.startsWith("/")) throw new Error("Sites package paths invalid");
  const stage = await mkdtemp(join(tmpdir(), "nearyou-sites-existing-stage-"));
  const extracted = await mkdtemp(join(tmpdir(), "nearyou-sites-existing-verify-"));
  try {
    const root = fileURLToPath(input.root);
    await validateSourceMigrations(root);
    await cp(join(root, "dist"), join(stage, "dist"), { recursive: true });
    await rm(join(stage, "dist/.openai/drizzle"), { recursive: true, force: true });
    await mkdir(join(stage, ".openai"), { recursive: true });
    await cp(join(root, ".openai/hosting.json"), join(stage, ".openai/hosting.json"));
    await mkdir(dirname(input.archive), { recursive: true });
    await execFile(input.officialHelper, [stage, input.archive]);
    await execFile("tar", ["-xzf", input.archive, "-C", extracted]);
    await readdir(join(extracted, "dist/.openai/drizzle")).then(
      () => { throw new Error("Sites existing-schema package contains migrations"); },
      (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
    );
    if (!(await stat(join(extracted, "dist/server/index.js"))).isFile() || !(await stat(join(extracted, "dist/.openai/hosting.json"))).isFile()) throw new Error("Sites package runtime invalid");
    return Object.freeze({
      requiredSchemaHead: DEPLOYED.at(-1)![0],
      requiredMigrations: Object.freeze(DEPLOYED.map(([name]) => name)),
      packagedMigrations: Object.freeze([] as string[]),
      archive: input.archive,
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(extracted, { recursive: true, force: true });
  }
}

export async function packageDarkSitesRelease(input: { root: URL; archive: string; officialHelper: string }) {
  if (!input.archive.startsWith("/") || !input.officialHelper.startsWith("/")) throw new Error("Sites package paths invalid");
  const stage = await mkdtemp(join(tmpdir(), "nearyou-sites-dark-stage-"));
  const extracted = await mkdtemp(join(tmpdir(), "nearyou-sites-dark-verify-"));
  try {
    const plan = await stageDarkSitesRelease({ root: input.root, stageDirectory: stage });
    await mkdir(dirname(input.archive), { recursive: true });
    await execFile(input.officialHelper, [stage, input.archive]);
    await execFile("tar", ["-xzf", input.archive, "-C", extracted]);
    const packaged = (await readdir(join(extracted, "dist/.openai/drizzle"))).filter((name) => name.endsWith(".sql")).sort();
    if (JSON.stringify(packaged) !== JSON.stringify(plan.deployedMigrations)) throw new Error("Sites package migration boundary invalid");
    const root = fileURLToPath(input.root);
    for (const [name, expected] of DEPLOYED) {
      const source = join(root, "drizzle", name);
      const archived = join(extracted, "dist/.openai/drizzle", name);
      if (await sha256(source) !== expected || await sha256(archived) !== expected) throw new Error("Sites package migration checksum invalid");
    }
    if (!(await stat(join(extracted, "dist/server/index.js"))).isFile() || !(await stat(join(extracted, "dist/.openai/hosting.json"))).isFile()) throw new Error("Sites package runtime invalid");
    return Object.freeze({ ...plan, archive: input.archive });
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(extracted, { recursive: true, force: true });
  }
}

function parseArgs(args: string[]) {
  if (args.length !== 6 || args[0] !== "--mode" || args[1] !== "existing-schema" || args[2] !== "--archive" || args[4] !== "--helper") throw new Error("Sites package arguments invalid");
  return { archive: resolve(args[3]!), officialHelper: resolve(args[5]!) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  packageExistingSitesRelease({ root: new URL("../", import.meta.url), ...options })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => { process.stderr.write("Sites dark package failed\n"); process.exitCode = 1; });
}
