import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
type CommandResult = { stdout: string; stderr?: string };
export type ReadinessGatewayCommandRunner = (file: string, args: string[]) => Promise<CommandResult>;
type Json = Record<string, unknown>;

const command: ReadinessGatewayCommandRunner = async (file, args) => {
  const result = await execFile(file, args, { maxBuffer: 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
};

function required(environment: Record<string, string | undefined>, name: string, expression: RegExp): string {
  const value = environment[name];
  if (!value || !expression.test(value)) throw new Error(`Readiness gateway proof requires ${name}`);
  return value;
}

export function requireReadinessGatewayProofEnvironment(environment: Record<string, string | undefined>) {
  if (environment.READINESS_GATEWAY_DISPOSABLE !== "true") throw new Error("Readiness gateway proof requires an explicit disposable deployment");
  const project = required(environment, "READINESS_GATEWAY_GCP_PROJECT", /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
  const region = required(environment, "READINESS_GATEWAY_REGION", /^[a-z]+(?:-[a-z]+)+[0-9]$/);
  const tfvars = environment.READINESS_GATEWAY_TFVARS;
  if (!tfvars || !existsSync(tfvars)) throw new Error("Readiness gateway proof requires the readiness gateway terraform vars file");
  return {
    project, region, tfvars,
    decisionService: required(environment, "READINESS_GATEWAY_DECISION_SERVICE", /^[a-z][a-z0-9-]{2,62}$/),
    controllerService: required(environment, "READINESS_GATEWAY_CONTROLLER_SERVICE", /^[a-z][a-z0-9-]{2,62}$/),
    killService: required(environment, "READINESS_GATEWAY_KILL_SERVICE", /^[a-z][a-z0-9-]{2,62}$/),
    backendService: required(environment, "READINESS_GATEWAY_BACKEND_SERVICE", /^[a-z][a-z0-9-]{2,62}$/),
    cloudArmorPolicy: required(environment, "READINESS_GATEWAY_CLOUD_ARMOR_POLICY", /^[a-z][a-z0-9-]{2,62}$/),
    denialProbeCommand: required(environment, "READINESS_GATEWAY_DENIAL_PROBE_COMMAND", /^[A-Za-z0-9._/-]{3,256}$/),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Json).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}
function parseJson(output: string, name: string): Json {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Json;
  } catch { throw new Error(`Readiness gateway ${name} returned malformed JSON`); }
}
async function readJson(runner: ReadinessGatewayCommandRunner, file: string, args: string[], name: string): Promise<Json> {
  try { return parseJson((await runner(file, args)).stdout, name); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("Readiness gateway")) throw error;
    throw new Error(`Readiness gateway ${name} read failed`);
  }
}
function serviceFacts(service: Json, name: string) {
  const template = service.template as Json | undefined;
  const containers = template?.containers;
  const container = Array.isArray(containers) && containers.length === 1 ? containers[0] as Json : undefined;
  const vpc = template?.vpcAccess as Json | undefined;
  const interfaces = vpc?.networkInterfaces;
  const image = container?.image;
  const account = template?.serviceAccount;
  const revision = service.latestReadyRevision;
  if (typeof account !== "string" || typeof revision !== "string" || typeof image !== "string" || !/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`Readiness gateway ${name} service has incomplete revision, image, or identity evidence`);
  if (vpc?.egress !== "PRIVATE_RANGES_ONLY" || !Array.isArray(interfaces) || interfaces.length !== 1) throw new Error(`Readiness gateway ${name} service is missing private VPC configuration`);
  return { account, revision, image, vpc: { egress: vpc.egress, interfaces: interfaces.length } };
}
function assertNoPublicIam(policy: Json, name: string): void {
  const members = Array.isArray(policy.bindings) ? policy.bindings.flatMap((binding) => Array.isArray((binding as Json).members) ? (binding as Json).members : []) : [];
  if (members.some((member) => member === "allUsers" || member === "allAuthenticatedUsers")) throw new Error(`Readiness gateway ${name} has public IAM`);
}
function assertDenialProbes(probes: Json): void {
  for (const key of ["missingHmac", "invalidHmac", "replayedHmac", "directCloudRun", "wrongAudience", "controllerEscalation"]) {
    const status = probes[key];
    if (!Number.isInteger(status) || Number(status) < 400 || Number(status) > 499) throw new Error(`Readiness gateway denial probe failed: ${key}`);
  }
}

export async function verifyReadinessGatewayProof(environment: Record<string, string | undefined> = process.env, runner: ReadinessGatewayCommandRunner = command) {
  const target = requireReadinessGatewayProofEnvironment(environment);
  const prefix = ["--project", target.project];
  const describe = (name: string) => readJson(runner, "gcloud", [...prefix, "run", "services", "describe", name, "--region", target.region, "--format=json"], `${name} service`);
  const policy = (name: string) => readJson(runner, "gcloud", [...prefix, "run", "services", "get-iam-policy", name, "--region", target.region, "--format=json"], `${name} IAM policy`);
  const [decision, controller, kill, decisionPolicy, controllerPolicy, killPolicy, backend, armor] = await Promise.all([
    describe(target.decisionService), describe(target.controllerService), describe(target.killService),
    policy(target.decisionService), policy(target.controllerService), policy(target.killService),
    readJson(runner, "gcloud", [...prefix, "compute", "backend-services", "describe", target.backendService, "--global", "--format=json"], "backend service"),
    readJson(runner, "gcloud", [...prefix, "compute", "security-policies", "describe", target.cloudArmorPolicy, "--format=json"], "Cloud Armor policy"),
  ]);
  if (decision.ingress !== "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" || decision.defaultUriDisabled !== true || decision.invokerIamDisabled !== true) throw new Error("Readiness gateway decision ingress, default URL, or public-invoker check is unsafe");
  if (controller.ingress !== "INGRESS_TRAFFIC_INTERNAL_ONLY" || kill.ingress !== "INGRESS_TRAFFIC_INTERNAL_ONLY") throw new Error("Readiness gateway controller or kill ingress is not internal-only");
  for (const [name, item] of [[target.decisionService, decisionPolicy], [target.controllerService, controllerPolicy], [target.killService, killPolicy]] as const) assertNoPublicIam(item, name);
  const decisionFacts = serviceFacts(decision, "decision");
  const controllerFacts = serviceFacts(controller, "controller");
  const killFacts = serviceFacts(kill, "kill");
  if (new Set([decisionFacts.account, controllerFacts.account, killFacts.account]).size !== 3) throw new Error("Readiness gateway services must use distinct service accounts");
  if (backend.loadBalancingScheme !== "EXTERNAL_MANAGED" || typeof backend.securityPolicy !== "string" || !backend.securityPolicy.endsWith(`/securityPolicies/${target.cloudArmorPolicy}`)) throw new Error("Readiness gateway external load balancer is missing its Cloud Armor policy");
  const rules = Array.isArray(armor.rules) ? armor.rules : [];
  if (!rules.some((rule) => (rule as Json).action === "throttle" && ((rule as Json).rateLimitOptions as Json | undefined)?.rateLimitThreshold)) throw new Error("Readiness gateway Cloud Armor rate limit is missing");
  const probes = await readJson(runner, target.denialProbeCommand, ["--project", target.project, "--region", target.region, "--decision-service", target.decisionService, "--controller-service", target.controllerService, "--kill-service", target.killService], "denial probe");
  assertDenialProbes(probes);
  const evidence = {
    version: 1,
    decision: { revision: digest(decisionFacts.revision), image: digest(decisionFacts.image), vpc: digest(decisionFacts.vpc), identity: digest(decisionFacts.account), iam: digest(decisionPolicy) },
    controller: { revision: digest(controllerFacts.revision), image: digest(controllerFacts.image), vpc: digest(controllerFacts.vpc), identity: digest(controllerFacts.account), iam: digest(controllerPolicy) },
    kill: { revision: digest(killFacts.revision), image: digest(killFacts.image), vpc: digest(killFacts.vpc), identity: digest(killFacts.account), iam: digest(killPolicy) },
    loadBalancer: digest({ scheme: backend.loadBalancingScheme, securityPolicy: backend.securityPolicy, backends: Array.isArray(backend.backends) ? backend.backends : [] }),
    cloudArmor: digest(armor), denials: digest(probes),
  };
  return { ready: true, evidenceSha256: digest(evidence), verification: { defaultUrlDisabled: true, denialProbes: true } };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  verifyReadinessGatewayProof().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "readiness gateway proof unavailable"}\n`);
    process.exitCode = 1;
  });
}
