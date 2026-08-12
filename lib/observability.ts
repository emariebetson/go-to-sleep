import { redactTelemetry } from "./platform-release";

export type Metric = { name: string; value: number; labels: Record<string, string> };

export function providerCostMetric(input: { provider: string; operation: string; units: number; estimatedUsd: number; householdId: string }): Metric[] {
  if (!Number.isFinite(input.units) || input.units < 0 || !Number.isFinite(input.estimatedUsd) || input.estimatedUsd < 0) throw new Error("Metric values must be non-negative.");
  return [
    { name: "provider_units", value: input.units, labels: { provider: input.provider, operation: input.operation } },
    { name: "provider_estimated_usd", value: input.estimatedUsd, labels: { provider: input.provider, operation: input.operation } },
  ];
}

export function structuredLog(event: Record<string, unknown>) {
  return JSON.stringify(redactTelemetry(event));
}

export function releaseCanaryHealth(input: { database: boolean; storage: boolean; worker: boolean; oauth: boolean; billing: boolean }) {
  const failed = Object.entries(input).filter(([, healthy]) => !healthy).map(([name]) => name);
  return { ready: failed.length === 0, failed };
}
