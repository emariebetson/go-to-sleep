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
import * as readinessGatewayRuntime from "../services/readiness-gateway/src/runtime.ts";
import { runReadinessDenialProbe } from "../scripts/readiness-denial-probe.ts";
import { createDisposableDecisionWorker } from "../cloudflare/readiness-disposable-worker.ts";

const execFile = promisify(execFileCallback);
const { createDatabaseBackedDecisionHandler, createDisposableGatewayHandler } = readinessGatewayRuntime;
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
  assert.match(source, /resource "google_cloud_run_v2_service_iam_member" "readiness_controller_invoker"/);
  assert.match(source, /resource "google_cloud_run_v2_service_iam_member" "readiness_controller_kill_invoker"/);
  assert.doesNotMatch(controller, /invoker_iam_disabled\s*=\s*true/);
  assert.doesNotMatch(kill, /invoker_iam_disabled\s*=\s*true/);
  assert.match(source, /member\s*=\s*"serviceAccount:\$\{var\.readiness_controller_caller_service_account_email\}"/);
  assert.match(source, /member\s*=\s*"serviceAccount:\$\{var\.readiness_kill_caller_service_account_email\}"/);
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
  assert.doesNotMatch(source, /database_roles\s*=/);
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

test("readiness gateway tfvars example contains the HMAC window and private-service audiences", () => {
  assert.equal(existsSync(tfvarsPath), true);
  const values = readFileSync(tfvarsPath, "utf8");
  assert.match(values, /readiness_decision_secret_name/);
  assert.match(values, /readiness_decision_key_not_before/);
  assert.match(values, /readiness_decision_key_not_after/);
  assert.match(values, /readiness_controller_service_audience/);
  assert.match(values, /readiness_decision_image_digest/);
  assert.match(values, /readiness_controller_image_digest/);
  assert.match(values, /readiness_kill_service_audience/);
});

test("disposable readiness gateway image pins its base and starts the guarded runtime", () => {
  const dockerfile = readFileSync(new URL("../services/readiness-gateway/Dockerfile", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../services/readiness-gateway/package.json", import.meta.url), "utf8"));
  const packageLock = JSON.parse(readFileSync(new URL("../services/readiness-gateway/package-lock.json", import.meta.url), "utf8"));
  assert.match(dockerfile, /^FROM node:24-bookworm@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /npm ci --ignore-scripts --omit=dev --no-audit --no-fund/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /runtime\.ts/);
  assert.match(dockerfile, /COPY services\/readiness-controller\/src \.\/services\/readiness-controller\/src/);
  assert.match(dockerfile, /COPY lib\/private-tester-activation\.ts \.\/lib\/private-tester-activation\.ts/);
  assert.deepEqual(packageJson.dependencies, { "@google-cloud/cloud-sql-connector": "1.11.3", "google-auth-library": "10.9.1", pg: "8.16.3", tsx: "4.22.1" });
  assert.equal(packageLock.lockfileVersion, 3);
});

test("Terraform binds the exact database-backed runtime contract", () => {
  const gatewaySource = readFileSync(new URL("../infra/production/readiness-gateway.tf", import.meta.url), "utf8");
  for (const value of ["decision", "controller", "kill"]) assert.match(gatewaySource, new RegExp(`READINESS_GATEWAY_MODE[\\s\\S]{0,120}value\\s*=\\s*"${value}"`));
  for (const name of [
    "READINESS_GATEWAY_DISPOSABLE",
    "READINESS_GATEWAY_DATABASE_BACKED",
    "READINESS_GATEWAY_CLOUD_SQL_INSTANCE",
    "READINESS_GATEWAY_DATABASE_USER",
    "READINESS_GATEWAY_DATABASE_NAME",
    "READINESS_GATEWAY_ORDINARY_AUDIENCE",
    "READINESS_GATEWAY_ORDINARY_CALLER",
    "READINESS_GATEWAY_EMERGENCY_AUDIENCE",
    "READINESS_GATEWAY_EMERGENCY_CALLER",
  ]) assert.match(gatewaySource, new RegExp(name));
  assert.match(gatewaySource, /READINESS_GATEWAY_HMAC_KEY_FILE[\s\S]{0,160}\/var\/run\/secrets\/nearyou\/hmac-key/);
  assert.match(gatewaySource, /READINESS_GATEWAY_KEY_NOT_BEFORE/);
  assert.match(gatewaySource, /READINESS_GATEWAY_KEY_NOT_AFTER/);
  assert.doesNotMatch(gatewaySource, /path\s*=\s*"database-url"/);
  assert.match(gatewaySource, /resource "google_secret_manager_secret_iam_member" "readiness_decision_hmac_accessor"[\s\S]*roles\/secretmanager\.secretAccessor[\s\S]*google_service_account\.readiness_decision\[0\]\.email/);
});

test("migration registration includes both ordinary and emergency controller identities", () => {
  const migrationJob = readFileSync(new URL("../infra/production/storage-queues.tf", import.meta.url), "utf8");
  assert.match(migrationJob, /NEARYOU_READINESS_KILL_DATABASE_USER/);
  assert.match(migrationJob, /NEARYOU_READINESS_KILL_OIDC_PRINCIPAL/);
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
    READINESS_GATEWAY_URL: "https://lb.example/v1/nearfamily/decision",
    READINESS_GATEWAY_DIRECT_DECISION_URL: "https://decision.run.app/v1/nearfamily/decision",
    READINESS_GATEWAY_CONTROLLER_URL: "https://controller.run.app/v1/nearfamily/controller",
    READINESS_GATEWAY_HMAC_KEY_FILE: tfvarsPath.pathname,
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
  const calls = [];
  const runner = commandRunner();
  const result = await verifyReadinessGatewayProof(proofEnvironment(), async (file, args) => { calls.push({ file, args }); return runner(file, args); });
  assert.equal(result.ready, true);
  assert.match(result.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(result).sort(), ["evidenceSha256", "ready", "verification"]);
  assert.equal(result.verification.defaultUrlDisabled, true);
  assert.equal(result.verification.denialProbes, true);
  assert.deepEqual(calls.find((call) => call.file === "readiness-denial-probe")?.args, [
    "--gateway-url", "https://lb.example/v1/nearfamily/decision",
    "--direct-decision-url", "https://decision.run.app/v1/nearfamily/decision",
    "--controller-url", "https://controller.run.app/v1/nearfamily/controller",
    "--key-file", tfvarsPath.pathname,
  ]);
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

test("database-backed disposable decision runtime uses PostgreSQL for clock, nonce, and authority", async () => {
  const now = 1_787_000_000_000;
  const key = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
  const calls = [];
  const pg = { query: async (sql) => {
    calls.push(sql);
    if (sql.includes("statement_timestamp")) return { rows: [{ observed_at: String(now) }] };
    if (sql.includes("consume_nearfamily_decision_nonce")) return { rows: [{ consumed: true }] };
    if (sql.includes("authorize_nearfamily_private_tester")) return { rows: [{ allowed: false, expires_at: null }] };
    throw new Error("unexpected SQL");
  } };
  const handler = createDatabaseBackedDecisionHandler({ disposable: true, key, pg, keyNotBefore: now - 60_000, keyNotAfter: now + 172_800_000 });
  const releaseId = "rel_20260819_readiness_gateway_01", householdHash = "a".repeat(64), nonce = "nonce_abcdefghijklmnopqrstuv";
  const bodySha256 = await (await import("../services/readiness-decision/src/envelope.ts")).sha256Hex(JSON.stringify({ householdHash, releaseId }));
  const claims = { version: 1, releaseId, householdHash, issuedAt: now, nonce, bodySha256, keyVersion: 1 };
  const envelope = (await import("../services/readiness-decision/src/envelope.ts")).canonicalDecisionEnvelope({ ...claims, signature: await (await import("../services/readiness-decision/src/envelope.ts")).signDecisionEnvelope(claims, key) });
  const response = await handler(new Request("https://lb.example/v1/nearfamily/decision", { method: "POST", headers: { "content-type": "application/json" }, body: envelope }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: 1, allowed: false });
  assert.equal(calls.length, 3);
  assert.match(calls[0], /statement_timestamp/);
  assert.match(calls[1], /consume_nearfamily_decision_nonce/);
  assert.match(calls[2], /authorize_nearfamily_private_tester/);
});

test("database-backed emergency runtime isolates its route and reaches the terminal PostgreSQL transaction", async () => {
  assert.equal(typeof readinessGatewayRuntime.createDatabaseBackedControllerHandler, "function");
  const now = 1_787_000_000_000;
  const releaseId = "rel_20260819_readiness_gateway_01";
  const calls = [];
  const pg = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes("statement_timestamp")) return { rows: [{ observed_at: String(now) }] };
      if (sql.includes("private_tester_activation_controller_principal")) return { rows: [{ principal: "service:nearyou_readiness_controller_kill" }] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    transaction: async (run) => run({ query: async (sql) => {
      calls.push(sql);
      if (!sql.includes("apply_private_tester_activation")) throw new Error(`unexpected transaction SQL: ${sql}`);
      return { rows: [{ result: { product: "nearfamily", releaseId, version: 2, globalPercent: 0, status: "killed", auditDigest: "f".repeat(64) } }] };
    } }),
  };
  const handler = readinessGatewayRuntime.createDatabaseBackedControllerHandler({
    mode: "kill",
    disposable: true,
    pg,
    ordinaryIdentity: { issuer: "https://accounts.google.com", audience: "https://nf-rdy-controller.example.run.app", subject: "ordinary-caller@nearnight.iam.gserviceaccount.com" },
    emergencyIdentity: { issuer: "https://accounts.google.com", audience: "https://nf-rdy-kill.example.run.app", subject: "kill-caller@nearnight.iam.gserviceaccount.com" },
    verifyIdToken: async ({ audience }) => ({ issuer: "https://accounts.google.com", audience, subject: "kill-caller@nearnight.iam.gserviceaccount.com", expiresAt: now + 60_000 }),
  });
  const wrongLane = await handler(new Request("https://internal.example/v1/nearfamily/controller", { method: "POST" }));
  assert.equal(wrongLane.status, 404);
  assert.equal(calls.length, 0);
  const body = JSON.stringify({
    action: "kill",
    expectedVersion: 1,
    invites: [],
    operationId: "kill-nearfamily-000001",
    product: "nearfamily",
    promotedBaselineSha256: "b".repeat(64),
    releaseEvidenceDigest: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    releaseId,
  });
  const response = await handler(new Request("https://internal.example/v1/nearfamily/emergency", {
    method: "POST",
    headers: {
      authorization: "Bearer emergency-token",
      "content-type": "application/json",
      "x-nearyou-request-sha256": await (await import("../services/readiness-decision/src/envelope.ts")).sha256Hex(body),
    },
    body,
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "killed");
  assert.equal(calls.some((sql) => sql.includes("load_private_tester_activation_baseline")), false);
  assert.equal(calls.some((sql) => sql.includes("load_private_tester_activation_evidence")), false);
  assert.equal(calls.some((sql) => sql.includes("apply_private_tester_activation")), true);
});

test("Google ID-token verification binds the verified service-account email to the exact audience", async () => {
  assert.equal(typeof readinessGatewayRuntime.createGoogleIdTokenVerifier, "function");
  const calls = [];
  const verify = readinessGatewayRuntime.createGoogleIdTokenVerifier({
    verifyIdToken: async (input) => {
      calls.push(input);
      return { getPayload: () => ({
        iss: "https://accounts.google.com",
        aud: "https://nf-rdy-kill.example.run.app",
        sub: "123456789012345678901",
        email: "kill-caller@nearnight.iam.gserviceaccount.com",
        email_verified: true,
        exp: 1_787_000_060,
      }) };
    },
  });
  assert.deepEqual(await verify({ token: "emergency-token", audience: "https://nf-rdy-kill.example.run.app" }), {
    issuer: "https://accounts.google.com",
    audience: "https://nf-rdy-kill.example.run.app",
    subject: "kill-caller@nearnight.iam.gserviceaccount.com",
    expiresAt: 1_787_000_060_000,
  });
  assert.deepEqual(calls, [{ idToken: "emergency-token", audience: "https://nf-rdy-kill.example.run.app" }]);
  const unverified = readinessGatewayRuntime.createGoogleIdTokenVerifier({ verifyIdToken: async () => ({ getPayload: () => ({
    iss: "https://accounts.google.com",
    aud: "https://nf-rdy-kill.example.run.app",
    email: "kill-caller@nearnight.iam.gserviceaccount.com",
    email_verified: false,
    exp: 1_787_000_060,
  }) }) });
  await assert.rejects(() => unverified({ token: "emergency-token", audience: "https://nf-rdy-kill.example.run.app" }), /identity/);
});

test("controller PostgreSQL transactions commit once and roll back failed operations", async () => {
  assert.equal(typeof readinessGatewayRuntime.createTransactionalPostgresPool, "function");
  const calls = [];
  const client = {
    query: async (sql, args = []) => {
      calls.push({ sql, args });
      return { rows: [{ value: "ok" }] };
    },
    release: () => calls.push({ sql: "RELEASE", args: [] }),
  };
  const pg = readinessGatewayRuntime.createTransactionalPostgresPool({
    query: async (sql, args) => client.query(sql, args),
    connect: async () => client,
  });
  assert.deepEqual(await pg.transaction((tx) => tx.query("SELECT $1::text AS value", ["ok"])), { rows: [{ value: "ok" }] });
  assert.deepEqual(calls.map((call) => call.sql), ["BEGIN", "SELECT $1::text AS value", "COMMIT", "RELEASE"]);
  calls.length = 0;
  await assert.rejects(() => pg.transaction(async () => { throw new Error("operation failed"); }), /operation failed/);
  assert.deepEqual(calls.map((call) => call.sql), ["BEGIN", "ROLLBACK", "RELEASE"]);
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
    keyHex: Buffer.from(key).toString("hex"),
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

test("disposable Cloudflare Worker never follows gateway redirects", async () => {
  const key = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
  let redirectMode;
  const worker = createDisposableDecisionWorker({
    gatewayUrl: "https://lb.example/v1/nearfamily/decision",
    keyHex: Buffer.from(key).toString("hex"),
    now: () => 1_787_000_000_000,
    nonce: () => "nonce_abcdefghijklmnopqrstuv",
    fetch: async (_url, init) => {
      redirectMode = init.redirect;
      return new Response("moved", { status: 302, headers: { location: "https://attacker.example" } });
    },
  });
  const body = '{"householdHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","releaseId":"rel_20260819_readiness_gateway_01"}';
  const response = await worker(new Request("https://worker.example/v1/nearfamily/decision", { method: "POST", headers: { "content-type": "application/json" }, body }));
  assert.equal(redirectMode, "manual");
  assert.equal(response.status, 503);
});

test("disposable signing worker is service-bound and never has a public workers.dev route", () => {
  const config = readFileSync(new URL("../wrangler.readiness-disposable.jsonc", import.meta.url), "utf8");
  assert.match(config, /"workers_dev"\s*:\s*false/);
  assert.doesNotMatch(config, /"routes"\s*:/);
});
