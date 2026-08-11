import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

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
    role: text("role", { enum: ["owner", "adult_manager", "listener"] }).notNull(),
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
    role: text("role", { enum: ["adult_manager", "listener"] }).notNull(),
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
    ageMonths: integer("age_months"),
    bedtimeChallenge: text("bedtime_challenge"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("child_profiles_legacy_child_idx").on(table.legacyChildId),
    uniqueIndex("child_profiles_household_nickname_idx").on(table.householdId, table.normalizedNickname),
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
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("contributors_household_status_idx").on(table.householdId, table.status)],
);

export const voices = sqliteTable(
  "voices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "cascade" }),
    currentConsentId: text("current_consent_id").references((): AnySQLiteColumn => voiceConsents.id, { onDelete: "set null" }),
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
    uniqueIndex("voice_consents_voice_version_idx").on(table.voiceId, table.consentVersion),
    index("voice_consents_household_status_idx").on(table.householdId, table.status),
  ],
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
    providerRequestId: text("provider_request_id"),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("sessions_user_created_idx").on(table.userId, table.createdAt),
    index("sessions_status_idx").on(table.status),
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

export const mediaAssets = sqliteTable(
  "media_assets",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    childProfileId: text("child_profile_id").references(() => childProfiles.id, { onDelete: "set null" }),
    legacySessionId: text("legacy_session_id").references(() => sleepSessions.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["narration", "recording", "photo", "export"] }).notNull(),
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
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("jobs_household_idempotency_idx").on(table.householdId, table.idempotencyKey),
    index("jobs_household_status_created_idx").on(table.householdId, table.status, table.createdAt),
  ],
);

export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: integer("processed_at", { mode: "timestamp_ms" }).notNull(),
});
