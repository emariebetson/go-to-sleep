import { canonicalEvidence, type Claims } from "./asymmetric-release-evidence";

export type PrivateTesterProduct = "nearstory" | "nearfamily";

type DarkGates = { nearfamily: false; nearstory: false; scheduler: false };
type Baseline = { sha256: string; releaseId: string; darkGates: DarkGates };
type Invite = { householdHash: string; expiresAt: number };
type ReleaseEvidence = {
  digest: string;
  releaseId: string;
  product: PrivateTesterProduct;
  expiresAt: number;
  controllerMapping: { verified: true; principal: string; artifact: string };
};
type ActivationRequest = {
  action: "activate" | "revoke" | "kill";
  operationId: string;
  principal: string;
  product: PrivateTesterProduct;
  expectedVersion: number;
  promotedBaselineSha256: string;
  releaseEvidence: ReleaseEvidence;
  invites: Invite[];
};
type ActivationState = {
  version: number;
  killSwitch: boolean;
  releaseId: string | null;
  promotedBaselineSha256: string | null;
  evidenceDigest: string | null;
  evidenceExpiresAt: number;
  invites: Map<string, number>;
};
export type PrivateTesterActivationResult = {
  product: PrivateTesterProduct;
  releaseId: string | null;
  version: number;
  globalPercent: 0;
  status: "active" | "revoked" | "killed";
  auditDigest: string;
};
export type PrivateTesterActivationAudit = PrivateTesterActivationResult & {
  operationId: string;
  requestDigest: string;
  createdAt: number;
};

const HASH = /^[a-f0-9]{64}$/;
const RELEASE = /^rel_[A-Za-z0-9_-]{8,100}$/;
const PRINCIPAL = /^service:[A-Za-z0-9_-]{3,100}$/;
const OPERATION = /^[a-z][a-z0-9-]{7,127}$/;
const PRODUCTS: readonly PrivateTesterProduct[] = ["nearstory", "nearfamily"];
const encoder = new TextEncoder();
const memoryWriteInternals = new WeakMap<object, { replaceState(product: PrivateTesterProduct, state: ActivationState): void; appendAudit(audit: PrivateTesterActivationAudit): void }>();

function invalid(message: string): never { throw new Error(`private tester activation ${message}`); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return record(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function darkGates(value: unknown): value is DarkGates { return exact(value, ["nearfamily", "nearstory", "scheduler"]) && value.nearfamily === false && value.nearstory === false && value.scheduler === false; }
function cloneState(state: ActivationState): ActivationState { return { ...state, invites: new Map(state.invites) }; }
function cloneResult(result: PrivateTesterActivationResult): PrivateTesterActivationResult { return { product: result.product, releaseId: result.releaseId, version: result.version, globalPercent: 0, status: result.status, auditDigest: result.auditDigest }; }

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
async function sha256(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(stable(value))));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validatePrivateTesterActivationTestRequest(input: unknown): asserts input is ActivationRequest {
  if (!exact(input, ["action", "operationId", "principal", "product", "expectedVersion", "promotedBaselineSha256", "releaseEvidence", "invites"])) invalid("invalid");
  if (!(input.action === "activate" || input.action === "revoke" || input.action === "kill") || typeof input.operationId !== "string" || !OPERATION.test(input.operationId) || typeof input.principal !== "string" || !PRINCIPAL.test(input.principal) || !PRODUCTS.includes(input.product as PrivateTesterProduct) || !integer(input.expectedVersion) || typeof input.promotedBaselineSha256 !== "string" || !HASH.test(input.promotedBaselineSha256) || !Array.isArray(input.invites)) invalid("invalid");
  if (!exact(input.releaseEvidence, ["digest", "releaseId", "product", "expiresAt", "controllerMapping"]) || typeof input.releaseEvidence.digest !== "string" || !HASH.test(input.releaseEvidence.digest) || typeof input.releaseEvidence.releaseId !== "string" || !RELEASE.test(input.releaseEvidence.releaseId) || input.releaseEvidence.product !== input.product || !integer(input.releaseEvidence.expiresAt)) invalid("evidence invalid");
  if (!exact(input.releaseEvidence.controllerMapping, ["verified", "principal", "artifact"]) || input.releaseEvidence.controllerMapping.verified !== true || input.releaseEvidence.controllerMapping.principal !== input.principal || typeof input.releaseEvidence.controllerMapping.artifact !== "string" || !HASH.test(input.releaseEvidence.controllerMapping.artifact)) invalid("mapping invalid");
  const seen = new Set<string>();
  for (const invite of input.invites) {
    if (!exact(invite, ["householdHash", "expiresAt"]) || typeof invite.householdHash !== "string" || !HASH.test(invite.householdHash) || !integer(invite.expiresAt) || seen.has(invite.householdHash)) invalid("invite invalid");
    seen.add(invite.householdHash);
  }
}

function validateBaseline(baseline: unknown, input: ActivationRequest): asserts baseline is Baseline {
  if (!exact(baseline, ["sha256", "releaseId", "darkGates"]) || baseline.sha256 !== input.promotedBaselineSha256 || baseline.releaseId !== input.releaseEvidence.releaseId || !darkGates(baseline.darkGates)) invalid("baseline invalid");
}

export type PrivateTesterActivationMemoryStore = ReturnType<typeof createPrivateTesterActivationTestStore>;

export function createPrivateTesterActivationTestStore(input: { promotedBaselines: Baseline[]; products?: PrivateTesterProduct[] }) {
  const baselines = new Map<string, Baseline>();
  const states = new Map<PrivateTesterProduct, ActivationState>();
  const audits = new Map<string, PrivateTesterActivationAudit>();
  const queues = new Map<PrivateTesterProduct, Promise<void>>();
  if (!record(input) || !Array.isArray(input.promotedBaselines) || (input.products !== undefined && !Array.isArray(input.products))) invalid("store invalid");
  for (const baseline of input.promotedBaselines) {
    if (!exact(baseline, ["sha256", "releaseId", "darkGates"]) || typeof baseline.sha256 !== "string" || !HASH.test(baseline.sha256) || typeof baseline.releaseId !== "string" || !RELEASE.test(baseline.releaseId) || !darkGates(baseline.darkGates) || baselines.has(baseline.sha256)) invalid("store invalid");
    baselines.set(baseline.sha256, { ...baseline, darkGates: { ...baseline.darkGates } });
  }
  for (const product of input.products ?? PRODUCTS) {
    if (!PRODUCTS.includes(product) || states.has(product)) invalid("store invalid");
    states.set(product, { version: 1, killSwitch: false, releaseId: null, promotedBaselineSha256: null, evidenceDigest: null, evidenceExpiresAt: 0, invites: new Map() });
  }
  const transact = async <T>(product: PrivateTesterProduct, run: () => Promise<T>): Promise<T> => {
    const previous = queues.get(product) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    queues.set(product, previous.then(() => current));
    await previous;
    try { return await run(); } finally { release(); }
  };
  const store = Object.freeze({
    transaction: transact,
    baseline: (sha256: string) => baselines.get(sha256),
    state: (product: PrivateTesterProduct) => {
      const state = states.get(product);
      if (!state) invalid("store unavailable");
      return cloneState(state);
    },
    audit: (operationId: string) => audits.get(operationId),
    readAudit: (operationId: string) => { const audit = audits.get(operationId); return audit ? { ...audit } : null; },
  });
  memoryWriteInternals.set(store, {
    replaceState: (product, state) => states.set(product, cloneState(state)),
    appendAudit: (audit) => { if (audits.has(audit.operationId)) invalid("replay conflict"); audits.set(audit.operationId, { ...audit }); },
  });
  return store;
}

export function createPrivateTesterActivationTestController(input: { store: PrivateTesterActivationMemoryStore; now(): number; verifyReleaseEvidence(evidence: ReleaseEvidence): Promise<boolean> }) {
  if (!record(input) || !record(input.store) || typeof input.now !== "function" || typeof input.verifyReleaseEvidence !== "function") invalid("controller invalid");
  const writes = memoryWriteInternals.get(input.store);
  if (!writes) invalid("controller invalid");
  const authorize = async (request: { product: PrivateTesterProduct; householdHash: string }): Promise<boolean> => {
    if (!exact(request, ["product", "householdHash"]) || !PRODUCTS.includes(request.product) || !HASH.test(request.householdHash)) return false;
    const now = input.now();
    if (!integer(now)) return false;
    try {
      const state = input.store.state(request.product);
      const baseline = state.promotedBaselineSha256 ? input.store.baseline(state.promotedBaselineSha256) : undefined;
      return !state.killSwitch && state.releaseId !== null && state.evidenceDigest !== null && state.evidenceExpiresAt > now && !!baseline && baseline.releaseId === state.releaseId && darkGates(baseline.darkGates) && (state.invites.get(request.householdHash) ?? 0) > now;
    } catch { return false; }
  };
  const activate = async (raw: unknown): Promise<PrivateTesterActivationResult> => {
    validatePrivateTesterActivationTestRequest(raw);
    const request = raw;
    const now = input.now();
    if (!integer(now)) invalid("clock unavailable");
    return input.store.transaction(request.product, async () => {
      const requestDigest = await sha256(request);
      const replay = input.store.audit(request.operationId);
      if (replay) {
        if (replay.requestDigest !== requestDigest) invalid("replay conflict");
        return cloneResult(replay);
      }
      const state = input.store.state(request.product);
      if (state.version !== request.expectedVersion) invalid("version conflict");
      if (state.killSwitch && request.action === "activate") invalid("kill switch terminal");
      const baseline = input.store.baseline(request.promotedBaselineSha256);
      if (request.action === "activate") {
        let verified = false;
        try { verified = await input.verifyReleaseEvidence(request.releaseEvidence); } catch { verified = false; }
        if (!verified) invalid("signature invalid");
        validateBaseline(baseline, request);
        if (request.releaseEvidence.expiresAt <= now || request.invites.some((invite) => invite.expiresAt <= now)) invalid("evidence or invite expired");
      } else if (request.action === "revoke" && (!baseline || baseline.releaseId !== request.releaseEvidence.releaseId || !darkGates(baseline.darkGates))) {
        invalid("baseline invalid");
      }
      if (request.action !== "kill" && state.releaseId !== null && state.releaseId !== request.releaseEvidence.releaseId) invalid("release conflict");
      const next = cloneState(state);
      next.version += 1;
      let status: PrivateTesterActivationResult["status"];
      if (request.action === "activate") {
        next.killSwitch = false;
        next.releaseId = request.releaseEvidence.releaseId;
        next.promotedBaselineSha256 = request.promotedBaselineSha256;
        next.evidenceDigest = request.releaseEvidence.digest;
        next.evidenceExpiresAt = request.releaseEvidence.expiresAt;
        next.invites = new Map(request.invites.map((invite) => [invite.householdHash, invite.expiresAt]));
        status = "active";
      } else if (request.action === "revoke") {
        for (const invite of request.invites) next.invites.delete(invite.householdHash);
        status = "revoked";
      } else {
        next.killSwitch = true;
        status = "killed";
      }
      const result: PrivateTesterActivationResult = { product: request.product, releaseId: next.releaseId, version: next.version, globalPercent: 0, status, auditDigest: await sha256({ requestDigest, version: next.version, status, product: request.product, releaseId: next.releaseId }) };
      writes.replaceState(request.product, next);
      writes.appendAudit({ ...result, operationId: request.operationId, requestDigest, createdAt: now });
      return cloneResult(result);
    });
  };
  return Object.assign(activate, { authorize });
}

type Pg = { query<T>(sql: string, args: unknown[]): Promise<{ rows: T[] }>; transaction?<T>(run: (tx: Pg) => Promise<T>): Promise<T> };
type DurableActivationCommand = {
  operationId: string;
  product: PrivateTesterProduct;
  expectedVersion: number;
  action: "activate" | "revoke" | "kill";
  principal: string;
  promotedBaselineSha256: string;
  releaseEvidenceDigest: string;
  releaseId: string;
  canonicalClaims: string;
  invites: Invite[];
};

function canonicalJson(value: string): boolean {
  if (typeof value !== "string" || value.length < 2 || encoder.encode(value).byteLength > 256_000) return false;
  try { return JSON.stringify(stable(JSON.parse(value))) === value; } catch { return false; }
}
function validateDurableCommand(input: unknown): asserts input is DurableActivationCommand {
  if (!exact(input, ["operationId", "product", "expectedVersion", "action", "principal", "promotedBaselineSha256", "releaseEvidenceDigest", "releaseId", "canonicalClaims", "invites"]) || typeof input.operationId !== "string" || !OPERATION.test(input.operationId) || !PRODUCTS.includes(input.product as PrivateTesterProduct) || !integer(input.expectedVersion) || !(input.action === "activate" || input.action === "revoke" || input.action === "kill") || typeof input.principal !== "string" || !PRINCIPAL.test(input.principal) || typeof input.promotedBaselineSha256 !== "string" || !HASH.test(input.promotedBaselineSha256) || typeof input.releaseEvidenceDigest !== "string" || !HASH.test(input.releaseEvidenceDigest) || typeof input.releaseId !== "string" || !RELEASE.test(input.releaseId) || typeof input.canonicalClaims !== "string" || !canonicalJson(input.canonicalClaims) || !Array.isArray(input.invites)) invalid("durable command invalid");
  const seen = new Set<string>();
  for (const invite of input.invites) {
    if (!exact(invite, ["householdHash", "expiresAt"]) || typeof invite.householdHash !== "string" || !HASH.test(invite.householdHash) || !integer(invite.expiresAt) || seen.has(invite.householdHash)) invalid("durable command invalid");
    seen.add(invite.householdHash);
  }
}

export function createPostgresPrivateTesterActivationStore(pg: Pg) {
  if (!pg || typeof pg.transaction !== "function") invalid("durable store unavailable");
  return Object.freeze({
    apply: async (raw: unknown): Promise<PrivateTesterActivationResult> => {
      validateDurableCommand(raw);
      return pg.transaction!(async (tx) => {
        const row = (await tx.query<{ result: unknown }>("SELECT nearyou.apply_private_tester_activation($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS result", [raw.principal, raw.operationId, raw.product, raw.expectedVersion, raw.action, raw.promotedBaselineSha256, raw.releaseEvidenceDigest, raw.releaseId, JSON.stringify({ canonicalClaims: raw.canonicalClaims, invites: raw.invites })])).rows[0];
        if (!row || !exact(row.result, ["product", "releaseId", "version", "globalPercent", "status", "auditDigest"]) || row.result.product !== raw.product || row.result.releaseId !== raw.releaseId || !integer(row.result.version) || row.result.version < 1 || row.result.globalPercent !== 0 || !(row.result.status === "active" || row.result.status === "revoked" || row.result.status === "killed") || typeof row.result.auditDigest !== "string" || !HASH.test(row.result.auditDigest)) invalid("durable store unavailable");
        return cloneResult(row.result as PrivateTesterActivationResult);
      });
    },
  });
}

export type PrivateTesterActivationAuthority = {
  authenticatedController(): Promise<{ principal: string }>;
  promotedBaseline(sha256: string): Promise<{ sha256: string; releaseId: string; darkGates: DarkGates } | null>;
  trustedReleaseEvidence(digest: string): Promise<Claims | null>;
};
export type PrivateTesterActivationDurableStore = { apply(command: DurableActivationCommand): Promise<PrivateTesterActivationResult> };
type DurableRequest = Omit<DurableActivationCommand, "principal" | "canonicalClaims">;

export function createPostgresPrivateTesterActivationAuthority(pg: Pick<Pg, "query">): PrivateTesterActivationAuthority {
  if (!pg || typeof pg.query !== "function") invalid("authority unavailable");
  return Object.freeze({
    authenticatedController: async () => {
      const rows = (await pg.query<{ principal: string }>("SELECT nearyou.private_tester_activation_controller_principal() AS principal", [])).rows;
      if (rows.length !== 1 || !PRINCIPAL.test(rows[0]!.principal)) invalid("authority invalid");
      return Object.freeze({ principal: rows[0]!.principal });
    },
    promotedBaseline: async (sha256) => {
      if (!HASH.test(sha256)) return null;
      const row = (await pg.query<{ sha256: string; release_id: string; dark_gates: DarkGates }>("SELECT sha256,release_id,dark_gates FROM nearyou.load_private_tester_activation_baseline($1)", [sha256])).rows[0];
      if (!row || !HASH.test(row.sha256) || !RELEASE.test(row.release_id) || !darkGates(row.dark_gates)) return null;
      return Object.freeze({ sha256: row.sha256, releaseId: row.release_id, darkGates: { ...row.dark_gates } });
    },
    trustedReleaseEvidence: async (digest) => {
      if (!HASH.test(digest)) return null;
      const row = (await pg.query<{ claims_projection: Claims }>("SELECT nearyou.load_private_tester_activation_evidence($1) AS claims_projection", [digest])).rows[0];
      return row?.claims_projection ?? null;
    },
  });
}

function validateDurableRequest(input: unknown): asserts input is DurableRequest {
  if (!exact(input, ["operationId", "product", "expectedVersion", "action", "promotedBaselineSha256", "releaseEvidenceDigest", "releaseId", "invites"])) invalid("request invalid");
  validateDurableCommand({ ...input, principal: "service:placeholder", canonicalClaims: "{}" });
}
export function validatePrivateTesterActivationRequest(input: unknown): asserts input is DurableRequest { validateDurableRequest(input); }
async function sha256Text(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createDurablePrivateTesterActivationController(input: { authority: PrivateTesterActivationAuthority; store: PrivateTesterActivationDurableStore; now(): number }) {
  if (!record(input) || !record(input.authority) || !record(input.store) || typeof input.authority.authenticatedController !== "function" || typeof input.authority.promotedBaseline !== "function" || typeof input.authority.trustedReleaseEvidence !== "function" || typeof input.store.apply !== "function" || typeof input.now !== "function") invalid("controller invalid");
  return async (raw: unknown): Promise<PrivateTesterActivationResult> => {
    validateDurableRequest(raw);
    const now = input.now();
    if (!integer(now)) invalid("clock unavailable");
    let principal: { principal: string }, baseline: { sha256: string; releaseId: string; darkGates: DarkGates } | null, claims: Claims | null;
    try {
      [principal, baseline, claims] = await Promise.all([input.authority.authenticatedController(), input.authority.promotedBaseline(raw.promotedBaselineSha256), input.authority.trustedReleaseEvidence(raw.releaseEvidenceDigest)]);
    } catch { invalid("authority unavailable"); }
    if (!PRINCIPAL.test(principal.principal) || !baseline || !exact(baseline, ["sha256", "releaseId", "darkGates"]) || baseline.sha256 !== raw.promotedBaselineSha256 || baseline.releaseId !== raw.releaseId || !darkGates(baseline.darkGates) || !claims) invalid("authority invalid");
    let canonicalClaims: string;
    try { canonicalClaims = canonicalEvidence(claims); } catch { invalid("evidence invalid"); }
    if (await sha256Text(canonicalClaims) !== raw.releaseEvidenceDigest || claims.releaseId !== raw.releaseId || claims.expiresAt <= now || !claims.productReadiness.some((item) => item.product === raw.product && item.releaseId === raw.releaseId && item.expiresAt > now && item.controllerMapping.verified === true)) invalid("evidence invalid");
    return input.store.apply({ ...raw, principal: principal.principal, canonicalClaims });
  };
}

export function createPostgresPrivateTesterActivationController(pg: Pg, now: () => number = Date.now) {
  return createDurablePrivateTesterActivationController({ authority: createPostgresPrivateTesterActivationAuthority(pg), store: createPostgresPrivateTesterActivationStore(pg), now });
}
