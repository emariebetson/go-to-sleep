import { jsonNoStore } from "./http";

export type DurableGenerationError = {
  status: number;
  error: string;
  code?: string;
};

export class GenerationResultReconciliationError extends Error {
  constructor() { super("Generation result requires reconciliation."); }
}

export class GenerationResultInvalidatedError extends Error {
  readonly failure: DurableGenerationError;
  constructor(failure: DurableGenerationError) {
    super(failure.code || "generation_result_invalidated");
    this.failure = failure;
  }
}

type GenerationClaim<Result> =
  | { kind: "claimed" }
  | { kind: "processing" }
  | { kind: "conflict" }
  | { kind: "replay"; result: Result }
  | { kind: "failed"; error: DurableGenerationError };

type GenerationIdentity = { requestId: string; requestFingerprint: string };
type GenerationActor = { userId: string; householdId: string };

export type DurableGenerationDependencies<Input, Result> = {
  operation: string;
  enabled(): boolean;
  authenticate(request: Request): Promise<GenerationActor>;
  requireAdultGate(actor: GenerationActor): Promise<void>;
  parse(request: Request): Promise<Input>;
  identify(input: Input): GenerationIdentity;
  claim(input: GenerationActor & GenerationIdentity & { operationId: string }): Promise<GenerationClaim<Result>>;
  recover(input: GenerationActor & GenerationIdentity & { operationId: string }): Promise<Result | null>;
  execute(input: GenerationActor & GenerationIdentity & { operationId: string; input: Input }): Promise<Result>;
  stageResult(input: GenerationActor & { operationId: string; result: Result }): Promise<void>;
  succeed(input: GenerationActor & { operationId: string; result: Result }): Promise<void>;
  fail(input: GenerationActor & { operationId: string; error: DurableGenerationError }): Promise<void>;
  recordReconciliation?(input: { operation: string; operationId: string; error: unknown }): void;
};

async function durableError(error: unknown): Promise<DurableGenerationError> {
  if (error instanceof Response) {
    let payload: { error?: string; code?: string } = {};
    try { payload = await error.clone().json() as { error?: string; code?: string }; } catch { /* bounded generic response below */ }
    return {
      status: error.status >= 400 && error.status <= 599 ? error.status : 500,
      error: String(payload.error || "Generation could not be completed.").slice(0, 240),
      ...(payload.code ? { code: String(payload.code).slice(0, 80) } : {}),
    };
  }
  return { status: 500, error: "Generation could not be completed.", code: "generation_failed" };
}

function failureResponse(error: DurableGenerationError, duplicate = false) {
  return jsonNoStore({ error: error.error, ...(error.code ? { code: error.code } : {}), ...(duplicate ? { duplicate: true } : {}) }, { status: error.status });
}

export function createDurableGenerationPostHandler<Input, Result extends Record<string, unknown>>(
  dependencies: DurableGenerationDependencies<Input, Result>,
) {
  return async function post(request: Request) {
    if (!dependencies.enabled()) return jsonNoStore({ error: "NearSleep production generation is not enabled." }, { status: 404 });
    let actor: GenerationActor | null = null;
    let operationId = "";
    try {
      actor = await dependencies.authenticate(request);
      await dependencies.requireAdultGate(actor);
      const input = await dependencies.parse(request);
      const identity = dependencies.identify(input);
      operationId = `generation:${encodeURIComponent(actor.householdId)}:${dependencies.operation}:${identity.requestId}`;
      const claim = await dependencies.claim({ ...actor, ...identity, operationId });
      if (claim.kind === "conflict") return jsonNoStore({ error: "That request ID is already associated with different generation data.", code: "idempotency_conflict" }, { status: 409 });
      if (claim.kind === "processing") {
        let recovered: Result | null;
        try {
          recovered = await dependencies.recover({ ...actor, ...identity, operationId });
        } catch (recoveryError) {
          if (recoveryError instanceof GenerationResultInvalidatedError) {
            try { await dependencies.fail({ ...actor, operationId, error: recoveryError.failure }); } catch (persistenceError) {
              dependencies.recordReconciliation?.({ operation: dependencies.operation, operationId, error: persistenceError });
              return failureResponse({ status: 503, error: "Generation invalidation is still being reconciled. Retry this same request ID.", code: "generation_result_reconciliation" });
            }
            return failureResponse(recoveryError.failure, true);
          }
          dependencies.recordReconciliation?.({ operation: dependencies.operation, operationId, error: recoveryError });
          return failureResponse({ status: 503, error: "Generation completed but its result is still being reconciled. Retry this same request ID.", code: "generation_result_reconciliation" });
        }
        if (!recovered) return jsonNoStore({ error: "This generation request is already processing.", code: "generation_in_progress" }, { status: 409 });
        try {
          await dependencies.stageResult({ ...actor, operationId, result: recovered });
          await dependencies.succeed({ ...actor, operationId, result: recovered });
          return jsonNoStore({ ...recovered, duplicate: true });
        } catch (persistenceError) {
          dependencies.recordReconciliation?.({ operation: dependencies.operation, operationId, error: persistenceError });
          return failureResponse({ status: 503, error: "Generation completed but its result is still being reconciled. Retry this same request ID.", code: "generation_result_reconciliation" });
        }
      }
      if (claim.kind === "replay") return jsonNoStore({ ...claim.result, duplicate: true });
      if (claim.kind === "failed") return failureResponse(claim.error, true);
      const result = await dependencies.execute({ ...actor, ...identity, operationId, input });
      try {
        await dependencies.stageResult({ ...actor, operationId, result });
        await dependencies.succeed({ ...actor, operationId, result });
        return jsonNoStore(result);
      } catch (persistenceError) {
        dependencies.recordReconciliation?.({ operation: dependencies.operation, operationId, error: persistenceError });
        return failureResponse({ status: 503, error: "Generation completed but its result is still being reconciled. Retry this same request ID.", code: "generation_result_reconciliation" });
      }
    } catch (error) {
      if (error instanceof GenerationResultReconciliationError) {
        return failureResponse({ status: 503, error: "Generation completed but its result is still being reconciled. Retry this same request ID.", code: "generation_result_reconciliation" });
      }
      const normalized = error instanceof GenerationResultInvalidatedError ? error.failure : await durableError(error);
      if (actor && operationId) {
        try { await dependencies.fail({ ...actor, operationId, error: normalized }); } catch (persistenceError) {
          console.error("Durable generation failure could not be recorded", dependencies.operation, operationId, persistenceError);
        }
      }
      return failureResponse(normalized);
    }
  };
}
