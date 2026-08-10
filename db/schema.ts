import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: text("role", { enum: ["parent", "admin"] }).notNull().default("parent"),
    stripeCustomerId: text("stripe_customer_id"),
    subscriptionId: text("subscription_id"),
    subscriptionStatus: text("subscription_status").notNull().default("free"),
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

export const children = sqliteTable(
  "children",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    nickname: text("nickname").notNull(),
    ageMonths: integer("age_months"),
    bedtimeChallenge: text("bedtime_challenge"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("children_user_idx").on(table.userId)],
);

export const voices = sqliteTable(
  "voices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
  ],
);

export const sleepSessions = sqliteTable(
  "sleep_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    childId: text("child_id").references(() => children.id, { onDelete: "set null" }),
    voiceId: text("voice_id").references(() => voices.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    script: text("script").notNull(),
    scriptMode: text("script_mode", { enum: ["curated", "personalized"] }).notNull(),
    theme: text("theme").notNull(),
    style: text("style").notNull(),
    backgroundSound: text("background_sound").notNull(),
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

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sleepSessions.id, { onDelete: "set null" }),
    type: text("type", { enum: ["script_generation", "audio_generation", "playback"] }).notNull(),
    units: integer("units").notNull().default(1),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("usage_user_created_idx").on(table.userId, table.createdAt)],
);

export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: integer("processed_at", { mode: "timestamp_ms" }).notNull(),
});
