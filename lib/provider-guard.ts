export type ProviderName = "openai" | "elevenlabs";

export function shouldRetryProviderStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

export function providerRetryDelay(attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 0) throw new Error("Retry attempt must be a non-negative integer.");
  return Math.min(2_000, 250 * (2 ** attempt));
}

export function circuitFailureState(currentFailures: number, nowMs: number) {
  const consecutiveFailures = Math.max(0, Math.trunc(currentFailures)) + 1;
  return { consecutiveFailures, openUntil: consecutiveFailures >= 5 ? nowMs + 60_000 : null };
}

export async function fetchProviderWithRetries(input: RequestInfo | URL, init: RequestInit, timeoutMs: number, idempotencyKey: string, maxRetries = 2) {
  if (!idempotencyKey.trim()) throw new Error("A provider idempotency key is required for retries.");
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("idempotency-key", idempotencyKey);
      const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      const response = await fetch(input, { ...init, headers, signal });
      if (!shouldRetryProviderStatus(response.status) || attempt === maxRetries) return response;
      await response.body?.cancel();
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, providerRetryDelay(attempt)));
  }
  throw new Error("Provider request exhausted its retry bound.");
}
