import assert from "node:assert/strict";
import test from "node:test";
import { inspectProductionTerraform } from "../lib/terraform-contract.ts";

test("canonical production HCL satisfies the fail-closed infrastructure contract", async () => {
  const result = await inspectProductionTerraform(new URL("../infra/production/", import.meta.url));
  assert.deepEqual(result.errors, []);
  assert.equal(result.applyReady, false);
  assert.equal(result.externalInputsRequired, true);
  assert.ok(Object.values(result.controls).every(Boolean));
});

test("comments cannot spoof missing resources", async () => {
  const result = await inspectProductionTerraform(new Map([["main.tf", `
    # resource "google_sql_database_instance" "primary" { availability_type = "REGIONAL" }
    terraform { required_version = "= 1.9.8" }
  `]]));
  assert.equal(result.controls.cloudSqlHa, false);
  assert.match(result.errors.join("\n"), /Cloud SQL/);
});

test("public access and static service account keys fail closed", async () => {
  const result = await inspectProductionTerraform(new Map([["bad.tf", `
    resource "google_service_account_key" "bad" { service_account_id = "x" }
    resource "google_cloud_run_v2_service_iam_member" "bad" { role = "roles/run.invoker" member = "allUsers" }
  `]]));
  assert.match(result.errors.join("\n"), /static service-account keys/);
  assert.match(result.errors.join("\n"), /public Cloud Run/);
});
