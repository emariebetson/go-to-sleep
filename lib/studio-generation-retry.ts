export function shouldPreserveGenerationRequest(_status: number, code?: string) {
  return ["generation_in_progress", "generation_result_reconciliation"].includes(code || "");
}
