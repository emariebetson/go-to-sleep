export type AccountBootstrapStage =
  | "upsertUser"
  | "hasHousehold"
  | "hasMembership"
  | "hasEntitlement"
  | "createHousehold"
  | "createMembership"
  | "createEntitlement";

export interface AccountBootstrapOperations {
  upsertUser(): Promise<void>;
  hasHousehold(): Promise<boolean>;
  hasMembership(): Promise<boolean>;
  hasEntitlement(): Promise<boolean>;
  createHousehold(): Promise<void>;
  createMembership(): Promise<void>;
  createEntitlement(): Promise<void>;
}

export class AccountBootstrapError extends Error {
  public readonly stage: AccountBootstrapStage;
  public override readonly cause: unknown;

  constructor(stage: AccountBootstrapStage, cause: unknown) {
    super(`Account bootstrap failed during ${stage}.`, { cause });
    this.name = "AccountBootstrapError";
    this.stage = stage;
    this.cause = cause;
  }
}

export function accountBootstrapCauseClassName(cause: unknown): string {
  if (cause === null) return "Null";
  if (cause === undefined) return "Undefined";
  try {
    const constructor = Object.getPrototypeOf(cause)?.constructor;
    if (typeof constructor === "function" && constructor.name) return constructor.name;
  } catch {
    // A hostile value can reject prototype inspection; keep diagnostics opaque.
  }
  return "Unknown";
}

async function runAtStage<T>(stage: AccountBootstrapStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AccountBootstrapError) throw error;
    throw new AccountBootstrapError(stage, error);
  }
}

export async function runAccountBootstrap(operations: AccountBootstrapOperations): Promise<void> {
  await runAtStage("upsertUser", () => operations.upsertUser());
  const hasHousehold = await runAtStage("hasHousehold", () => operations.hasHousehold());
  const hasMembership = await runAtStage("hasMembership", () => operations.hasMembership());
  const hasEntitlement = await runAtStage("hasEntitlement", () => operations.hasEntitlement());

  if (hasHousehold && hasMembership && hasEntitlement) return;
  if (!hasHousehold) await runAtStage("createHousehold", () => operations.createHousehold());
  if (!hasMembership) await runAtStage("createMembership", () => operations.createMembership());
  if (!hasEntitlement) await runAtStage("createEntitlement", () => operations.createEntitlement());
}
