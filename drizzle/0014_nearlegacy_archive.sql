CREATE TABLE `legacy_activation_state` (
  `id` text PRIMARY KEY NOT NULL,
  `status` text DEFAULT 'blocked' NOT NULL CHECK (`status` IN ('blocked','ready')),
  `migration_version` text NOT NULL,
  `worker_heartbeat_at` integer,
  `unresolved_objects` integer DEFAULT 0 NOT NULL CHECK (`unresolved_objects` >= 0),
  `updated_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `legacy_activation_state` (`id`,`status`,`migration_version`,`unresolved_objects`,`updated_at`) VALUES ('archive','blocked','0014',0,unixepoch('subsec')*1000);--> statement-breakpoint
CREATE TABLE `legacy_rate_limits` (`household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,`operation` text NOT NULL,`window_started_at` integer NOT NULL,`request_count` integer NOT NULL CHECK (`request_count`>0),PRIMARY KEY (`household_id`,`user_id`,`operation`));--> statement-breakpoint
CREATE UNIQUE INDEX `contributors_household_id_idx` ON `contributors` (`household_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_spend_household_id_idx` ON `provider_spend_reservations` (`household_id`,`id`);--> statement-breakpoint
ALTER TABLE `contributors` ADD COLUMN `creation_idempotency_key` text;--> statement-breakpoint
ALTER TABLE `contributors` ADD COLUMN `request_hash` text;--> statement-breakpoint
ALTER TABLE `contributors` ADD COLUMN `invitation_id` text;--> statement-breakpoint
ALTER TABLE `contributors` ADD COLUMN `death_reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `contributors` ADD COLUMN `death_reviewed_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL;--> statement-breakpoint
CREATE TABLE `annual_allowance_refills` (`entitlement_id` text PRIMARY KEY NOT NULL REFERENCES `entitlements`(`id`) ON DELETE CASCADE,`household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,`anchor_seconds` integer NOT NULL,`refilled_through_seconds` integer NOT NULL,`created_at` integer NOT NULL,`updated_at` integer NOT NULL,UNIQUE (`household_id`,`entitlement_id`));--> statement-breakpoint
CREATE UNIQUE INDEX `contributors_household_creation_key` ON `contributors` (`household_id`,`creation_idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `contributors_one_active_identity` ON `contributors` (`household_id`,`adult_user_id`) WHERE `adult_user_id` IS NOT NULL AND `status` IN ('active','deceased_pending_review');--> statement-breakpoint
CREATE TABLE `legacy_audit_events` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `actor_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL, `event_type` text NOT NULL,
  `target_kind` text NOT NULL, `target_id` text NOT NULL, `request_hash` text NOT NULL, `created_at` integer NOT NULL,
  UNIQUE (`household_id`,`id`)
);--> statement-breakpoint
CREATE TABLE `legacy_mfa_enrollments` (
  `id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `method` text DEFAULT 'totp' NOT NULL CHECK (`method`='totp'), `status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending','active','revoked')),
  `secret_ciphertext` text NOT NULL, `secret_iv` text NOT NULL, `last_used_counter` integer DEFAULT -1 NOT NULL,
  `reauth_challenge_id` text REFERENCES `account_reauth_challenges`(`id`) ON DELETE SET NULL, `reauth_session_id` text,
  `created_at` integer NOT NULL, `verified_at` integer, `revoked_at` integer,
  UNIQUE (`user_id`,`id`)
);--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_one_active_mfa` ON `legacy_mfa_enrollments` (`user_id`) WHERE `status`='active';--> statement-breakpoint
CREATE TABLE `legacy_mfa_recovery_codes` (`id` text PRIMARY KEY NOT NULL,`enrollment_id` text NOT NULL REFERENCES `legacy_mfa_enrollments`(`id`) ON DELETE CASCADE,`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,`code_hash` text NOT NULL CHECK (length(`code_hash`)=64),`created_at` integer NOT NULL,`used_at` integer,UNIQUE (`user_id`,`code_hash`));--> statement-breakpoint
CREATE TABLE `legacy_mfa_rate_limits` (`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,`operation` text NOT NULL,`window_started_at` integer NOT NULL,`request_count` integer NOT NULL CHECK (`request_count`>0),PRIMARY KEY (`user_id`,`operation`));--> statement-breakpoint
CREATE TABLE `legacy_security_actions` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `actor_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `action` text NOT NULL CHECK (`action` IN ('custodian_bootstrap','custodian_appoint','death_report','death_review','contributor_revoke','mfa_enroll','mfa_revoke')),
  `target_kind` text NOT NULL CHECK (`target_kind` IN ('custodian','contributor','mfa')), `target_id` text NOT NULL,
  `request_hash` text NOT NULL CHECK (length(`request_hash`)=64),
  `reauth_challenge_id` text REFERENCES `account_reauth_challenges`(`id`) ON DELETE SET NULL, `reauth_session_id` text,
  `created_at` integer NOT NULL, UNIQUE (`household_id`,`id`)
);--> statement-breakpoint
CREATE TRIGGER `legacy_security_action_authorize` BEFORE INSERT ON `legacy_security_actions`
WHEN NOT EXISTS (SELECT 1 FROM `account_reauth_challenges` a WHERE a.`id`=NEW.`reauth_challenge_id` AND a.`user_id`=NEW.`actor_user_id` AND a.`status`='verified' AND a.`verified_session_id`=NEW.`reauth_session_id` AND a.`expires_at`>NEW.`created_at`)
BEGIN SELECT RAISE(ABORT,'fresh_reauthentication_required'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_security_action_consume` AFTER INSERT ON `legacy_security_actions` BEGIN
  UPDATE `account_reauth_challenges` SET `status`='consumed',`consumed_at`=NEW.`created_at` WHERE `id`=NEW.`reauth_challenge_id` AND `status`='verified' AND `verified_session_id`=NEW.`reauth_session_id`;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'fresh_reauthentication_required') END;
END;--> statement-breakpoint
CREATE TABLE `legacy_custodians` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `role` text NOT NULL CHECK (`role` IN ('primary','successor')),
  `status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending','active','revoked')),
  `appointed_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `accepted_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  UNIQUE (`household_id`,`user_id`), UNIQUE (`household_id`,`id`)
);--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_one_active_primary_custodian` ON `legacy_custodians` (`household_id`) WHERE `role`='primary' AND `status`='active';--> statement-breakpoint
CREATE TABLE `legacy_custodian_transfers` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `from_custodian_id` text NOT NULL, `to_custodian_id` text NOT NULL, `requested_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `status` text DEFAULT 'requested' NOT NULL CHECK (`status` IN ('requested','completed')), `reauth_challenge_id` text REFERENCES `account_reauth_challenges`(`id`) ON DELETE SET NULL, `reauth_session_id` text, `created_at` integer NOT NULL, `completed_at` integer,
  FOREIGN KEY (`household_id`,`from_custodian_id`) REFERENCES `legacy_custodians`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`to_custodian_id`) REFERENCES `legacy_custodians`(`household_id`,`id`) ON DELETE RESTRICT,
  UNIQUE (`household_id`,`id`), UNIQUE (`household_id`,`from_custodian_id`,`status`)
);--> statement-breakpoint
CREATE TABLE `legacy_custodian_acceptances` (`id` text PRIMARY KEY NOT NULL,`household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,`custodian_id` text NOT NULL,`user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,`request_hash` text NOT NULL,`reauth_challenge_id` text REFERENCES `account_reauth_challenges`(`id`) ON DELETE SET NULL,`reauth_session_id` text,`created_at` integer NOT NULL,FOREIGN KEY (`household_id`,`custodian_id`) REFERENCES `legacy_custodians`(`household_id`,`id`) ON DELETE RESTRICT,UNIQUE (`household_id`,`id`),UNIQUE (`household_id`,`custodian_id`));--> statement-breakpoint
CREATE TABLE `legacy_liveness_challenges` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `contributor_id` text NOT NULL, `user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('recording','transcription','synthetic')), `phrase` text NOT NULL CHECK (length(`phrase`) BETWEEN 12 AND 160),
  `phrase_hash` text NOT NULL CHECK (length(`phrase_hash`)=64 AND lower(`phrase_hash`) NOT GLOB '*[^0-9a-f]*'),
  `status` text DEFAULT 'issued' NOT NULL CHECK (`status` IN ('issued','consumed','expired')),
  `expires_at` integer NOT NULL, `created_at` integer NOT NULL, `consumed_at` integer,
  FOREIGN KEY (`household_id`,`contributor_id`) REFERENCES `contributors`(`household_id`,`id`) ON DELETE CASCADE,
  UNIQUE (`household_id`,`id`)
);--> statement-breakpoint
CREATE TABLE `legacy_media_probe_receipts` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `challenge_id` text NOT NULL, `user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL, `contributor_id` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind`='consent_evidence'), `consent_kind` text NOT NULL CHECK (`consent_kind` IN ('recording','transcription','synthetic')),
  `checksum` text NOT NULL CHECK (length(`checksum`)=64 AND lower(`checksum`) NOT GLOB '*[^0-9a-f]*'),
  `byte_size` integer NOT NULL CHECK (`byte_size` BETWEEN 1 AND 2000000), `content_type` text NOT NULL CHECK (`content_type` IN ('audio/webm','audio/mp4')),
  `duration_ms` integer NOT NULL CHECK (`duration_ms` BETWEEN 2000 AND 60000), `phrase_matched` integer NOT NULL CHECK (`phrase_matched`=1),
  `live_speaker_verified` integer NOT NULL CHECK (`live_speaker_verified`=1), `processor_receipt_hash` text NOT NULL CHECK (length(`processor_receipt_hash`)=64),
  `status` text DEFAULT 'verified' NOT NULL CHECK (`status` IN ('verified','consumed','expired')),
  `expires_at` integer NOT NULL, `created_at` integer NOT NULL, `consumed_at` integer,
  FOREIGN KEY (`household_id`,`challenge_id`) REFERENCES `legacy_liveness_challenges`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`contributor_id`) REFERENCES `contributors`(`household_id`,`id`) ON DELETE CASCADE,
  UNIQUE (`household_id`,`id`), UNIQUE (`checksum`), UNIQUE (`processor_receipt_hash`)
);--> statement-breakpoint
CREATE TABLE `legacy_consents` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `contributor_id` text NOT NULL,
  `attesting_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `supersedes_consent_id` text,
  `version` text NOT NULL CHECK (`version` IN ('legacy-consent-v1','legacy-synthetic-v1')),
  `kind` text NOT NULL CHECK (`kind` IN ('recording','transcription','synthetic')),
  `audience` text NOT NULL CHECK (`audience`='household'),
  `purpose` text NOT NULL CHECK (`purpose` IN ('private_archive','private_archive_narration')),
  `posthumous_use` integer DEFAULT 0 NOT NULL CHECK (`posthumous_use`=0),
  `status` text DEFAULT 'active' NOT NULL CHECK (`status` IN ('active','superseded','revoked','expired')),
  `evidence_key` text,
  `evidence_checksum` text,
  `evidence_media_asset_id` text NOT NULL,
  `liveness_challenge_id` text NOT NULL,
  `media_probe_receipt_id` text NOT NULL,
  `attested_at` integer NOT NULL,
  `expires_at` integer,
  `revoked_at` integer,
  FOREIGN KEY (`household_id`,`contributor_id`) REFERENCES `contributors`(`household_id`,`id`) ON DELETE CASCADE,
  FOREIGN KEY (`household_id`,`supersedes_consent_id`) REFERENCES `legacy_consents`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`evidence_media_asset_id`) REFERENCES `media_assets`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`liveness_challenge_id`) REFERENCES `legacy_liveness_challenges`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`media_probe_receipt_id`) REFERENCES `legacy_media_probe_receipts`(`household_id`,`id`) ON DELETE RESTRICT,
  UNIQUE (`household_id`,`media_probe_receipt_id`),
  UNIQUE (`household_id`,`id`)
);--> statement-breakpoint
CREATE TABLE `legacy_evidence_retention` (
  `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE, `consent_id` text NOT NULL,
  `media_asset_id` text NOT NULL, `delete_after` integer NOT NULL, `status` text DEFAULT 'retained' NOT NULL CHECK (`status` IN ('retained','cleanup_required','deleted','dead_letter')),
  `attempts` integer DEFAULT 0 NOT NULL CHECK (`attempts`>=0), `next_attempt_at` integer, `attempt_token` text, `lease_expires_at` integer, `dead_lettered_at` integer, `error_code` text, `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`consent_id`) REFERENCES `legacy_consents`(`household_id`,`id`) ON DELETE CASCADE,
  FOREIGN KEY (`household_id`,`media_asset_id`) REFERENCES `media_assets`(`household_id`,`id`) ON DELETE RESTRICT,
  PRIMARY KEY (`household_id`,`consent_id`), UNIQUE (`household_id`,`media_asset_id`)
);--> statement-breakpoint
CREATE INDEX `legacy_active_consent_scope` ON `legacy_consents` (`household_id`,`contributor_id`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `legacy_consent_contributor_status` ON `legacy_consents` (`household_id`,`contributor_id`,`status`);--> statement-breakpoint
CREATE TABLE `legacy_interviews` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `contributor_id` text NOT NULL,
  `created_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `title` text NOT NULL CHECK (length(`title`) BETWEEN 1 AND 160),
  `idempotency_key` text NOT NULL, `request_hash` text NOT NULL,
  `prompt_set_version` text NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL CHECK (`status` IN ('draft','recording','completed','archived','deleted')),
  `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `deleted_at` integer,
  FOREIGN KEY (`household_id`,`contributor_id`) REFERENCES `contributors`(`household_id`,`id`) ON DELETE RESTRICT,
  UNIQUE (`household_id`,`id`), UNIQUE (`household_id`,`idempotency_key`)
);--> statement-breakpoint
CREATE TABLE `legacy_recordings` (
  `id` text PRIMARY KEY NOT NULL,
  `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `interview_id` text, `contributor_id` text NOT NULL, `consent_id` text NOT NULL,
  `media_asset_id` text NOT NULL, `transcription_job_id` text,
  `recorded_at` integer NOT NULL, `duration_ms` integer NOT NULL CHECK (`duration_ms` > 0),
  `status` text DEFAULT 'processing' NOT NULL CHECK (`status` IN ('processing','ready','failed','delete_pending','deleted')),
  `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `deleted_at` integer,
  FOREIGN KEY (`household_id`,`interview_id`) REFERENCES `legacy_interviews`(`household_id`,`id`) ON DELETE SET NULL,
  FOREIGN KEY (`household_id`,`contributor_id`) REFERENCES `contributors`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`consent_id`) REFERENCES `legacy_consents`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`media_asset_id`) REFERENCES `media_assets`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`transcription_job_id`) REFERENCES `jobs`(`household_id`,`id`) ON DELETE SET NULL,
  UNIQUE (`household_id`,`id`), UNIQUE (`household_id`,`media_asset_id`)
);--> statement-breakpoint
CREATE TABLE `legacy_transcripts` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `recording_id` text NOT NULL, `consent_id` text NOT NULL, `job_binding_id` text NOT NULL, `provider_request_id` text, `language` text NOT NULL,
  `status` text DEFAULT 'processing' NOT NULL CHECK (`status` IN ('processing','ready','failed','deleted')),
  `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `deleted_at` integer,
  FOREIGN KEY (`household_id`,`recording_id`) REFERENCES `legacy_recordings`(`household_id`,`id`) ON DELETE CASCADE,
  FOREIGN KEY (`household_id`,`consent_id`) REFERENCES `legacy_consents`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`job_binding_id`) REFERENCES `legacy_job_bindings`(`household_id`,`id`) ON DELETE RESTRICT,
  UNIQUE (`household_id`,`id`), UNIQUE (`household_id`,`recording_id`)
);--> statement-breakpoint
CREATE TABLE `legacy_transcript_segments` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `transcript_id` text NOT NULL, `recording_id` text NOT NULL, `contributor_id` text NOT NULL,
  `ordinal` integer NOT NULL CHECK (`ordinal` >= 0), `start_ms` integer NOT NULL CHECK (`start_ms` >= 0), `end_ms` integer NOT NULL CHECK (`end_ms` > `start_ms`),
  `original_text` text NOT NULL CHECK (length(`original_text`) BETWEEN 1 AND 4000),
  `effective_text` text NOT NULL CHECK (length(`effective_text`) BETWEEN 1 AND 4000),
  `provenance` text DEFAULT 'original_recording' NOT NULL CHECK (`provenance`='original_recording'),
  `status` text DEFAULT 'ready' NOT NULL CHECK (`status` IN ('ready','superseded','deleted')),
  `created_at` integer NOT NULL, `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`transcript_id`) REFERENCES `legacy_transcripts`(`household_id`,`id`) ON DELETE CASCADE,
  FOREIGN KEY (`household_id`,`recording_id`) REFERENCES `legacy_recordings`(`household_id`,`id`) ON DELETE CASCADE,
  FOREIGN KEY (`household_id`,`contributor_id`) REFERENCES `contributors`(`household_id`,`id`) ON DELETE RESTRICT,
  UNIQUE (`household_id`,`id`), UNIQUE (`transcript_id`,`ordinal`)
);--> statement-breakpoint
CREATE TABLE `legacy_transcript_corrections` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `segment_id` text NOT NULL, `corrected_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `speaker_contributor_id` text NOT NULL, `corrected_text` text NOT NULL CHECK (length(`corrected_text`) BETWEEN 1 AND 4000),
  `reason` text NOT NULL CHECK (length(`reason`) BETWEEN 1 AND 120), `idempotency_key` text NOT NULL, `request_hash` text NOT NULL, `created_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`segment_id`) REFERENCES `legacy_transcript_segments`(`household_id`,`id`) ON DELETE CASCADE,
  FOREIGN KEY (`household_id`,`speaker_contributor_id`) REFERENCES `contributors`(`household_id`,`id`) ON DELETE RESTRICT,
  UNIQUE (`household_id`,`id`), UNIQUE (`household_id`,`idempotency_key`)
);--> statement-breakpoint
CREATE TABLE `legacy_memories` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `contributor_id` text NOT NULL, `title` text NOT NULL, `summary` text,
  `source_segment_id` text NOT NULL, `status` text DEFAULT 'active' NOT NULL CHECK (`status` IN ('active','archived','deleted')),
  `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `deleted_at` integer,
  FOREIGN KEY (`household_id`,`contributor_id`) REFERENCES `contributors`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`source_segment_id`) REFERENCES `legacy_transcript_segments`(`household_id`,`id`) ON DELETE RESTRICT,
  UNIQUE (`household_id`,`id`)
);--> statement-breakpoint
CREATE TABLE `legacy_people` (`id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE, `display_name` text NOT NULL, `relationship` text, `created_at` integer NOT NULL, `updated_at` integer NOT NULL, UNIQUE (`household_id`,`id`));--> statement-breakpoint
CREATE TABLE `legacy_places` (`id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE, `name` text NOT NULL, `description` text, `created_at` integer NOT NULL, `updated_at` integer NOT NULL, UNIQUE (`household_id`,`id`));--> statement-breakpoint
CREATE TABLE `legacy_photos` (`id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE, `media_asset_id` text NOT NULL, `caption` text, `taken_at` integer, `created_at` integer NOT NULL, FOREIGN KEY (`household_id`,`media_asset_id`) REFERENCES `media_assets`(`household_id`,`id`) ON DELETE RESTRICT, UNIQUE (`household_id`,`id`));--> statement-breakpoint
CREATE TABLE `legacy_tags` (`id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE, `name` text NOT NULL, `normalized_name` text NOT NULL, `created_at` integer NOT NULL, UNIQUE (`household_id`,`id`), UNIQUE (`household_id`,`normalized_name`));--> statement-breakpoint
CREATE TABLE `legacy_memory_tags` (`household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE, `memory_id` text NOT NULL, `tag_id` text NOT NULL, FOREIGN KEY (`household_id`,`memory_id`) REFERENCES `legacy_memories`(`household_id`,`id`) ON DELETE CASCADE, FOREIGN KEY (`household_id`,`tag_id`) REFERENCES `legacy_tags`(`household_id`,`id`) ON DELETE CASCADE, PRIMARY KEY (`household_id`,`memory_id`,`tag_id`));--> statement-breakpoint
CREATE TABLE `legacy_timeline_events` (`id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE, `memory_id` text NOT NULL, `occurred_on` text, `precision` text NOT NULL CHECK (`precision` IN ('exact','month','year','unknown')), `title` text NOT NULL, `created_at` integer NOT NULL, FOREIGN KEY (`household_id`,`memory_id`) REFERENCES `legacy_memories`(`household_id`,`id`) ON DELETE CASCADE, UNIQUE (`household_id`,`id`));--> statement-breakpoint
CREATE TABLE `legacy_collections` (`id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE, `created_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL, `name` text NOT NULL, `description` text, `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `deleted_at` integer, UNIQUE (`household_id`,`id`));--> statement-breakpoint
CREATE TABLE `legacy_collection_items` (`id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE, `collection_id` text NOT NULL, `memory_id` text NOT NULL, `position` integer NOT NULL CHECK (`position` >= 0), `created_at` integer NOT NULL, FOREIGN KEY (`household_id`,`collection_id`) REFERENCES `legacy_collections`(`household_id`,`id`) ON DELETE CASCADE, FOREIGN KEY (`household_id`,`memory_id`) REFERENCES `legacy_memories`(`household_id`,`id`) ON DELETE CASCADE, UNIQUE (`collection_id`,`position`), UNIQUE (`collection_id`,`memory_id`));--> statement-breakpoint
CREATE TABLE `legacy_query_receipts` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `requested_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL, `question_hash` text NOT NULL,
  `supported` integer NOT NULL CHECK (`supported` IN (0,1)), `answer_kind` text NOT NULL CHECK (`answer_kind` IN ('original_recording','no_evidence')),
  `status` text NOT NULL CHECK (`status` IN ('building','ready')), `answer_text` text NOT NULL CHECK (length(`answer_text`) BETWEEN 1 AND 4000), `answer_checksum` text NOT NULL CHECK (length(`answer_checksum`)=64 AND lower(`answer_checksum`) NOT GLOB '*[^0-9a-f]*'),
  `selected_segment_id` text, `selected_transcript_id` text, `selected_correction_id` text, `selected_recording_id` text, `selected_score_micros` integer,
  `created_at` integer NOT NULL, `completed_at` integer,
  UNIQUE (`household_id`,`id`)
);--> statement-breakpoint
CREATE TABLE `legacy_query_sources` (
  `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE, `query_receipt_id` text NOT NULL,
  `segment_id` text NOT NULL, `transcript_id` text NOT NULL, `correction_id` text, `recording_id` text NOT NULL, `rank` integer NOT NULL CHECK (`rank` >= 0), `score_micros` integer NOT NULL CHECK (`score_micros` BETWEEN 720000 AND 1000000),
  FOREIGN KEY (`household_id`,`query_receipt_id`) REFERENCES `legacy_query_receipts`(`household_id`,`id`) ON DELETE CASCADE,
  FOREIGN KEY (`household_id`,`segment_id`) REFERENCES `legacy_transcript_segments`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`transcript_id`) REFERENCES `legacy_transcripts`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`correction_id`) REFERENCES `legacy_transcript_corrections`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`recording_id`) REFERENCES `legacy_recordings`(`household_id`,`id`) ON DELETE RESTRICT,
  PRIMARY KEY (`household_id`,`query_receipt_id`,`rank`), UNIQUE (`query_receipt_id`,`segment_id`)
);--> statement-breakpoint
CREATE TABLE `legacy_job_bindings` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `job_id` text NOT NULL, `contributor_id` text NOT NULL, `recording_id` text, `consent_id` text NOT NULL, `reservation_id` text, `provider_spend_reservation_id` text,
  `operation` text NOT NULL CHECK (`operation` IN ('transcription','synthetic_narration','export')),
  `status` text DEFAULT 'active' NOT NULL CHECK (`status` IN ('active','published','released','fenced')),
  `created_at` integer NOT NULL, `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`job_id`) REFERENCES `jobs`(`household_id`,`id`) ON DELETE CASCADE,
  FOREIGN KEY (`household_id`,`contributor_id`) REFERENCES `contributors`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`recording_id`) REFERENCES `legacy_recordings`(`household_id`,`id`) ON DELETE SET NULL,
  FOREIGN KEY (`household_id`,`consent_id`) REFERENCES `legacy_consents`(`household_id`,`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`household_id`,`reservation_id`) REFERENCES `usage_reservations`(`household_id`,`id`) ON DELETE SET NULL,
  FOREIGN KEY (`household_id`,`provider_spend_reservation_id`) REFERENCES `provider_spend_reservations`(`household_id`,`id`) ON DELETE SET NULL,
  UNIQUE (`household_id`,`job_id`), UNIQUE (`household_id`,`id`)
);--> statement-breakpoint
CREATE TABLE `legacy_export_operations` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `requested_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `request_hash` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL CHECK (`status` IN ('queued','inventory','copying','ready','failed','expired','dead_letter')),
  `snapshot_at` integer NOT NULL, `inventory_stage` text DEFAULT 'recordings' NOT NULL CHECK (`inventory_stage` IN ('recordings','transcripts','photos','metadata','manifest')), `cursor` text, `manifest_key` text, `manifest_checksum` text, `part_count` integer DEFAULT 0 NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL CHECK (`attempts`>=0), `next_attempt_at` integer, `dead_lettered_at` integer, `error_code` text,
  `expires_at` integer NOT NULL, `reauth_challenge_id` text REFERENCES `account_reauth_challenges`(`id`) ON DELETE SET NULL, `reauth_session_id` text, `attempt_token` text, `lease_expires_at` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL,
  UNIQUE (`household_id`,`id`)
);--> statement-breakpoint
CREATE TABLE `legacy_upload_operations` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `requested_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL, `kind` text NOT NULL CHECK (`kind` IN ('consent_evidence','recording','photo')),
  `request_hash` text NOT NULL, `storage_key` text NOT NULL, `checksum` text NOT NULL, `byte_size` integer NOT NULL,
  `status` text DEFAULT 'staged' NOT NULL CHECK (`status` IN ('staged','stored','committed','cleanup_required','deleted')),
  `target_id` text NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL,
  UNIQUE (`household_id`,`id`), UNIQUE (`storage_key`)
);--> statement-breakpoint
CREATE TABLE `legacy_export_parts` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE, `export_id` text NOT NULL,
  `ordinal` integer NOT NULL, `source_kind` text, `source_id` text, `logical_path` text, `content_type` text, `storage_key` text NOT NULL, `checksum` text NOT NULL, `byte_size` integer NOT NULL CHECK (`byte_size` >= 0),
  `status` text DEFAULT 'copying' NOT NULL CHECK (`status` IN ('copying','ready','deleted')), `created_at` integer NOT NULL, `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`export_id`) REFERENCES `legacy_export_operations`(`household_id`,`id`) ON DELETE CASCADE,
  UNIQUE (`export_id`,`ordinal`), UNIQUE (`storage_key`), UNIQUE (`household_id`,`id`)
);--> statement-breakpoint
CREATE TABLE `legacy_export_consents` (`household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,`export_id` text NOT NULL,`consent_id` text NOT NULL,FOREIGN KEY (`household_id`,`export_id`) REFERENCES `legacy_export_operations`(`household_id`,`id`) ON DELETE CASCADE,FOREIGN KEY (`household_id`,`consent_id`) REFERENCES `legacy_consents`(`household_id`,`id`) ON DELETE RESTRICT,PRIMARY KEY (`household_id`,`export_id`,`consent_id`));--> statement-breakpoint
CREATE TABLE `legacy_deletion_operations` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `requested_by_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL, `target_kind` text NOT NULL CHECK (`target_kind` IN ('recording','contributor','archive')),
  `target_id` text NOT NULL, `status` text DEFAULT 'queued' NOT NULL CHECK (`status` IN ('queued','processing','completed','failed','dead_letter')),
  `request_hash` text NOT NULL, `reauth_challenge_id` text REFERENCES `account_reauth_challenges`(`id`) ON DELETE SET NULL, `reauth_session_id` text, `cursor` text, `attempt_token` text, `lease_expires_at` integer, `attempts` integer DEFAULT 0 NOT NULL CHECK (`attempts`>=0), `next_attempt_at` integer, `dead_lettered_at` integer, `error_code` text,
  `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `completed_at` integer,
  UNIQUE (`household_id`,`id`)
);--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_one_active_deletion_target` ON `legacy_deletion_operations` (`household_id`,`target_kind`,`target_id`) WHERE `status`<>'completed';--> statement-breakpoint
CREATE TABLE `legacy_erasure_tombstones` (
  `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `target_kind` text NOT NULL CHECK (`target_kind` IN ('archive','contributor','recording')),
  `target_id` text NOT NULL, `operation_id` text NOT NULL, `completed_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`operation_id`) REFERENCES `legacy_deletion_operations`(`household_id`,`id`) ON DELETE CASCADE,
  PRIMARY KEY (`household_id`,`target_kind`,`target_id`)
);--> statement-breakpoint
CREATE TRIGGER `legacy_deletion_tombstone` AFTER UPDATE OF `status` ON `legacy_deletion_operations`
WHEN NEW.`status`='completed' AND OLD.`status`<>'completed'
BEGIN INSERT OR IGNORE INTO `legacy_erasure_tombstones` (`household_id`,`target_kind`,`target_id`,`operation_id`,`completed_at`) VALUES (NEW.`household_id`,NEW.`target_kind`,NEW.`target_id`,NEW.`id`,NEW.`completed_at`); END;--> statement-breakpoint
CREATE TABLE `legacy_deletion_items` (
  `id` text PRIMARY KEY NOT NULL, `household_id` text NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE, `operation_id` text NOT NULL,
  `object_kind` text NOT NULL CHECK (`object_kind` IN ('recording','photo','consent_evidence','export_part','transcript','upload')),
  `object_id` text NOT NULL, `storage_key` text, `status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending','delete_sent','verified_absent','tombstoned')),
  `attempts` integer DEFAULT 0 NOT NULL, `updated_at` integer NOT NULL,
  FOREIGN KEY (`household_id`,`operation_id`) REFERENCES `legacy_deletion_operations`(`household_id`,`id`) ON DELETE CASCADE,
  UNIQUE (`operation_id`,`object_kind`,`object_id`), UNIQUE (`household_id`,`id`)
);--> statement-breakpoint
CREATE TABLE `legacy_erasure_authorizations` (`id` text PRIMARY KEY NOT NULL,`household_id` text NOT NULL,`operation_kind` text NOT NULL CHECK (`operation_kind` IN ('account','legacy')),`operation_id` text NOT NULL,`active` integer DEFAULT 1 NOT NULL CHECK (`active` IN (0,1)),`created_at` integer NOT NULL,`expires_at` integer NOT NULL,UNIQUE (`operation_kind`,`operation_id`));--> statement-breakpoint
CREATE TRIGGER `legacy_erasure_authorization_validate` BEFORE INSERT ON `legacy_erasure_authorizations` WHEN NOT ((NEW.`operation_kind`='account' AND EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`id`=NEW.`operation_id` AND a.`household_id`=NEW.`household_id` AND a.`status` NOT IN ('completed','canceled'))) OR (NEW.`operation_kind`='legacy' AND EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`id`=NEW.`operation_id` AND d.`household_id`=NEW.`household_id` AND d.`status` IN ('queued','processing')))) BEGIN SELECT RAISE(ABORT,'legacy_erasure_authorization_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_account_erasure_authorize` AFTER INSERT ON `account_deletion_operations` WHEN NEW.`status` NOT IN ('completed','canceled') BEGIN INSERT OR IGNORE INTO `legacy_erasure_authorizations` (`id`,`household_id`,`operation_kind`,`operation_id`,`active`,`created_at`,`expires_at`) VALUES ('account:'||NEW.`id`,NEW.`household_id`,'account',NEW.`id`,1,NEW.`created_at`,NEW.`created_at`+86400000); END;--> statement-breakpoint
CREATE TRIGGER `legacy_operation_erasure_authorize` AFTER INSERT ON `legacy_deletion_operations` WHEN NEW.`status`='queued' BEGIN INSERT OR IGNORE INTO `legacy_erasure_authorizations` (`id`,`household_id`,`operation_kind`,`operation_id`,`active`,`created_at`,`expires_at`) VALUES ('legacy:'||NEW.`id`,NEW.`household_id`,'legacy',NEW.`id`,1,NEW.`created_at`,NEW.`created_at`+86400000); END;--> statement-breakpoint
CREATE TRIGGER `legacy_operation_erasure_close` AFTER UPDATE OF `status` ON `legacy_deletion_operations` WHEN NEW.`status`='completed' BEGIN UPDATE `legacy_erasure_authorizations` SET `active`=0 WHERE `operation_kind`='legacy' AND `operation_id`=NEW.`id`; END;--> statement-breakpoint
CREATE TRIGGER `legacy_account_deletion_custody_preflight` BEFORE INSERT ON `account_deletion_operations` WHEN EXISTS (SELECT 1 FROM `legacy_custodians` c WHERE c.`user_id`=NEW.`user_id` AND c.`role`='primary' AND c.`status`='active' AND c.`household_id`<>NEW.`household_id`) BEGIN SELECT RAISE(ABORT,'legacy_custody_transfer_required'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_audit_delete_guard` BEFORE DELETE ON `legacy_audit_events` WHEN NOT EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`household_id`=OLD.`household_id` AND a.`status`='finalizing') AND NOT EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=OLD.`household_id` AND d.`target_kind`='archive' AND d.`status`='processing') BEGIN SELECT RAISE(ABORT,'legacy_audit_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_upload_delete_guard` BEFORE DELETE ON `legacy_upload_operations` WHEN NOT EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE (a.`household_id`=OLD.`household_id` OR a.`user_id`=OLD.`requested_by_user_id`) AND a.`status`='finalizing') AND NOT EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=OLD.`household_id` AND d.`status`='processing' AND (d.`target_kind`='archive' OR d.`target_id`=OLD.`target_id` OR (d.`target_kind`='contributor' AND (EXISTS (SELECT 1 FROM `legacy_recordings` r WHERE r.`household_id`=OLD.`household_id` AND r.`id`=OLD.`target_id` AND r.`contributor_id`=d.`target_id`) OR EXISTS (SELECT 1 FROM `legacy_consents` c WHERE c.`household_id`=OLD.`household_id` AND c.`id`=OLD.`target_id` AND c.`contributor_id`=d.`target_id`) OR OLD.`requested_by_user_id`=(SELECT n.`adult_user_id` FROM `contributors` n WHERE n.`household_id`=OLD.`household_id` AND n.`id`=d.`target_id`))))) BEGIN SELECT RAISE(ABORT,'legacy_upload_history_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_consent_delete_guard` BEFORE DELETE ON `legacy_consents` WHEN NOT EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE (a.`household_id`=OLD.`household_id` OR a.`user_id`=OLD.`attesting_user_id`) AND a.`status`='finalizing') AND NOT EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=OLD.`household_id` AND d.`status`='processing' AND (d.`target_kind`='archive' OR (d.`target_kind`='contributor' AND d.`target_id`=OLD.`contributor_id`))) BEGIN SELECT RAISE(ABORT,'legacy_consent_history_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_correction_delete_guard` BEFORE DELETE ON `legacy_transcript_corrections` WHEN NOT EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE (a.`household_id`=OLD.`household_id` OR a.`user_id`=OLD.`corrected_by_user_id`) AND a.`status`='finalizing') AND NOT EXISTS (SELECT 1 FROM `legacy_deletion_operations` d JOIN `legacy_transcript_segments` s ON s.`id`=OLD.`segment_id` AND s.`household_id`=OLD.`household_id` WHERE d.`household_id`=OLD.`household_id` AND d.`status`='processing' AND (d.`target_kind`='archive' OR (d.`target_kind`='contributor' AND d.`target_id`=s.`contributor_id`) OR (d.`target_kind`='recording' AND d.`target_id`=s.`recording_id`))) BEGIN SELECT RAISE(ABORT,'legacy_correction_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_query_source_delete_guard` BEFORE DELETE ON `legacy_query_sources` WHEN NOT EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`household_id`=OLD.`household_id` AND a.`status`='finalizing') AND NOT EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=OLD.`household_id` AND d.`status`='processing' AND (d.`target_kind`='archive' OR (d.`target_kind`='recording' AND d.`target_id`=OLD.`recording_id`) OR (d.`target_kind`='contributor' AND (EXISTS (SELECT 1 FROM `legacy_recordings` r WHERE r.`id`=OLD.`recording_id` AND r.`household_id`=OLD.`household_id` AND r.`contributor_id`=d.`target_id`) OR EXISTS (SELECT 1 FROM `legacy_transcript_segments` s WHERE s.`id`=OLD.`segment_id` AND s.`household_id`=OLD.`household_id` AND s.`contributor_id`=d.`target_id`))))) BEGIN SELECT RAISE(ABORT,'legacy_query_source_immutable'); END;--> statement-breakpoint

CREATE TRIGGER `legacy_consents_immutable_scope` BEFORE UPDATE ON `legacy_consents`
WHEN NEW.`household_id`<>OLD.`household_id` OR NEW.`contributor_id`<>OLD.`contributor_id` OR (NEW.`attesting_user_id` IS NOT OLD.`attesting_user_id` AND NOT (OLD.`attesting_user_id` IS NOT NULL AND NEW.`attesting_user_id` IS NULL AND EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`user_id`=OLD.`attesting_user_id` AND a.`status`='finalizing'))) OR NEW.`supersedes_consent_id` IS NOT OLD.`supersedes_consent_id` OR NEW.`version`<>OLD.`version` OR NEW.`kind`<>OLD.`kind` OR NEW.`audience`<>OLD.`audience` OR NEW.`purpose`<>OLD.`purpose` OR NEW.`posthumous_use`<>OLD.`posthumous_use` OR NEW.`evidence_key` IS NOT OLD.`evidence_key` OR NEW.`evidence_checksum` IS NOT OLD.`evidence_checksum` OR NEW.`evidence_media_asset_id`<>OLD.`evidence_media_asset_id` OR NEW.`liveness_challenge_id`<>OLD.`liveness_challenge_id` OR NEW.`media_probe_receipt_id`<>OLD.`media_probe_receipt_id` OR NEW.`attested_at`<>OLD.`attested_at` OR NEW.`expires_at` IS NOT OLD.`expires_at` OR (OLD.`status`<>'active' AND NEW.`status`<>OLD.`status`) OR (NEW.`status`='active' AND OLD.`status`<>'active') OR (NEW.`status`='revoked' AND NEW.`revoked_at` IS NULL) OR (NEW.`status`<>'revoked' AND NEW.`revoked_at` IS NOT OLD.`revoked_at`)
BEGIN SELECT RAISE(ABORT,'legacy_consent_history_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_contributor_cap` BEFORE INSERT ON `contributors`
WHEN (SELECT count(*) FROM `contributors` c WHERE c.`household_id`=NEW.`household_id` AND c.`status` IN ('invited','active','deceased_pending_review')) >= 5
BEGIN SELECT RAISE(ABORT,'legacy_contributor_limit_reached'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_contributor_identity_transition` BEFORE UPDATE ON `contributors`
WHEN NEW.`household_id`<>OLD.`household_id` OR NEW.`invitation_id` IS NOT OLD.`invitation_id` OR (NEW.`adult_user_id` IS NOT OLD.`adult_user_id` AND NOT ((OLD.`status`='invited' AND NEW.`status`='active' AND OLD.`adult_user_id` IS NULL AND NEW.`adult_user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM `household_members` m WHERE m.`household_id`=OLD.`household_id` AND m.`user_id`=NEW.`adult_user_id` AND m.`status`='active' AND m.`role`='contributor') AND EXISTS (SELECT 1 FROM `household_invitations` i WHERE i.`id`=OLD.`invitation_id` AND i.`household_id`=OLD.`household_id` AND i.`role`='contributor' AND i.`status`='accepted' AND i.`accepted_by_user_id`=NEW.`adult_user_id` AND i.`expires_at`>OLD.`created_at`) AND EXISTS (SELECT 1 FROM `legacy_audit_events` e WHERE e.`household_id`=OLD.`household_id` AND e.`actor_user_id`=NEW.`adult_user_id` AND e.`event_type`='contributor_acceptance' AND e.`target_id`=OLD.`id`)) OR (OLD.`adult_user_id` IS NOT NULL AND NEW.`adult_user_id` IS NULL AND (EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`user_id`=OLD.`adult_user_id` AND a.`status`='finalizing') OR EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=OLD.`household_id` AND d.`target_kind`='contributor' AND d.`target_id`=OLD.`id` AND d.`status`='processing')))))
BEGIN SELECT RAISE(ABORT,'legacy_contributor_identity_transition_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_audit_immutable_update` BEFORE UPDATE ON `legacy_audit_events` WHEN NOT (OLD.`actor_user_id` IS NOT NULL AND NEW.`actor_user_id` IS NULL AND OLD.`household_id`=NEW.`household_id` AND OLD.`id`=NEW.`id` AND EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`user_id`=OLD.`actor_user_id` AND a.`status`='finalizing')) BEGIN SELECT RAISE(ABORT,'legacy_audit_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_upload_identity_immutable` BEFORE UPDATE ON `legacy_upload_operations`
WHEN NEW.`household_id`<>OLD.`household_id` OR (NEW.`requested_by_user_id` IS NOT OLD.`requested_by_user_id` AND NOT (OLD.`requested_by_user_id` IS NOT NULL AND NEW.`requested_by_user_id` IS NULL AND EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`user_id`=OLD.`requested_by_user_id` AND a.`status`='finalizing'))) OR NEW.`kind`<>OLD.`kind` OR NEW.`request_hash`<>OLD.`request_hash` OR NEW.`storage_key`<>OLD.`storage_key` OR NEW.`checksum`<>OLD.`checksum` OR NEW.`byte_size`<>OLD.`byte_size` OR NEW.`target_id`<>OLD.`target_id` OR NOT ((OLD.`status`='staged' AND NEW.`status` IN ('stored','cleanup_required','deleted')) OR (OLD.`status`='stored' AND NEW.`status` IN ('committed','cleanup_required','deleted')) OR (OLD.`status`='cleanup_required' AND NEW.`status`='deleted') OR NEW.`status`=OLD.`status`)
BEGIN SELECT RAISE(ABORT,'legacy_upload_transition_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_upload_unresolved_insert` AFTER INSERT ON `legacy_upload_operations`
WHEN NEW.`status` IN ('staged','stored','cleanup_required')
BEGIN UPDATE `legacy_activation_state` SET `unresolved_objects`=`unresolved_objects`+1,`updated_at`=NEW.`created_at` WHERE `id`='archive'; END;--> statement-breakpoint
CREATE TRIGGER `legacy_upload_unresolved_resolve` AFTER UPDATE OF `status` ON `legacy_upload_operations`
WHEN OLD.`status` IN ('staged','stored','cleanup_required') AND NEW.`status` IN ('committed','deleted')
BEGIN UPDATE `legacy_activation_state` SET `unresolved_objects`=max(0,`unresolved_objects`-1),`updated_at`=NEW.`updated_at` WHERE `id`='archive'; END;--> statement-breakpoint
CREATE TRIGGER `legacy_consent_insert_attester_membership` BEFORE INSERT ON `legacy_consents`
WHEN NOT EXISTS (SELECT 1 FROM `household_members` m WHERE m.`household_id`=NEW.`household_id` AND m.`user_id`=NEW.`attesting_user_id` AND m.`status`='active')
BEGIN SELECT RAISE(ABORT,'legacy_cross_household_attester'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_consent_exact_scope_insert` BEFORE INSERT ON `legacy_consents`
WHEN NOT ((NEW.`kind` IN ('recording','transcription') AND NEW.`version`='legacy-consent-v1' AND NEW.`purpose`='private_archive') OR (NEW.`kind`='synthetic' AND NEW.`version`='legacy-synthetic-v1' AND NEW.`purpose`='private_archive_narration'))
BEGIN SELECT RAISE(ABORT,'legacy_consent_scope_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_consent_identity_evidence_insert` BEFORE INSERT ON `legacy_consents`
WHEN NOT EXISTS (SELECT 1 FROM `contributors` c WHERE c.`id`=NEW.`contributor_id` AND c.`household_id`=NEW.`household_id` AND c.`adult_user_id`=NEW.`attesting_user_id` AND c.`status`='active') OR NEW.`evidence_key` IS NULL OR length(COALESCE(NEW.`evidence_checksum`,''))<>64
BEGIN SELECT RAISE(ABORT,'legacy_consent_identity_or_evidence_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_consent_requires_verified_liveness` BEFORE INSERT ON `legacy_consents`
WHEN NOT EXISTS (
  SELECT 1 FROM `legacy_media_probe_receipts` p
  JOIN `legacy_liveness_challenges` l ON l.`id`=p.`challenge_id` AND l.`household_id`=p.`household_id`
  JOIN `media_assets` m ON m.`id`=NEW.`evidence_media_asset_id` AND m.`household_id`=NEW.`household_id`
  JOIN `household_storage_reservations` r ON r.`media_asset_id`=m.`id` AND r.`household_id`=m.`household_id`
  JOIN `task2c_media_integrity` i ON i.`media_asset_id`=m.`id`
  WHERE p.`id`=NEW.`media_probe_receipt_id` AND p.`household_id`=NEW.`household_id`
    AND p.`user_id`=NEW.`attesting_user_id` AND p.`contributor_id`=NEW.`contributor_id`
    AND p.`consent_kind`=NEW.`kind` AND p.`checksum`=NEW.`evidence_checksum`
    AND p.`status`='verified' AND p.`expires_at`>NEW.`attested_at`
    AND l.`id`=NEW.`liveness_challenge_id` AND l.`user_id`=NEW.`attesting_user_id`
    AND l.`contributor_id`=NEW.`contributor_id` AND l.`kind`=NEW.`kind`
    AND l.`status`='issued' AND l.`expires_at`>NEW.`attested_at`
    AND m.`storage_key`=NEW.`evidence_key` AND m.`kind`='evidence' AND m.`status`='ready' AND m.`private`=1
    AND m.`checksum`=NEW.`evidence_checksum` AND m.`byte_size`=p.`byte_size`
    AND r.`status`='committed' AND r.`byte_size`=m.`byte_size`
    AND i.`byte_size`=m.`byte_size` AND i.`checksum`=m.`checksum`
)
BEGIN SELECT RAISE(ABORT,'legacy_consent_verified_liveness_required'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_media_probe_consume` AFTER INSERT ON `legacy_consents`
BEGIN
  UPDATE `legacy_media_probe_receipts` SET `status`='consumed',`consumed_at`=NEW.`attested_at` WHERE `id`=NEW.`media_probe_receipt_id` AND `household_id`=NEW.`household_id` AND `status`='verified';
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'legacy_media_probe_replay') END;
  UPDATE `legacy_liveness_challenges` SET `status`='consumed',`phrase`='consumed phrase',`consumed_at`=NEW.`attested_at` WHERE `id`=NEW.`liveness_challenge_id` AND `household_id`=NEW.`household_id` AND `status`='issued';
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'legacy_liveness_replay') END;
END;--> statement-breakpoint
CREATE TRIGGER `legacy_consent_supersession_scope_insert` BEFORE INSERT ON `legacy_consents`
WHEN NEW.`supersedes_consent_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `legacy_consents` c WHERE c.`id`=NEW.`supersedes_consent_id` AND c.`household_id`=NEW.`household_id` AND c.`contributor_id`=NEW.`contributor_id` AND c.`kind`=NEW.`kind` AND c.`status`='active')
BEGIN SELECT RAISE(ABORT,'legacy_consent_supersession_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_consent_active_unique_insert` BEFORE INSERT ON `legacy_consents`
WHEN NEW.`status`='active' AND NEW.`supersedes_consent_id` IS NULL AND EXISTS (SELECT 1 FROM `legacy_consents` c WHERE c.`household_id`=NEW.`household_id` AND c.`contributor_id`=NEW.`contributor_id` AND c.`kind`=NEW.`kind` AND c.`status`='active')
BEGIN SELECT RAISE(ABORT,'legacy_active_consent_exists'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_consent_supersede_previous` AFTER INSERT ON `legacy_consents`
WHEN NEW.`status`='active' AND NEW.`supersedes_consent_id` IS NOT NULL
BEGIN UPDATE `legacy_consents` SET `status`='superseded' WHERE `id`=NEW.`supersedes_consent_id` AND `status`='active'; END;--> statement-breakpoint
CREATE TRIGGER `legacy_synthetic_consent_scope` BEFORE INSERT ON `legacy_consents`
WHEN NEW.`kind`='synthetic' AND (NEW.`version`<>'legacy-synthetic-v1' OR NEW.`purpose`<>'private_archive_narration' OR NEW.`posthumous_use`<>0)
BEGIN SELECT RAISE(ABORT,'posthumous_synthesis_disabled'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_consent_revocation_fence` AFTER UPDATE OF `status` ON `legacy_consents`
WHEN OLD.`status`='active' AND NEW.`status` IN ('revoked','expired','superseded')
BEGIN
  UPDATE `jobs` SET `status`='canceled',`error_code`='legacy_consent_inactive',`completed_at`=unixepoch('subsec')*1000,`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `status` IN ('queued','running') AND `id` IN (SELECT `job_id` FROM `legacy_job_bindings` WHERE `consent_id`=NEW.`id` AND `status`='active');
  UPDATE `usage_reservations` SET `status`='released',`finalized_at`=unixepoch('subsec')*1000,`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `status`='reserved' AND `id` IN (SELECT `reservation_id` FROM `legacy_job_bindings` WHERE `consent_id`=NEW.`id` AND `status`='active');
  UPDATE `provider_spend_reservations` SET `status`=CASE WHEN `status`='charge_committed' THEN 'settled' ELSE 'released' END,`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `id` IN (SELECT `provider_spend_reservation_id` FROM `legacy_job_bindings` WHERE `consent_id`=NEW.`id` AND `status`='active') AND `status` IN ('in_flight','charge_committed');
  UPDATE `legacy_export_operations` SET `status`='expired',`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `status` IN ('queued','inventory','copying','ready','failed','dead_letter');
  UPDATE `legacy_evidence_retention` SET `status`='cleanup_required',`delete_after`=unixepoch('subsec')*1000,`next_attempt_at`=NULL,`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `consent_id`=NEW.`id` AND `status` IN ('retained','dead_letter');
  UPDATE `legacy_job_bindings` SET `status`='fenced',`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `consent_id`=NEW.`id` AND `status`='active';
END;--> statement-breakpoint
CREATE TRIGGER `legacy_job_publish_consent_fence` BEFORE UPDATE OF `status` ON `legacy_job_bindings`
WHEN NEW.`status`='published' AND (OLD.`status`<>'active' OR NOT EXISTS (SELECT 1 FROM `legacy_consents` c JOIN `contributors` r ON r.`id`=c.`contributor_id` AND r.`household_id`=c.`household_id` JOIN `jobs` j ON j.`id`=OLD.`job_id` AND j.`household_id`=OLD.`household_id` LEFT JOIN `usage_reservations` u ON u.`id`=OLD.`reservation_id` AND u.`household_id`=OLD.`household_id` LEFT JOIN `provider_spend_reservations` p ON p.`id`=OLD.`provider_spend_reservation_id` AND p.`household_id`=OLD.`household_id` WHERE c.`id`=OLD.`consent_id` AND c.`household_id`=OLD.`household_id` AND c.`status`='active' AND (c.`expires_at` IS NULL OR c.`expires_at`>unixepoch('subsec')*1000) AND r.`status`='active' AND j.`status`='succeeded' AND (OLD.`reservation_id` IS NULL OR u.`status`='committed') AND (OLD.`provider_spend_reservation_id` IS NULL OR p.`status`='settled')))
BEGIN SELECT RAISE(ABORT,'legacy_consent_inactive'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_job_binding_scope_insert` BEFORE INSERT ON `legacy_job_bindings`
WHEN NOT EXISTS (SELECT 1 FROM `jobs` j JOIN `legacy_consents` c ON c.`id`=NEW.`consent_id` AND c.`household_id`=NEW.`household_id` JOIN `contributors` r ON r.`id`=NEW.`contributor_id` AND r.`household_id`=NEW.`household_id` LEFT JOIN `usage_reservations` u ON u.`id`=NEW.`reservation_id` AND u.`household_id`=NEW.`household_id` LEFT JOIN `provider_spend_reservations` p ON p.`id`=NEW.`provider_spend_reservation_id` AND p.`household_id`=NEW.`household_id` WHERE j.`id`=NEW.`job_id` AND j.`household_id`=NEW.`household_id` AND j.`status` IN ('queued','running') AND c.`contributor_id`=NEW.`contributor_id` AND c.`status`='active' AND (c.`expires_at` IS NULL OR c.`expires_at`>unixepoch('subsec')*1000) AND r.`status`='active' AND ((NEW.`operation`='transcription' AND c.`kind`='transcription' AND j.`type`='archive_transcription' AND u.`status`='reserved' AND p.`provider`='elevenlabs' AND p.`operation`='archive_transcription' AND p.`status`='in_flight') OR (NEW.`operation`='synthetic_narration' AND c.`kind`='synthetic' AND j.`type`='legacy_synthetic_narration' AND u.`status`='reserved' AND p.`provider`='elevenlabs' AND p.`operation`='legacy_synthetic_narration' AND p.`status`='in_flight') OR (NEW.`operation`='export' AND c.`kind`='recording' AND j.`type`='media_export' AND NEW.`provider_spend_reservation_id` IS NULL)))
BEGIN SELECT RAISE(ABORT,'legacy_job_binding_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_recording_ready_requires_active_consent` BEFORE UPDATE OF `status` ON `legacy_recordings`
WHEN NEW.`status`='ready' AND NOT EXISTS (SELECT 1 FROM `legacy_consents` c WHERE c.`id`=NEW.`consent_id` AND c.`household_id`=NEW.`household_id` AND c.`contributor_id`=NEW.`contributor_id` AND c.`kind`='recording' AND c.`version`='legacy-consent-v1' AND c.`audience`='household' AND c.`purpose`='private_archive' AND c.`status`='active' AND c.`attested_at`<=NEW.`recorded_at` AND (c.`expires_at` IS NULL OR c.`expires_at`>NEW.`recorded_at`))
BEGIN SELECT RAISE(ABORT,'legacy_consent_inactive'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_recording_ready_media_required` BEFORE UPDATE OF `status` ON `legacy_recordings`
WHEN NEW.`status`='ready' AND NOT EXISTS (SELECT 1 FROM `media_assets` m WHERE m.`id`=NEW.`media_asset_id` AND m.`household_id`=NEW.`household_id` AND m.`kind`='recording' AND m.`status`='ready' AND m.`private`=1 AND m.`byte_size`>0 AND length(m.`checksum`)=64)
BEGIN SELECT RAISE(ABORT,'legacy_recording_ready_media_required'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_recording_ready_insert_fence` BEFORE INSERT ON `legacy_recordings`
WHEN NEW.`status`='ready'
BEGIN SELECT RAISE(ABORT,'legacy_recording_ready_requires_finalize'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_transcript_ready_insert_fence` BEFORE INSERT ON `legacy_transcripts`
WHEN NEW.`status`='ready'
BEGIN SELECT RAISE(ABORT,'legacy_transcript_ready_requires_finalize'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_transcript_ready_source_update` BEFORE UPDATE OF `status` ON `legacy_transcripts`
WHEN NEW.`status`='ready' AND NOT EXISTS (SELECT 1 FROM `legacy_recordings` r JOIN `legacy_consents` c ON c.`id`=NEW.`consent_id` AND c.`household_id`=r.`household_id` JOIN `legacy_job_bindings` b ON b.`id`=NEW.`job_binding_id` AND b.`household_id`=r.`household_id` WHERE r.`id`=NEW.`recording_id` AND r.`household_id`=NEW.`household_id` AND r.`status`='ready' AND c.`contributor_id`=r.`contributor_id` AND c.`kind`='transcription' AND c.`status`='active' AND (c.`expires_at` IS NULL OR c.`expires_at`>NEW.`created_at`) AND b.`recording_id`=r.`id` AND b.`contributor_id`=r.`contributor_id` AND b.`consent_id`=c.`id` AND b.`operation`='transcription' AND b.`status`='published')
BEGIN SELECT RAISE(ABORT,'legacy_transcript_source_not_ready'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_transcript_provenance_immutable` BEFORE UPDATE ON `legacy_transcripts` WHEN NEW.`household_id`<>OLD.`household_id` OR NEW.`recording_id`<>OLD.`recording_id` OR NEW.`consent_id`<>OLD.`consent_id` OR NEW.`job_binding_id`<>OLD.`job_binding_id` OR NEW.`provider_request_id` IS NOT OLD.`provider_request_id` OR NEW.`language`<>OLD.`language` BEGIN SELECT RAISE(ABORT,'legacy_transcript_provenance_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_segment_ready_source_required` BEFORE INSERT ON `legacy_transcript_segments`
WHEN NEW.`status`='ready' AND NOT EXISTS (SELECT 1 FROM `legacy_recordings` r JOIN `legacy_transcripts` t ON t.`recording_id`=r.`id` AND t.`household_id`=r.`household_id` WHERE r.`id`=NEW.`recording_id` AND r.`household_id`=NEW.`household_id` AND r.`contributor_id`=NEW.`contributor_id` AND r.`status`='ready' AND NEW.`end_ms`<=r.`duration_ms` AND t.`id`=NEW.`transcript_id` AND t.`status`='ready')
BEGIN SELECT RAISE(ABORT,'legacy_segment_source_not_ready'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_custodian_no_self_appointment` BEFORE INSERT ON `legacy_custodians`
WHEN NOT ((NEW.`role`='primary' AND NEW.`status`='active' AND NEW.`user_id`=NEW.`appointed_by_user_id` AND EXISTS (SELECT 1 FROM `households` h WHERE h.`id`=NEW.`household_id` AND h.`owner_user_id`=NEW.`user_id`) AND NOT EXISTS (SELECT 1 FROM `legacy_custodians` c WHERE c.`household_id`=NEW.`household_id`)) OR (NEW.`role`='successor' AND NEW.`status`='pending' AND NEW.`user_id`<>NEW.`appointed_by_user_id` AND EXISTS (SELECT 1 FROM `legacy_custodians` c WHERE c.`household_id`=NEW.`household_id` AND c.`user_id`=NEW.`appointed_by_user_id` AND c.`role`='primary' AND c.`status`='active') AND EXISTS (SELECT 1 FROM `household_members` m WHERE m.`household_id`=NEW.`household_id` AND m.`user_id`=NEW.`user_id` AND m.`status`='active')))
BEGIN SELECT RAISE(ABORT,'legacy_custodian_appointment_unauthorized'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_custodian_identity_immutable` BEFORE UPDATE ON `legacy_custodians`
WHEN NEW.`household_id`<>OLD.`household_id` OR (NEW.`user_id` IS NOT OLD.`user_id` AND NOT (OLD.`user_id` IS NOT NULL AND NEW.`user_id` IS NULL AND EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`user_id`=OLD.`user_id` AND a.`status`='finalizing'))) OR (NEW.`appointed_by_user_id` IS NOT OLD.`appointed_by_user_id` AND NOT (OLD.`appointed_by_user_id` IS NOT NULL AND NEW.`appointed_by_user_id` IS NULL AND EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`user_id`=OLD.`appointed_by_user_id` AND a.`status`='finalizing'))) OR (OLD.`status`<>'pending' AND NEW.`role`<>OLD.`role` AND NOT EXISTS (SELECT 1 FROM `legacy_custodian_transfers` t WHERE t.`household_id`=OLD.`household_id` AND t.`to_custodian_id`=OLD.`id` AND t.`status`='requested')) OR (OLD.`status`='revoked' AND NEW.`status`<>OLD.`status`) OR (OLD.`status`='pending' AND NEW.`status`='active' AND (NEW.`accepted_at` IS NULL OR NOT EXISTS (SELECT 1 FROM `legacy_custodian_acceptances` a WHERE a.`household_id`=OLD.`household_id` AND a.`custodian_id`=OLD.`id` AND a.`user_id`=OLD.`user_id` AND a.`created_at`=NEW.`accepted_at`)))
BEGIN SELECT RAISE(ABORT,'legacy_custodian_transition_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_custodian_transfer_authorize` BEFORE INSERT ON `legacy_custodian_transfers`
WHEN NOT EXISTS (SELECT 1 FROM `legacy_custodians` f JOIN `legacy_custodians` t ON t.`id`=NEW.`to_custodian_id` AND t.`household_id`=f.`household_id` WHERE f.`id`=NEW.`from_custodian_id` AND f.`household_id`=NEW.`household_id` AND f.`role`='primary' AND f.`status`='active' AND f.`user_id`=NEW.`requested_by_user_id` AND t.`role`='successor' AND t.`status`='active' AND t.`accepted_at` IS NOT NULL) OR NOT EXISTS (SELECT 1 FROM `account_reauth_challenges` a WHERE a.`id`=NEW.`reauth_challenge_id` AND a.`user_id`=NEW.`requested_by_user_id` AND a.`status`='verified' AND a.`verified_session_id`=NEW.`reauth_session_id` AND a.`expires_at`>NEW.`created_at`)
BEGIN SELECT RAISE(ABORT,'legacy_custodian_transfer_unauthorized'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_custodian_transfer_apply` AFTER INSERT ON `legacy_custodian_transfers`
WHEN NEW.`status`='requested'
BEGIN
  UPDATE `legacy_custodians` SET `status`='revoked',`updated_at`=NEW.`created_at` WHERE `id`=NEW.`from_custodian_id` AND `role`='primary' AND `status`='active';
  UPDATE `legacy_custodians` SET `role`='primary',`updated_at`=NEW.`created_at` WHERE `id`=NEW.`to_custodian_id` AND `role`='successor' AND `status`='active';
  UPDATE `legacy_custodian_transfers` SET `status`='completed',`completed_at`=NEW.`created_at` WHERE `id`=NEW.`id` AND `status`='requested';
  UPDATE `account_reauth_challenges` SET `status`='consumed',`consumed_at`=NEW.`created_at` WHERE `id`=NEW.`reauth_challenge_id` AND `status`='verified' AND `verified_session_id`=NEW.`reauth_session_id`;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'fresh_reauthentication_required') END;
END;--> statement-breakpoint
CREATE TRIGGER `legacy_custodian_accept_authorize` BEFORE INSERT ON `legacy_custodian_acceptances` WHEN NOT EXISTS (SELECT 1 FROM `legacy_custodians` c JOIN `account_reauth_challenges` a ON a.`id`=NEW.`reauth_challenge_id` WHERE c.`id`=NEW.`custodian_id` AND c.`household_id`=NEW.`household_id` AND c.`user_id`=NEW.`user_id` AND c.`role`='successor' AND c.`status`='pending' AND a.`user_id`=NEW.`user_id` AND a.`status`='verified' AND a.`verified_session_id`=NEW.`reauth_session_id` AND a.`expires_at`>NEW.`created_at`) BEGIN SELECT RAISE(ABORT,'legacy_custodian_acceptance_unauthorized'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_custodian_accept_apply` AFTER INSERT ON `legacy_custodian_acceptances` BEGIN UPDATE `legacy_custodians` SET `status`='active',`accepted_at`=NEW.`created_at`,`updated_at`=NEW.`created_at` WHERE `id`=NEW.`custodian_id` AND `household_id`=NEW.`household_id` AND `status`='pending'; UPDATE `account_reauth_challenges` SET `status`='consumed',`consumed_at`=NEW.`created_at` WHERE `id`=NEW.`reauth_challenge_id` AND `status`='verified' AND `verified_session_id`=NEW.`reauth_session_id`; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'fresh_reauthentication_required') END; END;--> statement-breakpoint
CREATE TRIGGER `legacy_export_one_use_reauth` BEFORE INSERT ON `legacy_export_operations` WHEN NOT EXISTS (SELECT 1 FROM `account_reauth_challenges` a WHERE a.`id`=NEW.`reauth_challenge_id` AND a.`user_id`=NEW.`requested_by_user_id` AND a.`status`='verified' AND a.`verified_session_id`=NEW.`reauth_session_id` AND a.`expires_at`>NEW.`created_at`) BEGIN SELECT RAISE(ABORT,'fresh_reauthentication_required'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_export_consume_reauth` AFTER INSERT ON `legacy_export_operations` BEGIN UPDATE `account_reauth_challenges` SET `status`='consumed',`consumed_at`=NEW.`created_at` WHERE `id`=NEW.`reauth_challenge_id` AND `status`='verified' AND `verified_session_id`=NEW.`reauth_session_id`; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'fresh_reauthentication_required') END; END;--> statement-breakpoint
CREATE TRIGGER `legacy_deletion_one_use_reauth` BEFORE INSERT ON `legacy_deletion_operations` WHEN NOT EXISTS (SELECT 1 FROM `account_reauth_challenges` a WHERE a.`id`=NEW.`reauth_challenge_id` AND a.`user_id`=NEW.`requested_by_user_id` AND a.`status`='verified' AND a.`verified_session_id`=NEW.`reauth_session_id` AND a.`expires_at`>NEW.`created_at`) BEGIN SELECT RAISE(ABORT,'fresh_reauthentication_required'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_deletion_consume_reauth` AFTER INSERT ON `legacy_deletion_operations` BEGIN UPDATE `account_reauth_challenges` SET `status`='consumed',`consumed_at`=NEW.`created_at` WHERE `id`=NEW.`reauth_challenge_id` AND `status`='verified' AND `verified_session_id`=NEW.`reauth_session_id`; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'fresh_reauthentication_required') END; END;--> statement-breakpoint
CREATE TRIGGER `legacy_deceased_synthesis_fence` AFTER UPDATE OF `status` ON `contributors`
WHEN NEW.`status`='deceased_pending_review' AND OLD.`status`<>NEW.`status`
BEGIN
  UPDATE `jobs` SET `status`='canceled',`error_code`='deceased_review_required',`completed_at`=unixepoch('subsec')*1000,`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `status` IN ('queued','running') AND `id` IN (SELECT `job_id` FROM `legacy_job_bindings` WHERE `contributor_id`=NEW.`id` AND `operation`='synthetic_narration' AND `status`='active');
  UPDATE `usage_reservations` SET `status`='released',`finalized_at`=unixepoch('subsec')*1000,`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `status`='reserved' AND `id` IN (SELECT `reservation_id` FROM `legacy_job_bindings` WHERE `contributor_id`=NEW.`id` AND `operation`='synthetic_narration' AND `status`='active');
  UPDATE `provider_spend_reservations` SET `status`=CASE WHEN `status`='charge_committed' THEN 'settled' ELSE 'released' END,`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `id` IN (SELECT `provider_spend_reservation_id` FROM `legacy_job_bindings` WHERE `contributor_id`=NEW.`id` AND `operation`='synthetic_narration' AND `status`='active') AND `status` IN ('in_flight','charge_committed');
  UPDATE `legacy_job_bindings` SET `status`='fenced',`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `contributor_id`=NEW.`id` AND `operation`='synthetic_narration' AND `status`='active';
END;--> statement-breakpoint
CREATE TRIGGER `legacy_contributor_revocation_fence` AFTER UPDATE OF `status` ON `contributors`
WHEN NEW.`status`='revoked' AND OLD.`status`<>NEW.`status`
BEGIN
  UPDATE `legacy_consents` SET `status`='revoked',`revoked_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `contributor_id`=NEW.`id` AND `status`='active';
  UPDATE `jobs` SET `status`='canceled',`error_code`='legacy_contributor_revoked',`completed_at`=unixepoch('subsec')*1000,`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `status` IN ('queued','running') AND `id` IN (SELECT `job_id` FROM `legacy_job_bindings` WHERE `contributor_id`=NEW.`id` AND `status`='active');
  UPDATE `usage_reservations` SET `status`='released',`finalized_at`=unixepoch('subsec')*1000,`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `status`='reserved' AND `id` IN (SELECT `reservation_id` FROM `legacy_job_bindings` WHERE `contributor_id`=NEW.`id` AND `status`='active');
  UPDATE `provider_spend_reservations` SET `status`=CASE WHEN `status`='charge_committed' THEN 'settled' ELSE 'released' END,`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `id` IN (SELECT `provider_spend_reservation_id` FROM `legacy_job_bindings` WHERE `contributor_id`=NEW.`id` AND `status`='active') AND `status` IN ('in_flight','charge_committed');
  UPDATE `legacy_job_bindings` SET `status`='fenced',`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `contributor_id`=NEW.`id` AND `status`='active';
  UPDATE `legacy_export_operations` SET `status`='expired',`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `status` IN ('queued','inventory','copying','ready');
  UPDATE `legacy_recordings` SET `status`='delete_pending',`updated_at`=unixepoch('subsec')*1000 WHERE `household_id`=NEW.`household_id` AND `contributor_id`=NEW.`id` AND `status` IN ('processing','ready','failed');
END;--> statement-breakpoint
CREATE TRIGGER `legacy_memory_contributor_source_match` BEFORE INSERT ON `legacy_memories`
WHEN NOT EXISTS (SELECT 1 FROM `legacy_transcript_segments` s WHERE s.`id`=NEW.`source_segment_id` AND s.`household_id`=NEW.`household_id` AND s.`contributor_id`=NEW.`contributor_id` AND s.`status`='ready')
BEGIN SELECT RAISE(ABORT,'legacy_cross_household_memory_source'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_query_source_match` BEFORE INSERT ON `legacy_query_sources`
WHEN NOT EXISTS (
  SELECT 1 FROM `legacy_transcript_segments` s
  JOIN `legacy_transcripts` t ON t.`id`=s.`transcript_id` AND t.`household_id`=s.`household_id`
  JOIN `legacy_recordings` r ON r.`id`=s.`recording_id` AND r.`household_id`=s.`household_id`
  JOIN `media_assets` m ON m.`id`=r.`media_asset_id` AND m.`household_id`=r.`household_id`
  JOIN `contributors` n ON n.`id`=s.`contributor_id` AND n.`household_id`=s.`household_id`
  JOIN `legacy_consents` c ON c.`id`=r.`consent_id` AND c.`household_id`=r.`household_id`
  JOIN `legacy_consents` tc ON tc.`id`=t.`consent_id` AND tc.`household_id`=t.`household_id`
  WHERE s.`id`=NEW.`segment_id` AND s.`transcript_id`=NEW.`transcript_id` AND s.`recording_id`=NEW.`recording_id` AND s.`household_id`=NEW.`household_id`
    AND (NEW.`correction_id` IS NULL OR EXISTS (SELECT 1 FROM `legacy_transcript_corrections` x WHERE x.`id`=NEW.`correction_id` AND x.`household_id`=NEW.`household_id` AND x.`segment_id`=NEW.`segment_id`))
    AND s.`status`='ready' AND t.`status`='ready' AND r.`status`='ready' AND m.`status`='ready' AND m.`private`=1
    AND n.`status` IN ('active','deceased_pending_review')
    AND c.`kind`='recording' AND c.`status`='active' AND (c.`expires_at` IS NULL OR c.`expires_at`>unixepoch('subsec')*1000)
    AND tc.`kind`='transcription' AND tc.`status`='active' AND (tc.`expires_at` IS NULL OR tc.`expires_at`>unixepoch('subsec')*1000)
    AND EXISTS (SELECT 1 FROM `legacy_consents` sc WHERE sc.`household_id`=s.`household_id` AND sc.`contributor_id`=s.`contributor_id` AND sc.`kind`='transcription' AND sc.`status`='active' AND (sc.`expires_at` IS NULL OR sc.`expires_at`>unixepoch('subsec')*1000))
    AND NOT EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`status` IN ('queued','processing','failed','dead_letter') AND (d.`target_kind`='archive' OR (d.`target_kind`='contributor' AND d.`target_id`=s.`contributor_id`) OR (d.`target_kind`='recording' AND d.`target_id`=r.`id`)))
    AND NOT EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`household_id`=NEW.`household_id` AND a.`status` NOT IN ('completed','canceled'))
)
BEGIN SELECT RAISE(ABORT,'legacy_query_source_not_ready'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_query_receipt_supported_sources` BEFORE UPDATE ON `legacy_query_receipts`
WHEN NEW.`supported`=1 AND NOT EXISTS (SELECT 1 FROM `legacy_query_sources` q WHERE q.`query_receipt_id`=NEW.`id` AND q.`household_id`=NEW.`household_id`)
BEGIN SELECT RAISE(ABORT,'legacy_query_source_required'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_query_receipt_insert_unfinalized` BEFORE INSERT ON `legacy_query_receipts`
WHEN (NEW.`supported`=0 AND (NEW.`answer_kind`<>'no_evidence' OR NEW.`status`<>'ready' OR NEW.`selected_segment_id` IS NOT NULL OR NEW.`selected_transcript_id` IS NOT NULL OR NEW.`selected_recording_id` IS NOT NULL)) OR (NEW.`supported`=1 AND (NEW.`answer_kind`<>'original_recording' OR NEW.`status`<>'building' OR NEW.`selected_segment_id` IS NULL OR NEW.`selected_transcript_id` IS NULL OR NEW.`selected_recording_id` IS NULL OR NEW.`selected_score_micros` NOT BETWEEN 720000 AND 1000000))
BEGIN SELECT RAISE(ABORT,'legacy_query_receipt_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_query_receipt_consistency` BEFORE UPDATE ON `legacy_query_receipts`
WHEN NEW.`household_id`<>OLD.`household_id` OR (NEW.`requested_by_user_id` IS NOT OLD.`requested_by_user_id` AND NOT (OLD.`requested_by_user_id` IS NOT NULL AND NEW.`requested_by_user_id` IS NULL AND EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`user_id`=OLD.`requested_by_user_id` AND a.`status`='finalizing'))) OR NEW.`question_hash`<>OLD.`question_hash` OR NEW.`supported`<>OLD.`supported` OR NEW.`answer_kind`<>OLD.`answer_kind` OR NEW.`answer_text`<>OLD.`answer_text` OR NEW.`answer_checksum`<>OLD.`answer_checksum` OR NEW.`selected_segment_id` IS NOT OLD.`selected_segment_id` OR NEW.`selected_transcript_id` IS NOT OLD.`selected_transcript_id` OR NEW.`selected_correction_id` IS NOT OLD.`selected_correction_id` OR NEW.`selected_recording_id` IS NOT OLD.`selected_recording_id` OR NEW.`selected_score_micros` IS NOT OLD.`selected_score_micros` OR NEW.`created_at`<>OLD.`created_at` OR NOT ((OLD.`status`='building' AND NEW.`status`='ready' AND NEW.`completed_at` IS NOT NULL) OR (NEW.`status`=OLD.`status` AND NEW.`completed_at` IS OLD.`completed_at`))
BEGIN SELECT RAISE(ABORT,'legacy_query_receipt_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_query_source_immutable_update` BEFORE UPDATE ON `legacy_query_sources` BEGIN SELECT RAISE(ABORT,'legacy_query_source_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_segment_provenance_immutable` BEFORE UPDATE ON `legacy_transcript_segments`
WHEN NEW.`household_id`<>OLD.`household_id` OR NEW.`transcript_id`<>OLD.`transcript_id` OR NEW.`recording_id`<>OLD.`recording_id` OR (NEW.`contributor_id`<>OLD.`contributor_id` AND NOT EXISTS (SELECT 1 FROM `legacy_transcript_corrections` c WHERE c.`household_id`=OLD.`household_id` AND c.`segment_id`=OLD.`id` AND c.`speaker_contributor_id`=NEW.`contributor_id` AND c.`corrected_text`=NEW.`effective_text`)) OR NEW.`ordinal`<>OLD.`ordinal` OR NEW.`start_ms`<>OLD.`start_ms` OR NEW.`end_ms`<>OLD.`end_ms` OR NEW.`original_text`<>OLD.`original_text` OR NEW.`provenance`<>OLD.`provenance`
BEGIN SELECT RAISE(ABORT,'legacy_segment_provenance_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_recording_provenance_immutable` BEFORE UPDATE ON `legacy_recordings`
WHEN NEW.`household_id`<>OLD.`household_id` OR NEW.`interview_id` IS NOT OLD.`interview_id` OR NEW.`contributor_id`<>OLD.`contributor_id` OR NEW.`consent_id`<>OLD.`consent_id` OR NEW.`media_asset_id`<>OLD.`media_asset_id` OR NEW.`recorded_at`<>OLD.`recorded_at` OR NEW.`duration_ms`<>OLD.`duration_ms`
BEGIN SELECT RAISE(ABORT,'legacy_recording_provenance_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_recording_lifecycle_monotonic` BEFORE UPDATE OF `status` ON `legacy_recordings`
WHEN OLD.`status` IN ('delete_pending','deleted') AND NEW.`status`<>OLD.`status` AND NOT (OLD.`status`='delete_pending' AND NEW.`status`='deleted')
BEGIN SELECT RAISE(ABORT,'legacy_recording_lifecycle_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_transcript_lifecycle_monotonic` BEFORE UPDATE OF `status` ON `legacy_transcripts`
WHEN OLD.`status`='deleted' AND NEW.`status`<>OLD.`status`
BEGIN SELECT RAISE(ABORT,'legacy_transcript_lifecycle_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_segment_lifecycle_monotonic` BEFORE UPDATE OF `status` ON `legacy_transcript_segments`
WHEN OLD.`status` IN ('superseded','deleted') AND NEW.`status`<>OLD.`status`
BEGIN SELECT RAISE(ABORT,'legacy_segment_lifecycle_invalid'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_segment_effective_text_guard` BEFORE UPDATE OF `effective_text` ON `legacy_transcript_segments`
WHEN NEW.`effective_text`<>OLD.`effective_text` AND NOT EXISTS (SELECT 1 FROM `legacy_transcript_corrections` c WHERE c.`household_id`=OLD.`household_id` AND c.`segment_id`=OLD.`id` AND c.`corrected_text`=NEW.`effective_text` AND c.`id`=(SELECT x.`id` FROM `legacy_transcript_corrections` x WHERE x.`household_id`=OLD.`household_id` AND x.`segment_id`=OLD.`id` ORDER BY x.`created_at` DESC,x.`id` DESC LIMIT 1))
BEGIN SELECT RAISE(ABORT,'legacy_correction_required'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_correction_actor_authorized` BEFORE INSERT ON `legacy_transcript_corrections`
WHEN NOT EXISTS (SELECT 1 FROM `household_members` m JOIN `legacy_transcript_segments` s ON s.`id`=NEW.`segment_id` AND s.`household_id`=NEW.`household_id` JOIN `legacy_transcripts` t ON t.`id`=s.`transcript_id` AND t.`household_id`=s.`household_id` JOIN `legacy_recordings` r ON r.`id`=s.`recording_id` AND r.`household_id`=s.`household_id` JOIN `contributors` c ON c.`id`=NEW.`speaker_contributor_id` AND c.`household_id`=NEW.`household_id` WHERE m.`household_id`=NEW.`household_id` AND m.`user_id`=NEW.`corrected_by_user_id` AND m.`status`='active' AND m.`role` IN ('owner','adult_manager') AND s.`status`='ready' AND t.`status`='ready' AND r.`status`='ready' AND c.`status` IN ('active','deceased_pending_review') AND EXISTS (SELECT 1 FROM `legacy_consents` sc WHERE sc.`household_id`=NEW.`household_id` AND sc.`contributor_id`=NEW.`speaker_contributor_id` AND sc.`kind`='transcription' AND sc.`status`='active' AND (sc.`expires_at` IS NULL OR sc.`expires_at`>NEW.`created_at`)) AND NOT EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`status` IN ('queued','processing','failed','dead_letter') AND (d.`target_kind`='archive' OR (d.`target_kind`='contributor' AND d.`target_id`=r.`contributor_id`) OR (d.`target_kind`='recording' AND d.`target_id`=r.`id`))))
BEGIN SELECT RAISE(ABORT,'legacy_correction_unauthorized'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_correction_apply` AFTER INSERT ON `legacy_transcript_corrections`
BEGIN UPDATE `legacy_transcript_segments` SET `effective_text`=NEW.`corrected_text`,`contributor_id`=NEW.`speaker_contributor_id`,`updated_at`=NEW.`created_at` WHERE `id`=NEW.`segment_id` AND `household_id`=NEW.`household_id` AND `status`='ready'; END;--> statement-breakpoint
CREATE TRIGGER `legacy_correction_immutable_update` BEFORE UPDATE ON `legacy_transcript_corrections` WHEN NOT (OLD.`corrected_by_user_id` IS NOT NULL AND NEW.`corrected_by_user_id` IS NULL AND OLD.`household_id`=NEW.`household_id` AND OLD.`id`=NEW.`id` AND EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`user_id`=OLD.`corrected_by_user_id` AND a.`status`='finalizing')) BEGIN SELECT RAISE(ABORT,'legacy_correction_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_archive_quiescence_recording` BEFORE INSERT ON `legacy_recordings`
WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`status` IN ('queued','processing','failed','dead_letter') AND (d.`target_kind`='archive' OR (d.`target_kind`='contributor' AND d.`target_id`=NEW.`contributor_id`) OR (d.`target_kind`='recording' AND d.`target_id`=NEW.`id`))) OR EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`household_id`=NEW.`household_id` AND a.`status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT,'legacy_archive_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_archive_quiescence_consent` BEFORE INSERT ON `legacy_consents`
WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`status` IN ('queued','processing','failed','dead_letter') AND (d.`target_kind`='archive' OR (d.`target_kind`='contributor' AND d.`target_id`=NEW.`contributor_id`))) OR EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`household_id`=NEW.`household_id` AND a.`status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT,'legacy_archive_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_archive_quiescence_upload` BEFORE INSERT ON `legacy_upload_operations`
WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`status` IN ('queued','processing','failed','dead_letter') AND (d.`target_kind`='archive' OR d.`target_id`=NEW.`target_id` OR (d.`target_kind`='contributor' AND NEW.`requested_by_user_id`=(SELECT n.`adult_user_id` FROM `contributors` n WHERE n.`household_id`=NEW.`household_id` AND n.`id`=d.`target_id`)))) OR EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`household_id`=NEW.`household_id` AND a.`status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT,'legacy_archive_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_archive_quiescence_job` BEFORE INSERT ON `legacy_job_bindings`
WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`target_kind` IN ('archive','contributor') AND d.`status` IN ('queued','processing','failed','dead_letter')) OR EXISTS (SELECT 1 FROM `account_deletion_operations` a WHERE a.`household_id`=NEW.`household_id` AND a.`status` NOT IN ('completed','canceled'))
BEGIN SELECT RAISE(ABORT,'legacy_archive_deletion_fenced'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_tombstone_recording` BEFORE INSERT ON `legacy_recordings`
WHEN EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND (x.`target_kind`='archive' OR (x.`target_kind`='contributor' AND x.`target_id`=NEW.`contributor_id`) OR (x.`target_kind`='recording' AND x.`target_id`=NEW.`id`)))
BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_tombstone_consent` BEFORE INSERT ON `legacy_consents`
WHEN EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND (x.`target_kind`='archive' OR (x.`target_kind`='contributor' AND x.`target_id`=NEW.`contributor_id`)))
BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_tombstone_job` BEFORE INSERT ON `legacy_job_bindings`
WHEN EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND (x.`target_kind`='archive' OR (x.`target_kind`='contributor' AND x.`target_id`=NEW.`contributor_id`)))
BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_contributor` BEFORE INSERT ON `contributors`
WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`target_kind`='archive') OR EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND x.`target_kind`='archive')
BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_interview` BEFORE INSERT ON `legacy_interviews`
WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND (d.`target_kind`='archive' OR (d.`target_kind`='contributor' AND d.`target_id`=NEW.`contributor_id`))) OR EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND (x.`target_kind`='archive' OR (x.`target_kind`='contributor' AND x.`target_id`=NEW.`contributor_id`)))
BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_export` BEFORE INSERT ON `legacy_export_operations`
WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND (d.`target_kind`='archive' OR d.`status`<>'completed')) OR EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND x.`target_kind`='archive')
BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_query_receipt` BEFORE INSERT ON `legacy_query_receipts`
WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`target_kind`='archive') OR EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND x.`target_kind`='archive')
BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_correction` BEFORE INSERT ON `legacy_transcript_corrections`
WHEN EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x JOIN `legacy_transcript_segments` s ON s.`household_id`=NEW.`household_id` AND s.`id`=NEW.`segment_id` WHERE x.`household_id`=NEW.`household_id` AND (x.`target_kind`='archive' OR (x.`target_kind`='contributor' AND (x.`target_id`=s.`contributor_id` OR x.`target_id`=NEW.`speaker_contributor_id`)) OR (x.`target_kind`='recording' AND x.`target_id`=s.`recording_id`)))
BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_photo` BEFORE INSERT ON `legacy_photos` WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`target_kind`='archive') OR EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND x.`target_kind`='archive') BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_memory` BEFORE INSERT ON `legacy_memories` WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND (d.`target_kind`='archive' OR (d.`target_kind`='contributor' AND d.`target_id`=NEW.`contributor_id`))) OR EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND (x.`target_kind`='archive' OR (x.`target_kind`='contributor' AND x.`target_id`=NEW.`contributor_id`))) BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_people` BEFORE INSERT ON `legacy_people` WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`target_kind`='archive') OR EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND x.`target_kind`='archive') BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_places` BEFORE INSERT ON `legacy_places` WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`target_kind`='archive') OR EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND x.`target_kind`='archive') BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_tags` BEFORE INSERT ON `legacy_tags` WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`target_kind`='archive') OR EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND x.`target_kind`='archive') BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_timeline` BEFORE INSERT ON `legacy_timeline_events` WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`target_kind`='archive') OR EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND x.`target_kind`='archive') BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_collection` BEFORE INSERT ON `legacy_collections` WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`target_kind`='archive') OR EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND x.`target_kind`='archive') BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_quiescence_collection_item` BEFORE INSERT ON `legacy_collection_items` WHEN EXISTS (SELECT 1 FROM `legacy_deletion_operations` d WHERE d.`household_id`=NEW.`household_id` AND d.`target_kind`='archive') OR EXISTS (SELECT 1 FROM `legacy_erasure_tombstones` x WHERE x.`household_id`=NEW.`household_id` AND x.`target_kind`='archive') BEGIN SELECT RAISE(ABORT,'legacy_archive_erased'); END;--> statement-breakpoint
CREATE TRIGGER `legacy_deletion_start` AFTER INSERT ON `legacy_deletion_operations`
WHEN NEW.`status`='queued'
BEGIN
  UPDATE `legacy_export_operations` SET `status`='expired',`updated_at`=NEW.`created_at` WHERE `household_id`=NEW.`household_id` AND `status` IN ('queued','inventory','copying','ready');
  UPDATE `legacy_recordings` SET `status`='delete_pending',`updated_at`=NEW.`created_at` WHERE `household_id`=NEW.`household_id` AND `status` IN ('processing','ready','failed') AND (NEW.`target_kind`='archive' OR (NEW.`target_kind`='contributor' AND `contributor_id`=NEW.`target_id`) OR (NEW.`target_kind`='recording' AND `id`=NEW.`target_id`));
  UPDATE `jobs` SET `status`='canceled',`error_code`='legacy_deletion_fenced',`completed_at`=NEW.`created_at`,`updated_at`=NEW.`created_at` WHERE `household_id`=NEW.`household_id` AND `status` IN ('queued','running') AND `id` IN (SELECT b.`job_id` FROM `legacy_job_bindings` b WHERE b.`household_id`=NEW.`household_id` AND b.`status`='active' AND (NEW.`target_kind`='archive' OR (NEW.`target_kind`='contributor' AND b.`contributor_id`=NEW.`target_id`) OR (NEW.`target_kind`='recording' AND b.`recording_id`=NEW.`target_id`)));
  UPDATE `usage_reservations` SET `status`='released',`finalized_at`=NEW.`created_at`,`updated_at`=NEW.`created_at` WHERE `household_id`=NEW.`household_id` AND `status`='reserved' AND `id` IN (SELECT b.`reservation_id` FROM `legacy_job_bindings` b WHERE b.`household_id`=NEW.`household_id` AND b.`status`='active' AND (NEW.`target_kind`='archive' OR (NEW.`target_kind`='contributor' AND b.`contributor_id`=NEW.`target_id`) OR (NEW.`target_kind`='recording' AND b.`recording_id`=NEW.`target_id`)));
  UPDATE `provider_spend_reservations` SET `status`=CASE WHEN `status`='charge_committed' THEN 'settled' ELSE 'released' END,`updated_at`=NEW.`created_at` WHERE `household_id`=NEW.`household_id` AND `status` IN ('in_flight','charge_committed') AND `id` IN (SELECT b.`provider_spend_reservation_id` FROM `legacy_job_bindings` b WHERE b.`household_id`=NEW.`household_id` AND b.`status`='active' AND (NEW.`target_kind`='archive' OR (NEW.`target_kind`='contributor' AND b.`contributor_id`=NEW.`target_id`) OR (NEW.`target_kind`='recording' AND b.`recording_id`=NEW.`target_id`)));
  UPDATE `legacy_job_bindings` SET `status`='fenced',`updated_at`=NEW.`created_at` WHERE `household_id`=NEW.`household_id` AND `status`='active' AND (NEW.`target_kind`='archive' OR (NEW.`target_kind`='contributor' AND `contributor_id`=NEW.`target_id`) OR (NEW.`target_kind`='recording' AND `recording_id`=NEW.`target_id`));
  INSERT OR IGNORE INTO `legacy_deletion_items` (`id`,`household_id`,`operation_id`,`object_kind`,`object_id`,`storage_key`,`status`,`updated_at`) SELECT NEW.`id`||':recording:'||r.`id`,NEW.`household_id`,NEW.`id`,'recording',r.`id`,m.`storage_key`,'pending',NEW.`created_at` FROM `legacy_recordings` r JOIN `media_assets` m ON m.`id`=r.`media_asset_id` AND m.`household_id`=r.`household_id` WHERE r.`household_id`=NEW.`household_id` AND (NEW.`target_kind`='archive' OR (NEW.`target_kind`='contributor' AND r.`contributor_id`=NEW.`target_id`) OR (NEW.`target_kind`='recording' AND r.`id`=NEW.`target_id`));
  INSERT OR IGNORE INTO `legacy_deletion_items` (`id`,`household_id`,`operation_id`,`object_kind`,`object_id`,`storage_key`,`status`,`updated_at`) SELECT NEW.`id`||':consent:'||c.`id`,NEW.`household_id`,NEW.`id`,'consent_evidence',c.`id`,c.`evidence_key`,'pending',NEW.`created_at` FROM `legacy_consents` c WHERE c.`household_id`=NEW.`household_id` AND c.`evidence_key` IS NOT NULL AND (NEW.`target_kind`='archive' OR (NEW.`target_kind`='contributor' AND c.`contributor_id`=NEW.`target_id`));
  INSERT OR IGNORE INTO `legacy_deletion_items` (`id`,`household_id`,`operation_id`,`object_kind`,`object_id`,`storage_key`,`status`,`updated_at`) SELECT NEW.`id`||':photo:'||p.`id`,NEW.`household_id`,NEW.`id`,'photo',p.`id`,m.`storage_key`,'pending',NEW.`created_at` FROM `legacy_photos` p JOIN `media_assets` m ON m.`id`=p.`media_asset_id` AND m.`household_id`=p.`household_id` WHERE p.`household_id`=NEW.`household_id` AND NEW.`target_kind`='archive';
  INSERT OR IGNORE INTO `legacy_deletion_items` (`id`,`household_id`,`operation_id`,`object_kind`,`object_id`,`storage_key`,`status`,`updated_at`) SELECT NEW.`id`||':export:'||p.`id`,NEW.`household_id`,NEW.`id`,'export_part',p.`id`,p.`storage_key`,'pending',NEW.`created_at` FROM `legacy_export_parts` p WHERE p.`household_id`=NEW.`household_id`;
  INSERT OR IGNORE INTO `legacy_deletion_items` (`id`,`household_id`,`operation_id`,`object_kind`,`object_id`,`storage_key`,`status`,`updated_at`) SELECT NEW.`id`||':transcript:'||t.`id`,NEW.`household_id`,NEW.`id`,'transcript',t.`id`,NULL,'pending',NEW.`created_at` FROM `legacy_transcripts` t JOIN `legacy_recordings` r ON r.`id`=t.`recording_id` AND r.`household_id`=t.`household_id` WHERE t.`household_id`=NEW.`household_id` AND (NEW.`target_kind`='archive' OR (NEW.`target_kind`='contributor' AND r.`contributor_id`=NEW.`target_id`) OR (NEW.`target_kind`='recording' AND r.`id`=NEW.`target_id`));
  INSERT OR IGNORE INTO `legacy_deletion_items` (`id`,`household_id`,`operation_id`,`object_kind`,`object_id`,`storage_key`,`status`,`updated_at`) SELECT NEW.`id`||':upload:'||u.`id`,NEW.`household_id`,NEW.`id`,'upload',u.`id`,u.`storage_key`,'pending',NEW.`created_at` FROM `legacy_upload_operations` u WHERE u.`household_id`=NEW.`household_id` AND (NEW.`target_kind`='archive' OR u.`target_id`=NEW.`target_id` OR (NEW.`target_kind`='contributor' AND EXISTS (SELECT 1 FROM `legacy_consents` c WHERE c.`household_id`=u.`household_id` AND c.`id`=u.`target_id` AND c.`contributor_id`=NEW.`target_id`)));
END;--> statement-breakpoint
CREATE TRIGGER `legacy_account_deletion_quiesce` AFTER INSERT ON `account_deletion_operations`
WHEN NEW.`status` NOT IN ('completed','canceled')
BEGIN
  UPDATE `jobs` SET `status`='canceled',`error_code`='account_deletion_fenced',`completed_at`=NEW.`created_at`,`updated_at`=NEW.`created_at` WHERE `household_id`=NEW.`household_id` AND `type` IN ('archive_transcription','legacy_synthetic_narration','media_export') AND `status` IN ('queued','running');
  UPDATE `legacy_recordings` SET `status`='delete_pending',`updated_at`=NEW.`created_at` WHERE `household_id`=NEW.`household_id` AND `status` IN ('processing','ready','failed');
END;--> statement-breakpoint
