ALTER TABLE `users` ADD `email_verified` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `image` text;
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `token` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `ip_address` text,
  `user_agent` text,
  `user_id` text NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_idx` ON `auth_sessions` (`token`);
--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `auth_sessions_expiry_idx` ON `auth_sessions` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `oauth_accounts` (
  `id` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `user_id` text NOT NULL,
  `access_token` text,
  `refresh_token` text,
  `id_token` text,
  `access_token_expires_at` integer,
  `refresh_token_expires_at` integer,
  `scope` text,
  `password` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_accounts_provider_idx` ON `oauth_accounts` (`provider_id`,`account_id`);
--> statement-breakpoint
CREATE INDEX `oauth_accounts_user_idx` ON `oauth_accounts` (`user_id`);
--> statement-breakpoint
CREATE TABLE `auth_verifications` (
  `id` text PRIMARY KEY NOT NULL,
  `identifier` text NOT NULL,
  `value` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_verifications_identifier_idx` ON `auth_verifications` (`identifier`);
--> statement-breakpoint
CREATE INDEX `auth_verifications_expiry_idx` ON `auth_verifications` (`expires_at`);
