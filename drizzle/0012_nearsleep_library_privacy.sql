ALTER TABLE `sleep_sessions` ADD `deletion_status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `deletion_requested_at` integer;--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `sessions_household_library_idx` ON `sleep_sessions` (`household_id`,`deletion_status`,`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `deletion_reconciliations` ADD `household_id` text REFERENCES `households`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `deletion_reconciliations` ADD `attempt_token` text;--> statement-breakpoint
ALTER TABLE `deletion_reconciliations` ADD `attempt_expires_at` integer;--> statement-breakpoint
UPDATE `deletion_reconciliations` SET `household_id` = COALESCE(
  (SELECT `household_id` FROM `sleep_sessions` WHERE `id` = `deletion_reconciliations`.`scope_id`),
  (SELECT `household_id` FROM `voices` WHERE `id` = `deletion_reconciliations`.`scope_id`),
  (SELECT `household_id` FROM `voice_replacements` WHERE `id` = `deletion_reconciliations`.`scope_id`),
  (SELECT `id` FROM `households` WHERE `id` = `deletion_reconciliations`.`scope_id` AND `deletion_reconciliations`.`scope` = 'account')
);--> statement-breakpoint
CREATE INDEX `deletion_reconciliations_household_status_idx` ON `deletion_reconciliations` (`household_id`,`status`,`id`);--> statement-breakpoint
CREATE TRIGGER `deletion_reconciliations_bind_household`
AFTER INSERT ON `deletion_reconciliations` WHEN NEW.`household_id` IS NULL
BEGIN
  UPDATE `deletion_reconciliations` SET `household_id` = COALESCE(
    (SELECT `household_id` FROM `sleep_sessions` WHERE `id` = NEW.`scope_id`),
    (SELECT `household_id` FROM `voices` WHERE `id` = NEW.`scope_id`),
    (SELECT `household_id` FROM `voice_replacements` WHERE `id` = NEW.`scope_id`),
    (SELECT `id` FROM `households` WHERE `id` = NEW.`scope_id` AND NEW.`scope` = 'account')
  ) WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TABLE `household_storage_reservations` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `media_asset_id` text NOT NULL,
  `byte_size` integer NOT NULL,
  `status` text DEFAULT 'reserved' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `released_at` integer,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON DELETE cascade,
  FOREIGN KEY (`media_asset_id`) REFERENCES `media_assets`(`id`) ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `household_storage_media_idx` ON `household_storage_reservations` (`media_asset_id`);--> statement-breakpoint
CREATE INDEX `household_storage_status_idx` ON `household_storage_reservations` (`household_id`,`status`);--> statement-breakpoint
CREATE TABLE `task2c_media_integrity` (
  `media_asset_id` text PRIMARY KEY NOT NULL,
  `byte_size` integer NOT NULL,
  `checksum` text NOT NULL,
  `verified_at` integer NOT NULL,
  FOREIGN KEY (`media_asset_id`) REFERENCES `media_assets`(`id`) ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `household_storage_reservations` (`id`,`household_id`,`media_asset_id`,`byte_size`,`status`,`created_at`,`updated_at`)
SELECT 'storage:' || `id`, `household_id`, `id`, `byte_size`, 'reserved', `created_at`, `updated_at`
FROM `media_assets` WHERE `status` = 'ready' AND `byte_size` IS NOT NULL AND `byte_size` > 0;--> statement-breakpoint
UPDATE `household_storage_reservations` SET `status` = 'committed' WHERE `status` = 'reserved' AND EXISTS (SELECT 1 FROM `media_assets` WHERE `media_assets`.`id` = `household_storage_reservations`.`media_asset_id` AND `media_assets`.`status` = 'ready');--> statement-breakpoint
CREATE TABLE `task2c_activation_state` (
  `id` text PRIMARY KEY NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `unresolved_ready_media` integer DEFAULT 0 NOT NULL,
  `checked_at` integer NOT NULL,
  `scheduler_heartbeat_at` integer,
  `scheduler_run_id` text
);--> statement-breakpoint
INSERT INTO `task2c_activation_state` (`id`,`status`,`unresolved_ready_media`,`checked_at`)
SELECT 'storage', CASE WHEN COUNT(*) = 0 THEN 'ready' ELSE 'pending' END, COUNT(*), unixepoch('subsec') * 1000
FROM `media_assets` m WHERE m.`status` = 'ready' AND (
  m.`byte_size` IS NULL OR m.`byte_size` <= 0 OR length(COALESCE(m.`checksum`,'')) <> 64 OR lower(m.`checksum`) GLOB '*[^0-9a-f]*'
  OR NOT EXISTS (SELECT 1 FROM `household_storage_reservations` r WHERE r.`media_asset_id` = m.`id` AND r.`household_id` = m.`household_id` AND r.`byte_size` = m.`byte_size` AND r.`status` = 'committed')
  OR NOT EXISTS (SELECT 1 FROM `task2c_media_integrity` i WHERE i.`media_asset_id` = m.`id` AND i.`byte_size` = m.`byte_size` AND i.`checksum` = m.`checksum`)
);--> statement-breakpoint
CREATE TABLE `household_exports` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `requested_by_user_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `request_hash` text NOT NULL,
  `snapshot` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `attempt_token` text,
  `attempt_expires_at` integer,
  `inventory_stage` text DEFAULT 'consents' NOT NULL,
  `inventory_cursor` text,
  `metadata_page_count` integer DEFAULT 0 NOT NULL,
  `cursor_position` integer DEFAULT 0 NOT NULL,
  `inventory_count` integer DEFAULT 0 NOT NULL,
  `manifest_storage_key` text,
  `manifest_byte_size` integer,
  `manifest_checksum` text,
  `error_code` text,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `completed_at` integer,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON DELETE cascade,
  FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `household_exports_idempotency_idx` ON `household_exports` (`household_id`,`requested_by_user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `household_exports_status_idx` ON `household_exports` (`household_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TRIGGER `household_exports_one_live_export`
BEFORE INSERT ON `household_exports` WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = NEW.`household_id` AND `status` IN ('queued','running','failed','succeeded') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_live_export_exists'); END;--> statement-breakpoint
CREATE TABLE `household_export_parts` (
  `id` text PRIMARY KEY NOT NULL,
  `export_id` text NOT NULL,
  `source_media_asset_id` text,
  `source_storage_key` text NOT NULL,
  `export_storage_key` text NOT NULL,
  `content_type` text NOT NULL,
  `byte_size` integer,
  `checksum` text,
  `status` text DEFAULT 'pending' NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`export_id`) REFERENCES `household_exports`(`id`) ON DELETE cascade,
  FOREIGN KEY (`source_media_asset_id`) REFERENCES `media_assets`(`id`) ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX `household_export_parts_source_idx` ON `household_export_parts` (`export_id`,`source_media_asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `household_export_parts_key_idx` ON `household_export_parts` (`export_storage_key`);--> statement-breakpoint
CREATE INDEX `household_export_parts_status_idx` ON `household_export_parts` (`export_id`,`status`,`id`);--> statement-breakpoint
CREATE TABLE `household_export_metadata_pages` (
  `id` text PRIMARY KEY NOT NULL,
  `export_id` text NOT NULL,
  `position` integer NOT NULL,
  `kind` text NOT NULL,
  `storage_key` text NOT NULL,
  `item_count` integer NOT NULL,
  `byte_size` integer NOT NULL,
  `checksum` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`export_id`) REFERENCES `household_exports`(`id`) ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `household_export_download_confirmations` (
  `export_id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `manifest_checksum` text NOT NULL,
  `artifact_count` integer NOT NULL,
  `confirmed_at` integer NOT NULL,
  FOREIGN KEY (`export_id`) REFERENCES `household_exports`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `household_export_metadata_pages_position_idx` ON `household_export_metadata_pages` (`export_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `household_export_metadata_pages_key_idx` ON `household_export_metadata_pages` (`storage_key`);--> statement-breakpoint
CREATE INDEX `household_export_metadata_pages_status_idx` ON `household_export_metadata_pages` (`export_id`,`status`,`position`);--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_live_export_delete_fence`
BEFORE UPDATE OF `deletion_status` ON `sleep_sessions`
WHEN OLD.`deletion_status` = 'active' AND NEW.`deletion_status` = 'delete_pending'
  AND EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = NEW.`household_id`
    AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'active_household_export'); END;--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_live_export_preferences_fence`
BEFORE UPDATE OF `favorite`,`repeat_minutes` ON `sleep_sessions`
WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = NEW.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_live_export_insert_fence`
BEFORE INSERT ON `sleep_sessions`
WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = NEW.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_live_export_finalize_fence`
BEFORE UPDATE OF `status` ON `sleep_sessions`
WHEN OLD.`status` <> 'ready' AND NEW.`status` = 'ready'
  AND EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = NEW.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `child_profiles_live_export_insert_fence`
BEFORE INSERT ON `child_profiles`
WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = NEW.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `child_profiles_live_export_update_fence`
BEFORE UPDATE ON `child_profiles`
WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = OLD.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `voices_live_export_insert_fence`
BEFORE INSERT ON `voices`
WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = NEW.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `voices_live_export_update_fence`
BEFORE UPDATE ON `voices`
WHEN NEW.`status` <> 'deleted' AND EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = OLD.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `voice_consents_live_export_insert_fence`
BEFORE INSERT ON `voice_consents`
WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = NEW.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `voice_consents_live_export_update_fence`
BEFORE UPDATE ON `voice_consents`
WHEN NOT (OLD.`status` <> 'revoked' AND NEW.`status` = 'revoked')
  AND EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = OLD.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `voice_consents_revoke_invalidates_exports`
AFTER UPDATE OF `status`,`revoked_at` ON `voice_consents`
WHEN OLD.`status` <> 'revoked' AND NEW.`status` = 'revoked'
BEGIN
  UPDATE `household_exports` SET `status` = 'failed',
    `expires_at` = COALESCE(NEW.`revoked_at`, unixepoch('subsec') * 1000),
    `error_code` = 'consent_revoked_cleanup_pending', `updated_at` = COALESCE(NEW.`revoked_at`, unixepoch('subsec') * 1000)
  WHERE `household_id` = NEW.`household_id` AND `status` IN ('queued','running','failed','succeeded');
END;--> statement-breakpoint
CREATE TRIGGER `household_exports_consent_invalidation_fence`
BEFORE UPDATE ON `household_exports`
WHEN OLD.`error_code` = 'consent_revoked_cleanup_pending'
  AND NOT (NEW.`status` = 'expired' OR NEW.`error_code` IN ('export_expiry_cleanup_pending','export_expiry_cleanup_retry'))
BEGIN SELECT RAISE(ABORT, 'export_consent_invalidated'); END;--> statement-breakpoint
CREATE TRIGGER `household_export_parts_parent_valid_insert`
BEFORE INSERT ON `household_export_parts`
WHEN NOT EXISTS (SELECT 1 FROM `household_exports` WHERE `id` = NEW.`export_id` AND `status` = 'running' AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'export_parent_invalidated'); END;--> statement-breakpoint
CREATE TRIGGER `household_export_parts_parent_valid_update`
BEFORE UPDATE ON `household_export_parts`
WHEN NEW.`status` <> 'failed'
  AND NOT (OLD.`source_media_asset_id` IS NOT NULL AND NEW.`source_media_asset_id` IS NULL
    AND NEW.`id` IS OLD.`id` AND NEW.`export_id` IS OLD.`export_id`
    AND NEW.`source_storage_key` IS OLD.`source_storage_key` AND NEW.`export_storage_key` IS OLD.`export_storage_key`
    AND NEW.`content_type` IS OLD.`content_type` AND NEW.`byte_size` IS OLD.`byte_size`
    AND NEW.`checksum` IS OLD.`checksum` AND NEW.`status` IS OLD.`status`
    AND NEW.`expires_at` IS OLD.`expires_at` AND NEW.`created_at` IS OLD.`created_at` AND NEW.`updated_at` IS OLD.`updated_at`)
  AND NOT EXISTS (SELECT 1 FROM `household_exports` WHERE `id` = NEW.`export_id` AND `status` = 'running' AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'export_parent_invalidated'); END;--> statement-breakpoint
CREATE TRIGGER `household_export_pages_parent_valid_insert`
BEFORE INSERT ON `household_export_metadata_pages`
WHEN NOT EXISTS (SELECT 1 FROM `household_exports` WHERE `id` = NEW.`export_id` AND `status` = 'running' AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'export_parent_invalidated'); END;--> statement-breakpoint
CREATE TRIGGER `household_export_pages_parent_valid_update`
BEFORE UPDATE ON `household_export_metadata_pages`
WHEN NEW.`status` <> 'expired' AND NOT EXISTS (SELECT 1 FROM `household_exports` WHERE `id` = NEW.`export_id` AND `status` = 'running' AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'export_parent_invalidated'); END;--> statement-breakpoint
CREATE TRIGGER `playlists_live_export_insert_fence`
BEFORE INSERT ON `playlists`
WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = NEW.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `playlists_live_export_update_fence`
BEFORE UPDATE ON `playlists`
WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = OLD.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `playlists_live_export_delete_fence`
BEFORE DELETE ON `playlists`
WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = OLD.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `playlist_items_live_export_insert_fence`
BEFORE INSERT ON `playlist_items`
WHEN EXISTS (SELECT 1 FROM `playlists` p JOIN `household_exports` e ON e.`household_id` = p.`household_id` WHERE p.`id` = NEW.`playlist_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `playlist_items_live_export_update_fence`
BEFORE UPDATE ON `playlist_items`
WHEN EXISTS (SELECT 1 FROM `playlists` p JOIN `household_exports` e ON e.`household_id` = p.`household_id` WHERE p.`id` = OLD.`playlist_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `playlist_items_live_export_delete_fence`
BEFORE DELETE ON `playlist_items`
WHEN EXISTS (SELECT 1 FROM `playlists` p JOIN `household_exports` e ON e.`household_id` = p.`household_id` WHERE p.`id` = OLD.`playlist_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `bedtime_queue_live_export_insert_fence`
BEFORE INSERT ON `bedtime_queue_items`
WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = NEW.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `bedtime_queue_live_export_update_fence`
BEFORE UPDATE ON `bedtime_queue_items`
WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = OLD.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `bedtime_queue_live_export_delete_fence`
BEFORE DELETE ON `bedtime_queue_items`
WHEN EXISTS (SELECT 1 FROM `household_exports` WHERE `household_id` = OLD.`household_id` AND `status` IN ('queued','running','failed') AND `expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TABLE `account_reauth_challenges` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `initial_session_id` text NOT NULL,
  `verified_session_id` text,
  `status` text DEFAULT 'pending' NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `verified_at` integer,
  `consumed_at` integer,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `account_reauth_user_status_idx` ON `account_reauth_challenges` (`user_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_reauth_verified_session_idx` ON `account_reauth_challenges` (`verified_session_id`) WHERE `verified_session_id` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `account_deletion_operations` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text,
  `household_id` text,
  `subject_receipt_hash` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `request_hash` text NOT NULL,
  `reauth_challenge_id` text NOT NULL,
  `reauth_session_id` text NOT NULL,
  `status` text DEFAULT 'grace_period' NOT NULL,
  `stage` text DEFAULT 'fenced' NOT NULL,
  `attempt_token` text,
  `attempt_expires_at` integer,
  `billing_cursor` integer DEFAULT 0 NOT NULL,
  `provider_cursor` integer DEFAULT 0 NOT NULL,
  `storage_cursor` integer DEFAULT 0 NOT NULL,
  `quiescent_at` integer,
  `inventory_stage` text DEFAULT 'billing_accounts' NOT NULL,
  `inventory_cursor` text,
  `inventory_complete` integer DEFAULT false NOT NULL,
  `export_policy` text NOT NULL,
  `grace_until` integer NOT NULL,
  `snapshot` text NOT NULL,
  `error_code` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `completed_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `account_deletion_user_live_idx` ON `account_deletion_operations` (`user_id`) WHERE `user_id` IS NOT NULL AND `status` NOT IN ('completed','canceled');--> statement-breakpoint
CREATE UNIQUE INDEX `account_deletion_idempotency_idx` ON `account_deletion_operations` (`user_id`,`idempotency_key`) WHERE `user_id` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `account_deletion_receipt_idx` ON `account_deletion_operations` (`subject_receipt_hash`);--> statement-breakpoint
CREATE INDEX `account_deletion_status_idx` ON `account_deletion_operations` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `account_deletion_items` (
  `id` text PRIMARY KEY NOT NULL,
  `operation_id` text NOT NULL,
  `kind` text NOT NULL,
  `reference` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `completed_at` integer,
  FOREIGN KEY (`operation_id`) REFERENCES `account_deletion_operations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `account_deletion_items_reference_idx` ON `account_deletion_items` (`operation_id`,`kind`,`reference`);--> statement-breakpoint
CREATE INDEX `account_deletion_items_pending_idx` ON `account_deletion_items` (`operation_id`,`kind`,`status`,`id`);--> statement-breakpoint
CREATE TABLE `account_deletion_billing_tombstones` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `reference_hash` text NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `account_deletion_billing_tombstones_hash_idx` ON `account_deletion_billing_tombstones` (`reference_hash`);--> statement-breakpoint
CREATE INDEX `account_deletion_billing_tombstones_expiry_idx` ON `account_deletion_billing_tombstones` (`expires_at`);--> statement-breakpoint
CREATE TABLE `household_owner_transfer_guards` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `prior_owner_user_id` text NOT NULL,
  `new_owner_user_id` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TRIGGER `household_owner_transfer_validate`
BEFORE INSERT ON `household_owner_transfer_guards`
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM `households` WHERE `id` = NEW.`household_id` AND `owner_user_id` = NEW.`new_owner_user_id`)
    THEN RAISE(ABORT, 'household_owner_transfer_conflict') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM `household_members` WHERE `household_id` = NEW.`household_id` AND `status` = 'active' AND `role` = 'owner') <> 1
    THEN RAISE(ABORT, 'household_owner_transfer_conflict') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM `household_members` WHERE `household_id` = NEW.`household_id` AND `user_id` = NEW.`new_owner_user_id` AND `status` = 'active' AND `role` = 'owner')
    THEN RAISE(ABORT, 'household_owner_transfer_conflict') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM `household_members` WHERE `household_id` = NEW.`household_id` AND `user_id` = NEW.`prior_owner_user_id` AND `status` = 'active' AND `role` = 'adult_manager')
    THEN RAISE(ABORT, 'household_owner_transfer_conflict') END;
END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_require_one_use_reauth`
BEFORE INSERT ON `account_deletion_operations`
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM `account_reauth_challenges`
    WHERE `id` = NEW.`reauth_challenge_id` AND `user_id` = NEW.`user_id` AND `status` = 'verified'
      AND `verified_session_id` = NEW.`reauth_session_id` AND `expires_at` > unixepoch('subsec') * 1000)
    THEN RAISE(ABORT, 'fresh_reauthentication_required') END;
  SELECT CASE WHEN NEW.`user_id` IS NULL OR NEW.`household_id` IS NULL
    OR NOT EXISTS (SELECT 1 FROM `households` WHERE `id` = NEW.`household_id` AND `owner_user_id` = NEW.`user_id`)
    OR (SELECT COUNT(*) FROM `household_members` WHERE `user_id` = NEW.`user_id` AND `status` = 'active') <> 1
    OR NOT EXISTS (SELECT 1 FROM `household_members` WHERE `household_id` = NEW.`household_id` AND `user_id` = NEW.`user_id` AND `status` = 'active' AND `role` = 'owner')
    OR (SELECT COUNT(*) FROM `household_members` WHERE `household_id` = NEW.`household_id` AND `status` = 'active') <> 1
    THEN RAISE(ABORT, 'account_deletion_membership_conflict') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM `household_billing_accounts` WHERE `household_id` = NEW.`household_id`
    AND `checkout_pending_at` IS NOT NULL AND `checkout_session_id` IS NULL AND COALESCE(`checkout_status`, 'creating') = 'creating')
    THEN RAISE(ABORT, 'account_deletion_checkout_in_progress') END;
END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_consume_one_use_reauth`
AFTER INSERT ON `account_deletion_operations`
BEGIN
  UPDATE `account_reauth_challenges` SET `status` = 'consumed', `consumed_at` = NEW.`created_at`
    WHERE `id` = NEW.`reauth_challenge_id` AND `user_id` = NEW.`user_id` AND `status` = 'verified' AND `verified_session_id` = NEW.`reauth_session_id`;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'fresh_reauthentication_required') END;
END;--> statement-breakpoint
CREATE VIEW `household_current_plan_limits` AS
SELECT `households`.`id` AS `household_id`,
  COALESCE((SELECT `plan_id` FROM `entitlements`
    WHERE `entitlements`.`household_id` = `households`.`id`
      AND `status` IN ('active','grace')
      AND `valid_from` <= unixepoch('subsec') * 1000
      AND (`valid_until` IS NULL OR `valid_until` > unixepoch('subsec') * 1000)
    ORDER BY CASE WHEN `plan_id` = 'nearsleep_free' THEN 0 ELSE 1 END DESC,
      CASE WHEN `status` = 'active' THEN 1 ELSE 0 END DESC, `updated_at` DESC, `id` DESC LIMIT 1), '') AS `plan_id`,
  CASE COALESCE((SELECT `plan_id` FROM `entitlements`
    WHERE `entitlements`.`household_id` = `households`.`id` AND `status` IN ('active','grace')
      AND `valid_from` <= unixepoch('subsec') * 1000 AND (`valid_until` IS NULL OR `valid_until` > unixepoch('subsec') * 1000)
    ORDER BY CASE WHEN `plan_id` = 'nearsleep_free' THEN 0 ELSE 1 END DESC, CASE WHEN `status` = 'active' THEN 1 ELSE 0 END DESC, `updated_at` DESC, `id` DESC LIMIT 1), '')
    WHEN 'nearsleep_free' THEN 1 WHEN 'nearsleep_plus_legacy' THEN 1 WHEN 'nearyou_plus' THEN 2 WHEN 'nearyou_family' THEN 5 WHEN 'nearlegacy' THEN 8 ELSE 0 END AS `member_limit`,
  CASE COALESCE((SELECT `plan_id` FROM `entitlements`
    WHERE `entitlements`.`household_id` = `households`.`id` AND `status` IN ('active','grace')
      AND `valid_from` <= unixepoch('subsec') * 1000 AND (`valid_until` IS NULL OR `valid_until` > unixepoch('subsec') * 1000)
    ORDER BY CASE WHEN `plan_id` = 'nearsleep_free' THEN 0 ELSE 1 END DESC, CASE WHEN `status` = 'active' THEN 1 ELSE 0 END DESC, `updated_at` DESC, `id` DESC LIMIT 1), '')
    WHEN 'nearsleep_free' THEN 1 WHEN 'nearsleep_plus_legacy' THEN 10 WHEN 'nearyou_plus' THEN 10 WHEN 'nearyou_family' THEN 25 WHEN 'nearlegacy' THEN 50 ELSE 0 END AS `playlist_limit`,
  CASE COALESCE((SELECT `plan_id` FROM `entitlements`
    WHERE `entitlements`.`household_id` = `households`.`id` AND `status` IN ('active','grace')
      AND `valid_from` <= unixepoch('subsec') * 1000 AND (`valid_until` IS NULL OR `valid_until` > unixepoch('subsec') * 1000)
    ORDER BY CASE WHEN `plan_id` = 'nearsleep_free' THEN 0 ELSE 1 END DESC, CASE WHEN `status` = 'active' THEN 1 ELSE 0 END DESC, `updated_at` DESC, `id` DESC LIMIT 1), '')
    WHEN 'nearsleep_free' THEN 10 WHEN 'nearsleep_plus_legacy' THEN 50 WHEN 'nearyou_plus' THEN 50 WHEN 'nearyou_family' THEN 100 WHEN 'nearlegacy' THEN 250 ELSE 0 END AS `playlist_item_limit`,
  CASE COALESCE((SELECT `plan_id` FROM `entitlements`
    WHERE `entitlements`.`household_id` = `households`.`id` AND `status` IN ('active','grace')
      AND `valid_from` <= unixepoch('subsec') * 1000 AND (`valid_until` IS NULL OR `valid_until` > unixepoch('subsec') * 1000)
    ORDER BY CASE WHEN `plan_id` = 'nearsleep_free' THEN 0 ELSE 1 END DESC, CASE WHEN `status` = 'active' THEN 1 ELSE 0 END DESC, `updated_at` DESC, `id` DESC LIMIT 1), '')
    WHEN 'nearsleep_free' THEN 10 WHEN 'nearsleep_plus_legacy' THEN 20 WHEN 'nearyou_plus' THEN 20 WHEN 'nearyou_family' THEN 50 WHEN 'nearlegacy' THEN 100 ELSE 0 END AS `queue_limit`,
  CASE COALESCE((SELECT `plan_id` FROM `entitlements`
    WHERE `entitlements`.`household_id` = `households`.`id` AND `status` IN ('active','grace')
      AND `valid_from` <= unixepoch('subsec') * 1000 AND (`valid_until` IS NULL OR `valid_until` > unixepoch('subsec') * 1000)
    ORDER BY CASE WHEN `plan_id` = 'nearsleep_free' THEN 0 ELSE 1 END DESC, CASE WHEN `status` = 'active' THEN 1 ELSE 0 END DESC, `updated_at` DESC, `id` DESC LIMIT 1), '')
    WHEN 'nearsleep_free' THEN 1000000000 WHEN 'nearsleep_plus_legacy' THEN 5000000000 WHEN 'nearyou_plus' THEN 5000000000 WHEN 'nearyou_family' THEN 25000000000 WHEN 'nearlegacy' THEN 100000000000 ELSE 0 END AS `storage_limit`
FROM `households`;--> statement-breakpoint

CREATE TABLE `_task_2c_owner_preflight` (
  `invalid_count` integer NOT NULL,
  CONSTRAINT `task_2c_owner_membership_preflight` CHECK (`invalid_count` = 0)
);--> statement-breakpoint
INSERT INTO `_task_2c_owner_preflight` (`invalid_count`)
SELECT COUNT(*) FROM `households` h
WHERE (SELECT COUNT(*) FROM `household_members` m
  WHERE m.`household_id` = h.`id` AND m.`status` = 'active' AND m.`role` = 'owner') <> 1
OR NOT EXISTS (SELECT 1 FROM `household_members` m
  WHERE m.`household_id` = h.`id` AND m.`user_id` = h.`owner_user_id`
    AND m.`status` = 'active' AND m.`role` = 'owner');--> statement-breakpoint
DROP TABLE `_task_2c_owner_preflight`;--> statement-breakpoint
CREATE UNIQUE INDEX `household_members_active_owner_idx` ON `household_members` (`household_id`) WHERE `status` = 'active' AND `role` = 'owner';--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_invitation_insert`
BEFORE INSERT ON `household_invitations` WHEN NEW.`status` = 'pending' AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_invitation_update`
BEFORE UPDATE OF `status` ON `household_invitations` WHEN NEW.`status` IN ('pending','accepted') AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_member_insert`
BEFORE INSERT ON `household_members` WHEN NEW.`status` = 'active' AND NOT EXISTS (SELECT 1 FROM `household_members` WHERE `id` = NEW.`id`) AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_member_restore`
BEFORE UPDATE OF `status` ON `household_members` WHEN OLD.`status` <> 'active' AND NEW.`status` = 'active' AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `household_invitations_member_cap_insert`
BEFORE INSERT ON `household_invitations` WHEN NEW.`status` = 'pending'
BEGIN
  SELECT CASE WHEN NEW.`expires_at` <= unixepoch('subsec') * 1000 THEN RAISE(ABORT, 'household_invitation_expired') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM `household_members` WHERE `household_id` = NEW.`household_id` AND `status` = 'active')
    + (SELECT COUNT(*) FROM `household_invitations` WHERE `household_id` = NEW.`household_id` AND `status` = 'pending' AND `expires_at` > unixepoch('subsec') * 1000)
    >= COALESCE((SELECT `member_limit` FROM `household_current_plan_limits` WHERE `household_id` = NEW.`household_id`), 0)
  THEN RAISE(ABORT, 'household_member_limit_reached') END;
END;--> statement-breakpoint
CREATE TRIGGER `household_invitations_member_cap_restore`
BEFORE UPDATE OF `status` ON `household_invitations` WHEN OLD.`status` <> 'pending' AND NEW.`status` = 'pending'
BEGIN
  SELECT CASE WHEN NEW.`expires_at` <= unixepoch('subsec') * 1000 THEN RAISE(ABORT, 'household_invitation_expired') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM `household_members` WHERE `household_id` = NEW.`household_id` AND `status` = 'active')
    + (SELECT COUNT(*) FROM `household_invitations` WHERE `household_id` = NEW.`household_id` AND `status` = 'pending' AND `expires_at` > unixepoch('subsec') * 1000)
    >= COALESCE((SELECT `member_limit` FROM `household_current_plan_limits` WHERE `household_id` = NEW.`household_id`), 0)
  THEN RAISE(ABORT, 'household_member_limit_reached') END;
END;--> statement-breakpoint
CREATE TRIGGER `household_members_member_cap_insert`
BEFORE INSERT ON `household_members` WHEN NEW.`status` = 'active'
  AND NOT EXISTS (SELECT 1 FROM `household_members` WHERE `id` = NEW.`id`)
  AND NOT (NEW.`role` = 'owner' AND EXISTS (SELECT 1 FROM `households` WHERE `id` = NEW.`household_id` AND `owner_user_id` = NEW.`user_id`)
    AND NOT EXISTS (SELECT 1 FROM `household_members` WHERE `household_id` = NEW.`household_id` AND `status` = 'active'))
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM `household_members` WHERE `household_id` = NEW.`household_id` AND `status` = 'active')
    + (SELECT COUNT(*) FROM `household_invitations` WHERE `household_id` = NEW.`household_id` AND `status` = 'pending' AND `expires_at` > unixepoch('subsec') * 1000)
    >= COALESCE((SELECT `member_limit` FROM `household_current_plan_limits` WHERE `household_id` = NEW.`household_id`), 0)
  THEN RAISE(ABORT, 'household_member_limit_reached') END;
END;--> statement-breakpoint
CREATE TRIGGER `household_members_member_cap_restore`
BEFORE UPDATE OF `status` ON `household_members` WHEN OLD.`status` <> 'active' AND NEW.`status` = 'active'
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM `household_members` WHERE `household_id` = NEW.`household_id` AND `status` = 'active')
    + (SELECT COUNT(*) FROM `household_invitations` WHERE `household_id` = NEW.`household_id` AND `status` = 'pending' AND `expires_at` > unixepoch('subsec') * 1000)
    >= COALESCE((SELECT `member_limit` FROM `household_current_plan_limits` WHERE `household_id` = NEW.`household_id`), 0)
  THEN RAISE(ABORT, 'household_member_limit_reached') END;
END;--> statement-breakpoint

CREATE TRIGGER `playlists_validate_private_cap`
BEFORE INSERT ON `playlists` WHEN NEW.`deleted_at` IS NULL
BEGIN
  SELECT CASE WHEN NEW.`private` <> 1 THEN RAISE(ABORT, 'household_playlists_must_be_private') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM `household_members` WHERE `household_id` = NEW.`household_id` AND `user_id` = NEW.`created_by_user_id` AND `status` = 'active' AND `role` IN ('owner','adult_manager'))
    THEN RAISE(ABORT, 'playlist_creator_not_authorized') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM `playlists` WHERE `household_id` = NEW.`household_id` AND `deleted_at` IS NULL)
    >= COALESCE((SELECT `playlist_limit` FROM `household_current_plan_limits` WHERE `household_id` = NEW.`household_id`), 0)
    THEN RAISE(ABORT, 'household_playlist_limit_reached') END;
END;--> statement-breakpoint
CREATE TRIGGER `playlists_validate_restore_cap`
BEFORE UPDATE OF `deleted_at` ON `playlists` WHEN OLD.`deleted_at` IS NOT NULL AND NEW.`deleted_at` IS NULL
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM `playlists` WHERE `household_id` = NEW.`household_id` AND `deleted_at` IS NULL)
    >= COALESCE((SELECT `playlist_limit` FROM `household_current_plan_limits` WHERE `household_id` = NEW.`household_id`), 0)
    THEN RAISE(ABORT, 'household_playlist_limit_reached') END;
END;--> statement-breakpoint
CREATE TRIGGER `playlist_items_validate_tenant_cap`
BEFORE INSERT ON `playlist_items`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `playlists` JOIN `media_assets` ON `media_assets`.`id` = NEW.`media_asset_id`
    WHERE `playlists`.`id` = NEW.`playlist_id` AND `playlists`.`deleted_at` IS NULL
      AND `media_assets`.`household_id` = `playlists`.`household_id` AND `media_assets`.`status` = 'ready' AND `media_assets`.`private` = 1
  ) THEN RAISE(ABORT, 'playlist_media_household_mismatch') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM `playlist_items` WHERE `playlist_id` = NEW.`playlist_id`)
    >= COALESCE((SELECT `playlist_item_limit` FROM `household_current_plan_limits` JOIN `playlists` ON `playlists`.`household_id` = `household_current_plan_limits`.`household_id` WHERE `playlists`.`id` = NEW.`playlist_id`), 0)
    THEN RAISE(ABORT, 'playlist_item_limit_reached') END;
END;--> statement-breakpoint

CREATE TRIGGER `bedtime_queue_validate_insert`
BEFORE INSERT ON `bedtime_queue_items` WHEN NEW.`status` IN ('queued','playing')
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM `sleep_sessions`
    WHERE `id` = NEW.`session_id` AND `household_id` = NEW.`household_id` AND `status` = 'ready' AND `deletion_status` = 'active')
    THEN RAISE(ABORT, 'queue_session_unavailable') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM `household_members` WHERE `household_id` = NEW.`household_id` AND `user_id` = NEW.`queued_by_user_id` AND `status` = 'active' AND `role` IN ('owner','adult_manager'))
    THEN RAISE(ABORT, 'queue_actor_not_authorized') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM `bedtime_queue_items` WHERE `household_id` = NEW.`household_id` AND `status` IN ('queued','playing'))
    >= COALESCE((SELECT `queue_limit` FROM `household_current_plan_limits` WHERE `household_id` = NEW.`household_id`), 0)
    THEN RAISE(ABORT, 'household_queue_limit_reached') END;
END;--> statement-breakpoint
CREATE TRIGGER `bedtime_queue_validate_restore`
BEFORE UPDATE OF `status` ON `bedtime_queue_items` WHEN OLD.`status` NOT IN ('queued','playing') AND NEW.`status` IN ('queued','playing')
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM `sleep_sessions`
    WHERE `id` = NEW.`session_id` AND `household_id` = NEW.`household_id` AND `status` = 'ready' AND `deletion_status` = 'active')
    THEN RAISE(ABORT, 'queue_session_unavailable') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM `bedtime_queue_items` WHERE `household_id` = NEW.`household_id` AND `status` IN ('queued','playing'))
    >= COALESCE((SELECT `queue_limit` FROM `household_current_plan_limits` WHERE `household_id` = NEW.`household_id`), 0)
    THEN RAISE(ABORT, 'household_queue_limit_reached') END;
END;--> statement-breakpoint

CREATE TRIGGER `storage_reservations_validate_capacity`
BEFORE INSERT ON `household_storage_reservations` WHEN NEW.`status` = 'reserved'
BEGIN
  SELECT CASE WHEN NEW.`byte_size` < 0 THEN RAISE(ABORT, 'invalid_storage_reservation') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM `media_assets` WHERE `id` = NEW.`media_asset_id` AND `household_id` = NEW.`household_id` AND `byte_size` = NEW.`byte_size` AND (
    `status` = 'processing' OR (`status` = 'ready' AND NEW.`id` = 'storage:' || `id` AND length(COALESCE(`checksum`,'')) = 64 AND lower(`checksum`) NOT GLOB '*[^0-9a-f]*')
  ))
    THEN RAISE(ABORT, 'invalid_storage_reservation') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM `media_assets` WHERE `household_id` = NEW.`household_id` AND `status` = 'ready' AND `byte_size` IS NULL AND `id` <> NEW.`media_asset_id`)
    AND EXISTS (SELECT 1 FROM `media_assets` WHERE `id` = NEW.`media_asset_id` AND `status` = 'processing')
    THEN RAISE(ABORT, 'household_storage_reconciliation_required') END;
  SELECT CASE WHEN COALESCE((SELECT SUM(`byte_size`) FROM `media_assets` WHERE `household_id` = NEW.`household_id` AND `status` = 'ready'), 0)
    + COALESCE((SELECT SUM(`byte_size`) FROM `household_storage_reservations` WHERE `household_id` = NEW.`household_id` AND `status` = 'reserved'), 0)
    + CASE WHEN EXISTS (SELECT 1 FROM `media_assets` WHERE `id` = NEW.`media_asset_id` AND `status` = 'ready') THEN 0 ELSE NEW.`byte_size` END
    > COALESCE((SELECT `storage_limit` FROM `household_current_plan_limits` WHERE `household_id` = NEW.`household_id`), 0)
    THEN RAISE(ABORT, 'household_storage_limit_reached') END;
END;--> statement-breakpoint
CREATE TRIGGER `media_assets_require_storage_reservation`
BEFORE UPDATE OF `status` ON `media_assets` WHEN OLD.`status` = 'processing' AND NEW.`status` = 'ready'
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM `household_storage_reservations`
    WHERE `media_asset_id` = NEW.`id` AND `household_id` = NEW.`household_id` AND `byte_size` = NEW.`byte_size` AND `status` = 'reserved')
    THEN RAISE(ABORT, 'media_storage_not_reserved') END;
END;--> statement-breakpoint
CREATE TRIGGER `media_assets_commit_storage_reservation`
AFTER UPDATE OF `status` ON `media_assets` WHEN OLD.`status` = 'processing' AND NEW.`status` = 'ready'
BEGIN
  UPDATE `household_storage_reservations` SET `status` = 'committed', `updated_at` = NEW.`updated_at`
  WHERE `media_asset_id` = NEW.`id` AND `household_id` = NEW.`household_id` AND `status` = 'reserved';
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'media_storage_not_reserved') END;
END;--> statement-breakpoint
CREATE TRIGGER `media_assets_release_storage_reservation`
AFTER UPDATE OF `status` ON `media_assets` WHEN OLD.`status` IN ('processing','ready','failed') AND NEW.`status` = 'deleted'
BEGIN
  UPDATE `household_storage_reservations` SET `status` = 'released', `released_at` = NEW.`deleted_at`, `updated_at` = NEW.`updated_at`
  WHERE `media_asset_id` = NEW.`id` AND `household_id` = NEW.`household_id` AND `status` IN ('reserved','committed');
END;--> statement-breakpoint

CREATE TRIGGER `sleep_sessions_validate_deletion_transition`
BEFORE UPDATE OF `deletion_status` ON `sleep_sessions` WHEN OLD.`deletion_status` <> NEW.`deletion_status`
BEGIN
  SELECT CASE WHEN NOT (
    (OLD.`deletion_status` = 'active' AND NEW.`deletion_status` = 'delete_pending' AND NEW.`deletion_requested_at` IS NOT NULL AND NEW.`deleted_at` IS NULL)
    OR (OLD.`deletion_status` = 'delete_pending' AND NEW.`deletion_status` = 'deleted' AND NEW.`deletion_requested_at` IS NOT NULL AND NEW.`deleted_at` IS NOT NULL)
  ) THEN RAISE(ABORT, 'invalid_session_deletion_transition') END;
END;--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_protect_deleted_library_state`
BEFORE UPDATE OF `favorite`,`repeat_minutes` ON `sleep_sessions` WHEN OLD.`deletion_status` <> 'active'
BEGIN SELECT RAISE(ABORT, 'session_deletion_pending'); END;--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_validate_repeat_timer`
BEFORE UPDATE OF `repeat_minutes` ON `sleep_sessions` WHEN NEW.`repeat_minutes` IS NOT NULL AND NEW.`repeat_minutes` NOT IN (15,30,45,60)
BEGIN SELECT RAISE(ABORT, 'invalid_repeat_timer'); END;--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_remove_library_references`
AFTER UPDATE OF `deletion_status` ON `sleep_sessions` WHEN OLD.`deletion_status` = 'active' AND NEW.`deletion_status` = 'delete_pending'
BEGIN
  UPDATE `bedtime_queue_items` SET `status` = 'removed', `updated_at` = NEW.`deletion_requested_at`
    WHERE `session_id` = NEW.`id` AND `household_id` = NEW.`household_id` AND `status` IN ('queued','playing');
  DELETE FROM `playlist_items` WHERE `media_asset_id` = NEW.`media_asset_id`;
END;--> statement-breakpoint

CREATE TRIGGER `account_deletion_fence_session_insert`
BEFORE INSERT ON `sleep_sessions` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_voice_insert`
BEFORE INSERT ON `voices` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_media_insert`
BEFORE INSERT ON `media_assets` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_job_insert`
BEFORE INSERT ON `jobs` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_job_update`
BEFORE UPDATE OF `status`,`result` ON `jobs` WHEN NEW.`status` NOT IN ('failed','canceled') AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_billing_change`
BEFORE UPDATE ON `household_billing_accounts`
WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_billing_insert`
BEFORE INSERT ON `household_billing_accounts`
WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint

CREATE TABLE `_task_2c_queue_preflight` (`duplicate_playing_count` integer NOT NULL, CONSTRAINT `task_2c_duplicate_playing_queue_preflight` CHECK (`duplicate_playing_count` = 0));--> statement-breakpoint
INSERT INTO `_task_2c_queue_preflight` (`duplicate_playing_count`) SELECT COALESCE(SUM(`playing_count` - 1), 0) FROM (
  SELECT COUNT(*) AS `playing_count` FROM `bedtime_queue_items` WHERE `status` = 'playing' GROUP BY `household_id` HAVING COUNT(*) > 1
);--> statement-breakpoint
DROP TABLE `_task_2c_queue_preflight`;--> statement-breakpoint
DROP INDEX `bedtime_queue_household_position_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `bedtime_queue_household_position_idx` ON `bedtime_queue_items` (`household_id`,`position`) WHERE `status` IN ('queued','playing');--> statement-breakpoint
CREATE UNIQUE INDEX `bedtime_queue_household_playing_idx` ON `bedtime_queue_items` (`household_id`) WHERE `status` = 'playing';--> statement-breakpoint
CREATE TRIGGER `playlists_protect_tenant_binding`
BEFORE UPDATE OF `household_id`,`created_by_user_id`,`private` ON `playlists`
WHEN (NEW.`household_id` IS NOT OLD.`household_id` OR NEW.`created_by_user_id` IS NOT OLD.`created_by_user_id` OR NEW.`private` <> 1)
  AND NOT EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = OLD.`created_by_user_id` AND `status` = 'finalizing')
BEGIN SELECT RAISE(ABORT, 'playlist_tenant_binding_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `playlist_items_protect_binding`
BEFORE UPDATE OF `playlist_id`,`media_asset_id` ON `playlist_items`
WHEN NEW.`playlist_id` IS NOT OLD.`playlist_id` OR NEW.`media_asset_id` IS NOT OLD.`media_asset_id`
BEGIN SELECT RAISE(ABORT, 'playlist_item_binding_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `bedtime_queue_protect_binding`
BEFORE UPDATE OF `household_id`,`queued_by_user_id`,`session_id` ON `bedtime_queue_items`
WHEN NEW.`household_id` IS NOT OLD.`household_id` OR NEW.`queued_by_user_id` IS NOT OLD.`queued_by_user_id` OR NEW.`session_id` IS NOT OLD.`session_id`
BEGIN SELECT RAISE(ABORT, 'queue_binding_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `media_assets_reject_direct_ready_insert`
BEFORE INSERT ON `media_assets` WHEN NEW.`status` = 'ready'
BEGIN SELECT RAISE(ABORT, 'media_storage_not_reserved'); END;--> statement-breakpoint
CREATE TRIGGER `media_assets_validate_status_transition`
BEFORE UPDATE OF `status` ON `media_assets` WHEN OLD.`status` <> NEW.`status`
BEGIN
  SELECT CASE WHEN NOT (
    (OLD.`status` = 'processing' AND NEW.`status` IN ('ready','deleted'))
    OR (OLD.`status` IN ('ready','failed') AND NEW.`status` = 'deleted')
  ) THEN RAISE(ABORT, 'invalid_media_status_transition') END;
  SELECT CASE WHEN NEW.`status` = 'deleted' AND NEW.`deleted_at` IS NULL THEN RAISE(ABORT, 'invalid_media_deletion_tombstone') END;
END;--> statement-breakpoint
CREATE TRIGGER `media_assets_validate_ready_shape`
BEFORE UPDATE OF `status` ON `media_assets` WHEN OLD.`status` = 'processing' AND NEW.`status` = 'ready'
BEGIN
  SELECT CASE WHEN NEW.`byte_size` IS NULL OR NEW.`byte_size` <= 0 OR length(trim(COALESCE(NEW.`storage_key`,''))) = 0
    OR length(COALESCE(NEW.`checksum`,'')) <> 64 OR lower(NEW.`checksum`) GLOB '*[^0-9a-f]*'
    THEN RAISE(ABORT, 'invalid_ready_media') END;
  SELECT CASE WHEN NEW.`kind` = 'narration' AND NOT EXISTS (SELECT 1 FROM `sleep_sessions`
    WHERE `id` = NEW.`legacy_session_id` AND `household_id` = NEW.`household_id` AND `status` = 'ready'
      AND `media_asset_id` = NEW.`id` AND `audio_key` = NEW.`storage_key` AND `deletion_status` = 'active')
    THEN RAISE(ABORT, 'media_session_finalize_mismatch') END;
END;--> statement-breakpoint
CREATE TRIGGER `media_assets_protect_ready_binding`
BEFORE UPDATE OF `household_id`,`owner_user_id`,`kind`,`storage_key`,`byte_size`,`private`,`checksum`,`legacy_session_id` ON `media_assets`
WHEN OLD.`status` = 'ready' AND (
  NEW.`household_id` IS NOT OLD.`household_id` OR NEW.`owner_user_id` IS NOT OLD.`owner_user_id` OR NEW.`kind` IS NOT OLD.`kind`
  OR NEW.`storage_key` IS NOT OLD.`storage_key`
  OR (NEW.`byte_size` IS NOT OLD.`byte_size` AND NOT (OLD.`byte_size` IS NULL AND NEW.`byte_size` > 0)) OR NEW.`private` IS NOT OLD.`private`
  OR NEW.`legacy_session_id` IS NOT OLD.`legacy_session_id`
  OR (NEW.`checksum` IS NOT OLD.`checksum` AND NOT (OLD.`checksum` IS NULL AND length(COALESCE(NEW.`checksum`,'')) = 64 AND lower(NEW.`checksum`) NOT GLOB '*[^0-9a-f]*'))
)
BEGIN SELECT RAISE(ABORT, 'ready_media_binding_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `media_assets_protect_deletion_tombstone`
BEFORE UPDATE OF `deleted_at` ON `media_assets`
WHEN (OLD.`status` = 'deleted' AND NEW.`deleted_at` IS NOT OLD.`deleted_at`) OR (OLD.`status` <> 'deleted' AND NEW.`status` <> 'deleted' AND NEW.`deleted_at` IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'invalid_media_deletion_tombstone'); END;--> statement-breakpoint
CREATE TRIGGER `storage_reservations_protect_binding`
BEFORE UPDATE OF `household_id`,`media_asset_id`,`byte_size` ON `household_storage_reservations`
WHEN NEW.`household_id` IS NOT OLD.`household_id` OR NEW.`media_asset_id` IS NOT OLD.`media_asset_id` OR NEW.`byte_size` IS NOT OLD.`byte_size`
BEGIN SELECT RAISE(ABORT, 'storage_reservation_binding_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `storage_reservations_validate_transition`
BEFORE UPDATE OF `status` ON `household_storage_reservations` WHEN OLD.`status` <> NEW.`status`
BEGIN
  SELECT CASE WHEN NOT (
    (OLD.`status` = 'reserved' AND NEW.`status` = 'committed' AND EXISTS (SELECT 1 FROM `media_assets` WHERE `id` = NEW.`media_asset_id` AND `household_id` = NEW.`household_id` AND `status` = 'ready'))
    OR (OLD.`status` IN ('reserved','committed') AND NEW.`status` = 'released' AND EXISTS (SELECT 1 FROM `media_assets` WHERE `id` = NEW.`media_asset_id` AND `household_id` = NEW.`household_id` AND `status` IN ('failed','deleted')))
  ) THEN RAISE(ABORT, 'invalid_storage_reservation_transition') END;
END;--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_create_deletion_reconciliation`
AFTER UPDATE OF `deletion_status` ON `sleep_sessions` WHEN OLD.`deletion_status` = 'active' AND NEW.`deletion_status` = 'delete_pending'
BEGIN
  INSERT OR IGNORE INTO `deletion_reconciliations` (`id`,`scope`,`scope_id`,`status`,`storage_keys`,`provider_references`,`created_at`,`updated_at`)
  VALUES ('session-delete:' || NEW.`id`, 'session', NEW.`id`, 'cleanup_pending', CASE WHEN NEW.`audio_key` IS NULL THEN '[]' ELSE json_array(NEW.`audio_key`) END, '[]', NEW.`deletion_requested_at`, NEW.`deletion_requested_at`);
END;--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_validate_deletion_shape`
BEFORE UPDATE OF `deletion_status`,`deletion_requested_at`,`deleted_at` ON `sleep_sessions`
BEGIN
  SELECT CASE WHEN NOT (
    (NEW.`deletion_status` = 'active' AND NEW.`deletion_requested_at` IS NULL AND NEW.`deleted_at` IS NULL)
    OR (NEW.`deletion_status` = 'delete_pending' AND NEW.`deletion_requested_at` IS NOT NULL AND NEW.`deleted_at` IS NULL)
    OR (NEW.`deletion_status` = 'deleted' AND NEW.`deletion_requested_at` IS NOT NULL AND NEW.`deleted_at` IS NOT NULL)
  ) THEN RAISE(ABORT, 'invalid_session_deletion_tombstone') END;
  SELECT CASE WHEN OLD.`deletion_status` IN ('delete_pending','deleted') AND NEW.`deletion_requested_at` IS NOT OLD.`deletion_requested_at`
    THEN RAISE(ABORT, 'invalid_session_deletion_tombstone') END;
  SELECT CASE WHEN OLD.`deletion_status` = 'deleted' AND NEW.`deleted_at` IS NOT OLD.`deleted_at`
    THEN RAISE(ABORT, 'invalid_session_deletion_tombstone') END;
END;--> statement-breakpoint

CREATE TRIGGER `account_deletion_fence_session_ready`
BEFORE UPDATE OF `status` ON `sleep_sessions` WHEN NEW.`status` = 'ready' AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_media_ready`
BEFORE UPDATE OF `status` ON `media_assets` WHEN NEW.`status` = 'ready' AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_generation_update`
BEFORE UPDATE OF `status`,`result` ON `generation_operations` WHEN NEW.`status` <> 'failed' AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_generation_insert`
BEFORE INSERT ON `generation_operations` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_voice_replacement_update`
BEFORE UPDATE OF `status` ON `voice_replacements` WHEN NEW.`status` NOT IN ('failed','cleanup_pending') AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_provider_spend_update`
BEFORE UPDATE OF `status` ON `provider_spend_reservations` WHEN NEW.`status` IN ('charge_committed','settled') AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_entitlement_insert`
BEFORE INSERT ON `entitlements` WHEN NOT EXISTS (SELECT 1 FROM `entitlements` WHERE `id` = NEW.`id`) AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_entitlement_update`
BEFORE UPDATE ON `entitlements` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_billing_subscription_insert`
BEFORE INSERT ON `household_billing_subscriptions` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_billing_subscription_update`
BEFORE UPDATE ON `household_billing_subscriptions` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_export_insert`
BEFORE INSERT ON `household_exports` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_export_update`
BEFORE UPDATE OF `status`,`inventory_stage`,`inventory_cursor`,`inventory_count`,`metadata_page_count`,`cursor_position`,`manifest_storage_key`,`manifest_byte_size`,`manifest_checksum` ON `household_exports`
WHEN NEW.`status` NOT IN ('canceled','expired') AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `household_id` = NEW.`household_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_export_part_insert`
BEFORE INSERT ON `household_export_parts` WHEN EXISTS (
  SELECT 1 FROM `household_exports` JOIN `account_deletion_operations` ON `account_deletion_operations`.`household_id` = `household_exports`.`household_id`
  WHERE `household_exports`.`id` = NEW.`export_id` AND `account_deletion_operations`.`status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_export_part_update`
BEFORE UPDATE ON `household_export_parts` WHEN EXISTS (
  SELECT 1 FROM `household_exports` JOIN `account_deletion_operations` ON `account_deletion_operations`.`household_id` = `household_exports`.`household_id`
  WHERE `household_exports`.`id` = NEW.`export_id` AND `account_deletion_operations`.`status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_export_page_insert`
BEFORE INSERT ON `household_export_metadata_pages` WHEN EXISTS (
  SELECT 1 FROM `household_exports` JOIN `account_deletion_operations` ON `account_deletion_operations`.`household_id` = `household_exports`.`household_id`
  WHERE `household_exports`.`id` = NEW.`export_id` AND `account_deletion_operations`.`status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_export_page_update`
BEFORE UPDATE ON `household_export_metadata_pages` WHEN EXISTS (
  SELECT 1 FROM `household_exports` JOIN `account_deletion_operations` ON `account_deletion_operations`.`household_id` = `household_exports`.`household_id`
  WHERE `household_exports`.`id` = NEW.`export_id` AND `account_deletion_operations`.`status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_session_insert`
BEFORE INSERT ON `sleep_sessions` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`user_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_member_insert`
BEFORE INSERT ON `household_members` WHEN NEW.`status` = 'active'
  AND NOT EXISTS (SELECT 1 FROM `household_members` WHERE `id` = NEW.`id`)
  AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`user_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_subject_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_member_update`
BEFORE UPDATE OF `status`,`role`,`user_id` ON `household_members` WHEN NEW.`status` = 'active' AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`user_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_subject_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_owner_update`
BEFORE UPDATE OF `owner_user_id` ON `households` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` IN (OLD.`owner_user_id`,NEW.`owner_user_id`) AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_subject_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_owner_guard_insert`
BEFORE INSERT ON `household_owner_transfer_guards` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` IN (NEW.`prior_owner_user_id`,NEW.`new_owner_user_id`) AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_subject_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_session_update`
BEFORE UPDATE OF `status`,`audio_key`,`media_asset_id` ON `sleep_sessions` WHEN NEW.`status` NOT IN ('failed') AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`user_id` AND `status` NOT IN ('completed','canceled','finalizing'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_media_insert`
BEFORE INSERT ON `media_assets` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`owner_user_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_media_update`
BEFORE UPDATE OF `status`,`storage_key` ON `media_assets` WHEN NEW.`status` NOT IN ('failed','deleted') AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`owner_user_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_voice_insert`
BEFORE INSERT ON `voices` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`user_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_generation_insert`
BEFORE INSERT ON `generation_operations` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`user_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_generation_update`
BEFORE UPDATE OF `status`,`result` ON `generation_operations` WHEN NEW.`status` <> 'failed' AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`user_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_job_insert`
BEFORE INSERT ON `jobs` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`requested_by_user_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_job_update`
BEFORE UPDATE OF `status`,`result` ON `jobs` WHEN NEW.`status` NOT IN ('failed','canceled') AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`requested_by_user_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_replacement_update`
BEFORE UPDATE OF `status` ON `voice_replacements` WHEN NEW.`status` NOT IN ('failed','cleanup_pending') AND EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`adult_user_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_export_insert`
BEFORE INSERT ON `household_exports` WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` WHERE `user_id` = NEW.`requested_by_user_id` AND `status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE VIEW `account_deletion_affected_exports` AS
SELECT o.`id` AS `operation_id`, e.`id` AS `export_id`
FROM `account_deletion_operations` o CROSS JOIN `household_exports` e
WHERE o.`status` NOT IN ('completed','canceled','finalizing') AND (
  e.`requested_by_user_id` = o.`user_id`
  OR EXISTS (SELECT 1 FROM `media_assets` m WHERE m.`household_id` = e.`household_id` AND m.`owner_user_id` = o.`user_id`)
  OR EXISTS (SELECT 1 FROM `sleep_sessions` s WHERE s.`household_id` = e.`household_id` AND s.`user_id` = o.`user_id`)
  OR EXISTS (SELECT 1 FROM `voices` v WHERE v.`household_id` = e.`household_id` AND v.`user_id` = o.`user_id`)
  OR EXISTS (SELECT 1 FROM `voice_consents` c WHERE c.`household_id` = e.`household_id` AND c.`adult_user_id` = o.`user_id`)
);--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_affected_export_update`
BEFORE UPDATE ON `household_exports`
WHEN NEW.`status` NOT IN ('canceled','expired') AND EXISTS (SELECT 1 FROM `account_deletion_affected_exports` WHERE `export_id` = OLD.`id`)
BEGIN SELECT RAISE(ABORT, 'account_deletion_subject_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_affected_export_part_insert`
BEFORE INSERT ON `household_export_parts`
WHEN EXISTS (SELECT 1 FROM `account_deletion_affected_exports` WHERE `export_id` = NEW.`export_id`)
BEGIN SELECT RAISE(ABORT, 'account_deletion_subject_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_affected_export_part_update`
BEFORE UPDATE ON `household_export_parts`
WHEN EXISTS (SELECT 1 FROM `account_deletion_affected_exports` WHERE `export_id` IN (OLD.`export_id`,NEW.`export_id`))
BEGIN SELECT RAISE(ABORT, 'account_deletion_subject_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_affected_export_page_insert`
BEFORE INSERT ON `household_export_metadata_pages`
WHEN EXISTS (SELECT 1 FROM `account_deletion_affected_exports` WHERE `export_id` = NEW.`export_id`)
BEGIN SELECT RAISE(ABORT, 'account_deletion_subject_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_fence_subject_affected_export_page_update`
BEFORE UPDATE ON `household_export_metadata_pages`
WHEN EXISTS (SELECT 1 FROM `account_deletion_affected_exports` WHERE `export_id` IN (OLD.`export_id`,NEW.`export_id`))
BEGIN SELECT RAISE(ABORT, 'account_deletion_subject_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `account_deletion_finalize_erasure`
AFTER UPDATE OF `status` ON `account_deletion_operations`
WHEN OLD.`status` = 'processing' AND NEW.`status` = 'finalizing' AND NEW.`attempt_token` = OLD.`attempt_token` AND NEW.`attempt_token` IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM `account_deletion_items` WHERE `operation_id` = NEW.`id` AND `status` = 'pending')
    THEN RAISE(ABORT, 'account_deletion_pending_cleanup') END;
  UPDATE `playlists` SET `created_by_user_id` = (SELECT `owner_user_id` FROM `households` WHERE `id` = `playlists`.`household_id`), `updated_at` = NEW.`updated_at`
    WHERE `created_by_user_id` = OLD.`user_id` AND `household_id` <> OLD.`household_id`
      AND EXISTS (SELECT 1 FROM `households` WHERE `id` = `playlists`.`household_id` AND `owner_user_id` <> OLD.`user_id`);
  UPDATE `household_invitations` SET `invited_by_user_id` = (SELECT `owner_user_id` FROM `households` WHERE `id` = `household_invitations`.`household_id`), `updated_at` = NEW.`updated_at`
    WHERE `invited_by_user_id` = OLD.`user_id` AND `household_id` <> OLD.`household_id`
      AND EXISTS (SELECT 1 FROM `households` WHERE `id` = `household_invitations`.`household_id` AND `owner_user_id` <> OLD.`user_id`);
  DELETE FROM `households` WHERE `id` = OLD.`household_id` AND `owner_user_id` = OLD.`user_id`;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'account_deletion_finalization_failed') END;
  DELETE FROM `users` WHERE `id` = OLD.`user_id`;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'account_deletion_finalization_failed') END;
  DELETE FROM `account_deletion_items` WHERE `operation_id` = NEW.`id`;
  UPDATE `account_deletion_operations` SET `user_id` = NULL, `household_id` = NULL, `idempotency_key` = 'redacted', `request_hash` = 'redacted',
    `reauth_challenge_id` = 'redacted', `reauth_session_id` = 'redacted', `status` = 'completed', `stage` = 'completed',
    `attempt_token` = NULL, `attempt_expires_at` = NULL, `billing_cursor` = 0, `provider_cursor` = 0, `storage_cursor` = 0, `quiescent_at` = NULL,
    `inventory_stage` = 'completed', `inventory_cursor` = NULL, `inventory_complete` = true,
    `export_policy` = 'skip', `grace_until` = NEW.`updated_at`, `snapshot` = '{}', `error_code` = NULL, `completed_at` = NEW.`updated_at`
  WHERE `id` = NEW.`id` AND `status` = 'finalizing' AND `attempt_token` = NEW.`attempt_token`;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'account_deletion_finalization_failed') END;
END;
