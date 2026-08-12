#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";

export function assertApprovalGraph(dot: string) {
  const labels = new Map<string, string>();
  for (const match of dot.matchAll(/^\s*"([^"]+)"\s+\[label\s*=\s*"([^"]+)"/gm)) labels.set(match[1], match[2]);
  const edges = new Map<string, Set<string>>();
  for (const match of dot.matchAll(/^\s*"([^"]+)"\s*->\s*"([^"]+)"/gm)) {
    if (!edges.has(match[1])) edges.set(match[1], new Set());
    edges.get(match[1])!.add(match[2]);
  }
  const gate = [...labels].find(([, label]) => label.includes("terraform_data.approval_gate"))?.[0];
  if (!gate) throw new Error("approval gate is absent from Terraform graph");
  const reachesGate = (start: string) => {
    const seen = new Set<string>(); const queue = [start];
    while (queue.length) { const node = queue.shift()!; if (node === gate) return true; if (seen.has(node)) continue; seen.add(node); queue.push(...(edges.get(node) ?? [])); }
    return false;
  };
  const bypasses = [...labels].filter(([, label]) => /^(google_|cloudflare_|terraform_data\.)/.test(label))
    .filter(([, label]) => !label.includes("terraform_data.approval_gate") && !label.includes("google_project_service.required"))
    .filter(([id]) => !reachesGate(id)).map(([, label]) => label);
  if (bypasses.length) throw new Error(`managed resources bypass approval gate: ${bypasses.sort().join(", ")}`);
  return { checked: labels.size, bypasses: 0 };
}

if (process.argv[1]?.endsWith("terraform-approval-graph.ts")) {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: terraform-approval-graph.ts <terraform-graph.dot>");
  process.stdout.write(`${JSON.stringify(assertApprovalGraph(await readFile(file, "utf8")))}\n`);
}
