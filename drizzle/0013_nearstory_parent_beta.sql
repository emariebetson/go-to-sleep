CREATE UNIQUE INDEX `child_profiles_household_id_idx` ON `child_profiles` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `voices_household_id_idx` ON `voices` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `voice_consents_household_id_idx` ON `voice_consents` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `voice_consent_leases_household_id_idx` ON `voice_consent_leases` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_household_id_idx` ON `jobs` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_reservations_household_id_idx` ON `usage_reservations` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_household_id_idx` ON `media_assets` (`household_id`,`id`);--> statement-breakpoint
CREATE TABLE `nearstory_activation_state` (
  `id` text PRIMARY KEY NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending','ready')),
  `migration_version` text NOT NULL,
  `worker_heartbeat_at` integer,
  `checked_at` integer NOT NULL
);--> statement-breakpoint
ALTER TABLE `jobs` ADD `worker_attempt_token` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `worker_lease_expires_at` integer;--> statement-breakpoint
CREATE INDEX `jobs_story_dispatch_idx` ON `jobs` (`type`,`status`,`worker_lease_expires_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `story_worker_checkpoints` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `story_id` text NOT NULL,
  `attempt_token` text NOT NULL,
  `stage` text NOT NULL CHECK (`stage` IN ('writer','moderation','speech','effect','mix')),
  `ordinal` integer DEFAULT -1 NOT NULL CHECK (`ordinal` BETWEEN -1 AND 4),
  `payload` text NOT NULL,
  `storage_key` text,
  `byte_size` integer CHECK (`byte_size` IS NULL OR `byte_size` > 0),
  `checksum` text CHECK (`checksum` IS NULL OR (length(`checksum`)=64 AND lower(`checksum`) NOT GLOB '*[^0-9a-f]*')),
  `status` text DEFAULT 'staging' NOT NULL CHECK (`status` IN ('staging','ready')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`story_id`) REFERENCES `story_experiences`(`household_id`,`id`) ON DELETE cascade,
  CHECK ((`stage` IN ('speech','effect','mix') AND `storage_key` IS NOT NULL AND `byte_size` IS NOT NULL AND `checksum` IS NOT NULL) OR (`stage` IN ('writer','moderation') AND `storage_key` IS NULL AND `byte_size` IS NULL AND `checksum` IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX `story_worker_checkpoint_stage_idx` ON `story_worker_checkpoints` (`story_id`,`stage`,`ordinal`);--> statement-breakpoint
CREATE TRIGGER `story_worker_checkpoint_attempt_guard` BEFORE INSERT ON `story_worker_checkpoints`
WHEN NOT EXISTS (SELECT 1 FROM `story_experiences` s JOIN `jobs` j ON j.`id`=s.`job_id` AND j.`household_id`=s.`household_id`
  WHERE s.`id`=NEW.`story_id` AND s.`household_id`=NEW.`household_id` AND s.`status` IN ('queued','processing')
    AND j.`status`='running' AND j.`worker_attempt_token`=NEW.`attempt_token` AND j.`worker_lease_expires_at`>unixepoch('subsec')*1000)
BEGIN SELECT RAISE(ABORT, 'story_checkpoint_worker_attempt_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `story_worker_checkpoint_attempt_update_guard` BEFORE UPDATE ON `story_worker_checkpoints`
WHEN NEW.`attempt_token`<>OLD.`attempt_token` AND NOT EXISTS (SELECT 1 FROM `story_experiences` s JOIN `jobs` j ON j.`id`=s.`job_id` AND j.`household_id`=s.`household_id`
  WHERE s.`id`=NEW.`story_id` AND s.`household_id`=NEW.`household_id` AND s.`status` IN ('queued','processing')
    AND j.`status`='running' AND j.`worker_attempt_token`=NEW.`attempt_token` AND j.`worker_lease_expires_at`>unixepoch('subsec')*1000)
BEGIN SELECT RAISE(ABORT, 'story_checkpoint_worker_attempt_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `story_worker_checkpoint_export_fence` BEFORE INSERT ON `story_worker_checkpoints`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id`=NEW.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at`>unixepoch('subsec')*1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TABLE `story_persist_staging_objects` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL, `story_id` text NOT NULL, `attempt_token` text NOT NULL,
  `role` text NOT NULL CHECK (`role` IN ('segment','final')), `ordinal` integer, `storage_key` text NOT NULL,
  `byte_size` integer NOT NULL CHECK (`byte_size`>0), `checksum` text NOT NULL CHECK (length(`checksum`)=64 AND lower(`checksum`) NOT GLOB '*[^0-9a-f]*'),
  `status` text DEFAULT 'staging' NOT NULL CHECK (`status` IN ('staging','published','deleted')), `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `deleted_at` integer,
  FOREIGN KEY (`household_id`,`story_id`) REFERENCES `story_experiences`(`household_id`,`id`) ON DELETE cascade,
  CHECK ((`role`='final' AND `ordinal` IS NULL) OR (`role`='segment' AND `ordinal` BETWEEN 0 AND 4))
);--> statement-breakpoint
CREATE UNIQUE INDEX `story_persist_staging_attempt_role_idx` ON `story_persist_staging_objects` (`story_id`,`attempt_token`,`role`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_persist_staging_key_idx` ON `story_persist_staging_objects` (`storage_key`);--> statement-breakpoint
CREATE TRIGGER `story_persist_staging_attempt_guard` BEFORE INSERT ON `story_persist_staging_objects`
WHEN NOT EXISTS (SELECT 1 FROM `story_experiences` s JOIN `jobs` j ON j.`id`=s.`job_id` AND j.`household_id`=s.`household_id` WHERE s.`id`=NEW.`story_id` AND s.`household_id`=NEW.`household_id` AND s.`status` IN ('queued','processing') AND j.`status`='running' AND j.`worker_attempt_token`=NEW.`attempt_token` AND j.`worker_lease_expires_at`>unixepoch('subsec')*1000)
BEGIN SELECT RAISE(ABORT, 'story_persist_staging_attempt_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `story_persist_staging_publish_guard` BEFORE UPDATE OF `status` ON `story_persist_staging_objects`
WHEN NEW.`status`='published' AND NOT EXISTS (SELECT 1 FROM `story_experiences` s JOIN `jobs` j ON j.`id`=s.`job_id` AND j.`household_id`=s.`household_id` WHERE s.`id`=NEW.`story_id` AND s.`household_id`=NEW.`household_id` AND s.`status` IN ('queued','processing') AND j.`status`='running' AND j.`worker_attempt_token`=OLD.`attempt_token` AND j.`worker_lease_expires_at`>unixepoch('subsec')*1000)
BEGIN SELECT RAISE(ABORT, 'story_persist_staging_attempt_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `story_persist_staging_export_fence` BEFORE INSERT ON `story_persist_staging_objects`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id`=NEW.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at`>unixepoch('subsec')*1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_persist_staging_deletion_fence` BEFORE INSERT ON `story_persist_staging_objects`
WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`status` NOT IN ('completed','canceled')) OR EXISTS (SELECT 1 FROM `story_experiences` s WHERE s.`id`=NEW.`story_id` AND s.`status` IN ('delete_pending','deleted'))
BEGIN SELECT RAISE(ABORT, 'story_persist_staging_deletion_fenced'); END;--> statement-breakpoint
INSERT INTO `nearstory_activation_state` (`id`,`status`,`migration_version`,`checked_at`) VALUES ('parent-beta','pending','0013',unixepoch('subsec') * 1000);--> statement-breakpoint
CREATE TABLE `story_moderation_receipts` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `requested_by_user_id` text NOT NULL,
  `request_hash` text NOT NULL,
  `verdict` text NOT NULL CHECK (`verdict` IN ('safe','unsafe')),
  `model` text NOT NULL,
  `provider_request_id` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`requested_by_user_id`) REFERENCES `household_members`(`household_id`,`user_id`) ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX `story_moderation_receipts_household_id_idx` ON `story_moderation_receipts` (`household_id`,`id`);--> statement-breakpoint
DROP TRIGGER `usage_reservations_after_insert`;--> statement-breakpoint
CREATE TRIGGER `usage_reservations_after_insert`
AFTER INSERT ON `usage_reservations` WHEN NEW.`status` = 'reserved'
BEGIN
  UPDATE `entitlements` SET `remaining_milliunits` = `remaining_milliunits` - NEW.`weight_milliunits`, `updated_at` = NEW.`updated_at`
    WHERE `id` = NEW.`entitlement_id` AND `household_id` = NEW.`household_id`;
  INSERT INTO `usage_ledger` (`id`,`household_id`,`user_id`,`entitlement_id`,`product`,`operation`,`quantity`,`weight_milliunits`,`direction`,`idempotency_key`,`metadata`,`created_at`)
  VALUES ('usage-reservation:' || NEW.`id`,NEW.`household_id`,NEW.`user_id`,NEW.`entitlement_id`,
    CASE WHEN NEW.`operation` = 'story_audio_generation' THEN 'nearstory' ELSE 'nearsleep' END,
    NEW.`operation`,NEW.`quantity`,NEW.`weight_milliunits`,'reservation','reserve:' || NEW.`id`,json_object('reservationId',NEW.`id`),NEW.`created_at`);
END;--> statement-breakpoint
DROP TRIGGER `usage_reservations_after_release`;--> statement-breakpoint
CREATE TRIGGER `usage_reservations_after_release`
AFTER UPDATE OF `status` ON `usage_reservations` WHEN OLD.`status` = 'reserved' AND NEW.`status` = 'released'
BEGIN
  UPDATE `entitlements` SET `remaining_milliunits` = `remaining_milliunits` + OLD.`weight_milliunits`, `updated_at` = NEW.`updated_at`
    WHERE `id` = OLD.`entitlement_id` AND `household_id` = OLD.`household_id`;
  INSERT INTO `usage_ledger` (`id`,`household_id`,`user_id`,`entitlement_id`,`product`,`operation`,`quantity`,`weight_milliunits`,`direction`,`idempotency_key`,`metadata`,`created_at`)
  VALUES ('usage-release:' || OLD.`id`,OLD.`household_id`,OLD.`user_id`,OLD.`entitlement_id`,
    CASE WHEN OLD.`operation` = 'story_audio_generation' THEN 'nearstory' ELSE 'nearsleep' END,
    OLD.`operation`,OLD.`quantity`,OLD.`weight_milliunits`,'release','release:' || OLD.`id`,json_object('reservationId',OLD.`id`),NEW.`updated_at`);
END;--> statement-breakpoint
CREATE TABLE `story_experiences` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `requested_by_user_id` text NOT NULL,
  `child_profile_id` text NOT NULL,
  `voice_id` text NOT NULL,
  `consent_id` text NOT NULL,
  `consent_version` text NOT NULL,
  `consent_lease_id` text NOT NULL,
  `mode` text NOT NULL CHECK (`mode` IN ('bedtime','adventure','learning','calm-down','potty-training','new-sibling','first-day-of-school')),
  `duration_minutes` integer NOT NULL CHECK (`duration_minutes` IN (5,10,15)),
  `plan` text NOT NULL,
  `rights_actor_user_id` text,
  `rights_version` text CHECK (`rights_version` IS NULL OR `rights_version` = 'story-linked-inspiration-v1'),
  `rights_canonical_url` text CHECK (`rights_canonical_url` IS NULL OR `rights_canonical_url` LIKE 'https://www.youtube.com/watch?v=%'),
  `rights_attested_at` integer,
  `status` text DEFAULT 'queued' NOT NULL CHECK (`status` IN ('queued','processing','review_required','completed','failed','canceled','delete_pending','deleted')),
  `highest_played_segment` integer DEFAULT -1 NOT NULL CHECK (`highest_played_segment` >= -1),
  `job_id` text,
  `reservation_id` text,
  `provider_budget_hold_ids` text DEFAULT '[]' NOT NULL,
  `media_asset_id` text,
  `idempotency_key` text NOT NULL,
  `request_hash` text NOT NULL,
  `error_code` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `completed_at` integer,
  `deleted_at` integer,
  FOREIGN KEY (`household_id`,`requested_by_user_id`) REFERENCES `household_members`(`household_id`,`user_id`) ON DELETE restrict,
  FOREIGN KEY (`household_id`,`child_profile_id`) REFERENCES `child_profiles`(`household_id`,`id`) ON DELETE restrict,
  FOREIGN KEY (`household_id`,`voice_id`) REFERENCES `voices`(`household_id`,`id`) ON DELETE restrict,
  FOREIGN KEY (`household_id`,`consent_id`) REFERENCES `voice_consents`(`household_id`,`id`) ON DELETE restrict,
  FOREIGN KEY (`household_id`,`consent_lease_id`) REFERENCES `voice_consent_leases`(`household_id`,`id`) ON DELETE restrict,
  FOREIGN KEY (`household_id`,`job_id`) REFERENCES `jobs`(`household_id`,`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`reservation_id`) REFERENCES `usage_reservations`(`household_id`,`id`) ON DELETE cascade
  ,FOREIGN KEY (`household_id`,`media_asset_id`) REFERENCES `media_assets`(`household_id`,`id`) ON DELETE cascade
  ,FOREIGN KEY (`household_id`,`rights_actor_user_id`) REFERENCES `household_members`(`household_id`,`user_id`) ON DELETE restrict
  ,CHECK ((`rights_actor_user_id` IS NULL AND `rights_version` IS NULL AND `rights_canonical_url` IS NULL AND `rights_attested_at` IS NULL)
    OR (`rights_actor_user_id` IS NOT NULL AND `rights_version` = 'story-linked-inspiration-v1' AND `rights_canonical_url` IS NOT NULL AND `rights_attested_at` IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX `story_experiences_household_request_idx` ON `story_experiences` (`household_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_experiences_household_id_idx` ON `story_experiences` (`household_id`,`id`);--> statement-breakpoint
CREATE INDEX `story_experiences_household_status_idx` ON `story_experiences` (`household_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `story_provider_budget_holds` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `user_id` text NOT NULL,
  `story_id` text NOT NULL,
  `branch_key` text DEFAULT 'root' NOT NULL,
  `provider` text NOT NULL CHECK (`provider` IN ('openai','elevenlabs')),
  `operation` text NOT NULL CHECK (`operation` IN ('story_writing','story_output_moderation','story_speech','story_sfx')),
  `max_microcents` integer NOT NULL CHECK (`max_microcents` > 0),
  `idempotency_key` text NOT NULL,
  `provider_spend_reservation_id` text,
  `status` text DEFAULT 'reserved' NOT NULL CHECK (`status` IN ('reserved','claimed','settled','released')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`story_id`) REFERENCES `story_experiences`(`household_id`,`id`) ON DELETE cascade,
  FOREIGN KEY (`provider_spend_reservation_id`) REFERENCES `provider_spend_reservations`(`id`) ON DELETE set null,
  FOREIGN KEY (`household_id`,`user_id`) REFERENCES `household_members`(`household_id`,`user_id`) ON DELETE restrict,
  CHECK ((`operation`='story_writing' AND `provider`='openai' AND `max_microcents` <= 150000)
    OR (`operation`='story_output_moderation' AND `provider`='openai' AND `max_microcents` <= 100000)
    OR (`operation`='story_speech' AND `provider`='elevenlabs' AND `max_microcents` <= 4000000)
    OR (`operation`='story_sfx' AND `provider`='elevenlabs' AND `max_microcents` <= 25000))
);--> statement-breakpoint
CREATE UNIQUE INDEX `story_provider_holds_story_operation_idx` ON `story_provider_budget_holds` (`story_id`,`branch_key`,`operation`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_provider_holds_household_id_idx` ON `story_provider_budget_holds` (`household_id`,`id`);--> statement-breakpoint
CREATE TRIGGER `story_provider_holds_transition` BEFORE UPDATE ON `story_provider_budget_holds`
WHEN NOT ((OLD.`status`='reserved' AND NEW.`status` IN ('claimed','released'))
  OR (OLD.`status`='claimed' AND NEW.`status` IN ('settled','released')) OR OLD.`status`=NEW.`status`)
BEGIN SELECT RAISE(ABORT, 'story_provider_hold_transition_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `story_provider_holds_immutable` BEFORE UPDATE ON `story_provider_budget_holds`
WHEN NEW.`id`<>OLD.`id` OR NEW.`household_id`<>OLD.`household_id` OR NEW.`user_id`<>OLD.`user_id`
  OR NEW.`story_id`<>OLD.`story_id` OR NEW.`branch_key`<>OLD.`branch_key` OR NEW.`provider`<>OLD.`provider` OR NEW.`operation`<>OLD.`operation`
  OR NEW.`max_microcents`<>OLD.`max_microcents` OR NEW.`idempotency_key`<>OLD.`idempotency_key` OR NEW.`created_at`<>OLD.`created_at`
BEGIN SELECT RAISE(ABORT, 'story_provider_hold_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `story_provider_charge_commit_guard` BEFORE UPDATE OF `status` ON `provider_spend_reservations`
WHEN NEW.`status`='charge_committed' AND NEW.`operation` IN ('story_writing','story_output_moderation','story_speech','story_sfx') AND NOT EXISTS (
  SELECT 1 FROM `story_provider_budget_holds` h JOIN `story_experiences` s ON s.`id`=h.`story_id` AND s.`household_id`=h.`household_id`
    JOIN `voice_consent_leases` l ON l.`household_id`=s.`household_id`
    JOIN `voices` v ON v.`id`=l.`voice_id` AND v.`household_id`=l.`household_id`
  WHERE h.`provider_spend_reservation_id`=NEW.`id` AND h.`status`='claimed' AND s.`status` IN ('queued','processing')
    AND l.`id`=CASE WHEN h.`branch_key`='root' THEN s.`consent_lease_id` ELSE (SELECT b.`consent_lease_id` FROM `story_branch_requests` b WHERE b.`id`=h.`branch_key` AND b.`household_id`=h.`household_id` AND b.`status` IN ('queued','processing')) END
    AND l.`status`='active' AND l.`expires_at`>unixepoch('subsec')*1000 AND v.`status`='ready' AND v.`current_consent_id`=l.`consent_id`
    AND EXISTS (SELECT 1 FROM `jobs` j WHERE j.`id`=CASE WHEN h.`branch_key`='root' THEN s.`job_id` ELSE (SELECT b.`job_id` FROM `story_branch_requests` b WHERE b.`id`=h.`branch_key`) END AND j.`household_id`=h.`household_id` AND j.`status`='running')
)
BEGIN SELECT RAISE(ABORT, 'story_provider_charge_not_authorized'); END;--> statement-breakpoint
CREATE TRIGGER `story_experiences_verified_consent_insert`
BEFORE INSERT ON `story_experiences`
WHEN NOT EXISTS (
  SELECT 1 FROM `voices` v JOIN `voice_consents` c ON c.`id` = v.`current_consent_id`
  WHERE v.`id` = NEW.`voice_id` AND v.`household_id` = NEW.`household_id` AND v.`status` = 'ready'
    AND c.`id` = NEW.`consent_id` AND c.`household_id` = NEW.`household_id`
    AND c.`status` = 'active_verified' AND c.`consent_version` = NEW.`consent_version`
)
BEGIN SELECT RAISE(ABORT, 'story_household_verified_consent_required'); END;--> statement-breakpoint
CREATE TRIGGER `story_experiences_job_reservation_binding`
BEFORE INSERT ON `story_experiences`
WHEN NEW.`job_id` IS NULL OR NEW.`reservation_id` IS NULL OR NOT EXISTS (
  SELECT 1 FROM `jobs` j JOIN `usage_reservations` r ON r.`id` = NEW.`reservation_id`
    JOIN `voice_consent_leases` l ON l.`id` = NEW.`consent_lease_id`
  WHERE j.`id` = NEW.`job_id` AND j.`household_id` = NEW.`household_id` AND j.`requested_by_user_id` = NEW.`requested_by_user_id`
    AND j.`type` = 'story_audio' AND j.`status` = 'queued' AND j.`idempotency_key` = NEW.`idempotency_key` AND j.`request_hash` = NEW.`request_hash`
    AND r.`household_id` = NEW.`household_id` AND r.`user_id` = NEW.`requested_by_user_id`
    AND r.`operation` = 'story_audio_generation' AND r.`status` = 'reserved' AND r.`quantity` = NEW.`duration_minutes`
    AND r.`weight_milliunits` = NEW.`duration_minutes` * 1000 AND r.`idempotency_key` = 'story-usage:' || NEW.`idempotency_key` AND r.`request_hash` = NEW.`request_hash`
    AND l.`household_id` = NEW.`household_id` AND l.`voice_id` = NEW.`voice_id` AND l.`consent_id` = NEW.`consent_id`
    AND l.`consent_version` = NEW.`consent_version` AND l.`status` = 'active' AND l.`expires_at` > NEW.`created_at`
)
BEGIN SELECT RAISE(ABORT, 'story_household_job_reservation_required'); END;--> statement-breakpoint
CREATE TRIGGER `story_experiences_completion_binding` BEFORE UPDATE OF `status`,`media_asset_id` ON `story_experiences`
WHEN NEW.`status`='completed' AND NOT EXISTS (
  SELECT 1 FROM `voices` v JOIN `voice_consents` c ON c.`id`=v.`current_consent_id`
    JOIN `voice_consent_leases` l ON l.`id`=NEW.`consent_lease_id`
  WHERE v.`id`=NEW.`voice_id` AND v.`household_id`=NEW.`household_id` AND v.`status`='ready'
    AND c.`id`=NEW.`consent_id` AND c.`household_id`=NEW.`household_id` AND c.`status`='active_verified' AND c.`consent_version`='voice-v2-live-phrase'
    AND l.`consent_id`=c.`id` AND l.`household_id`=NEW.`household_id` AND l.`status`='consumed'
    AND EXISTS (SELECT 1 FROM `media_assets` m JOIN `story_media_bindings` b
      ON b.`media_asset_id`=m.`id` AND b.`household_id`=m.`household_id`
      WHERE m.`id`=NEW.`media_asset_id` AND m.`household_id`=NEW.`household_id` AND m.`status`='ready'
        AND b.`story_id`=NEW.`id` AND b.`branch_key`='root' AND b.`role`='final' AND b.`ordinal` IS NULL AND b.`status`='ready')
    AND 5=(SELECT count(*) FROM `story_segments` sg JOIN `story_media_bindings` sb
      ON sb.`household_id`=sg.`household_id` AND sb.`story_id`=sg.`story_id` AND sb.`branch_key`=sg.`branch_key`
        AND sb.`ordinal`=sg.`ordinal` AND sb.`role`='segment' AND sb.`media_asset_id`=sg.`media_asset_id` AND sb.`status`='ready'
      WHERE sg.`household_id`=NEW.`household_id` AND sg.`story_id`=NEW.`id` AND sg.`branch_key`='root' AND sg.`status`='ready')
)
BEGIN SELECT RAISE(ABORT, 'story_completion_binding_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `story_usage_commit_binding` BEFORE UPDATE OF `status` ON `usage_reservations`
WHEN OLD.`operation`='story_audio_generation' AND NEW.`status`='committed' AND NOT EXISTS (
  SELECT 1 FROM `story_experiences` s JOIN `jobs` j ON j.`id`=s.`job_id` AND j.`household_id`=s.`household_id`
  WHERE s.`reservation_id`=NEW.`id` AND s.`household_id`=NEW.`household_id` AND s.`status`='completed' AND j.`status`='succeeded'
)
BEGIN SELECT RAISE(ABORT, 'story_usage_completion_binding_invalid'); END;--> statement-breakpoint
CREATE TABLE `story_segments` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `story_id` text NOT NULL,
  `branch_key` text DEFAULT 'root' NOT NULL,
  `ordinal` integer NOT NULL CHECK (`ordinal` BETWEEN 0 AND 4),
  `purpose` text NOT NULL,
  `narration` text,
  `status` text DEFAULT 'queued' NOT NULL CHECK (`status` IN ('queued','processing','ready','failed','superseded')),
  `plan_version` text NOT NULL CHECK (`plan_version` = 'nearstory-plan-v1'),
  `prompt_version` text NOT NULL CHECK (`prompt_version` = 'nearstory-segment-v1'),
  `writer_model` text,
  `writer_request_id` text,
  `moderation_model` text,
  `moderation_request_id` text,
  `moderation_verdict` text CHECK (`moderation_verdict` IS NULL OR `moderation_verdict` IN ('safe','unsafe')),
  `tts_model` text,
  `tts_request_id` text,
  `media_asset_id` text,
  `start_ms` integer CHECK (`start_ms` IS NULL OR `start_ms` >= 0),
  `end_ms` integer CHECK (`end_ms` IS NULL OR `end_ms` > `start_ms`),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`story_id`) REFERENCES `story_experiences`(`household_id`,`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`media_asset_id`) REFERENCES `media_assets`(`household_id`,`id`) ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `story_segments_story_branch_ordinal_idx` ON `story_segments` (`story_id`,`branch_key`,`ordinal`);--> statement-breakpoint
CREATE INDEX `story_segments_household_story_idx` ON `story_segments` (`household_id`,`story_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `story_media_bindings` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `story_id` text NOT NULL,
  `media_asset_id` text NOT NULL,
  `role` text NOT NULL CHECK (`role` IN ('segment','final')),
  `branch_key` text DEFAULT 'root' NOT NULL,
  `ordinal` integer,
  `status` text DEFAULT 'processing' NOT NULL CHECK (`status` IN ('processing','ready','deleted')),
  `attempt_token` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`story_id`) REFERENCES `story_experiences`(`household_id`,`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`media_asset_id`) REFERENCES `media_assets`(`household_id`,`id`) ON DELETE cascade,
  CHECK ((`role`='final' AND `ordinal` IS NULL) OR (`role`='segment' AND `ordinal` >= 0))
);--> statement-breakpoint
CREATE UNIQUE INDEX `story_media_asset_idx` ON `story_media_bindings` (`media_asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_media_role_idx` ON `story_media_bindings` (`story_id`,`branch_key`,`role`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_media_final_idx` ON `story_media_bindings` (`story_id`,`branch_key`) WHERE `role`='final';--> statement-breakpoint
CREATE TRIGGER `story_media_attempt_insert_guard` BEFORE INSERT ON `story_media_bindings`
WHEN NOT EXISTS (SELECT 1 FROM `story_experiences` s JOIN `jobs` j ON j.`id`=s.`job_id` AND j.`household_id`=s.`household_id`
  WHERE s.`id`=NEW.`story_id` AND s.`household_id`=NEW.`household_id` AND s.`status` IN ('queued','processing')
    AND j.`status`='running' AND j.`worker_attempt_token`=NEW.`attempt_token` AND j.`worker_lease_expires_at`>unixepoch('subsec')*1000)
BEGIN SELECT RAISE(ABORT, 'story_media_worker_attempt_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `story_media_attempt_ready_guard` BEFORE UPDATE OF `status` ON `story_media_bindings`
WHEN NEW.`status`='ready' AND NOT EXISTS (SELECT 1 FROM `story_experiences` s JOIN `jobs` j ON j.`id`=s.`job_id` AND j.`household_id`=s.`household_id`
  WHERE s.`id`=NEW.`story_id` AND s.`household_id`=NEW.`household_id` AND s.`status` IN ('queued','processing')
    AND j.`status`='running' AND j.`worker_attempt_token`=OLD.`attempt_token` AND j.`worker_lease_expires_at`>unixepoch('subsec')*1000)
BEGIN SELECT RAISE(ABORT, 'story_media_worker_attempt_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `story_media_attempt_adopt_guard` BEFORE UPDATE OF `attempt_token` ON `story_media_bindings`
WHEN NEW.`attempt_token`<>OLD.`attempt_token` AND (OLD.`status`<>'processing' OR NOT EXISTS (SELECT 1 FROM `story_experiences` s JOIN `jobs` j ON j.`id`=s.`job_id` AND j.`household_id`=s.`household_id`
  WHERE s.`id`=NEW.`story_id` AND s.`household_id`=NEW.`household_id` AND s.`status` IN ('queued','processing')
    AND j.`status`='running' AND j.`worker_attempt_token`=NEW.`attempt_token` AND j.`worker_lease_expires_at`>unixepoch('subsec')*1000))
BEGIN SELECT RAISE(ABORT, 'story_media_worker_attempt_invalid'); END;--> statement-breakpoint
CREATE TABLE `story_deletion_operations` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `story_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `request_hash` text NOT NULL,
  `status` text DEFAULT 'inventory_pending' NOT NULL CHECK (`status` IN ('inventory_pending','cleanup_pending','cleanup_verified','failed','completed')),
  `storage_keys` text DEFAULT '[]' NOT NULL,
  `attempt_token` text,
  `attempt_expires_at` integer,
  `error_code` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `completed_at` integer,
  FOREIGN KEY (`household_id`,`story_id`) REFERENCES `story_experiences`(`household_id`,`id`) ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `story_deletion_household_request_idx` ON `story_deletion_operations` (`household_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_deletion_household_id_idx` ON `story_deletion_operations` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `story_deletion_story_live_idx` ON `story_deletion_operations` (`household_id`,`story_id`) WHERE `status`<>'completed';--> statement-breakpoint
CREATE TABLE `story_branch_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL,
  `story_id` text NOT NULL,
  `requested_by_user_id` text NOT NULL,
  `direction` text NOT NULL,
  `after_segment` integer NOT NULL CHECK (`after_segment` >= 0),
  `request_hash` text NOT NULL,
  `job_id` text NOT NULL,
  `reservation_id` text NOT NULL,
  `consent_lease_id` text NOT NULL,
  `moderation_receipt_id` text NOT NULL,
  `reserved_minutes` integer NOT NULL CHECK (`reserved_minutes` > 0),
  `status` text DEFAULT 'queued' NOT NULL CHECK (`status` IN ('queued','processing','applied','rejected','failed')),
  `moderation_provenance` text NOT NULL,
  `error_code` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`story_id`) REFERENCES `story_experiences`(`household_id`,`id`) ON DELETE cascade,
  FOREIGN KEY (`household_id`,`requested_by_user_id`) REFERENCES `household_members`(`household_id`,`user_id`) ON DELETE restrict,
  FOREIGN KEY (`household_id`,`job_id`) REFERENCES `jobs`(`household_id`,`id`) ON DELETE restrict,
  FOREIGN KEY (`household_id`,`reservation_id`) REFERENCES `usage_reservations`(`household_id`,`id`) ON DELETE restrict,
  FOREIGN KEY (`household_id`,`consent_lease_id`) REFERENCES `voice_consent_leases`(`household_id`,`id`) ON DELETE restrict
  ,FOREIGN KEY (`household_id`,`moderation_receipt_id`) REFERENCES `story_moderation_receipts`(`household_id`,`id`) ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX `story_branch_requests_story_id_idx` ON `story_branch_requests` (`story_id`,`id`);--> statement-breakpoint
CREATE TRIGGER `story_branch_paid_binding` BEFORE INSERT ON `story_branch_requests`
WHEN NOT EXISTS (
  SELECT 1 FROM `story_experiences` s JOIN `jobs` j ON j.`id`=NEW.`job_id`
    JOIN `usage_reservations` r ON r.`id`=NEW.`reservation_id`
    JOIN `voice_consent_leases` l ON l.`id`=NEW.`consent_lease_id`
  WHERE s.`id`=NEW.`story_id` AND s.`household_id`=NEW.`household_id`
    AND j.`household_id`=NEW.`household_id` AND j.`requested_by_user_id`=NEW.`requested_by_user_id` AND j.`type`='story_audio' AND j.`status`='queued' AND j.`request_hash`=NEW.`request_hash`
    AND r.`household_id`=NEW.`household_id` AND r.`user_id`=NEW.`requested_by_user_id` AND r.`operation`='story_audio_generation' AND r.`status`='reserved' AND r.`request_hash`=NEW.`request_hash`
    AND r.`quantity`=NEW.`reserved_minutes` AND r.`weight_milliunits`=NEW.`reserved_minutes`*1000
    AND NEW.`reserved_minutes`=((s.`duration_minutes`*(5-NEW.`after_segment`)+4)/5)
    AND (SELECT count(*) FROM `story_segments` root WHERE root.`story_id`=s.`id` AND root.`household_id`=s.`household_id` AND root.`branch_key`='root')=5
    AND r.`idempotency_key`='story-branch-usage:' || substr(j.`idempotency_key`,8)
    AND l.`id`=NEW.`consent_lease_id` AND l.`household_id`=NEW.`household_id` AND l.`voice_id`=s.`voice_id`
    AND l.`consent_version`='voice-v2-live-phrase' AND l.`status`='active' AND l.`expires_at`>NEW.`created_at`
    AND EXISTS (SELECT 1 FROM `story_moderation_receipts` m WHERE m.`id`=NEW.`moderation_receipt_id` AND m.`household_id`=NEW.`household_id` AND m.`request_hash`=NEW.`request_hash` AND m.`verdict`='safe')
)
BEGIN SELECT RAISE(ABORT, 'story_branch_paid_binding_required'); END;--> statement-breakpoint
CREATE TRIGGER `story_branch_target_unplayed`
BEFORE INSERT ON `story_branch_requests`
WHEN NOT EXISTS (
  SELECT 1 FROM `story_experiences` s JOIN `story_segments` g ON g.`story_id` = s.`id` AND g.`household_id` = s.`household_id`
  WHERE s.`id` = NEW.`story_id` AND s.`household_id` = NEW.`household_id`
    AND s.`status` = 'completed'
    AND NEW.`after_segment` > s.`highest_played_segment`
    AND g.`branch_key` = 'root' AND g.`ordinal` = NEW.`after_segment` AND g.`status`='ready'
)
BEGIN SELECT RAISE(ABORT, 'story_branch_target_already_played'); END;--> statement-breakpoint
CREATE TRIGGER `story_branch_count_limit` BEFORE INSERT ON `story_branch_requests`
WHEN (SELECT count(*) FROM `story_branch_requests` WHERE `story_id`=NEW.`story_id` AND `status` NOT IN ('rejected','failed')) >= 3
BEGIN SELECT RAISE(ABORT, 'story_branch_limit_reached'); END;--> statement-breakpoint
CREATE TABLE `story_sound_assets` (
  `id` text PRIMARY KEY NOT NULL,
  `cache_key` text NOT NULL,
  `descriptor` text NOT NULL,
  `provenance` text NOT NULL CHECK (`provenance` = 'nearyou-allowlisted-effect'),
  `license_policy_version` text NOT NULL CHECK (`license_policy_version` = 'story-sfx-rights-v1'),
  `provider` text NOT NULL,
  `provider_request_id` text,
  `storage_key` text,
  `checksum` text,
  `byte_size` integer CHECK (`byte_size` IS NULL OR `byte_size` > 0),
  `attempt_token` text,
  `attempt_expires_at` integer,
  `status` text DEFAULT 'processing' NOT NULL CHECK (`status` IN ('processing','ready','failed','deleted')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `story_sound_assets_cache_idx` ON `story_sound_assets` (`cache_key`);--> statement-breakpoint
CREATE TRIGGER `story_sound_assets_processing_lease_insert`
BEFORE INSERT ON `story_sound_assets` WHEN NEW.`status` = 'processing' AND (
  length(COALESCE(NEW.`attempt_token`,'')) < 16 OR NEW.`attempt_expires_at` IS NULL OR NEW.`attempt_expires_at` <= NEW.`updated_at`
)
BEGIN SELECT RAISE(ABORT, 'story_sound_processing_lease_required'); END;--> statement-breakpoint
CREATE TRIGGER `story_sound_assets_processing_lease_update`
BEFORE UPDATE ON `story_sound_assets` WHEN NEW.`status` = 'processing' AND (
  length(COALESCE(NEW.`attempt_token`,'')) < 16 OR NEW.`attempt_expires_at` IS NULL OR NEW.`attempt_expires_at` <= NEW.`updated_at`
)
BEGIN SELECT RAISE(ABORT, 'story_sound_processing_lease_required'); END;--> statement-breakpoint
CREATE TRIGGER `story_sound_assets_rights`
BEFORE INSERT ON `story_sound_assets`
WHEN NEW.`provenance` <> 'nearyou-allowlisted-effect' OR NEW.`license_policy_version` <> 'story-sfx-rights-v1'
BEGIN SELECT RAISE(ABORT, 'story_sound_rights_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `story_sound_assets_ready_integrity_insert`
BEFORE INSERT ON `story_sound_assets` WHEN NEW.`status` = 'ready' AND (
  length(COALESCE(NEW.`storage_key`,'')) = 0 OR NEW.`byte_size` IS NULL OR NEW.`byte_size`<=0 OR length(COALESCE(NEW.`checksum`,'')) <> 64 OR lower(NEW.`checksum`) GLOB '*[^0-9a-f]*'
  OR length(COALESCE(NEW.`provider_request_id`,'')) = 0
)
BEGIN SELECT RAISE(ABORT, 'story_sound_integrity_required'); END;--> statement-breakpoint
CREATE TRIGGER `story_sound_assets_ready_integrity_update`
BEFORE UPDATE ON `story_sound_assets` WHEN NEW.`status` = 'ready' AND (
  length(COALESCE(NEW.`storage_key`,'')) = 0 OR NEW.`byte_size` IS NULL OR NEW.`byte_size`<=0 OR length(COALESCE(NEW.`checksum`,'')) <> 64 OR lower(NEW.`checksum`) GLOB '*[^0-9a-f]*'
  OR length(COALESCE(NEW.`provider_request_id`,'')) = 0 OR NEW.`descriptor` <> OLD.`descriptor`
  OR NEW.`provenance` <> OLD.`provenance` OR NEW.`license_policy_version` <> OLD.`license_policy_version`
)
BEGIN SELECT RAISE(ABORT, 'story_sound_integrity_required'); END;--> statement-breakpoint
CREATE TRIGGER `story_experiences_account_deletion_insert_fence`
BEFORE INSERT ON `story_experiences`
WHEN EXISTS (SELECT 1 FROM `account_deletion_operations` d WHERE d.`household_id` = NEW.`household_id` AND d.`status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT, 'account_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `story_experiences_live_export_insert_fence`
BEFORE INSERT ON `story_experiences`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id` = NEW.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_experiences_live_export_update_fence` BEFORE UPDATE ON `story_experiences`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id` = OLD.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at` > unixepoch('subsec') * 1000)
  AND NOT (NEW.`status`='canceled' AND EXISTS (SELECT 1 FROM `account_deletion_operations` d WHERE d.`household_id`=OLD.`household_id` AND d.`status` NOT IN ('completed','canceled')))
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_experiences_live_export_delete_fence` BEFORE DELETE ON `story_experiences`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id` = OLD.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_segments_live_export_insert_fence` BEFORE INSERT ON `story_segments`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id` = NEW.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_segments_live_export_update_fence` BEFORE UPDATE ON `story_segments`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id` = OLD.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_segments_live_export_delete_fence` BEFORE DELETE ON `story_segments`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id` = OLD.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_segments_ready_media_required_insert` BEFORE INSERT ON `story_segments`
WHEN NEW.`status`='ready' AND (NEW.`start_ms` IS NULL OR NEW.`end_ms` IS NULL OR NEW.`media_asset_id` IS NULL OR NOT EXISTS (
  SELECT 1 FROM `media_assets` m JOIN `story_media_bindings` b
    ON b.`media_asset_id`=m.`id` AND b.`household_id`=m.`household_id`
  WHERE m.`id`=NEW.`media_asset_id` AND m.`household_id`=NEW.`household_id`
    AND m.`status`='ready' AND m.`private`=1 AND m.`storage_key` IS NOT NULL AND m.`byte_size`>0
    AND length(COALESCE(m.`checksum`,''))=64 AND lower(m.`checksum`) NOT GLOB '*[^0-9a-f]*'
    AND b.`story_id`=NEW.`story_id` AND b.`branch_key`=NEW.`branch_key` AND b.`role`='segment'
    AND b.`ordinal`=NEW.`ordinal` AND b.`status`='ready'
)) BEGIN SELECT RAISE(ABORT, 'story_segment_ready_media_required'); END;--> statement-breakpoint
CREATE TRIGGER `story_segments_ready_media_required_update` BEFORE UPDATE ON `story_segments`
WHEN NEW.`status`='ready' AND (NEW.`start_ms` IS NULL OR NEW.`end_ms` IS NULL OR NEW.`media_asset_id` IS NULL OR NOT EXISTS (
  SELECT 1 FROM `media_assets` m JOIN `story_media_bindings` b
    ON b.`media_asset_id`=m.`id` AND b.`household_id`=m.`household_id`
  WHERE m.`id`=NEW.`media_asset_id` AND m.`household_id`=NEW.`household_id`
    AND m.`status`='ready' AND m.`private`=1 AND m.`storage_key` IS NOT NULL AND m.`byte_size`>0
    AND length(COALESCE(m.`checksum`,''))=64 AND lower(m.`checksum`) NOT GLOB '*[^0-9a-f]*'
    AND b.`story_id`=NEW.`story_id` AND b.`branch_key`=NEW.`branch_key` AND b.`role`='segment'
    AND b.`ordinal`=NEW.`ordinal` AND b.`status`='ready'
)) BEGIN SELECT RAISE(ABORT, 'story_segment_ready_media_required'); END;--> statement-breakpoint
CREATE TRIGGER `story_experiences_delete_pending_finalize_fence` BEFORE UPDATE ON `story_experiences`
WHEN OLD.`status` IN ('delete_pending','deleted') AND (
  NEW.`status` NOT IN ('delete_pending','deleted') OR NEW.`media_asset_id` IS NOT OLD.`media_asset_id`
) AND NOT (OLD.`status`='delete_pending' AND NEW.`status`='deleted' AND NEW.`media_asset_id` IS NULL)
BEGIN SELECT RAISE(ABORT, 'story_delete_pending_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `story_segments_delete_pending_insert_fence` BEFORE INSERT ON `story_segments`
WHEN EXISTS (SELECT 1 FROM `story_experiences` s WHERE s.`id`=NEW.`story_id` AND s.`household_id`=NEW.`household_id` AND s.`status` IN ('delete_pending','deleted'))
BEGIN SELECT RAISE(ABORT, 'story_delete_pending_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `story_segments_delete_pending_write_fence` BEFORE UPDATE ON `story_segments`
WHEN EXISTS (SELECT 1 FROM `story_experiences` s WHERE s.`id`=OLD.`story_id` AND s.`household_id`=OLD.`household_id` AND s.`status` IN ('delete_pending','deleted'))
BEGIN SELECT RAISE(ABORT, 'story_delete_pending_fenced'); END;--> statement-breakpoint
DROP TRIGGER `media_assets_validate_ready_shape`;--> statement-breakpoint
CREATE TRIGGER `media_assets_validate_ready_shape`
BEFORE UPDATE OF `status` ON `media_assets` WHEN OLD.`status` = 'processing' AND NEW.`status` = 'ready'
BEGIN
  SELECT CASE WHEN NEW.`byte_size` IS NULL OR NEW.`byte_size` <= 0 OR length(trim(COALESCE(NEW.`storage_key`,''))) = 0
    OR length(COALESCE(NEW.`checksum`,'')) <> 64 OR lower(NEW.`checksum`) GLOB '*[^0-9a-f]*'
    THEN RAISE(ABORT, 'invalid_ready_media') END;
  SELECT CASE WHEN NEW.`kind` = 'narration' AND NOT EXISTS (SELECT 1 FROM `sleep_sessions`
    WHERE `id` = NEW.`legacy_session_id` AND `household_id` = NEW.`household_id` AND `status` = 'ready'
      AND `media_asset_id` = NEW.`id` AND `audio_key` = NEW.`storage_key` AND `deletion_status` = 'active')
    AND NOT EXISTS (SELECT 1 FROM `story_media_bindings` b JOIN `story_experiences` s ON s.`id`=b.`story_id` AND s.`household_id`=b.`household_id`
      WHERE b.`media_asset_id`=NEW.`id` AND b.`household_id`=NEW.`household_id` AND b.`status`='processing'
        AND s.`status` IN ('queued','processing') AND s.`status` NOT IN ('delete_pending','deleted'))
    THEN RAISE(ABORT, 'media_session_finalize_mismatch') END;
END;--> statement-breakpoint
CREATE TRIGGER `story_media_delete_pending_insert_fence` BEFORE INSERT ON `story_media_bindings`
WHEN EXISTS (SELECT 1 FROM `story_experiences` s WHERE s.`id`=NEW.`story_id` AND s.`household_id`=NEW.`household_id` AND s.`status` IN ('delete_pending','deleted'))
BEGIN SELECT RAISE(ABORT, 'story_delete_pending_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `story_media_live_export_insert_fence` BEFORE INSERT ON `story_media_bindings`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id`=NEW.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at`>unixepoch('subsec')*1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_media_live_export_update_fence` BEFORE UPDATE ON `story_media_bindings`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id`=OLD.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at`>unixepoch('subsec')*1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_media_live_export_delete_fence` BEFORE DELETE ON `story_media_bindings`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id`=OLD.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at`>unixepoch('subsec')*1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_branches_live_export_insert_fence` BEFORE INSERT ON `story_branch_requests`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id` = NEW.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_branches_live_export_update_fence` BEFORE UPDATE ON `story_branch_requests`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id` = OLD.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at` > unixepoch('subsec') * 1000)
  AND NOT (NEW.`status`='failed' AND NEW.`error_code`='account_deletion_fenced' AND EXISTS (SELECT 1 FROM `account_deletion_operations` d WHERE d.`household_id`=OLD.`household_id` AND d.`status` NOT IN ('completed','canceled')))
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_branches_live_export_delete_fence` BEFORE DELETE ON `story_branch_requests`
WHEN EXISTS (SELECT 1 FROM `household_exports` e WHERE e.`household_id` = OLD.`household_id` AND e.`status` IN ('queued','running','failed') AND e.`expires_at` > unixepoch('subsec') * 1000)
BEGIN SELECT RAISE(ABORT, 'household_export_snapshot_locked'); END;--> statement-breakpoint
CREATE TRIGGER `story_account_deletion_quiesce` AFTER INSERT ON `account_deletion_operations`
WHEN NEW.`status` NOT IN ('completed','canceled')
BEGIN
  UPDATE `jobs` SET `status`='canceled', `error_code`='account_deletion_fenced', `updated_at`=NEW.`created_at`, `completed_at`=NEW.`created_at`
    WHERE `household_id`=NEW.`household_id` AND `type`='story_audio' AND `status` IN ('queued','running');
  UPDATE `story_experiences` SET `status`='canceled', `error_code`='account_deletion_fenced', `updated_at`=NEW.`created_at`
    WHERE `household_id`=NEW.`household_id` AND `status` IN ('queued','processing','review_required');
  UPDATE `story_branch_requests` SET `status`='failed', `error_code`='account_deletion_fenced', `updated_at`=NEW.`created_at`
    WHERE `household_id`=NEW.`household_id` AND `status` IN ('queued','processing');
  UPDATE `usage_reservations` SET `status`='released', `finalized_at`=NEW.`created_at`, `updated_at`=NEW.`created_at`
    WHERE `household_id`=NEW.`household_id` AND `operation`='story_audio_generation' AND `status`='reserved';
  UPDATE `voice_consent_leases` SET `status`='revoked', `finalized_at`=NEW.`created_at`
    WHERE `household_id`=NEW.`household_id` AND `status`='active' AND (`id` IN (SELECT `consent_lease_id` FROM `story_experiences` WHERE `household_id`=NEW.`household_id`) OR `id` IN (SELECT `consent_lease_id` FROM `story_branch_requests` WHERE `household_id`=NEW.`household_id`));
  UPDATE `provider_spend_reservations` SET `status`=CASE WHEN `status`='charge_committed' THEN 'settled' ELSE 'released' END, `updated_at`=NEW.`created_at`
    WHERE `id` IN (SELECT `provider_spend_reservation_id` FROM `story_provider_budget_holds` WHERE `household_id`=NEW.`household_id` AND `provider_spend_reservation_id` IS NOT NULL) AND `status` IN ('in_flight','charge_committed');
  UPDATE `story_provider_budget_holds` SET `status`=CASE WHEN `status`='claimed' THEN 'settled' ELSE 'released' END, `updated_at`=NEW.`created_at`
    WHERE `household_id`=NEW.`household_id` AND `status` IN ('reserved','claimed');
END;--> statement-breakpoint
