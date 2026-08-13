import { reportOutcomeFromEnv } from "./product-outcome-telemetry";
type D1Result = {
    meta: {
        changes: number;
    };
};
type Statement = {
    bind(...values: unknown[]): Statement;
    run(): Promise<D1Result>;
    all<T = Record<string, unknown>>(): Promise<{
        results: T[];
    }>;
};
type D1 = {
    prepare(sql: string): Statement;
};
export type OutcomeRecord = {
    product: "nearstory" | "nearlegacy";
    operation: "attempt_started" | "terminal";
    jobId: string;
    householdId: string;
    attemptToken: string;
    requestHash: string;
    releaseId: string;
    releaseVersion: number;
    terminalStatus?: "succeeded" | "failed" | "dead_letter";
};
const identifier = /^[A-Za-z0-9_-]{8,200}$/, jobIdentifier = /^(?:[A-Za-z0-9_-]{8,200}|job:[a-f0-9]{64})$/, release = /^rel_[A-Za-z0-9_-]{8,100}$/, hash = /^[a-f0-9]{64}$/;
export function validateOutcomeRecord(v: OutcomeRecord) { if (!jobIdentifier.test(v.jobId) || !identifier.test(v.householdId) || !identifier.test(v.attemptToken) || !release.test(v.releaseId) || !hash.test(v.requestHash) || !Number.isSafeInteger(v.releaseVersion) || v.releaseVersion < 1 || v.operation === "terminal" && !new Set(["succeeded", "failed", "dead_letter"]).has(v.terminalStatus ?? ""))
    throw new Error("outcome invalid"); return v; }
export async function outcomeChecksum(v: OutcomeRecord) { validateOutcomeRecord(v); const canonical = JSON.stringify([v.product, v.operation, v.jobId, v.householdId, v.attemptToken, v.requestHash, v.releaseId, v.releaseVersion, v.terminalStatus ?? null]); return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))), b => b.toString(16).padStart(2, "0")).join(""); }
export async function enqueueOperationalOutcome<T extends D1>(db: T, v: OutcomeRecord, now = Date.now()) { const checksum = await outcomeChecksum(v), id = `${v.product}:${v.jobId}:${v.attemptToken}:${v.operation}`; return db.prepare("INSERT INTO operational_outcome_outbox(id,product,operation,job_id,household_id,attempt_token,request_hash,release_id,release_version,terminal_status,delivery_status,attempts,next_attempt_at,payload_checksum,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',0,?,?,?,?) ON CONFLICT(product,job_id,attempt_token,operation) DO UPDATE SET payload_checksum=excluded.payload_checksum WHERE payload_checksum=excluded.payload_checksum").bind(id, v.product, v.operation, v.jobId, v.householdId, v.attemptToken, v.requestHash, v.releaseId, v.releaseVersion, v.terminalStatus ?? null, now, checksum, now, now) as ReturnType<T["prepare"]>; }
export async function flushOperationalOutcomeOutbox(db: D1, runtime: Record<string, unknown>, limit = 10) { let delivered = 0; for (let i = 0; i < Math.max(1, Math.min(limit, 25)); i++) {
    const now = Date.now(), token = crypto.randomUUID(), row = (await db.prepare("SELECT * FROM operational_outcome_outbox WHERE (delivery_status='pending' AND next_attempt_at<=?) OR (delivery_status='leased' AND lease_expires_at<=?) ORDER BY created_at LIMIT 1").bind(now, now).all()).results[0];
    if (!row)
        break;
    const claimed = await db.prepare("UPDATE operational_outcome_outbox SET delivery_status='leased',lease_token=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND ((delivery_status='pending' AND next_attempt_at<=?) OR (delivery_status='leased' AND lease_expires_at<=?))").bind(token, now + 30000, now, row.id, now, now).run();
    if (claimed.meta.changes !== 1)
        continue;
    const event = { releaseId: String(row.release_id), releaseVersion: Number(row.release_version), product: String(row.product) as OutcomeRecord["product"], jobId: String(row.job_id), householdId: String(row.household_id), attemptToken: String(row.attempt_token), inputChecksum: String(row.request_hash), evidenceChecksum:String(row.payload_checksum), operation: String(row.operation) as OutcomeRecord["operation"], status: row.terminal_status as OutcomeRecord["terminalStatus"] }, ok = await reportOutcomeFromEnv(runtime, event), attempts = Number(row.attempts) + 1, next = now + Math.min(3600000, 1000 * 2 ** Math.max(0, attempts - 1));
    if (ok) {
        await db.prepare("UPDATE operational_outcome_outbox SET delivery_status='delivered',delivered_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND delivery_status='leased' AND lease_token=?").bind(now, now, row.id, token).run();
        delivered++;
    }
    else
        await db.prepare("UPDATE operational_outcome_outbox SET delivery_status=?,next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND delivery_status='leased' AND lease_token=?").bind(attempts >= 12 ? 'dead_letter' : 'pending', next, now, row.id, token).run();
} return delivered; }
