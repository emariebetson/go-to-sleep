export const PRODUCT_COMPATIBILITY = {
  umbrella: "NearYou",
  productFamily: "NearSleep",
  currentProduct: "Nearnight",
  apiVersion: "v1",
  preservedPagePaths: ["/", "/account", "/admin", "/library", "/pricing", "/safety", "/sign-in", "/studio"],
  preservedApiPaths: [
    "/api/account",
    "/api/audio/[id]",
    "/api/auth/[...all]",
    "/api/billing/checkout",
    "/api/billing/portal",
    "/api/pronunciation",
    "/api/scripts",
    "/api/sessions",
    "/api/voices",
    "/api/webhooks/stripe",
  ],
} as const;

export const PLAN_CATALOG = {
  nearsleep_free: {
    id: "nearsleep_free",
    product: "nearsleep",
    name: "NearSleep Free",
    monthlyPriceUsd: 0,
    annualPriceUsd: 0,
    monthlyAllowanceMilliunits: 1_000,
    maxAdultVoices: 1,
    features: { nearsleep: true, nearstoryParentControlled: false, nearlegacy: false, childMicrophone: false },
    limits: { children: 1, voices: 1, members: 1, narrationMinutes: 1, transcriptionMinutes: 0, storageBytes: 1_000_000_000 },
  },
  nearsleep_plus_legacy: {
    id: "nearsleep_plus_legacy",
    product: "nearsleep",
    name: "Nearnight Plus (grandfathered)",
    monthlyPriceUsd: 12,
    annualPriceUsd: null,
    monthlyAllowanceMilliunits: 12_000,
    maxAdultVoices: 1,
    features: { nearsleep: true, nearstoryParentControlled: false, nearlegacy: false, childMicrophone: false },
    limits: { children: 3, voices: 1, members: 1, narrationMinutes: 12, transcriptionMinutes: 0, storageBytes: 5_000_000_000 },
  },
  nearyou_plus: {
    id: "nearyou_plus",
    product: "nearyou",
    name: "NearYou Plus",
    monthlyPriceUsd: 14.99,
    annualPriceUsd: 149.99,
    monthlyAllowanceMilliunits: 60_000,
    maxAdultVoices: 1,
    features: { nearsleep: true, nearstoryParentControlled: true, nearlegacy: false, childMicrophone: false },
    limits: { children: 2, voices: 1, members: 2, narrationMinutes: 60, transcriptionMinutes: 0, storageBytes: 5_000_000_000 },
  },
  nearyou_family: {
    id: "nearyou_family",
    product: "nearyou",
    name: "NearFamily",
    monthlyPriceUsd: 24.99,
    annualPriceUsd: 249.99,
    monthlyAllowanceMilliunits: 120_000,
    maxAdultVoices: 2,
    features: { nearsleep: true, nearstoryParentControlled: true, nearlegacy: false, childMicrophone: false },
    limits: { children: 5, voices: 2, members: 5, narrationMinutes: 120, transcriptionMinutes: 0, storageBytes: 25_000_000_000 },
  },
  nearlegacy: {
    id: "nearlegacy",
    product: "nearyou",
    name: "NearLegacy",
    monthlyPriceUsd: 39.99,
    annualPriceUsd: 399.99,
    monthlyAllowanceMilliunits: 300_000,
    maxAdultVoices: 5,
    features: { nearsleep: true, nearstoryParentControlled: true, nearlegacy: true, childMicrophone: false },
    limits: { children: 5, voices: 5, members: 8, narrationMinutes: 120, transcriptionMinutes: 180, storageBytes: 100_000_000_000 },
  },
  archive_builder: {
    id: "archive_builder",
    product: "nearlegacy",
    name: "Archive Builder",
    monthlyPriceUsd: 0,
    annualPriceUsd: null,
    oneTimePriceUsd: 199,
    monthlyAllowanceMilliunits: 600_000,
    maxAdultVoices: 5,
    features: { nearsleep: false, nearstoryParentControlled: false, nearlegacy: true, childMicrophone: false },
    limits: { children: 5, voices: 5, members: 8, narrationMinutes: 0, transcriptionMinutes: 600, storageBytes: 100_000_000_000 },
  },
  archive_care: {
    id: "archive_care",
    product: "nearlegacy",
    name: "Archive Care",
    monthlyPriceUsd: 0,
    annualPriceUsd: 59,
    monthlyAllowanceMilliunits: 0,
    maxAdultVoices: 5,
    features: { nearsleep: false, nearstoryParentControlled: false, nearlegacy: true, childMicrophone: false },
    limits: { children: 5, voices: 5, members: 8, narrationMinutes: 0, transcriptionMinutes: 0, storageBytes: 100_000_000_000 },
  },
} as const;

export type PlanId = keyof typeof PLAN_CATALOG;

export function nearSleepNarratorPolicy(planId: PlanId, standardNarratorOverride = false) {
  return {
    // Free deliberately uses a catalog narrator. It never creates or stores a
    // private voice clone, so deleting a voice cannot reset a provider-funded trial.
    standardNarratorAvailable: planId === "nearsleep_free" || standardNarratorOverride,
    privateVoiceCloneAllowed: planId !== "nearsleep_free",
  };
}

export type FeatureFlags = {
  foundationApi: boolean;
  productionUpgradeFoundation: boolean;
  nearSleepProduction: boolean;
  nearSleepLibraryPrivacy: boolean;
  legacyNearsleepRoutes: boolean;
  story: boolean;
  legacyArchive: boolean;
  verifiedMediaProbe: boolean;
  asyncMediaJobs: boolean;
  usageReservations: boolean;
  requireVerifiedVoiceConsent: boolean;
  requireLegacyMfa: boolean;
  childMicrophone: false;
  posthumousSynthesis: false;
  stripeLiveMode: false;
};

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

export function featureFlagsFromEnv(environment: Record<string, string | undefined>): FeatureFlags {
  return {
    foundationApi: enabled(environment.NEARYOU_ENABLE_FOUNDATION_API),
    productionUpgradeFoundation: enabled(environment.NEARYOU_ENABLE_PRODUCTION_UPGRADE_FOUNDATION),
    nearSleepProduction: enabled(environment.NEARYOU_ENABLE_NEARSLEEP_PRODUCTION),
    nearSleepLibraryPrivacy: enabled(environment.NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY),
    legacyNearsleepRoutes: true,
    story: enabled(environment.NEARYOU_ENABLE_STORY),
    legacyArchive: enabled(environment.NEARYOU_ENABLE_LEGACY_ARCHIVE),
    verifiedMediaProbe: enabled(environment.NEARYOU_ENABLE_VERIFIED_MEDIA_PROBE),
    asyncMediaJobs: enabled(environment.NEARYOU_ENABLE_ASYNC_MEDIA_JOBS),
    usageReservations: enabled(environment.NEARYOU_ENABLE_USAGE_RESERVATIONS),
    requireVerifiedVoiceConsent: enabled(environment.NEARYOU_REQUIRE_VERIFIED_VOICE_CONSENT),
    requireLegacyMfa: enabled(environment.NEARYOU_REQUIRE_LEGACY_MFA),
    childMicrophone: false,
    posthumousSynthesis: false,
    stripeLiveMode: false,
  };
}

export function nearSleepProductionEnabled(flags: FeatureFlags) {
  return flags.foundationApi
    && flags.productionUpgradeFoundation
    && flags.nearSleepProduction
    && flags.usageReservations
    && flags.requireVerifiedVoiceConsent;
}

export function nearSleepLibraryPrivacyEnabled(flags: FeatureFlags) {
  return nearSleepProductionEnabled(flags) && flags.nearSleepLibraryPrivacy;
}

export function nearStoryParentBetaFlagsEnabled(flags: FeatureFlags) {
  return nearSleepLibraryPrivacyEnabled(flags)
    && flags.story
    && flags.asyncMediaJobs
    && flags.usageReservations
    && flags.requireVerifiedVoiceConsent;
}

export function nearLegacyArchiveFlagsEnabled(flags: FeatureFlags) {
  return nearSleepLibraryPrivacyEnabled(flags)
    && flags.legacyArchive
    && flags.asyncMediaJobs
    && flags.usageReservations
    && flags.requireVerifiedVoiceConsent
    && flags.requireLegacyMfa
    && flags.verifiedMediaProbe
    && !flags.posthumousSynthesis;
}

export const FEATURE_FLAGS = featureFlagsFromEnv({});
export const VOICE_CONSENT_VERSION = "voice-v1";
export const VOICE_CONSENT_ATTESTATION = "I confirm this is my voice and I consent to private narration in my household.";

export type HouseholdRole = "owner" | "adult_manager" | "contributor" | "listener";
export type HouseholdCapability =
  | "household:read"
  | "household:write"
  | "invitation:write"
  | "child:read"
  | "child:write"
  | "voice:read"
  | "voice:consent"
  | "entitlement:read"
  | "usage:read"
  | "playlist:read"
  | "playlist:write"
  | "job:read"
  | "job:write"
  | "archive:read"
  | "archive:write"
  | "archive:self"
  | "archive:custody";

const ROLE_CAPABILITIES: Record<HouseholdRole, ReadonlySet<HouseholdCapability>> = {
  owner: new Set<HouseholdCapability>(["household:read", "household:write", "invitation:write", "child:read", "child:write", "voice:read", "voice:consent", "entitlement:read", "usage:read", "playlist:read", "playlist:write", "job:read", "job:write", "archive:read", "archive:write", "archive:self", "archive:custody"]),
  adult_manager: new Set<HouseholdCapability>(["household:read", "child:read", "child:write", "voice:read", "voice:consent", "entitlement:read", "usage:read", "playlist:read", "playlist:write", "job:read", "job:write", "archive:read", "archive:write"]),
  contributor: new Set<HouseholdCapability>(["household:read", "archive:read", "archive:self"]),
  listener: new Set<HouseholdCapability>(["household:read", "child:read", "voice:read", "playlist:read", "archive:read"]),
};

export function roleCan(role: HouseholdRole, capability: HouseholdCapability) {
  return ROLE_CAPABILITIES[role].has(capability);
}

export type JobType = "nearsleep_audio" | "story_audio" | "archive_transcription" | "media_export";

export function jobTypeEnabled(type: JobType, flags: FeatureFlags) {
  // Story must be enqueued through /api/v1/stories so allowance, spend,
  // consent lease, and the story row are committed as one transaction.
  if (type === "story_audio" || type === "nearsleep_audio") return false;
  // Other generic job types do not yet have an atomic product-specific enqueue path.
  if (!flags.foundationApi || !flags.asyncMediaJobs || !flags.usageReservations) return false;
  if (type === "archive_transcription" || type === "media_export") return flags.legacyArchive;
  return false;
}

type EntitlementGrant = {
  planId: string;
  status: string;
  allowanceMilliunits: number;
  remainingMilliunits: number;
  validFrom: Date | number;
  validUntil: Date | number | null;
  updatedAt: Date | number;
};

export function resolveEffectiveEntitlement(grants: EntitlementGrant[], now = new Date()) {
  const nowMs = now.getTime();
  const selected = [...grants]
    .filter((grant) => {
      if (grant.status !== "active" && grant.status !== "grace") return false;
      const validFrom = new Date(grant.validFrom).getTime();
      const validUntil = grant.validUntil === null ? null : new Date(grant.validUntil).getTime();
      return Number.isFinite(validFrom) && validFrom <= nowMs && (validUntil === null || validUntil > nowMs);
    })
    .sort((left, right) => {
      const paidDifference = Number(right.planId !== "nearsleep_free") - Number(left.planId !== "nearsleep_free");
      if (paidDifference) return paidDifference;
      const statusDifference = Number(right.status === "active") - Number(left.status === "active");
      if (statusDifference) return statusDifference;
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    })[0];
  if (!selected) throw new Error("No active household entitlement is available.");
  if (!(selected.planId in PLAN_CATALOG)) throw new Error("The household entitlement references an unknown plan.");
  const plan = PLAN_CATALOG[selected.planId as PlanId];
  return {
    planId: plan.id,
    status: selected.status as "active" | "grace",
    allowanceMilliunits: selected.allowanceMilliunits,
    remainingMilliunits: selected.remainingMilliunits,
    validFrom: selected.validFrom,
    validUntil: selected.validUntil,
    features: plan.features,
    limits: plan.limits,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Job input numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new Error("Job input must contain JSON-compatible values.");
}

export async function canonicalJobRequestHash(type: JobType, input: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(canonicalJson({ type, input }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function householdIdForUser(userId: string) {
  if (!userId.trim()) throw new Error("A user ID is required to create a household ID.");
  return `household:${userId}`;
}

export type UsageOperation =
  | "nearsleep_audio_generation"
  | "nearsleep_audio_preview"
  | "story_audio_generation"
  | "archive_transcription_minute"
  | "playback";

export const USAGE_RULES: Record<UsageOperation, { milliunitsPerUnit: number; unit: string }> = {
  nearsleep_audio_generation: { milliunitsPerUnit: 1_000, unit: "generation" },
  nearsleep_audio_preview: { milliunitsPerUnit: 100, unit: "preview" },
  story_audio_generation: { milliunitsPerUnit: 1_000, unit: "narration_minute" },
  archive_transcription_minute: { milliunitsPerUnit: 50, unit: "minute" },
  playback: { milliunitsPerUnit: 0, unit: "play" },
};

export function weightedUsage(operation: UsageOperation, quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 0) throw new Error("Usage quantity must be a non-negative integer.");
  return USAGE_RULES[operation].milliunitsPerUnit * quantity;
}

export function resolveLegacyEntitlement(account: { subscriptionStatus: string; creditsRemaining: number }) {
  const paid = account.subscriptionStatus === "active" || account.subscriptionStatus === "trialing";
  const planId: PlanId = paid ? "nearsleep_plus_legacy" : "nearsleep_free";
  return {
    planId,
    status: "active" as const,
    billingStatus: account.subscriptionStatus,
    allowanceMilliunits: PLAN_CATALOG[planId].monthlyAllowanceMilliunits,
    remainingMilliunits: Math.max(0, Math.trunc(account.creditsRemaining)) * 1_000,
    features: PLAN_CATALOG[planId].features,
    limits: PLAN_CATALOG[planId].limits,
  };
}
