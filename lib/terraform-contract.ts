import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type Block = { kind: string; labels: string[]; body: string };
function parse(source: string): Block[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*#.*(?=\n|$)/g, "$1").replace(/(^|\n)\s*\/\/.*(?=\n|$)/g, "$1");
  const blocks: Block[] = [];
  const head = /\b(terraform|provider|variable|resource|data)\s*((?:"[^"]*"\s*)*)\{/g;
  for (let match; (match = head.exec(clean));) {
    let depth = 1, i = head.lastIndex, quoted = false, escape = false;
    for (; i < clean.length && depth; i++) {
      const c = clean[i];
      if (quoted) { if (escape) escape = false; else if (c === "\\") escape = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true; else if (c === "{") depth++; else if (c === "}") depth--;
    }
    if (depth) throw new Error("unbalanced HCL block");
    blocks.push({ kind: match[1], labels: [...match[2].matchAll(/"([^"]*)"/g)].map(x => x[1]), body: clean.slice(head.lastIndex, i - 1) });
  }
  return blocks;
}

export async function inspectProductionTerraform(input: URL | Map<string, string>) {
  let entries: [string, string][];
  if (input instanceof Map) entries = [...input];
  else { const dir = fileURLToPath(input); entries = await Promise.all((await readdir(dir)).filter(n => n.endsWith(".tf")).map(async n => [n, await readFile(`${dir}/${n}`, "utf8")] as [string,string])); }
  const blocks = entries.flatMap(([, source]) => parse(source));
  const rs = (type: string) => blocks.filter(b => b.kind === "resource" && b.labels[0] === type);
  const all = entries.map(([,s]) => s).join("\n");
  const sql = rs("google_sql_database_instance");
  const controls = {
    exactProviderPins: /version\s*=\s*"= \d+\.\d+\.\d+"/.test(blocks.find(b=>b.kind==="terraform")?.body ?? "") && !/>=|~>/.test(blocks.find(b=>b.kind==="terraform")?.body ?? ""),
    remoteState: /backend\s+"gcs"/.test(blocks.find(b=>b.kind==="terraform")?.body ?? ""),
    requiredApis: rs("google_project_service").length >= 1 && ["artifactregistry.googleapis.com","cloudkms.googleapis.com","run.googleapis.com","secretmanager.googleapis.com","sqladmin.googleapis.com","cloudscheduler.googleapis.com","cloudtasks.googleapis.com","monitoring.googleapis.com"].every(api => all.includes(api)),
    artifactRegistry: rs("google_artifact_registry_repository").length >= 1,
    cloudSqlHa: sql.some(b => /availability_type\s*=\s*"REGIONAL"/.test(b.body) && /point_in_time_recovery_enabled\s*=\s*true/.test(b.body) && /deletion_protection\s*=\s*true/.test(b.body) && /cloudsql\.iam_authentication/.test(b.body) && /encryption_key_name/.test(b.body)),
    regionalKms: rs("google_kms_crypto_key").length >= 3 && rs("google_kms_crypto_key").every(b => /rotation_period/.test(b.body) && /prevent_destroy\s*=\s*true/.test(b.body)),
    exactSecretIam: rs("google_secret_manager_secret_iam_member").length >= 3 && rs("google_project_iam_member").every(b => !/roles\/secretmanager\.secretAccessor/.test(b.body)),
    secretAgentKms: rs("google_kms_crypto_key_iam_member").some(b => /secretmanager/.test(b.labels.join(" "))),
    privateCloudRun: rs("google_cloud_run_v2_service").length >= 2 && rs("google_cloud_run_v2_service").every(b => /INGRESS_TRAFFIC_INTERNAL_ONLY/.test(b.body) && /deletion_protection\s*=\s*true/.test(b.body)),
    keylessWif: rs("google_iam_workload_identity_pool_provider").length >= 2 && rs("google_service_account_key").length === 0 && rs("google_iam_workload_identity_pool_provider").every(b => /attribute_condition/.test(b.body) && /issuer_uri/.test(b.body) && /allowed_audiences/.test(b.body)),
    authenticatedScheduling: rs("google_cloud_scheduler_job").length >= 2 && rs("google_cloud_scheduler_job").every(b => /oidc_token/.test(b.body)),
    monitoringBudget: rs("google_monitoring_alert_policy").length >= 3 && rs("google_billing_budget").length >= 1,
    residencyValidation: blocks.some(b => b.kind === "variable" && b.labels[0] === "data_residency" && /US[\s\S]*CANADA/.test(b.body)),
    approvalGate: /var\.deployment_approved/.test(all) && /precondition/.test(all),
  };
  const errors: string[] = [];
  const need = (key: keyof typeof controls, message: string) => { if (!controls[key]) errors.push(message); };
  need("exactProviderPins", "providers must use exact pins"); need("remoteState", "GCS remote state is required"); need("requiredApis", "required Google APIs are missing"); need("artifactRegistry", "Artifact Registry is required"); need("cloudSqlHa", "Cloud SQL REGIONAL HA/PITR/CMEK/deletion protection/IAM auth is required"); need("regionalKms", "regional rotating protected KMS keys are required"); need("exactSecretIam", "exact per-secret IAM is required"); need("secretAgentKms", "Secret Manager service agent KMS access is required"); need("privateCloudRun", "private Cloud Run services are required"); need("keylessWif", "keyless conditional WIF is required"); need("authenticatedScheduling", "OIDC authenticated scheduling is required"); need("monitoringBudget", "monitoring and budgets are required"); need("residencyValidation", "US/Canada residency validation is required"); need("approvalGate", "enforced deployment approval precondition is required");
  if (rs("google_service_account_key").length) errors.push("static service-account keys are prohibited");
  if (rs("google_cloud_run_v2_service_iam_member").some(b => /allUsers|allAuthenticatedUsers/.test(b.body))) errors.push("public Cloud Run invocation is prohibited");
  return { controls, errors, applyReady: false, externalInputsRequired: true };
}
