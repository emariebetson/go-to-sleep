import assert from "node:assert/strict";
import test from "node:test";
import { assertApprovalGraph } from "../scripts/terraform-approval-graph.ts";

test("approval graph accepts resources transitively fenced by the gate", () => {
  const dot = `digraph {\n"a" [label="google_sql_database_instance.primary"]\n"b" [label="google_kms_crypto_key.database"]\n"g" [label="terraform_data.approval_gate"]\n"a" -> "b"\n"b" -> "g"\n}`;
  assert.equal(assertApprovalGraph(dot).bypasses, 0);
});

test("approval graph rejects a managed resource with no gate path", () => {
  const dot = `digraph {\n"a" [label="cloudflare_r2_bucket.audio"]\n"g" [label="terraform_data.approval_gate"]\n}`;
  assert.throws(() => assertApprovalGraph(dot), /cloudflare_r2_bucket\.audio/);
});
