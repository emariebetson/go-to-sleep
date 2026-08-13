type Event = {
    releaseId: string;
    releaseVersion: number;
    product: "nearstory" | "nearlegacy";
    jobId: string;
    householdId?: string;
    attemptToken?: string;
    inputChecksum?: string;
    evidenceChecksum?: string;
    operation?: "attempt_started" | "terminal";
    status?: "succeeded" | "failed" | "dead_letter";
};
export function createCloudRunOutcomeTokenMinter(audience: string, f: typeof fetch = fetch) { return async () => { const r = await f(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`, { headers: { "metadata-flavor": "Google" } }), t = await r.text(); if (!r.ok || t.split(".").length !== 3)
    throw new Error("outcome identity failed"); return t; }; }
export function createGoogleOutcomeTokenMinter(input: {
    serviceAccount: string;
    audience: string;
    accessToken(): Promise<string>;
    fetch?: typeof fetch;
}) { return async () => { const r = await (input.fetch ?? fetch)(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(input.serviceAccount)}:generateIdToken`, { method: "POST", headers: { authorization: `Bearer ${await input.accessToken()}`, "content-type": "application/json" }, body: JSON.stringify({ audience: input.audience, includeEmail: true }) }), v = await r.json() as {
    token?: unknown;
}; if (!r.ok || typeof v.token !== "string" || v.token.split(".").length !== 3)
    throw new Error("outcome identity failed"); return v.token; }; }
export function createCloudflareWifOutcomeTokenMinter(input: {
    audience: string;
    subjectToken(): Promise<string>;
    stsAudience: string;
    serviceAccount: string;
    fetch?: typeof fetch;
}) { return async () => { const f = input.fetch ?? fetch, r = await f("https://sts.googleapis.com/v1/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ audience: input.stsAudience, grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", requested_token_type: "urn:ietf:params:oauth:token-type:access_token", scope: "https://www.googleapis.com/auth/cloud-platform", subject_token_type: "urn:ietf:params:oauth:token-type:jwt", subject_token: await input.subjectToken() }) }), v = await r.json() as {
    access_token?: unknown;
}; if (!r.ok || typeof v.access_token !== "string")
    throw new Error("outcome identity failed"); return createGoogleOutcomeTokenMinter({ ...input, accessToken: async () => v.access_token as string, fetch: f })(); }; }
export async function reportProductOutcome(input: Event & {
    endpoint: string;
    token(): Promise<string>;
    fetch?: typeof fetch;
}) { try {
    if (!/^https:\/\//.test(input.endpoint) || !/^rel_[A-Za-z0-9_-]{8,100}$/.test(input.releaseId) || !Number.isSafeInteger(input.releaseVersion) || input.releaseVersion < 1 || !/^(?:[A-Za-z0-9_-]{8,200}|job:[a-f0-9]{64})$/.test(input.jobId) || ![input.householdId, input.attemptToken].every(v => typeof v === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(v)) || ![input.inputChecksum, input.evidenceChecksum].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)) || !new Set(["attempt_started", "terminal"]).has(input.operation ?? "") || input.operation === "terminal" && !new Set(["succeeded", "failed", "dead_letter"]).has(input.status ?? ""))
        return false;
    const r = await (input.fetch ?? fetch)(input.endpoint, { method: "POST", headers: { authorization: `Bearer ${await input.token()}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    return r.ok;
}
catch {
    return false;
} }
export async function reportOutcomeFromEnv(runtime: Record<string, unknown>, event: Event) { const audience = String(runtime.OUTCOME_AUDIENCE ?? ""), kind = runtime.OUTCOME_RUNTIME; let token: () => Promise<string>; if (kind === "cloudrun")
    token = createCloudRunOutcomeTokenMinter(audience);
else if (kind === "cloudflare")
    token = createCloudflareWifOutcomeTokenMinter({ audience, stsAudience: String(runtime.OUTCOME_WIF_AUDIENCE ?? ""), serviceAccount: String(runtime.OUTCOME_SERVICE_ACCOUNT ?? ""), subjectToken: async () => String(await (runtime.OUTCOME_SUBJECT_TOKEN as {
            get(): Promise<string>;
        }).get()) });
else
    return false; return reportProductOutcome({ endpoint: String(runtime.OUTCOME_ENDPOINT ?? ""), token, ...event }); }
