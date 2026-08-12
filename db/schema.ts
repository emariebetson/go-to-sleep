import { sql } from "drizzle-orm";
import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    image: text("image"),
    role: text("role", { enum: ["parent", "admin"] }).notNull().default("parent"),
    stripeCustomerId: text("stripe_customer_id"),
    subscriptionId: text("subscription_id"),
    subscriptionPriceId: text("subscription_price_id"),
    subscriptionStatus: text("subscription_status").notNull().default("free"),
    subscriptionEventCreatedAt: integer("subscription_event_created_at"),
    checkoutPendingAt: integer("checkout_pending_at", { mode: "timestamp_ms" }),
    lastCreditedInvoiceId: text("last_credited_invoice_id"),
    lastCreditedPeriodStart: integer("last_credited_period_start"),
    creditsRemaining: integer("credits_remaining").notNull().default(1),
    consentVersion: text("consent_version"),
    consentedAt: integer("consented_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("users_email_idx").on(table.email),
    uniqueIndex("users_stripe_customer_idx").on(table.stripeCustomerId),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_idx").on(table.token),
    index("auth_sessions_user_idx").on(table.userId),
    index("auth_sessions_expiry_idx").on(table.expiresAt),
  ],
);

export const oauthAccounts = sqliteTable(
  "oauth_accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("oauth_accounts_provider_idx").on(table.providerId, table.accountId),
    index("oauth_accounts_user_idx").on(table.userId),
  ],
);

export const authVerifications = sqliteTable(
  "auth_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("auth_verifications_identifier_idx").on(table.identifier),
    index("auth_verifications_expiry_idx").on(table.expiresAt),
  ],
);

export const households = sqliteTable(
  "households",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("households_owner_user_idx").on(table.ownerUserId)],
);

export const householdMembers = sqliteTable(
  "household_members",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "adult_manager", "contributor", "listener"] }).notNull(),
    status: text("status", { enum: ["active", "invited", "removed"] }).notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("household_members_household_user_idx").on(table.householdId, table.userId),
    index("household_members_user_status_idx").on(table.userId, table.status),
  ],
);

export const householdInvitations = sqliteTable(
  "household_invitations",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    invitedByUserId: text("invited_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    invitedEmail: text("invited_email").notNull(),
    role: text("role", { enum: ["adult_manager", "contributor", "listener"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status", { enum: ["pending", "accepted", "revoked", "expired"] }).notNull().default("pending"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedByUserId: text("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("household_invitations_token_hash_idx").on(table.tokenHash),
    index("household_invitations_household_status_idx").on(table.householdId, table.status),
    index("household_invitations_email_status_idx").on(table.invitedEmail, table.status),
  ],
);

export const children = sqliteTable(
  "children",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "cascade" }),
    profileId: text("profile_id").references((): AnySQLiteColumn => childProfiles.id, { onDelete: "set null" }),
    nickname: text("nickname").notNull(),
    normalizedNickname: text("normalized_nickname"),
    pronunciation: text("pronunciation"),
    ageMonths: integer("age_months"),
    bedtimeChallenge: text("bedtime_challenge"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("children_user_idx").on(table.userId),
    uniqueIndex("children_user_normalized_nickname_idx").on(table.userId, table.normalizedNickname),
    index("children_household_idx").on(table.householdId),
  ],
);

export const childProfiles = sqliteTable(
  "child_profiles",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    legacyChildId: text("legacy_child_id").references(() => children.id, { onDelete: "set null" }),
    nickname: text("nickname").notNull(),
    normalizedNickname: text("normalized_nickname").notNull(),
    pronunciation: text("pronunciation").notNull().default(""),
    ageMonths: integer("age_months"),
    bedtimeChallenge: text("bedtime_challenge"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("child_profiles_legacy_child_idx").on(table.legacyChildId),
    uniqueIndex("child_profiles_household_nickname_idx").on(table.householdId, table.normalizedNickname),
    uniqueIndex("child_profiles_household_id_idx").on(table.householdId, table.id),
  ],
);

export const contributors = sqliteTable(
  "contributors",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    adultUserId: text("adult_user_id").references(() => users.id, { onDelete: "set null" }),
    displayName: text("display_name").notNull(),
    relationship: text("relationship"),
    status: text("status", { enum: ["invited", "active", "revoked", "deceased_pending_review"] }).notNull().default("invited"),
    creationIdempotencyKey: text("creation_idempotency_key"),
    requestHash: text("request_hash"),
    invitationId: text("invitation_id"),
    deathReviewedAt: integer("death_reviewed_at", { mode: "timestamp_ms" }),
    deathReviewedByUserId: text("death_reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("contributors_household_status_idx").on(table.householdId, table.status), uniqueIndex("contributors_household_creation_key").on(table.householdId, table.creationIdempotencyKey), uniqueIndex("contributors_household_id_idx").on(table.householdId, table.id)],
);

export const voices = sqliteTable(
  "voices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "cascade" }),
    currentConsentId: text("current_consent_id").references((): AnySQLiteColumn => voiceConsents.id, { onDelete: "set null" }),
    creationRequestId: text("creation_request_id"),
    providerVoiceId: text("provider_voice_id").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["processing", "ready", "failed", "deleted"] })
      .notNull()
      .default("processing"),
    consentAttestedAt: integer("consent_attested_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("voices_user_idx").on(table.userId),
    uniqueIndex("voices_provider_idx").on(table.providerVoiceId),
    index("voices_household_status_idx").on(table.householdId, table.status),
    uniqueIndex("voices_household_user_live_idx").on(table.householdId, table.userId)
      .where(sql`${table.householdId} IS NOT NULL AND ${table.status} IN ('processing', 'ready')`),
    uniqueIndex("voices_household_creation_request_idx").on(table.householdId, table.creationRequestId),
    uniqueIndex("voices_household_id_idx").on(table.householdId, table.id),
  ],
);

export const voiceConsents = sqliteTable(
  "voice_consents",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    voiceId: text("voice_id").references(() => voices.id, { onDelete: "set null" }),
    contributorId: text("contributor_id").references(() => contributors.id, { onDelete: "set null" }),
    adultUserId: text("adult_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    consentVersion: text("consent_version").notNull(),
    scope: text("scope", { enum: ["adult_self_private_narration"] }).notNull(),
    status: text("status", { enum: ["pending_verification", "active_verified", "revoked"] }).notNull().default("pending_verification"),
    evidence: text("evidence", { mode: "json" }),
    attestedAt: integer("attested_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("voice_consents_voice_version_idx").on(table.voiceId, table.consentVersion),
    uniqueIndex("voice_consents_active_voice_idx").on(table.voiceId)
      .where(sql`${table.voiceId} IS NOT NULL AND ${table.status} = 'active_verified'`),
    index("voice_consents_household_status_idx").on(table.householdId, table.status),
    uniqueIndex("voice_consents_household_id_idx").on(table.householdId, table.id),
  ],
);

export const adultOnboardingAcceptances = sqliteTable(
  "adult_onboarding_acceptances",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    adultUserId: text("adult_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    attestation: text("attestation").notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("adult_onboarding_household_user_version_idx").on(table.householdId, table.adultUserId, table.version)],
);

export const voiceVerificationChallenges = sqliteTable(
  "voice_verification_challenges",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    voiceId: text("voice_id").notNull().references(() => voices.id, { onDelete: "cascade" }),
    adultUserId: text("adult_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    onboardingAcceptanceId: text("onboarding_acceptance_id").notNull().references(() => adultOnboardingAcceptances.id, { onDelete: "restrict" }),
    version: text("version").notNull(),
    phrase: text("phrase").notNull(),
    phraseHash: text("phrase_hash").notNull(),
    status: text("status", { enum: ["pending", "processing", "verified", "failed", "expired"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("voice_verification_voice_status_idx").on(table.voiceId, table.status)],
);

export const voiceReplacements = sqliteTable(
  "voice_replacements",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    voiceId: text("voice_id").notNull().references(() => voices.id, { onDelete: "cascade" }),
    challengeId: text("challenge_id").notNull().references(() => voiceVerificationChallenges.id, { onDelete: "cascade" }),
    adultUserId: text("adult_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    originalProviderVoiceId: text("original_provider_voice_id").notNull(),
    originalConsentId: text("original_consent_id").notNull().references(() => voiceConsents.id, { onDelete: "restrict" }),
    replacementProviderVoiceId: text("replacement_provider_voice_id"),
    providerRequestId: text("provider_request_id"),
    consentId: text("consent_id").notNull(),
    consentVersion: text("consent_version").notNull(),
    evidence: text("evidence", { mode: "json" }),
    status: text("status", { enum: ["processing", "provider_created", "activating", "cleanup_pending", "completed", "failed"] }).notNull().default("processing"),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("voice_replacements_challenge_idx").on(table.challengeId),
    index("voice_replacements_voice_status_idx").on(table.voiceId, table.status),
  ],
);

export const voiceConsentLeases = sqliteTable(
  "voice_consent_leases",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    voiceId: text("voice_id").notNull().references(() => voices.id, { onDelete: "cascade" }),
    consentId: text("consent_id").notNull().references(() => voiceConsents.id, { onDelete: "cascade" }),
    consentVersion: text("consent_version").notNull(),
    sessionId: text("session_id").references((): AnySQLiteColumn => sleepSessions.id, { onDelete: "set null" }),
    status: text("status", { enum: ["active", "consumed", "revoked", "expired"] }).notNull().default("active"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    finalizedAt: integer("finalized_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("voice_consent_leases_consent_status_idx").on(table.consentId, table.status), uniqueIndex("voice_consent_leases_household_id_idx").on(table.householdId, table.id)],
);

export const sleepSessions = sqliteTable(
  "sleep_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "cascade" }),
    jobId: text("job_id").references((): AnySQLiteColumn => jobs.id, { onDelete: "set null" }),
    mediaAssetId: text("media_asset_id").references((): AnySQLiteColumn => mediaAssets.id, { onDelete: "set null" }),
    childId: text("child_id").references(() => children.id, { onDelete: "set null" }),
    voiceId: text("voice_id").references(() => voices.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    script: text("script").notNull(),
    scriptMode: text("script_mode", { enum: ["curated", "personalized"] }).notNull(),
    contentType: text("content_type", { enum: ["story", "sleep-hypnosis"] }).notNull().default("story"),
    narrationKind: text("narration_kind", { enum: ["parent_clone", "demo_narrator"] }).notNull().default("parent_clone"),
    sourceUrl: text("source_url"),
    sourceTitle: text("source_title"),
    consentId: text("consent_id").references(() => voiceConsents.id, { onDelete: "set null" }),
    consentVersion: text("consent_version"),
    consentLeaseId: text("consent_lease_id").references(() => voiceConsentLeases.id, { onDelete: "set null" }),
    allowanceReservationId: text("allowance_reservation_id").references((): AnySQLiteColumn => usageReservations.id, { onDelete: "set null" }),
    theme: text("theme").notNull(),
    style: text("style").notNull(),
    backgroundSound: text("background_sound").notNull(),
    pronunciation: text("pronunciation").notNull().default(""),
    frequencyLayers: text("frequency_layers").notNull().default("[]"),
    durationMinutes: integer("duration_minutes").notNull(),
    status: text("status", { enum: ["queued", "generating", "ready", "failed"] })
      .notNull()
      .default("queued"),
    audioKey: text("audio_key"),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    repeatMinutes: integer("repeat_minutes"),
    deletionStatus: text("deletion_status", { enum: ["active", "delete_pending", "deleted"] }).notNull().default("active"),
    deletionRequestedAt: integer("deletion_requested_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    providerRequestId: text("provider_request_id"),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("sessions_user_created_idx").on(table.userId, table.createdAt),
    index("sessions_status_idx").on(table.status),
    index("sessions_consent_lease_idx").on(table.consentLeaseId),
    index("sessions_allowance_reservation_idx").on(table.allowanceReservationId),
    index("sessions_household_library_idx").on(table.householdId, table.deletionStatus, table.status, table.createdAt),
  ],
);

export const entitlements = sqliteTable(
  "entitlements",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    source: text("source", { enum: ["legacy", "stripe", "revenuecat", "manual"] }).notNull(),
    status: text("status", { enum: ["active", "inactive", "grace", "revoked"] }).notNull(),
    allowanceMilliunits: integer("allowance_milliunits").notNull(),
    remainingMilliunits: integer("remaining_milliunits").notNull(),
    legacyCreditsRemaining: integer("legacy_credits_remaining"),
    externalRef: text("external_ref"),
    billingPeriodStart: integer("billing_period_start"),
    validFrom: integer("valid_from", { mode: "timestamp_ms" }).notNull(),
    validUntil: integer("valid_until", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("entitlements_household_status_idx").on(table.householdId, table.status),
    uniqueIndex("entitlements_source_external_idx").on(table.source, table.externalRef),
  ],
);

export const annualAllowanceRefills=sqliteTable("annual_allowance_refills",{entitlementId:text("entitlement_id").primaryKey().references(()=>entitlements.id,{onDelete:"cascade"}),householdId:text("household_id").notNull().references(()=>households.id,{onDelete:"cascade"}),anchorSeconds:integer("anchor_seconds").notNull(),refilledThroughSeconds:integer("refilled_through_seconds").notNull(),createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull(),updatedAt:integer("updated_at",{mode:"timestamp_ms"}).notNull()},table=>[uniqueIndex("annual_allowance_household_entitlement_idx").on(table.householdId,table.entitlementId)]);

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "cascade" }),
    ledgerEntryId: text("ledger_entry_id").references((): AnySQLiteColumn => usageLedger.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => sleepSessions.id, { onDelete: "set null" }),
    type: text("type", { enum: ["script_generation", "audio_preview", "audio_generation", "playback", "pronunciation_guess"] }).notNull(),
    units: integer("units").notNull().default(1),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("usage_user_created_idx").on(table.userId, table.createdAt)],
);

export const usageLedger = sqliteTable(
  "usage_ledger",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    entitlementId: text("entitlement_id").references(() => entitlements.id, { onDelete: "set null" }),
    legacyUsageEventId: text("legacy_usage_event_id").references(() => usageEvents.id, { onDelete: "set null" }),
    product: text("product").notNull(),
    operation: text("operation").notNull(),
    quantity: integer("quantity").notNull(),
    weightMilliunits: integer("weight_milliunits").notNull(),
    direction: text("direction", { enum: ["debit", "credit", "reservation", "release"] }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("usage_ledger_household_idempotency_idx").on(table.householdId, table.idempotencyKey),
    index("usage_ledger_household_created_idx").on(table.householdId, table.createdAt),
  ],
);

export const usageReservations = sqliteTable(
  "usage_reservations",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    entitlementId: text("entitlement_id").notNull().references(() => entitlements.id, { onDelete: "restrict" }),
    operation: text("operation").notNull(),
    quantity: integer("quantity").notNull(),
    weightMilliunits: integer("weight_milliunits").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: ["reserved", "committed", "released"] }).notNull().default("reserved"),
    consentLeaseId: text("consent_lease_id").references(() => voiceConsentLeases.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    finalizedAt: integer("finalized_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("usage_reservations_household_idempotency_idx").on(table.householdId, table.idempotencyKey),
    uniqueIndex("usage_reservations_household_id_idx").on(table.householdId, table.id),
    index("usage_reservations_household_status_created_idx").on(table.householdId, table.status, table.createdAt),
  ],
);

export const providerSpendReservations = sqliteTable(
  "provider_spend_reservations",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    estimatedMicrocents: integer("estimated_microcents").notNull(),
    actualMicrocents: integer("actual_microcents"),
    status: text("status", { enum: ["in_flight", "charge_committed", "settled", "released"] }).notNull().default("in_flight"),
    chargeCommittedAt: integer("charge_committed_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("provider_spend_household_idempotency_idx").on(table.householdId, table.idempotencyKey),
    index("provider_spend_provider_status_created_idx").on(table.provider, table.status, table.createdAt),
  ],
);

export const providerBudgetPolicies = sqliteTable("provider_budget_policies", {
  provider: text("provider").primaryKey(),
  householdWindowMicrocents: integer("household_window_microcents").notNull(),
  globalWindowMicrocents: integer("global_window_microcents").notNull(),
  windowMilliseconds: integer("window_milliseconds").notNull(),
  maxConcurrent: integer("max_concurrent").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const providerCircuits = sqliteTable("provider_circuits", {
  provider: text("provider").primaryKey(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  openUntil: integer("open_until", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const generationOperations = sqliteTable(
  "generation_operations",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: ["processing", "succeeded", "failed"] }).notNull().default("processing"),
    result: text("result", { mode: "json" }),
    errorCode: text("error_code"),
    allowanceReservationId: text("allowance_reservation_id").references(() => usageReservations.id, { onDelete: "set null" }),
    providerSpendReservationId: text("provider_spend_reservation_id").references(() => providerSpendReservations.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("generation_operations_household_status_idx").on(table.householdId, table.status)],
);

export const mediaAssets = sqliteTable(
  "media_assets",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    childProfileId: text("child_profile_id").references(() => childProfiles.id, { onDelete: "set null" }),
    legacySessionId: text("legacy_session_id").references(() => sleepSessions.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["narration", "recording", "evidence", "photo", "export"] }).notNull(),
    status: text("status", { enum: ["processing", "ready", "failed", "deleted"] }).notNull(),
    storageKey: text("storage_key"),
    contentType: text("content_type"),
    byteSize: integer("byte_size"),
    checksum: text("checksum"),
    private: integer("private", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("media_assets_storage_key_idx").on(table.storageKey),
    uniqueIndex("media_assets_legacy_session_idx").on(table.legacySessionId),
    index("media_assets_household_created_idx").on(table.householdId, table.createdAt),
    uniqueIndex("media_assets_household_id_idx").on(table.householdId, table.id),
  ],
);

export const playlists = sqliteTable(
  "playlists",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    private: integer("private", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("playlists_household_created_idx").on(table.householdId, table.createdAt)],
);

export const playlistItems = sqliteTable(
  "playlist_items",
  {
    id: text("id").primaryKey(),
    playlistId: text("playlist_id").notNull().references(() => playlists.id, { onDelete: "cascade" }),
    mediaAssetId: text("media_asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("playlist_items_playlist_media_idx").on(table.playlistId, table.mediaAssetId),
    uniqueIndex("playlist_items_playlist_position_idx").on(table.playlistId, table.position),
  ],
);

export const bedtimeQueueItems = sqliteTable(
  "bedtime_queue_items",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    queuedByUserId: text("queued_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull().references(() => sleepSessions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    status: text("status", { enum: ["queued", "playing", "played", "removed"] }).notNull().default("queued"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("bedtime_queue_household_position_idx").on(table.householdId, table.position),
    index("bedtime_queue_household_status_idx").on(table.householdId, table.status),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    legacySessionId: text("legacy_session_id").references(() => sleepSessions.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed", "canceled"] }).notNull().default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    input: text("input", { mode: "json" }).notNull(),
    result: text("result", { mode: "json" }),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
    progressPercent: integer("progress_percent").notNull().default(0),
    progressStage: text("progress_stage").notNull().default("queued"),
    workerAttemptToken: text("worker_attempt_token"),
    workerLeaseExpiresAt: integer("worker_lease_expires_at", { mode: "timestamp_ms" }),
    reservationId: text("reservation_id").references(() => usageReservations.id, { onDelete: "set null" }),
    consentId: text("consent_id").references(() => voiceConsents.id, { onDelete: "set null" }),
    consentVersion: text("consent_version"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("jobs_household_idempotency_idx").on(table.householdId, table.idempotencyKey),
    uniqueIndex("jobs_household_id_idx").on(table.householdId, table.id),
    index("jobs_household_status_created_idx").on(table.householdId, table.status, table.createdAt),
    index("jobs_story_dispatch_idx").on(table.type, table.status, table.workerLeaseExpiresAt, table.createdAt),
  ],
);

export const storyExperiences = sqliteTable(
  "story_experiences",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    childProfileId: text("child_profile_id").notNull().references(() => childProfiles.id, { onDelete: "restrict" }),
    voiceId: text("voice_id").notNull().references(() => voices.id, { onDelete: "restrict" }),
    consentId: text("consent_id").notNull().references(() => voiceConsents.id, { onDelete: "restrict" }),
    consentVersion: text("consent_version").notNull(),
    consentLeaseId: text("consent_lease_id").notNull().references(() => voiceConsentLeases.id, { onDelete: "restrict" }),
    mode: text("mode").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    plan: text("plan", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    rightsActorUserId: text("rights_actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    rightsVersion: text("rights_version"),
    rightsCanonicalUrl: text("rights_canonical_url"),
    rightsAttestedAt: integer("rights_attested_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: ["queued", "processing", "review_required", "completed", "failed", "canceled", "delete_pending", "deleted"] }).notNull().default("queued"),
    highestPlayedSegment: integer("highest_played_segment").notNull().default(-1),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    reservationId: text("reservation_id").references(() => usageReservations.id, { onDelete: "set null" }),
    providerBudgetHoldIds: text("provider_budget_hold_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    mediaAssetId: text("media_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("story_experiences_household_request_idx").on(table.householdId, table.idempotencyKey),
    uniqueIndex("story_experiences_household_id_idx").on(table.householdId, table.id),
    index("story_experiences_household_status_idx").on(table.householdId, table.status, table.createdAt),
    foreignKey({ columns: [table.householdId, table.requestedByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId] }),
    foreignKey({ columns: [table.householdId, table.childProfileId], foreignColumns: [childProfiles.householdId, childProfiles.id] }),
    foreignKey({ columns: [table.householdId, table.voiceId], foreignColumns: [voices.householdId, voices.id] }),
    foreignKey({ columns: [table.householdId, table.consentId], foreignColumns: [voiceConsents.householdId, voiceConsents.id] }),
    foreignKey({ columns: [table.householdId, table.consentLeaseId], foreignColumns: [voiceConsentLeases.householdId, voiceConsentLeases.id] }),
    foreignKey({ columns: [table.householdId, table.jobId], foreignColumns: [jobs.householdId, jobs.id] }).onDelete("cascade"),
    foreignKey({ columns: [table.householdId, table.reservationId], foreignColumns: [usageReservations.householdId, usageReservations.id] }).onDelete("cascade"),
    foreignKey({ columns: [table.householdId, table.mediaAssetId], foreignColumns: [mediaAssets.householdId, mediaAssets.id] }).onDelete("cascade"),
  ],
);

export const storyWorkerCheckpoints = sqliteTable(
  "story_worker_checkpoints",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    storyId: text("story_id").notNull().references(() => storyExperiences.id, { onDelete: "cascade" }),
    attemptToken: text("attempt_token").notNull(),
    stage: text("stage", { enum: ["writer", "moderation", "speech", "effect", "mix"] }).notNull(),
    ordinal: integer("ordinal").notNull().default(-1),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    storageKey: text("storage_key"),
    byteSize: integer("byte_size"),
    checksum: text("checksum"),
    status: text("status", { enum: ["staging", "ready"] }).notNull().default("staging"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("story_worker_checkpoint_stage_idx").on(table.storyId, table.stage, table.ordinal),
    foreignKey({ columns: [table.householdId, table.storyId], foreignColumns: [storyExperiences.householdId, storyExperiences.id] }),
  ],
);

export const storyPersistStagingObjects = sqliteTable(
  "story_persist_staging_objects",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    storyId: text("story_id").notNull().references(() => storyExperiences.id, { onDelete: "cascade" }),
    attemptToken: text("attempt_token").notNull(),
    role: text("role", { enum: ["segment", "final"] }).notNull(),
    ordinal: integer("ordinal"),
    storageKey: text("storage_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    checksum: text("checksum").notNull(),
    status: text("status", { enum: ["staging", "published", "deleted"] }).notNull().default("staging"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("story_persist_staging_attempt_role_idx").on(table.storyId, table.attemptToken, table.role, table.ordinal),
    uniqueIndex("story_persist_staging_key_idx").on(table.storageKey),
    foreignKey({ columns: [table.householdId, table.storyId], foreignColumns: [storyExperiences.householdId, storyExperiences.id] }),
  ],
);

export const storySegments = sqliteTable(
  "story_segments",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    storyId: text("story_id").notNull().references(() => storyExperiences.id, { onDelete: "cascade" }),
    branchKey: text("branch_key").notNull().default("root"),
    ordinal: integer("ordinal").notNull(),
    purpose: text("purpose").notNull(),
    narration: text("narration"),
    status: text("status", { enum: ["queued", "processing", "ready", "failed", "superseded"] }).notNull().default("queued"),
    planVersion: text("plan_version").notNull(),
    promptVersion: text("prompt_version").notNull(),
    writerModel: text("writer_model"),
    writerRequestId: text("writer_request_id"),
    moderationModel: text("moderation_model"),
    moderationRequestId: text("moderation_request_id"),
    moderationVerdict: text("moderation_verdict", { enum: ["safe", "unsafe"] }),
    ttsModel: text("tts_model"),
    ttsRequestId: text("tts_request_id"),
    mediaAssetId: text("media_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    startMs: integer("start_ms"),
    endMs: integer("end_ms"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("story_segments_story_branch_ordinal_idx").on(table.storyId, table.branchKey, table.ordinal),
    foreignKey({ columns: [table.householdId, table.storyId], foreignColumns: [storyExperiences.householdId, storyExperiences.id] }),
    foreignKey({ columns: [table.householdId, table.mediaAssetId], foreignColumns: [mediaAssets.householdId, mediaAssets.id] }).onDelete("cascade"),
  ],
);

export const storyDeletionOperations = sqliteTable(
  "story_deletion_operations",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    storyId: text("story_id").notNull().references(() => storyExperiences.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: ["inventory_pending", "cleanup_pending", "cleanup_verified", "failed", "completed"] }).notNull().default("inventory_pending"),
    storageKeys: text("storage_keys", { mode: "json" }).$type<string[]>().notNull().default([]),
    attemptToken: text("attempt_token"),
    attemptExpiresAt: integer("attempt_expires_at", { mode: "timestamp_ms" }),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("story_deletion_household_request_idx").on(table.householdId, table.idempotencyKey),
    uniqueIndex("story_deletion_household_id_idx").on(table.householdId, table.id),
    uniqueIndex("story_deletion_story_live_idx").on(table.householdId, table.storyId).where(sql`${table.status} <> 'completed'`),
    foreignKey({ columns: [table.householdId, table.storyId], foreignColumns: [storyExperiences.householdId, storyExperiences.id] }),
  ],
);

export const storyMediaBindings = sqliteTable(
  "story_media_bindings",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    storyId: text("story_id").notNull().references(() => storyExperiences.id, { onDelete: "cascade" }),
    mediaAssetId: text("media_asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["segment", "final"] }).notNull(),
    branchKey: text("branch_key").notNull().default("root"),
    ordinal: integer("ordinal"),
    status: text("status", { enum: ["processing", "ready", "deleted"] }).notNull().default("processing"),
    attemptToken: text("attempt_token").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("story_media_asset_idx").on(table.mediaAssetId),
    uniqueIndex("story_media_role_idx").on(table.storyId, table.branchKey, table.role, table.ordinal),
    uniqueIndex("story_media_final_idx").on(table.storyId, table.branchKey).where(sql`${table.role} = 'final'`),
    foreignKey({ columns: [table.householdId, table.storyId], foreignColumns: [storyExperiences.householdId, storyExperiences.id] }),
    foreignKey({ columns: [table.householdId, table.mediaAssetId], foreignColumns: [mediaAssets.householdId, mediaAssets.id] }),
  ],
);

export const storyProviderBudgetHolds = sqliteTable(
  "story_provider_budget_holds",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    storyId: text("story_id").notNull().references(() => storyExperiences.id, { onDelete: "cascade" }),
    branchKey: text("branch_key").notNull().default("root"),
    provider: text("provider", { enum: ["openai", "elevenlabs"] }).notNull(),
    operation: text("operation", { enum: ["story_writing", "story_output_moderation", "story_speech", "story_sfx"] }).notNull(),
    maxMicrocents: integer("max_microcents").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerSpendReservationId: text("provider_spend_reservation_id").references(() => providerSpendReservations.id, { onDelete: "set null" }),
    status: text("status", { enum: ["reserved", "claimed", "settled", "released"] }).notNull().default("reserved"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("story_provider_holds_story_operation_idx").on(table.storyId, table.branchKey, table.operation),
    uniqueIndex("story_provider_holds_household_id_idx").on(table.householdId, table.id),
    foreignKey({ columns: [table.householdId, table.storyId], foreignColumns: [storyExperiences.householdId, storyExperiences.id] }),
    foreignKey({ columns: [table.householdId, table.userId], foreignColumns: [householdMembers.householdId, householdMembers.userId] }),
  ],
);

export const storyBranchRequests = sqliteTable(
  "story_branch_requests",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    storyId: text("story_id").notNull().references(() => storyExperiences.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    direction: text("direction").notNull(),
    afterSegment: integer("after_segment").notNull(),
    requestHash: text("request_hash").notNull(),
    jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "restrict" }),
    reservationId: text("reservation_id").notNull().references(() => usageReservations.id, { onDelete: "restrict" }),
    consentLeaseId: text("consent_lease_id").notNull().references(() => voiceConsentLeases.id, { onDelete: "restrict" }),
    moderationReceiptId: text("moderation_receipt_id").notNull().references(() => storyModerationReceipts.id, { onDelete: "restrict" }),
    reservedMinutes: integer("reserved_minutes").notNull(),
    status: text("status", { enum: ["queued", "processing", "applied", "rejected", "failed"] }).notNull().default("queued"),
    moderationProvenance: text("moderation_provenance", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    foreignKey({ columns: [table.householdId, table.jobId], foreignColumns: [jobs.householdId, jobs.id] }),
    foreignKey({ columns: [table.householdId, table.reservationId], foreignColumns: [usageReservations.householdId, usageReservations.id] }),
    foreignKey({ columns: [table.householdId, table.consentLeaseId], foreignColumns: [voiceConsentLeases.householdId, voiceConsentLeases.id] }),
    foreignKey({ columns: [table.householdId, table.moderationReceiptId], foreignColumns: [storyModerationReceipts.householdId, storyModerationReceipts.id] }),
  ],
);

export const storySoundAssets = sqliteTable(
  "story_sound_assets",
  {
    id: text("id").primaryKey(),
    cacheKey: text("cache_key").notNull(),
    descriptor: text("descriptor").notNull(),
    provenance: text("provenance").notNull(),
    licensePolicyVersion: text("license_policy_version").notNull(),
    provider: text("provider").notNull(),
    providerRequestId: text("provider_request_id"),
    storageKey: text("storage_key"),
    checksum: text("checksum"),
    byteSize: integer("byte_size"),
    attemptToken: text("attempt_token"),
    attemptExpiresAt: integer("attempt_expires_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: ["processing", "ready", "failed", "deleted"] }).notNull().default("processing"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("story_sound_assets_cache_idx").on(table.cacheKey)],
);

export const nearStoryActivationState = sqliteTable("nearstory_activation_state", {
  id: text("id").primaryKey(),
  status: text("status", { enum: ["pending", "ready"] }).notNull().default("pending"),
  migrationVersion: text("migration_version").notNull(),
  workerHeartbeatAt: integer("worker_heartbeat_at", { mode: "timestamp_ms" }),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
});

export const storyModerationReceipts = sqliteTable(
  "story_moderation_receipts",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    requestHash: text("request_hash").notNull(),
    verdict: text("verdict", { enum: ["safe", "unsafe"] }).notNull(),
    model: text("model").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("story_moderation_receipts_household_id_idx").on(table.householdId, table.id),
    foreignKey({ columns: [table.householdId, table.requestedByUserId], foreignColumns: [householdMembers.householdId, householdMembers.userId] }),
  ],
);

export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  eventCreatedAt: integer("event_created_at").notNull().default(0),
  status: text("status", { enum: ["processing", "completed", "failed"] }).notNull().default("processing"),
  errorCode: text("error_code"),
  attemptToken: text("attempt_token"),
  processedAt: integer("processed_at", { mode: "timestamp_ms" }).notNull(),
  // Drizzle's timestamp mode expects a Date in TypeScript, but this database
  // default is the numeric Unix-epoch sentinel added by migration 0008.
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(0 as unknown as Date),
});

export const householdBillingAccounts = sqliteTable(
  "household_billing_accounts",
  {
    householdId: text("household_id").primaryKey().references(() => households.id, { onDelete: "cascade" }),
    customerId: text("customer_id"),
    subscriptionId: text("subscription_id"),
    priceId: text("price_id"),
    status: text("status").notNull().default("free"),
    subscriptionEventCreatedAt: integer("subscription_event_created_at"),
    checkoutPendingAt: integer("checkout_pending_at", { mode: "timestamp_ms" }),
    checkoutOperationId: text("checkout_operation_id"),
    checkoutSessionId: text("checkout_session_id"),
    checkoutSessionUrl: text("checkout_session_url"),
    checkoutPriceId: text("checkout_price_id"),
    checkoutStatus: text("checkout_status", { enum: ["creating", "open", "completed", "expired"] }),
    checkoutExpiresAt: integer("checkout_expires_at", { mode: "timestamp_ms" }),
    lastCreditedInvoiceId: text("last_credited_invoice_id"),
    lastCreditedPeriodStart: integer("last_credited_period_start"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("household_billing_customer_idx").on(table.customerId),
    uniqueIndex("household_billing_subscription_idx").on(table.subscriptionId),
    uniqueIndex("household_billing_checkout_session_idx").on(table.checkoutSessionId),
  ],
);

export const householdBillingSubscriptions = sqliteTable(
  "household_billing_subscriptions",
  {
    subscriptionId: text("subscription_id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    priceId: text("price_id"),
    status: text("status").notNull(),
    eventCreatedAt: integer("event_created_at"),
    supersededAt: integer("superseded_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("household_billing_subscriptions_household_idx").on(table.householdId, table.updatedAt)],
);

export const deletionReconciliations = sqliteTable(
  "deletion_reconciliations",
  {
    id: text("id").primaryKey(),
    scope: text("scope", { enum: ["voice", "session", "account"] }).notNull(),
    scopeId: text("scope_id").notNull(),
    householdId: text("household_id").references(() => households.id, { onDelete: "cascade" }),
    attemptToken: text("attempt_token"),
    attemptExpiresAt: integer("attempt_expires_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: ["cleanup_pending", "cleanup_verified", "failed", "completed"] }).notNull().default("cleanup_pending"),
    storageKeys: text("storage_keys", { mode: "json" }).$type<string[]>().notNull().default([]),
    providerReferences: text("provider_references", { mode: "json" }).$type<string[]>().notNull().default([]),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("deletion_reconciliations_scope_status_idx").on(table.scope, table.scopeId, table.status),
    index("deletion_reconciliations_household_status_idx").on(table.householdId, table.status, table.id),
  ],
);

export const householdStorageReservations = sqliteTable(
  "household_storage_reservations",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    mediaAssetId: text("media_asset_id").notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
    byteSize: integer("byte_size").notNull(),
    status: text("status", { enum: ["reserved", "committed", "released"] }).notNull().default("reserved"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    releasedAt: integer("released_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("household_storage_media_idx").on(table.mediaAssetId),
    index("household_storage_status_idx").on(table.householdId, table.status),
  ],
);

export const task2cActivationState = sqliteTable("task2c_activation_state", {
  id: text("id").primaryKey(),
  status: text("status", { enum: ["pending", "ready"] }).notNull().default("pending"),
  unresolvedReadyMedia: integer("unresolved_ready_media").notNull().default(0),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
  schedulerHeartbeatAt: integer("scheduler_heartbeat_at", { mode: "timestamp_ms" }),
  schedulerRunId: text("scheduler_run_id"),
});

export const task2cMediaIntegrity = sqliteTable("task2c_media_integrity", {
  mediaAssetId: text("media_asset_id").primaryKey().references(() => mediaAssets.id, { onDelete: "cascade" }),
  byteSize: integer("byte_size").notNull(),
  checksum: text("checksum").notNull(),
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" }).notNull(),
});

export const householdExports = sqliteTable(
  "household_exports",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    snapshot: text("snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed", "canceled", "expired"] }).notNull().default("queued"),
    attemptToken: text("attempt_token"),
    attemptExpiresAt: integer("attempt_expires_at", { mode: "timestamp_ms" }),
    inventoryStage: text("inventory_stage").notNull().default("sessions"),
    inventoryCursor: text("inventory_cursor"),
    metadataPageCount: integer("metadata_page_count").notNull().default(0),
    cursorPosition: integer("cursor_position").notNull().default(0),
    inventoryCount: integer("inventory_count").notNull().default(0),
    manifestStorageKey: text("manifest_storage_key"),
    manifestByteSize: integer("manifest_byte_size"),
    manifestChecksum: text("manifest_checksum"),
    errorCode: text("error_code"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("household_exports_idempotency_idx").on(table.householdId, table.requestedByUserId, table.idempotencyKey),
    index("household_exports_status_idx").on(table.householdId, table.status, table.updatedAt),
  ],
);

export const householdExportParts = sqliteTable(
  "household_export_parts",
  {
    id: text("id").primaryKey(),
    exportId: text("export_id").notNull().references(() => householdExports.id, { onDelete: "cascade" }),
    sourceMediaAssetId: text("source_media_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    sourceStorageKey: text("source_storage_key").notNull(),
    exportStorageKey: text("export_storage_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size"),
    checksum: text("checksum"),
    status: text("status", { enum: ["pending", "copied", "failed"] }).notNull().default("pending"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("household_export_parts_source_idx").on(table.exportId, table.sourceMediaAssetId),
    uniqueIndex("household_export_parts_key_idx").on(table.exportStorageKey),
    index("household_export_parts_status_idx").on(table.exportId, table.status, table.id),
  ],
);

export const householdExportMetadataPages = sqliteTable(
  "household_export_metadata_pages",
  {
    id: text("id").primaryKey(),
    exportId: text("export_id").notNull().references(() => householdExports.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    itemCount: integer("item_count").notNull(),
    byteSize: integer("byte_size").notNull(),
    checksum: text("checksum").notNull(),
    status: text("status", { enum: ["pending", "ready", "expired"] }).notNull().default("pending"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("household_export_metadata_pages_position_idx").on(table.exportId, table.position),
    uniqueIndex("household_export_metadata_pages_key_idx").on(table.storageKey),
    index("household_export_metadata_pages_status_idx").on(table.exportId, table.status, table.position),
  ],
);

export const householdExportDownloadConfirmations = sqliteTable(
  "household_export_download_confirmations",
  {
    exportId: text("export_id").primaryKey().references(() => householdExports.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    manifestChecksum: text("manifest_checksum").notNull(),
    artifactCount: integer("artifact_count").notNull(),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }).notNull(),
  },
);

export const accountReauthChallenges = sqliteTable(
  "account_reauth_challenges",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    initialSessionId: text("initial_session_id").notNull(),
    verifiedSessionId: text("verified_session_id"),
    status: text("status", { enum: ["pending", "verified", "consumed", "expired"] }).notNull().default("pending"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("account_reauth_user_status_idx").on(table.userId, table.status, table.expiresAt),
    uniqueIndex("account_reauth_verified_session_idx").on(table.verifiedSessionId),
  ],
);

export const accountDeletionOperations = sqliteTable(
  "account_deletion_operations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    householdId: text("household_id"),
    subjectReceiptHash: text("subject_receipt_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    reauthChallengeId: text("reauth_challenge_id").notNull(),
    reauthSessionId: text("reauth_session_id").notNull(),
    status: text("status", { enum: ["grace_period", "processing", "retry_required", "finalizing", "completed", "canceled"] }).notNull().default("grace_period"),
    stage: text("stage").notNull().default("fenced"),
    attemptToken: text("attempt_token"),
    attemptExpiresAt: integer("attempt_expires_at", { mode: "timestamp_ms" }),
    billingCursor: integer("billing_cursor").notNull().default(0),
    providerCursor: integer("provider_cursor").notNull().default(0),
    storageCursor: integer("storage_cursor").notNull().default(0),
    quiescentAt: integer("quiescent_at", { mode: "timestamp_ms" }),
    inventoryStage: text("inventory_stage").notNull().default("billing_accounts"),
    inventoryCursor: text("inventory_cursor"),
    inventoryComplete: integer("inventory_complete", { mode: "boolean" }).notNull().default(false),
    exportPolicy: text("export_policy", { enum: ["skip", "require_completed_export"] }).notNull(),
    graceUntil: integer("grace_until", { mode: "timestamp_ms" }).notNull(),
    snapshot: text("snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("account_deletion_user_live_idx").on(table.userId)
      .where(sql`${table.userId} IS NOT NULL AND ${table.status} NOT IN ('completed', 'canceled')`),
    uniqueIndex("account_deletion_idempotency_idx").on(table.userId, table.idempotencyKey).where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex("account_deletion_receipt_idx").on(table.subjectReceiptHash),
    index("account_deletion_status_idx").on(table.status, table.updatedAt),
  ],
);

export const accountDeletionItems = sqliteTable(
  "account_deletion_items",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull().references(() => accountDeletionOperations.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["billing_checkout", "billing_subscription", "billing_customer", "provider_voice", "storage_key"] }).notNull(),
    reference: text("reference").notNull(),
    status: text("status", { enum: ["pending", "completed"] }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("account_deletion_items_reference_idx").on(table.operationId, table.kind, table.reference),
    index("account_deletion_items_pending_idx").on(table.operationId, table.kind, table.status, table.id),
  ],
);

export const accountDeletionBillingTombstones = sqliteTable(
  "account_deletion_billing_tombstones",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    referenceHash: text("reference_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("account_deletion_billing_tombstones_hash_idx").on(table.referenceHash),
    index("account_deletion_billing_tombstones_expiry_idx").on(table.expiresAt),
  ],
);

export const householdOwnerTransferGuards = sqliteTable("household_owner_transfer_guards", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
  priorOwnerUserId: text("prior_owner_user_id").notNull(),
  newOwnerUserId: text("new_owner_user_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// NearLegacy remains migration-dark. These definitions deliberately mirror the
// additive D1 bridge so the PostgreSQL cutover can map the archive without raw,
// untyped tenant tables.
export const legacyActivationState = sqliteTable("legacy_activation_state", {
  id: text("id").primaryKey(), status: text("status", { enum: ["blocked", "ready"] }).notNull().default("blocked"), migrationVersion: text("migration_version").notNull(), workerHeartbeatAt: integer("worker_heartbeat_at", { mode: "timestamp_ms" }), unresolvedObjects: integer("unresolved_objects").notNull().default(0), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const legacyRateLimits = sqliteTable("legacy_rate_limits", { householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), operation: text("operation").notNull(), windowStartedAt: integer("window_started_at", { mode: "timestamp_ms" }).notNull(), requestCount: integer("request_count").notNull() }, (table) => [uniqueIndex("legacy_rate_limit_scope_idx").on(table.householdId, table.userId, table.operation)]);
export const legacyAuditEvents = sqliteTable("legacy_audit_events", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }), eventType: text("event_type").notNull(), targetKind: text("target_kind").notNull(), targetId: text("target_id").notNull(), requestHash: text("request_hash").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("legacy_audit_household_id_idx").on(table.householdId, table.id)]);
export const legacyMfaEnrollments=sqliteTable("legacy_mfa_enrollments",{id:text("id").primaryKey(),userId:text("user_id").notNull().references(()=>users.id,{onDelete:"cascade"}),method:text("method",{enum:["totp"]}).notNull().default("totp"),status:text("status",{enum:["pending","active","revoked"]}).notNull().default("pending"),secretCiphertext:text("secret_ciphertext").notNull(),secretIv:text("secret_iv").notNull(),lastUsedCounter:integer("last_used_counter").notNull().default(-1),reauthChallengeId:text("reauth_challenge_id").references(()=>accountReauthChallenges.id,{onDelete:"set null"}),reauthSessionId:text("reauth_session_id"),createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull(),verifiedAt:integer("verified_at",{mode:"timestamp_ms"}),revokedAt:integer("revoked_at",{mode:"timestamp_ms"})},table=>[uniqueIndex("legacy_mfa_user_id_idx").on(table.userId,table.id)]);
export const legacyMfaRecoveryCodes=sqliteTable("legacy_mfa_recovery_codes",{id:text("id").primaryKey(),enrollmentId:text("enrollment_id").notNull().references(()=>legacyMfaEnrollments.id,{onDelete:"cascade"}),userId:text("user_id").notNull().references(()=>users.id,{onDelete:"cascade"}),codeHash:text("code_hash").notNull(),createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull(),usedAt:integer("used_at",{mode:"timestamp_ms"})},table=>[uniqueIndex("legacy_mfa_recovery_user_code_idx").on(table.userId,table.codeHash)]);
export const legacyMfaRateLimits=sqliteTable("legacy_mfa_rate_limits",{userId:text("user_id").notNull().references(()=>users.id,{onDelete:"cascade"}),operation:text("operation").notNull(),windowStartedAt:integer("window_started_at",{mode:"timestamp_ms"}).notNull(),requestCount:integer("request_count").notNull()},table=>[primaryKey({columns:[table.userId,table.operation]})]);
export const legacySecurityActions=sqliteTable("legacy_security_actions",{id:text("id").primaryKey(),householdId:text("household_id").notNull().references(()=>households.id,{onDelete:"cascade"}),actorUserId:text("actor_user_id").references(()=>users.id,{onDelete:"set null"}),action:text("action",{enum:["custodian_bootstrap","custodian_appoint","death_report","death_review","contributor_revoke","mfa_enroll","mfa_revoke"]}).notNull(),targetKind:text("target_kind",{enum:["custodian","contributor","mfa"]}).notNull(),targetId:text("target_id").notNull(),requestHash:text("request_hash").notNull(),reauthChallengeId:text("reauth_challenge_id").references(()=>accountReauthChallenges.id,{onDelete:"set null"}),reauthSessionId:text("reauth_session_id"),createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull()},table=>[uniqueIndex("legacy_security_action_household_id_idx").on(table.householdId,table.id)]);
export const legacyCustodians = sqliteTable("legacy_custodians", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), userId: text("user_id").references(() => users.id, { onDelete: "set null" }), role: text("role", { enum: ["primary", "successor"] }).notNull(), status: text("status", { enum: ["pending", "active", "revoked"] }).notNull().default("pending"), appointedByUserId: text("appointed_by_user_id").references(() => users.id, { onDelete: "set null" }), acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("legacy_custodian_household_user_idx").on(table.householdId, table.userId), uniqueIndex("legacy_custodian_household_id_idx").on(table.householdId, table.id)]);
export const legacyCustodianTransfers = sqliteTable("legacy_custodian_transfers", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), fromCustodianId: text("from_custodian_id").notNull(), toCustodianId: text("to_custodian_id").notNull(), requestedByUserId: text("requested_by_user_id").references(() => users.id, { onDelete: "set null" }), status: text("status", { enum: ["requested", "completed"] }).notNull().default("requested"), reauthChallengeId: text("reauth_challenge_id").references(() => accountReauthChallenges.id,{onDelete:"set null"}), reauthSessionId:text("reauth_session_id"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), completedAt: integer("completed_at", { mode: "timestamp_ms" }),
}, (table) => [uniqueIndex("legacy_transfer_household_id_idx").on(table.householdId, table.id)]);
export const legacyCustodianAcceptances=sqliteTable("legacy_custodian_acceptances",{id:text("id").primaryKey(),householdId:text("household_id").notNull().references(()=>households.id,{onDelete:"cascade"}),custodianId:text("custodian_id").notNull().references(()=>legacyCustodians.id,{onDelete:"restrict"}),userId:text("user_id").references(()=>users.id,{onDelete:"set null"}),requestHash:text("request_hash").notNull(),reauthChallengeId:text("reauth_challenge_id").references(()=>accountReauthChallenges.id,{onDelete:"set null"}),reauthSessionId:text("reauth_session_id"),createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull()},table=>[uniqueIndex("legacy_acceptance_household_id_idx").on(table.householdId,table.id),uniqueIndex("legacy_acceptance_custodian_idx").on(table.householdId,table.custodianId)]);
export const legacyLivenessChallenges = sqliteTable("legacy_liveness_challenges", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), contributorId: text("contributor_id").notNull().references(() => contributors.id, { onDelete: "cascade" }), userId: text("user_id").references(() => users.id, { onDelete: "set null" }), kind: text("kind", { enum: ["recording", "transcription", "synthetic"] }).notNull(), phrase: text("phrase").notNull(), phraseHash: text("phrase_hash").notNull(), status: text("status", { enum: ["issued", "consumed", "expired"] }).notNull().default("issued"), expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), consumedAt: integer("consumed_at", { mode: "timestamp_ms" }) }, (table) => [uniqueIndex("legacy_liveness_household_id_idx").on(table.householdId, table.id)]);
export const legacyMediaProbeReceipts = sqliteTable("legacy_media_probe_receipts", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), challengeId: text("challenge_id").notNull().references(() => legacyLivenessChallenges.id, { onDelete: "restrict" }), userId: text("user_id").references(() => users.id, { onDelete: "set null" }), contributorId: text("contributor_id").notNull().references(() => contributors.id, { onDelete: "cascade" }), kind: text("kind").notNull(), consentKind: text("consent_kind", { enum: ["recording", "transcription", "synthetic"] }).notNull(), checksum: text("checksum").notNull().unique(), byteSize: integer("byte_size").notNull(), contentType: text("content_type").notNull(), durationMs: integer("duration_ms").notNull(), phraseMatched: integer("phrase_matched", { mode: "boolean" }).notNull(), liveSpeakerVerified: integer("live_speaker_verified", { mode: "boolean" }).notNull(), processorReceiptHash: text("processor_receipt_hash").notNull().unique(), status: text("status", { enum: ["verified", "consumed", "expired"] }).notNull().default("verified"), expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), consumedAt: integer("consumed_at", { mode: "timestamp_ms" }) }, (table) => [uniqueIndex("legacy_probe_household_id_idx").on(table.householdId, table.id)]);
export const legacyConsents = sqliteTable("legacy_consents", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), contributorId: text("contributor_id").notNull().references(() => contributors.id, { onDelete: "cascade" }), attestingUserId: text("attesting_user_id").references(() => users.id, { onDelete: "set null" }), supersedesConsentId: text("supersedes_consent_id"), version: text("version").notNull(), kind: text("kind", { enum: ["recording", "transcription", "synthetic"] }).notNull(), audience: text("audience").notNull(), purpose: text("purpose").notNull(), posthumousUse: integer("posthumous_use", { mode: "boolean" }).notNull().default(false), status: text("status", { enum: ["active", "superseded", "revoked", "expired"] }).notNull().default("active"), evidenceKey: text("evidence_key"), evidenceChecksum: text("evidence_checksum"), evidenceMediaAssetId: text("evidence_media_asset_id").notNull().references(() => mediaAssets.id, { onDelete: "restrict" }), livenessChallengeId: text("liveness_challenge_id").notNull().references(() => legacyLivenessChallenges.id, { onDelete: "restrict" }), mediaProbeReceiptId: text("media_probe_receipt_id").notNull().references(() => legacyMediaProbeReceipts.id, { onDelete: "restrict" }), attestedAt: integer("attested_at", { mode: "timestamp_ms" }).notNull(), expiresAt: integer("expires_at", { mode: "timestamp_ms" }), revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
}, (table) => [uniqueIndex("legacy_consents_household_id_idx").on(table.householdId, table.id), uniqueIndex("legacy_consent_probe_idx").on(table.householdId, table.mediaProbeReceiptId), index("legacy_consent_contributor_status").on(table.householdId, table.contributorId, table.status)]);
export const legacyEvidenceRetention = sqliteTable("legacy_evidence_retention", { householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), consentId: text("consent_id").notNull().references(() => legacyConsents.id, { onDelete: "cascade" }), mediaAssetId: text("media_asset_id").notNull().references(() => mediaAssets.id, { onDelete: "restrict" }), deleteAfter: integer("delete_after", { mode: "timestamp_ms" }).notNull(), status: text("status", { enum: ["retained", "cleanup_required", "deleted", "dead_letter"] }).notNull().default("retained"), attempts:integer("attempts").notNull().default(0),nextAttemptAt:integer("next_attempt_at",{mode:"timestamp_ms"}),attemptToken:text("attempt_token"),leaseExpiresAt:integer("lease_expires_at",{mode:"timestamp_ms"}),deadLetteredAt:integer("dead_lettered_at",{mode:"timestamp_ms"}),errorCode:text("error_code"), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull() }, (table) => [uniqueIndex("legacy_evidence_consent_idx").on(table.householdId, table.consentId), uniqueIndex("legacy_evidence_media_idx").on(table.householdId, table.mediaAssetId)]);
export const legacyInterviews = sqliteTable("legacy_interviews", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), contributorId: text("contributor_id").notNull().references(() => contributors.id, { onDelete: "restrict" }), createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }), title: text("title").notNull(), idempotencyKey: text("idempotency_key").notNull(), requestHash: text("request_hash").notNull(), promptSetVersion: text("prompt_set_version").notNull(), status: text("status", { enum: ["draft", "recording", "completed", "archived", "deleted"] }).notNull().default("draft"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(), deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
}, (table) => [uniqueIndex("legacy_interview_household_id_idx").on(table.householdId, table.id), uniqueIndex("legacy_interview_idempotency_idx").on(table.householdId, table.idempotencyKey)]);
export const legacyRecordings = sqliteTable("legacy_recordings", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), interviewId: text("interview_id").references(() => legacyInterviews.id, { onDelete: "set null" }), contributorId: text("contributor_id").notNull().references(() => contributors.id, { onDelete: "restrict" }), consentId: text("consent_id").notNull().references(() => legacyConsents.id, { onDelete: "restrict" }), mediaAssetId: text("media_asset_id").notNull().references(() => mediaAssets.id, { onDelete: "restrict" }), transcriptionJobId: text("transcription_job_id").references(() => jobs.id, { onDelete: "set null" }), recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(), durationMs: integer("duration_ms").notNull(), status: text("status", { enum: ["processing", "ready", "failed", "delete_pending", "deleted"] }).notNull().default("processing"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(), deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
}, (table) => [uniqueIndex("legacy_recording_household_id_idx").on(table.householdId, table.id), uniqueIndex("legacy_recording_media_idx").on(table.householdId, table.mediaAssetId)]);
export const legacyTranscripts = sqliteTable("legacy_transcripts", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), recordingId: text("recording_id").notNull().references(() => legacyRecordings.id, { onDelete: "cascade" }), consentId: text("consent_id").notNull().references(() => legacyConsents.id, { onDelete: "restrict" }), jobBindingId: text("job_binding_id").notNull(), providerRequestId: text("provider_request_id"), language: text("language").notNull(), status: text("status", { enum: ["processing", "ready", "failed", "deleted"] }).notNull().default("processing"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(), deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
}, (table) => [uniqueIndex("legacy_transcript_household_id_idx").on(table.householdId, table.id), uniqueIndex("legacy_transcript_recording_idx").on(table.householdId, table.recordingId)]);
export const legacyTranscriptSegments = sqliteTable("legacy_transcript_segments", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), transcriptId: text("transcript_id").notNull().references(() => legacyTranscripts.id, { onDelete: "cascade" }), recordingId: text("recording_id").notNull().references(() => legacyRecordings.id, { onDelete: "cascade" }), contributorId: text("contributor_id").notNull().references(() => contributors.id, { onDelete: "restrict" }), ordinal: integer("ordinal").notNull(), startMs: integer("start_ms").notNull(), endMs: integer("end_ms").notNull(), originalText: text("original_text").notNull(), effectiveText: text("effective_text").notNull(), provenance: text("provenance").notNull().default("original_recording"), status: text("status", { enum: ["ready", "superseded", "deleted"] }).notNull().default("ready"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("legacy_segment_household_id_idx").on(table.householdId, table.id), uniqueIndex("legacy_segment_ordinal_idx").on(table.transcriptId, table.ordinal)]);
export const legacyTranscriptCorrections = sqliteTable("legacy_transcript_corrections", {
  id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), segmentId: text("segment_id").notNull().references(() => legacyTranscriptSegments.id, { onDelete: "cascade" }), correctedByUserId: text("corrected_by_user_id").references(() => users.id, { onDelete: "set null" }), speakerContributorId: text("speaker_contributor_id").notNull().references(() => contributors.id, { onDelete: "restrict" }), correctedText: text("corrected_text").notNull(), reason: text("reason").notNull(), idempotencyKey: text("idempotency_key").notNull(), requestHash: text("request_hash").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("legacy_correction_household_id_idx").on(table.householdId, table.id), uniqueIndex("legacy_correction_idempotency_idx").on(table.householdId, table.idempotencyKey)]);
export const legacyMemories = sqliteTable("legacy_memories", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), contributorId: text("contributor_id").notNull().references(() => contributors.id), title: text("title").notNull(), summary: text("summary"), sourceSegmentId: text("source_segment_id").notNull().references(() => legacyTranscriptSegments.id), status: text("status").notNull().default("active"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(), deletedAt: integer("deleted_at", { mode: "timestamp_ms" }) });
export const legacyPeople = sqliteTable("legacy_people", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), displayName: text("display_name").notNull(), relationship: text("relationship"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull() });
export const legacyPlaces = sqliteTable("legacy_places", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), name: text("name").notNull(), description: text("description"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull() });
export const legacyPhotos = sqliteTable("legacy_photos", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), mediaAssetId: text("media_asset_id").notNull().references(() => mediaAssets.id), caption: text("caption"), takenAt: integer("taken_at", { mode: "timestamp_ms" }), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull() });
export const legacyTags = sqliteTable("legacy_tags", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), name: text("name").notNull(), normalizedName: text("normalized_name").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull() }, (table) => [uniqueIndex("legacy_tag_name_idx").on(table.householdId, table.normalizedName)]);
export const legacyMemoryTags = sqliteTable("legacy_memory_tags", { householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), memoryId: text("memory_id").notNull().references(() => legacyMemories.id, { onDelete: "cascade" }), tagId: text("tag_id").notNull().references(() => legacyTags.id, { onDelete: "cascade" }) });
export const legacyTimelineEvents = sqliteTable("legacy_timeline_events", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), memoryId: text("memory_id").notNull().references(() => legacyMemories.id, { onDelete: "cascade" }), occurredOn: text("occurred_on"), precision: text("precision").notNull(), title: text("title").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull() });
export const legacyCollections = sqliteTable("legacy_collections", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }), name: text("name").notNull(), description: text("description"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(), deletedAt: integer("deleted_at", { mode: "timestamp_ms" }) });
export const legacyCollectionItems = sqliteTable("legacy_collection_items", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), collectionId: text("collection_id").notNull().references(() => legacyCollections.id, { onDelete: "cascade" }), memoryId: text("memory_id").notNull().references(() => legacyMemories.id, { onDelete: "cascade" }), position: integer("position").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull() }, (table) => [uniqueIndex("legacy_collection_position_idx").on(table.collectionId, table.position)]);
export const legacyQueryReceipts = sqliteTable("legacy_query_receipts", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), requestedByUserId: text("requested_by_user_id").references(() => users.id, { onDelete: "set null" }), questionHash: text("question_hash").notNull(), supported: integer("supported", { mode: "boolean" }).notNull(), answerKind: text("answer_kind").notNull(), status: text("status").notNull(), answerText: text("answer_text").notNull(), answerChecksum: text("answer_checksum").notNull(), selectedSegmentId: text("selected_segment_id"), selectedTranscriptId: text("selected_transcript_id"), selectedCorrectionId: text("selected_correction_id"), selectedRecordingId: text("selected_recording_id"), selectedScoreMicros: integer("selected_score_micros"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), completedAt: integer("completed_at", { mode: "timestamp_ms" }) });
export const legacyQuerySources = sqliteTable("legacy_query_sources", { householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), queryReceiptId: text("query_receipt_id").notNull().references(() => legacyQueryReceipts.id, { onDelete: "cascade" }), segmentId: text("segment_id").notNull().references(() => legacyTranscriptSegments.id), transcriptId: text("transcript_id").notNull().references(() => legacyTranscripts.id), correctionId: text("correction_id").references(() => legacyTranscriptCorrections.id), recordingId: text("recording_id").notNull().references(() => legacyRecordings.id), rank: integer("rank").notNull(), scoreMicros: integer("score_micros").notNull() });
export const legacyJobBindings = sqliteTable("legacy_job_bindings", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }), contributorId: text("contributor_id").notNull().references(() => contributors.id), recordingId: text("recording_id").references(() => legacyRecordings.id), consentId: text("consent_id").notNull().references(() => legacyConsents.id), reservationId: text("reservation_id").references(() => usageReservations.id), providerSpendReservationId: text("provider_spend_reservation_id").references(() => providerSpendReservations.id), operation: text("operation").notNull(), status: text("status").notNull().default("active"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull() });
export const legacyUploadOperations = sqliteTable("legacy_upload_operations", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), requestedByUserId: text("requested_by_user_id").references(() => users.id, { onDelete: "set null" }), kind: text("kind").notNull(), requestHash: text("request_hash").notNull(), storageKey: text("storage_key").notNull(), checksum: text("checksum").notNull(), byteSize: integer("byte_size").notNull(), status: text("status").notNull().default("staged"), targetId: text("target_id").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull() }, (table) => [uniqueIndex("legacy_upload_storage_key_idx").on(table.storageKey), uniqueIndex("legacy_upload_household_id_idx").on(table.householdId, table.id)]);
export const legacyExportOperations = sqliteTable("legacy_export_operations", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), requestedByUserId: text("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),requestHash:text("request_hash").notNull(), status: text("status").notNull().default("queued"), snapshotAt: integer("snapshot_at", { mode: "timestamp_ms" }).notNull(), inventoryStage:text("inventory_stage").notNull().default("recordings"), cursor: text("cursor"), manifestKey: text("manifest_key"), manifestChecksum: text("manifest_checksum"), partCount: integer("part_count").notNull().default(0), attempts:integer("attempts").notNull().default(0),nextAttemptAt:integer("next_attempt_at",{mode:"timestamp_ms"}),deadLetteredAt:integer("dead_lettered_at",{mode:"timestamp_ms"}),errorCode:text("error_code"), expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),reauthChallengeId:text("reauth_challenge_id").references(()=>accountReauthChallenges.id,{onDelete:"set null"}),reauthSessionId:text("reauth_session_id"), attemptToken: text("attempt_token"), leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull() });
export const legacyExportParts = sqliteTable("legacy_export_parts", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), exportId: text("export_id").notNull().references(() => legacyExportOperations.id, { onDelete: "cascade" }), ordinal: integer("ordinal").notNull(), sourceKind:text("source_kind"),sourceId:text("source_id"),logicalPath:text("logical_path"),contentType:text("content_type"), storageKey: text("storage_key").notNull(), checksum: text("checksum").notNull(), byteSize: integer("byte_size").notNull(), status: text("status").notNull().default("copying"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull() });
export const legacyExportConsents = sqliteTable("legacy_export_consents", { householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), exportId: text("export_id").notNull().references(() => legacyExportOperations.id, { onDelete: "cascade" }), consentId: text("consent_id").notNull().references(() => legacyConsents.id, { onDelete: "restrict" }) });
export const legacyDeletionOperations = sqliteTable("legacy_deletion_operations", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), requestedByUserId: text("requested_by_user_id").references(() => users.id, { onDelete: "set null" }), targetKind: text("target_kind").notNull(), targetId: text("target_id").notNull(),requestHash:text("request_hash").notNull(),reauthChallengeId:text("reauth_challenge_id").references(()=>accountReauthChallenges.id,{onDelete:"set null"}),reauthSessionId:text("reauth_session_id"), status: text("status").notNull().default("queued"), cursor: text("cursor"), attemptToken: text("attempt_token"), leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }), attempts:integer("attempts").notNull().default(0),nextAttemptAt:integer("next_attempt_at",{mode:"timestamp_ms"}),deadLetteredAt:integer("dead_lettered_at",{mode:"timestamp_ms"}), errorCode: text("error_code"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(), completedAt: integer("completed_at", { mode: "timestamp_ms" }) });
export const legacyErasureTombstones = sqliteTable("legacy_erasure_tombstones", {householdId:text("household_id").notNull().references(()=>households.id,{onDelete:"cascade"}),targetKind:text("target_kind",{enum:["archive","contributor","recording"]}).notNull(),targetId:text("target_id").notNull(),operationId:text("operation_id").notNull().references(()=>legacyDeletionOperations.id,{onDelete:"cascade"}),completedAt:integer("completed_at",{mode:"timestamp_ms"}).notNull()},table=>[primaryKey({columns:[table.householdId,table.targetKind,table.targetId]})]);
export const legacyDeletionItems = sqliteTable("legacy_deletion_items", { id: text("id").primaryKey(), householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }), operationId: text("operation_id").notNull().references(() => legacyDeletionOperations.id, { onDelete: "cascade" }), objectKind: text("object_kind").notNull(), objectId: text("object_id").notNull(), storageKey: text("storage_key"), status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull() });
export const legacyErasureAuthorizations=sqliteTable("legacy_erasure_authorizations",{id:text("id").primaryKey(),householdId:text("household_id").notNull(),operationKind:text("operation_kind").notNull(),operationId:text("operation_id").notNull(),active:integer("active",{mode:"boolean"}).notNull().default(true),createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull(),expiresAt:integer("expires_at",{mode:"timestamp_ms"}).notNull()},table=>[uniqueIndex("legacy_erasure_operation_idx").on(table.operationKind,table.operationId)]);
