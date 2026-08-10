CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL,
  `display_name` text,
  `role` text DEFAULT 'parent' NOT NULL,
  `stripe_customer_id` text,
  `subscription_id` text,
  `subscription_status` text DEFAULT 'free' NOT NULL,
  `credits_remaining` integer DEFAULT 1 NOT NULL,
  `consent_version` text,
  `consented_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_stripe_customer_idx` ON `users` (`stripe_customer_id`);
--> statement-breakpoint
CREATE TABLE `children` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `nickname` text NOT NULL,
  `age_months` integer,
  `bedtime_challenge` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `children_user_idx` ON `children` (`user_id`);
--> statement-breakpoint
CREATE TABLE `voices` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `provider_voice_id` text NOT NULL,
  `name` text NOT NULL,
  `status` text DEFAULT 'processing' NOT NULL,
  `consent_attested_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `deleted_at` integer,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `voices_user_idx` ON `voices` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `voices_provider_idx` ON `voices` (`provider_voice_id`);
--> statement-breakpoint
CREATE TABLE `sleep_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `child_id` text,
  `voice_id` text,
  `title` text NOT NULL,
  `script` text NOT NULL,
  `script_mode` text NOT NULL,
  `theme` text NOT NULL,
  `style` text NOT NULL,
  `background_sound` text NOT NULL,
  `duration_minutes` integer NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `audio_key` text,
  `provider_request_id` text,
  `error_code` text,
  `created_at` integer NOT NULL,
  `completed_at` integer,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`voice_id`) REFERENCES `voices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sessions_user_created_idx` ON `sleep_sessions` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sleep_sessions` (`status`);
--> statement-breakpoint
CREATE TABLE `usage_events` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `session_id` text,
  `type` text NOT NULL,
  `units` integer DEFAULT 1 NOT NULL,
  `metadata` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`session_id`) REFERENCES `sleep_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `usage_user_created_idx` ON `usage_events` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `stripe_events` (
  `id` text PRIMARY KEY NOT NULL,
  `type` text NOT NULL,
  `processed_at` integer NOT NULL
);
