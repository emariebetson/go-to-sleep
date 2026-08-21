import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import {
  requireReadinessGatewayProofEnvironment,
  verifyReadinessGatewayProof,
} from "../scripts/verify-readiness-gateway.ts";
import { createDisposableGatewayHandler } from "../services/readiness-gateway/src/runtime.ts";
import { runReadinessDenialProbe } from "../scripts/readiness-denial-probe.ts";
import { createDisposableDecisionWorker } from "../cloudflare/readiness-disposable-worker.ts";

const execFile = promisify(execFileCallback);
const tfvarsPath = new URL("../infra/disposable/readiness-gateway.tfvars.example", import.meta.url);

const productionDirectory = fileURLToPath(new URL("../infra/production", import.meta.url));
const source = readdirSync(productionDirectory)
  .filter((name) => name.endsWith(".tf"))
  .sort()
  .map((name) => readFileSync(path.join(productionDirectory, name), "utf8"))
  .join("\n");

test("readiness gateway declares distinct decision, controller, and kill service accounts", () => {
  assert.match(source, /resource "google_service_account" "readiness_decision"/);
  assert.match(source, /resource "google_service_account" "readiness_controller_kill"/);
  assert.match(source, /google_service_account\.readiness_controller\.email/);

  const identities = [...source.matchAll(/google_service_account\.([a-z_]+)(?:\[0\])?\.email/g)].map((entry) => entry[1]);
  const unique = new Set(identities);
  assert.equal(unique.has("readiness_decision"), true);
  assert.equal(unique.has("readiness_controller"), true);
  assert.equal(unique.has("readiness_controller_kill"), true);
});

test("readiness decision service enforces exactly one max instance, 10 concurrency, and two-second timeout", () => {
  assert.match(source, /resource "google_cloud_run_v2_service" "readiness_decision"/);
  assert.match(source, /max_instance_count\s*=\s*1/);
  assert.match(source, /max_instance_request_concurrency\s*=\s*10/);
  assert.match(source, /timeout\s*=\s*"2s"/);
  assert.match(source, /ingress\s*=\s*"INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"/);
  assert.match(source, /default_uri_disabled\s*=\s*true/);
  assert.match(source, /invoker_iam_disabled\s*=\s*true/);
});

test("readiness controller and kill services are private, vpc-routed, and identity-distinct", () => {
  assert.match(source, /resource "google_cloud_run_v2_service" "readiness_controller"/);
  assert.match(source, /resource "google_cloud_run_v2_service" "readiness_controller_kill"/);
  assert.match(source, /INGRESS_TRAFFIC_INTERNAL_ONLY/);

  const serviceAccounts = new Set(
    [...source.matchAll(/google_service_account\.(readiness_[a-z_]+)(?:\[0\])?\.email/g)].map((entry) => entry[1]),
  );
  assert.equal(serviceAccounts.has("readiness_decision"), true);
  assert.equal(serviceAccounts.has("readiness_controller"), true);
  assert.equal(serviceAccounts.has("readiness_controller_kill"), true);
  assert.equal(serviceAccounts.size, 3);

  const controller = source.match(/resource "google_cloud_run_v2_service" "readiness_controller" \{([\s\S]*?)\n\}/)?.[1] || "";
  const kill = source.match(/resource "google_cloud_run_v2_service" "readiness_controller_kill" \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(controller, /INGRESS_TRAFFIC_INTERNAL_ONLY/);
  assert.match(kill, /INGRESS_TRAFFIC_INTERNAL_ONLY/);
});

test("readiness decision is reachable only through an external load balancer protected by Cloud Armor", () => {
  assert.match(source, /resource "google_compute_region_network_endpoint_group" "readiness_decision"/);
  assert.match(source, /network_endpoint_type\s*=\s*"SERVERLESS"/);
  assert.match(source, /resource "google_compute_backend_service" "readiness_decision"/);
  assert.match(source, /resource "google_compute_security_policy" "readiness_decision"/);
  assert.match(source, /rate_limit_options/);
  assert.match(source, /resource "google_compute_target_https_proxy" "readiness_decision"/);
  assert.match(source, /resource "google_compute_global_forwarding_rule" "readiness_decision"/);
});

test("readiness gateway never exposes public IAM members", () => {
  assert.ok(!/allUsers/.test(source), "readiness gateway file must not include allUsers");
  assert.ok(!/allAuthenticatedUsers/.test(source), "readiness gateway file must not include allAuthenticatedUsers");
});

test("readiness gateway binds separate Cloud SQL roles for decision and controller identities", () => {
  assert.match(source, /resource "google_project_iam_member" "readiness_decision_cloudsql_client"/);
  assert.match(source, /resource "google_project_iam_member" "readiness_controller_cloudsql_client"/);
  assert.match(source, /resource "google_project_iam_member" "readiness_controller_kill_cloudsql_client"/);

  assert.match(source, /resource "google_sql_user" "readiness_decision"/);
  assert.match(source, /resource "google_sql_user" "readiness_controller_kill"/);
});

test("readiness gateway reuses the existing controller OIDC principal instead of redeclaring it", () => {
  const gatewaySource = readFileSync(new URL("../infra/production/readiness-gateway.tf", import.meta.url), "utf8");
  assert.doesNotMatch(gatewaySource, /readiness_controller_oidc_principal\s*=/);
});

test("readiness gateway kill service account uses a Google-valid account ID", () => {
  const gatewaySource = readFileSync(new URL("../infra/production/readiness-gateway.tf", import.meta.url), "utf8");
  assert.match(gatewaySource, /account_id\s*=\s*"nearyou-readiness-kill"/);
});

test("readiness gateway provisions only under an explicit disposable-proof gate", () => {
  const gatewaySource = readFileSync(new URL("../infra/production/readiness-gateway.tf", import.meta.url), "utf8");
  const variables = readFileSync(new URL("../infra/production/variables.tf", import.meta.url), "utf8");
  assert.match(variables, /variable "readiness_gateway_disposable"/);
  assert.match(variables, /variable "readiness_gateway_proof_approved"/);
  assert.match(gatewaySource, /readiness_gateway_proof_ready\s*=\s*var\.readiness_gateway_disposable\s*&&\s*var\.readiness_gateway_proof_approved/);
  assert.match(gatewaySource, /resource "google_cloud_run_v2_service" "readiness_decision" \{[\s\S]*?count\s*=\s*local\.readiness_gateway_proof_ready/);
  assert.match(gatewaySource, /resource "google_service_account" "readiness_decision" \{[\s\S]*?count\s*=\s*local\.readiness_gateway_proof_ready/);
});

test("readiness gateway tfvars example exists and contains dedicated identity and secret inputs", () => {
  assert.equal(existsSync(tfvarsPath), true);
  const values = readFileSync(tfvarsPath, "utf8");
  assert.match(values, /readiness_decision_secret_name/);
  assert.match(values, /readiness_controller_secret_name/);
  assert.match(values, /readiness_kill_secret_name/);
  assert.match(values, /readiness_decision_image_digest/);
  assert.match(values, /readiness_controller_image_digest/);
  assert.match(values, /readiness_kill_service_audience/);
});

test("disposable readiness gateway image pins its base and starts the guarded runtime", () => {
  const dockerfile = readFileSync(new URL("../services/readiness-gateway/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^FROM node:24-bookworm@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /npm install --global tsx@4\.22\.1/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /runtime\.ts/);
});

test("readiness gateway proof proof requires disposable target and explicit vars", () => {
  assert.throws(() => requireReadinessGatewayProofEnvironment({}), /Readiness gateway proof requires an explicit disposable deployment/);
  assert.throws(
    () => requireReadinessGatewayProofEnvironment({ READINESS_GATEWAY_DISPOSABLE: "true", READINESS_GATEWAY_GCP_PROJECT: "bad" }),
    /READINESS_GATEWAY_GCP_PROJECT/,
  );
});

function proofEnvironment() {
  return {
    READINESS_GATEWAY_DISPOSABLE: "true",
    READINESS_GATEWAY_GCP_PROJECT: "nearyou-rdy-gwy",
    READINESS_GATEWAY_REGION: "us-central1",
    READINESS_GATEWAY_TFVARS: tfvarsPath.pathname,
    READINESS_GATEWAY_DECISION_SERVICE: "nearyou-readiness-decision",
    READINESS_GATEWAY_CONTROLLER_SERVICE: "nearyou-readiness-controller",
    READINESS_GATEWAY_KILL_SERVICE: "nearyou-readiness-controller-kill",
    READINESS_GATEWAY_BACKEND_SERVICE: "nearyou-readiness-decision",
    READINESS_GATEWAY_CLOUD_ARMOR_POLICY: "nearyou-readiness-decision",
    READINESS_GATEWAY_DENIAL_PROBE_COMMAND: "readiness-denial-probe",
  };
}

function commandRunner(overrides = {}) {
  const runService = (name, ingress, publicInvoker = false) => JSON.stringify({
    name,
    ingress,
    defaultUriDisabled: name === "nearyou-readiness-decision",
    invokerIamDisabled: publicInvoker,
    latestReadyRevision: `${name}-00001-a1b`,
    template: {
      serviceAccount: `${name}@nearyou-rdy-gwy.iam.gserviceaccount.com`,
      vpcAccess: { egress: "PRIVATE_RANGES_ONLY", networkInterfaces: [{ network: "private", subnetwork: "private" }] },
      containers: [{ image: `us-docker.pkg.dev/nearyou-rdy-gwy/readiness/${name}@sha256:${"a".repeat(64)}` }],
    },
  });
  return async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    if (file === "readiness-denial-probe") return { stdout: JSON.stringify({ missingHmac: 401, invalidHmac: 401, replayedHmac: 401, directCloudRun: 404, wrongAudience: 401, controllerEscalation: 403 }) };
    if (key.includes("run services describe nearyou-readiness-controller-kill")) return { stdout: runService("nearyou-readiness-controller-kill", "INGRESS_TRAFFIC_INTERNAL_ONLY") };
    if (key.includes("run services describe nearyou-readiness-controller")) return { stdout: runService("nearyou-readiness-controller", "INGRESS_TRAFFIC_INTERNAL_ONLY") };
    if (key.includes("run services describe nearyou-readiness-decision")) return { stdout: runService("nearyou-readiness-decision", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", true) };
    if (key.includes("run services get-iam-policy")) return { stdout: JSON.stringify({ bindings: [{ role: "roles/run.invoker", members: ["serviceAccount:reviewed-builder@nearyou-rdy-gwy.iam.gserviceaccount.com"] }] }) };
    if (key.includes("compute backend-services describe")) return { stdout: JSON.stringify({ loadBalancingScheme: "EXTERNAL_MANAGED", securityPolicy: "https://www.googleapis.com/compute/v1/projects/nearyou-rdy-gwy/global/securityPolicies/nearyou-readiness-decision", backends: [{ group: "https://www.googleapis.com/compute/v1/projects/nearyou-rdy-gwy/regions/us-central1/networkEndpointGroups/nearyou-readiness-decision" }] }) };
    if (key.includes("compute security-policies describe")) return { stdout: JSON.stringify({ rules: [{ priority: 1000, action: "throttle", rateLimitOptions: { rateLimitThreshold: { count: 60, intervalSec: 60 } } }] }) };
    throw new Error(`unexpected command: ${key}`);
  };
}

test("readiness gateway proof hashes live read-only evidence and denial probes without emitting values", async () => {
  const result = await verifyReadinessGatewayProof(proofEnvironment(), commandRunner());
  assert.equal(result.ready, true);
  assert.match(result.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(result).sort(), ["evidenceSha256", "ready", "verification"]);
  assert.equal(result.verification.defaultUrlDisabled, true);
  assert.equal(result.verification.denialProbes, true);
});

test("readiness gateway proof rejects public IAM, wrong ingress, shared identities, missing VPC, and malformed probe output", async () => {
  const cases = [
    ["public IAM", async (file, args) => {
      if (`${file} ${args.join(" ")}`.includes("get-iam-policy")) return { stdout: JSON.stringify({ bindings: [{ members: ["allUsers"] }] }) };
      return commandRunner()(file, args);
    }, /public IAM/],
    ["wrong ingress", async (file, args) => {
      if (`${file} ${args.join(" ")}`.includes("describe nearyou-readiness-decision")) return { stdout: JSON.stringify({ name: "nearyou-readiness-decision", ingress: "INGRESS_TRAFFIC_ALL", defaultUriDisabled: true, invokerIamDisabled: true, latestReadyRevision: "r", template: { serviceAccount: "decision", vpcAccess: { egress: "PRIVATE_RANGES_ONLY", networkInterfaces: [{}] }, containers: [{ image: `x@sha256:${"a".repeat(64)}` }] } }) };
      return commandRunner()(file, args);
    }, /decision ingress/],
    ["shared identity", async (file, args) => {
      if (`${file} ${args.join(" ")}`.includes("describe nearyou-readiness-controller")) return { stdout: JSON.stringify({ name: "nearyou-readiness-controller", ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY", defaultUriDisabled: false, invokerIamDisabled: false, latestReadyRevision: "r", template: { serviceAccount: "nearyou-readiness-decision@nearyou-rdy-gwy.iam.gserviceaccount.com", vpcAccess: { egress: "PRIVATE_RANGES_ONLY", networkInterfaces: [{}] }, containers: [{ image: `x@sha256:${"a".repeat(64)}` }] } }) };
      return commandRunner()(file, args);
    }, /distinct service accounts/],
    ["missing private VPC", async (file, args) => {
      if (`${file} ${args.join(" ")}`.includes("describe nearyou-readiness-controller-kill")) return { stdout: JSON.stringify({ name: "nearyou-readiness-controller-kill", ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY", defaultUriDisabled: false, invokerIamDisabled: false, latestReadyRevision: "r", template: { serviceAccount: "kill", containers: [{ image: `x@sha256:${"a".repeat(64)}` }] } }) };
      return commandRunner()(file, args);
    }, /private VPC/],
    ["malformed probe", async (file, args) => file === "readiness-denial-probe" ? { stdout: "not-json" } : commandRunner()(file, args), /denial probe/],
  ];
  for (const [, runner, expected] of cases) await assert.rejects(() => verifyReadinessGatewayProof(proofEnvironment(), runner), expected);
});

test("readiness gateway proof CLI rejects omitted disposable confirmation", async () => {

  await assert.rejects(() => execFile(process.execPath, ["--import", "tsx", "scripts/verify-readiness-gateway.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, READINESS_GATEWAY_DISPOSABLE: "false" },
  }),
    (error) => error.code === 1 && /Readiness gateway proof requires an explicit disposable deployment/.test(error.stderr || ""),
  );
});

test("disposable runtime refuses production mode and keeps controller lanes closed", async () => {
  assert.throws(() => createDisposableGatewayHandler({ mode: "decision", disposable: false, key: new Uint8Array(32), now: () => 1_787_000_000_000 }), /disposable/);
  for (const mode of ["controller", "kill"]) {
    const handler = createDisposableGatewayHandler({ mode, disposable: true, key: new Uint8Array(32), now: () => 1_787_000_000_000 });
    assert.equal((await handler(new Request("https://internal.example/v1/nearfamily/controller", { method: "POST" }))).status, 403);
  }
});

test("real denial probe requires one accepted HMAC then proves missing, invalid, replayed, and direct denials", async () => {
  const now = 1_787_000_000_000;
  const key = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
  const decision = createDisposableGatewayHandler({ mode: "decision", disposable: true, key, now: () => now });
  const fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === "https://lb.example/v1/nearfamily/decision") return decision(new Request(target, init));
    if (target === "https://decision.run.app/v1/nearfamily/decision") return new Response("", { status: 404 });
    if (target.includes("controller.run.app")) return new Response("", { status: 403 });
    throw new Error(`unexpected URL ${target}`);
  };
  assert.deepEqual(await runReadinessDenialProbe({
    gatewayUrl: "https://lb.example/v1/nearfamily/decision",
    directDecisionUrl: "https://decision.run.app/v1/nearfamily/decision",
    controllerUrl: "https://controller.run.app/v1/nearfamily/controller",
    key,
    now,
    nonce: "nonce_abcdefghijklmnopqrstuv",
    fetch,
  }), { missingHmac: 401, invalidHmac: 401, replayedHmac: 401, directCloudRun: 404, wrongAudience: 403, controllerEscalation: 403 });
});

test("disposable Cloudflare Worker signs one canonical decision and forwards only to the HTTPS gateway", async () => {
  const now = 1_787_000_000_000;
  const key = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
  const decision = createDisposableGatewayHandler({ mode: "decision", disposable: true, key, now: () => now });
  const forwarded = [];
  const worker = createDisposableDecisionWorker({
    gatewayUrl: "https://lb.example/v1/nearfamily/decision",
    keyBase64: Buffer.from(key).toString("base64"),
    now: () => now,
    nonce: () => "nonce_abcdefghijklmnopqrstuv",
    fetch: async (url, init) => {
      forwarded.push(String(url));
      return decision(new Request(String(url), init));
    },
  });
  const body = '{"householdHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","releaseId":"rel_20260819_readiness_gateway_01"}';
  const response = await worker(new Request("https://worker.example/v1/nearfamily/decision", { method: "POST", headers: { "content-type": "application/json" }, body }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: 1, allowed: false });
  assert.deepEqual(forwarded, ["https://lb.example/v1/nearfamily/decision"]);
});
