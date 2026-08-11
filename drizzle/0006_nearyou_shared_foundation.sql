CREATE TABLE `households` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `owner_user_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `households_owner_user_idx` ON `households` (`owner_user_id`);
--> statement-breakpoint
CREATE TABLE `household_members` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `user_id` text NOT NULL,
  `role` text NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_members_household_user_idx` ON `household_members` (`household_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `household_members_user_status_idx` ON `household_members` (`user_id`,`status`);
--> statement-breakpoint
CREATE TABLE `household_invitations` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `invited_by_user_id` text NOT NULL,
  `invited_email` text NOT NULL,
  `role` text NOT NULL,
  `token_hash` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `expires_at` integer NOT NULL,
  `accepted_by_user_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`accepted_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_invitations_token_hash_idx` ON `household_invitations` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `household_invitations_household_status_idx` ON `household_invitations` (`household_id`,`status`);
--> statement-breakpoint
CREATE INDEX `household_invitations_email_status_idx` ON `household_invitations` (`invited_email`,`status`);
--> statement-breakpoint
INSERT INTO `households` (`id`, `name`, `owner_user_id`, `created_at`, `updated_at`)
SELECT 'household:' || `id`, COALESCE(NULLIF(TRIM(`display_name`), ''), `email`) || '''s household', `id`, `created_at`, `updated_at`
FROM `users`;
--> statement-breakpoint
INSERT INTO `household_members` (`id`, `household_id`, `user_id`, `role`, `status`, `created_at`, `updated_at`)
SELECT 'household-member:' || `id`, 'household:' || `id`, `id`, 'owner', 'active', `created_at`, `updated_at`
FROM `users`;
--> statement-breakpoint
ALTER TABLE `children` ADD `household_id` text REFERENCES `households`(`id`) ON DELETE cascade;
--> statement-breakpoint
UPDATE `children` SET `household_id` = 'household:' || `user_id`;
--> statement-breakpoint
CREATE INDEX `children_household_idx` ON `children` (`household_id`);
--> statement-breakpoint
CREATE TABLE `child_profiles` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `legacy_child_id` text,
  `nickname` text NOT NULL,
  `normalized_nickname` text NOT NULL,
  `age_months` integer,
  `bedtime_challenge` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `archived_at` integer,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`legacy_child_id`) REFERENCES `children`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `child_profiles_legacy_child_idx` ON `child_profiles` (`legacy_child_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `child_profiles_household_nickname_idx` ON `child_profiles` (`household_id`,`normalized_nickname`);
--> statement-breakpoint
ALTER TABLE `children` ADD `profile_id` text REFERENCES `child_profiles`(`id`) ON DELETE set null;
--> statement-breakpoint
WITH `normalized_children` AS (
  SELECT *, COALESCE(`normalized_nickname`, LOWER(TRIM(`nickname`))) AS `bridge_nickname`
  FROM `children`
), `ranked_children` AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY `household_id`, `bridge_nickname` ORDER BY `id`) AS `nickname_rank`
  FROM `normalized_children`
)
INSERT INTO `child_profiles` (`id`, `household_id`, `legacy_child_id`, `nickname`, `normalized_nickname`, `age_months`, `bedtime_challenge`, `created_at`, `updated_at`)
SELECT 'child-profile:' || `id`, `household_id`, `id`, `nickname`, CASE WHEN `nickname_rank` = 1 THEN `bridge_nickname` ELSE `bridge_nickname` || ':legacy:' || `id` END, `age_months`, `bedtime_challenge`, `created_at`, `updated_at`
FROM `ranked_children`;
--> statement-breakpoint
UPDATE `children` SET `profile_id` = 'child-profile:' || `id`;
--> statement-breakpoint
CREATE TABLE `contributors` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `adult_user_id` text,
  `display_name` text NOT NULL,
  `relationship` text,
  `status` text DEFAULT 'invited' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`adult_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `contributors_household_status_idx` ON `contributors` (`household_id`,`status`);
--> statement-breakpoint
ALTER TABLE `voices` ADD `household_id` text REFERENCES `households`(`id`) ON DELETE cascade;
--> statement-breakpoint
UPDATE `voices` SET `household_id` = 'household:' || `user_id`;
--> statement-breakpoint
CREATE INDEX `voices_household_status_idx` ON `voices` (`household_id`,`status`);
--> statement-breakpoint
CREATE TABLE `voice_consents` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `voice_id` text,
  `contributor_id` text,
  `adult_user_id` text NOT NULL,
  `consent_version` text NOT NULL,
  `scope` text NOT NULL,
  `status` text DEFAULT 'pending_verification' NOT NULL,
  `evidence` text,
  `attested_at` integer NOT NULL,
  `revoked_at` integer,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`voice_id`) REFERENCES `voices`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`contributor_id`) REFERENCES `contributors`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`adult_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_consents_voice_version_idx` ON `voice_consents` (`voice_id`,`consent_version`);
--> statement-breakpoint
CREATE INDEX `voice_consents_household_status_idx` ON `voice_consents` (`household_id`,`status`);
--> statement-breakpoint
ALTER TABLE `voices` ADD `current_consent_id` text REFERENCES `voice_consents`(`id`) ON DELETE set null;
--> statement-breakpoint
INSERT INTO `voice_consents` (`id`, `household_id`, `voice_id`, `adult_user_id`, `consent_version`, `scope`, `status`, `evidence`, `attested_at`, `revoked_at`)
SELECT 'voice-consent:' || `voices`.`id`, `voices`.`household_id`, `voices`.`id`, `voices`.`user_id`, 'legacy-voice-checkbox-v1', 'adult_self_private_narration', CASE WHEN `voices`.`status` = 'deleted' THEN 'revoked' ELSE 'pending_verification' END, '{"kind":"legacy_checkbox_attestation","verified":false,"posthumousSynthesis":false}', `voices`.`consent_attested_at`, CASE WHEN `voices`.`status` = 'deleted' THEN `voices`.`deleted_at` ELSE NULL END
FROM `voices` INNER JOIN `users` ON `users`.`id` = `voices`.`user_id`;
--> statement-breakpoint
UPDATE `voices` SET `current_consent_id` = 'voice-consent:' || `id`;
--> statement-breakpoint
CREATE TABLE `entitlements` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `plan_id` text NOT NULL,
  `source` text NOT NULL,
  `status` text NOT NULL,
  `allowance_milliunits` integer NOT NULL,
  `remaining_milliunits` integer NOT NULL,
  `legacy_credits_remaining` integer,
  `external_ref` text,
  `valid_from` integer NOT NULL,
  `valid_until` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `entitlements_household_status_idx` ON `entitlements` (`household_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `entitlements_source_external_idx` ON `entitlements` (`source`,`external_ref`);
--> statement-breakpoint
INSERT INTO `entitlements` (`id`, `household_id`, `plan_id`, `source`, `status`, `allowance_milliunits`, `remaining_milliunits`, `legacy_credits_remaining`, `external_ref`, `valid_from`, `created_at`, `updated_at`)
SELECT 'entitlement:legacy:' || `id`, 'household:' || `id`, CASE WHEN `subscription_status` IN ('active', 'trialing') THEN 'nearsleep_plus_legacy' ELSE 'nearsleep_free' END, 'legacy', 'active', CASE WHEN `subscription_status` IN ('active', 'trialing') THEN 12000 ELSE 1000 END, MAX(`credits_remaining`, 0) * 1000, MAX(`credits_remaining`, 0), `subscription_id`, `created_at`, `created_at`, `updated_at`
FROM `users`;
--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `household_id` text REFERENCES `households`(`id`) ON DELETE cascade;
--> statement-breakpoint
UPDATE `sleep_sessions` SET `household_id` = 'household:' || `user_id`;
--> statement-breakpoint
CREATE INDEX `sessions_household_created_idx` ON `sleep_sessions` (`household_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `usage_events` ADD `household_id` text REFERENCES `households`(`id`) ON DELETE cascade;
--> statement-breakpoint
UPDATE `usage_events` SET `household_id` = 'household:' || `user_id`;
--> statement-breakpoint
CREATE INDEX `usage_household_created_idx` ON `usage_events` (`household_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `usage_ledger` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `user_id` text NOT NULL,
  `entitlement_id` text,
  `legacy_usage_event_id` text,
  `product` text NOT NULL,
  `operation` text NOT NULL,
  `quantity` integer NOT NULL,
  `weight_milliunits` integer NOT NULL,
  `direction` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `metadata` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`entitlement_id`) REFERENCES `entitlements`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`legacy_usage_event_id`) REFERENCES `usage_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_ledger_household_idempotency_idx` ON `usage_ledger` (`household_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `usage_ledger_household_created_idx` ON `usage_ledger` (`household_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `usage_events` ADD `ledger_entry_id` text REFERENCES `usage_ledger`(`id`) ON DELETE set null;
--> statement-breakpoint
INSERT INTO `usage_ledger` (`id`, `household_id`, `user_id`, `entitlement_id`, `legacy_usage_event_id`, `product`, `operation`, `quantity`, `weight_milliunits`, `direction`, `idempotency_key`, `metadata`, `created_at`)
SELECT 'usage-ledger:' || `id`, `household_id`, `user_id`, 'entitlement:legacy:' || `user_id`, `id`, 'nearsleep', 'legacy:' || `type`, `units`, 0, 'debit', 'legacy-usage:' || `id`, `metadata`, `created_at`
FROM `usage_events`;
--> statement-breakpoint
UPDATE `usage_events` SET `ledger_entry_id` = 'usage-ledger:' || `id`;
--> statement-breakpoint
CREATE TABLE `media_assets` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `owner_user_id` text NOT NULL,
  `child_profile_id` text,
  `legacy_session_id` text,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `storage_key` text,
  `content_type` text,
  `byte_size` integer,
  `checksum` text,
  `private` integer DEFAULT true NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`child_profile_id`) REFERENCES `child_profiles`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`legacy_session_id`) REFERENCES `sleep_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_storage_key_idx` ON `media_assets` (`storage_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_legacy_session_idx` ON `media_assets` (`legacy_session_id`);
--> statement-breakpoint
CREATE INDEX `media_assets_household_created_idx` ON `media_assets` (`household_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `media_asset_id` text REFERENCES `media_assets`(`id`) ON DELETE set null;
--> statement-breakpoint
INSERT INTO `media_assets` (`id`, `household_id`, `owner_user_id`, `child_profile_id`, `legacy_session_id`, `kind`, `status`, `storage_key`, `content_type`, `private`, `created_at`, `updated_at`)
SELECT 'media-asset:' || `sleep_sessions`.`id`, `sleep_sessions`.`household_id`, `sleep_sessions`.`user_id`, `children`.`profile_id`, `sleep_sessions`.`id`, 'narration', CASE WHEN `sleep_sessions`.`status` = 'ready' THEN 'ready' WHEN `sleep_sessions`.`status` = 'failed' THEN 'failed' ELSE 'processing' END, `sleep_sessions`.`audio_key`, 'audio/mpeg', true, `sleep_sessions`.`created_at`, COALESCE(`sleep_sessions`.`completed_at`, `sleep_sessions`.`created_at`)
FROM `sleep_sessions` LEFT JOIN `children` ON `children`.`id` = `sleep_sessions`.`child_id`
WHERE `sleep_sessions`.`audio_key` IS NOT NULL;
--> statement-breakpoint
UPDATE `sleep_sessions` SET `media_asset_id` = 'media-asset:' || `id` WHERE `audio_key` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `playlists` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `created_by_user_id` text NOT NULL,
  `name` text NOT NULL,
  `private` integer DEFAULT true NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playlists_household_created_idx` ON `playlists` (`household_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `playlist_items` (
  `id` text PRIMARY KEY NOT NULL,
  `playlist_id` text NOT NULL,
  `media_asset_id` text NOT NULL,
  `position` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`media_asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playlist_items_playlist_media_idx` ON `playlist_items` (`playlist_id`,`media_asset_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `playlist_items_playlist_position_idx` ON `playlist_items` (`playlist_id`,`position`);
--> statement-breakpoint
CREATE TABLE `jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `requested_by_user_id` text NOT NULL,
  `legacy_session_id` text,
  `type` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `idempotency_key` text NOT NULL,
  `request_hash` text NOT NULL,
  `input` text NOT NULL,
  `result` text,
  `attempts` integer DEFAULT 0 NOT NULL,
  `error_code` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `started_at` integer,
  `completed_at` integer,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`legacy_session_id`) REFERENCES `sleep_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_household_idempotency_idx` ON `jobs` (`household_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `jobs_household_status_created_idx` ON `jobs` (`household_id`,`status`,`created_at`);
--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `job_id` text REFERENCES `jobs`(`id`) ON DELETE set null;
--> statement-breakpoint
INSERT INTO `jobs` (`id`, `household_id`, `requested_by_user_id`, `legacy_session_id`, `type`, `status`, `idempotency_key`, `request_hash`, `input`, `result`, `attempts`, `error_code`, `created_at`, `updated_at`, `started_at`, `completed_at`)
SELECT 'job:' || `id`, `household_id`, `user_id`, `id`, 'nearsleep_audio', CASE WHEN `status` = 'ready' THEN 'succeeded' WHEN `status` = 'generating' THEN 'running' WHEN `status` = 'failed' THEN 'failed' ELSE 'queued' END, 'legacy-session:' || `id`, 'legacy-session:' || `id`, json_object('sessionId', `id`), CASE WHEN `status` = 'ready' THEN json_object('audioUrl', '/api/audio/' || `id`) ELSE NULL END, CASE WHEN `status` IN ('generating', 'ready', 'failed') THEN 1 ELSE 0 END, `error_code`, `created_at`, COALESCE(`completed_at`, `created_at`), CASE WHEN `status` IN ('generating', 'ready', 'failed') THEN `created_at` ELSE NULL END, `completed_at`
FROM `sleep_sessions`;
--> statement-breakpoint
UPDATE `sleep_sessions` SET `job_id` = 'job:' || `id`;
--> statement-breakpoint
PRAGMA optimize;
