export function annualAllowanceBoundary(previousSeconds: number, anchorSeconds = previousSeconds) {
  if (!Number.isSafeInteger(previousSeconds) || previousSeconds <= 0) throw new Error("annual_allowance_boundary_invalid");
  if (!Number.isSafeInteger(anchorSeconds) || anchorSeconds <= 0) throw new Error("annual_allowance_anchor_invalid");
  const prior = new Date(previousSeconds * 1000);
  const day = new Date(anchorSeconds * 1000).getUTCDate();
  const next = new Date(Date.UTC(prior.getUTCFullYear(), prior.getUTCMonth() + 1, 1, prior.getUTCHours(), prior.getUTCMinutes(), prior.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return Math.floor(next.getTime() / 1000);
}
