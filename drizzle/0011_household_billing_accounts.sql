CREATE TABLE IF NOT EXISTS `_task_2b_voice_preflight` (
  `duplicate_live_voice_count` integer NOT NULL,
  CONSTRAINT `task_2b_duplicate_live_voice_preflight` CHECK (`duplicate_live_voice_count` = 0)
);--> statement-breakpoint
DELETE FROM `_task_2b_voice_preflight`;--> statement-breakpoint
INSERT INTO `_task_2b_voice_preflight` (`duplicate_live_voice_count`)
SELECT COALESCE(SUM(`live_count` - 1), 0)
FROM (
  SELECT COUNT(*) AS `live_count`
  FROM `voices`
  WHERE `household_id` IS NOT NULL AND `status` IN ('processing', 'ready')
  GROUP BY `household_id`, `user_id`
  HAVING COUNT(*) > 1
);--> statement-breakpoint
DROP TABLE `_task_2b_voice_preflight`;--> statement-breakpoint
CREATE TABLE `household_billing_accounts` (
	`household_id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`subscription_id` text,
	`price_id` text,
	`status` text DEFAULT 'free' NOT NULL,
	`subscription_event_created_at` integer,
	`checkout_pending_at` integer,
	`checkout_operation_id` text,
	`checkout_session_id` text,
	`checkout_session_url` text,
	`checkout_price_id` text,
	`checkout_status` text,
	`checkout_expires_at` integer,
	`last_credited_invoice_id` text,
	`last_credited_period_start` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_billing_customer_idx` ON `household_billing_accounts` (`customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `household_billing_subscription_idx` ON `household_billing_accounts` (`subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `household_billing_checkout_session_idx` ON `household_billing_accounts` (`checkout_session_id`);--> statement-breakpoint
CREATE TABLE `household_billing_subscriptions` (
	`subscription_id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`price_id` text,
	`status` text NOT NULL,
	`event_created_at` integer,
	`superseded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `household_billing_subscriptions_household_idx` ON `household_billing_subscriptions` (`household_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `entitlements` ADD `billing_period_start` integer;--> statement-breakpoint
UPDATE `entitlements` SET `billing_period_start` = CAST(`valid_from` / 1000 AS integer)
WHERE `external_ref` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `stripe_events` ADD `attempt_token` text;--> statement-breakpoint
ALTER TABLE `voices` ADD `creation_request_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `voices_household_user_live_idx` ON `voices` (`household_id`,`user_id`) WHERE "voices"."household_id" IS NOT NULL AND "voices"."status" IN ('processing', 'ready');--> statement-breakpoint
CREATE UNIQUE INDEX `voices_household_creation_request_idx` ON `voices` (`household_id`,`creation_request_id`);--> statement-breakpoint
INSERT INTO `household_billing_accounts`
  (`household_id`, `customer_id`, `subscription_id`, `price_id`, `status`, `subscription_event_created_at`, `checkout_pending_at`, `last_credited_invoice_id`, `last_credited_period_start`, `created_at`, `updated_at`)
SELECT
  `households`.`id`, `users`.`stripe_customer_id`, `users`.`subscription_id`, `users`.`subscription_price_id`,
  `users`.`subscription_status`, `users`.`subscription_event_created_at`, `users`.`checkout_pending_at`,
  `users`.`last_credited_invoice_id`, `users`.`last_credited_period_start`, `households`.`created_at`, `households`.`updated_at`
FROM `households`
JOIN `users` ON `households`.`id` = 'household:' || `users`.`id`;--> statement-breakpoint
INSERT INTO `household_billing_subscriptions`
  (`subscription_id`, `household_id`, `customer_id`, `price_id`, `status`, `event_created_at`, `created_at`, `updated_at`)
SELECT `subscription_id`, `household_id`, `customer_id`, `price_id`, `status`, `subscription_event_created_at`, `created_at`, `updated_at`
FROM `household_billing_accounts`
WHERE `subscription_id` IS NOT NULL AND `customer_id` IS NOT NULL;--> statement-breakpoint
UPDATE `voice_consents`
SET `status` = 'revoked', `revoked_at` = COALESCE(`revoked_at`, unixepoch('subsec') * 1000)
WHERE `status` = 'active_verified' AND `voice_id` IS NOT NULL
  AND `id` <> COALESCE((SELECT `current_consent_id` FROM `voices` WHERE `voices`.`id` = `voice_consents`.`voice_id`), '');--> statement-breakpoint
DROP INDEX `voice_consents_voice_version_idx`;--> statement-breakpoint
CREATE INDEX `voice_consents_voice_version_idx` ON `voice_consents` (`voice_id`,`consent_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `voice_consents_active_voice_idx` ON `voice_consents` (`voice_id`) WHERE `voice_id` IS NOT NULL AND `status` = 'active_verified';--> statement-breakpoint
CREATE TRIGGER `voice_consents_rotate_active_receipt`
BEFORE INSERT ON `voice_consents`
WHEN NEW.`voice_id` IS NOT NULL AND NEW.`status` = 'active_verified'
BEGIN
  UPDATE `voice_consents`
  SET `status` = 'revoked', `revoked_at` = COALESCE(`revoked_at`, NEW.`attested_at`)
  WHERE `voice_id` = NEW.`voice_id` AND `status` = 'active_verified';
END;--> statement-breakpoint
CREATE TRIGGER `voice_consent_leases_require_current_version_insert`
BEFORE INSERT ON `voice_consent_leases`
WHEN NEW.`consent_version` <> 'voice-v2-live-phrase'
BEGIN SELECT RAISE(ABORT, 'voice_consent_version_not_current'); END;--> statement-breakpoint
CREATE TRIGGER `voice_consent_leases_require_current_version_consume`
BEFORE UPDATE OF `status` ON `voice_consent_leases`
WHEN NEW.`status` = 'consumed' AND NEW.`consent_version` <> 'voice-v2-live-phrase'
BEGIN SELECT RAISE(ABORT, 'voice_consent_version_not_current'); END;--> statement-breakpoint
CREATE TRIGGER `usage_reservations_require_current_consent_version`
BEFORE INSERT ON `usage_reservations`
WHEN NEW.`consent_lease_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `voice_consent_leases`
  WHERE `id` = NEW.`consent_lease_id` AND `household_id` = NEW.`household_id`
    AND `consent_version` = 'voice-v2-live-phrase'
)
BEGIN SELECT RAISE(ABORT, 'voice_consent_version_not_current'); END;--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_require_current_consent_version_ready`
BEFORE UPDATE OF `status` ON `sleep_sessions`
WHEN NEW.`status` = 'ready' AND NEW.`consent_lease_id` IS NOT NULL
  AND (NEW.`consent_version` <> 'voice-v2-live-phrase' OR NOT EXISTS (
    SELECT 1 FROM `voice_consent_leases`
    WHERE `id` = NEW.`consent_lease_id` AND `household_id` = NEW.`household_id`
      AND `consent_version` = 'voice-v2-live-phrase'
  ))
BEGIN SELECT RAISE(ABORT, 'voice_consent_version_not_current'); END;--> statement-breakpoint
CREATE TRIGGER `child_profiles_validate_household_capacity_insert`
BEFORE INSERT ON `child_profiles`
WHEN NEW.`archived_at` IS NULL
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM `child_profiles` WHERE `household_id` = NEW.`household_id` AND `archived_at` IS NULL) >= CASE (
    SELECT `plan_id` FROM `entitlements` WHERE `household_id` = NEW.`household_id`
      AND `status` IN ('active', 'grace') AND `valid_from` <= unixepoch('subsec') * 1000
      AND (`valid_until` IS NULL OR `valid_until` > unixepoch('subsec') * 1000)
    ORDER BY CASE WHEN `plan_id` = 'nearsleep_free' THEN 0 ELSE 1 END DESC,
      CASE WHEN `status` = 'active' THEN 1 ELSE 0 END DESC, `updated_at` DESC LIMIT 1
  ) WHEN 'nearyou_family' THEN 5 WHEN 'nearlegacy' THEN 5 WHEN 'nearsleep_plus_legacy' THEN 3 WHEN 'nearyou_plus' THEN 2 WHEN 'nearsleep_free' THEN 1 ELSE 0 END
  THEN RAISE(ABORT, 'household_child_limit_reached') END;
END;--> statement-breakpoint
CREATE TRIGGER `child_profiles_validate_household_capacity_restore`
BEFORE UPDATE OF `archived_at` ON `child_profiles`
WHEN OLD.`archived_at` IS NOT NULL AND NEW.`archived_at` IS NULL
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM `child_profiles` WHERE `household_id` = NEW.`household_id` AND `archived_at` IS NULL) >= CASE (
    SELECT `plan_id` FROM `entitlements` WHERE `household_id` = NEW.`household_id`
      AND `status` IN ('active', 'grace') AND `valid_from` <= unixepoch('subsec') * 1000
      AND (`valid_until` IS NULL OR `valid_until` > unixepoch('subsec') * 1000)
    ORDER BY CASE WHEN `plan_id` = 'nearsleep_free' THEN 0 ELSE 1 END DESC,
      CASE WHEN `status` = 'active' THEN 1 ELSE 0 END DESC, `updated_at` DESC LIMIT 1
  ) WHEN 'nearyou_family' THEN 5 WHEN 'nearlegacy' THEN 5 WHEN 'nearsleep_plus_legacy' THEN 3 WHEN 'nearyou_plus' THEN 2 WHEN 'nearsleep_free' THEN 1 ELSE 0 END
  THEN RAISE(ABORT, 'household_child_limit_reached') END;
END;--> statement-breakpoint
CREATE TRIGGER `voices_validate_household_slot_insert`
BEFORE INSERT ON `voices`
WHEN NEW.`household_id` IS NOT NULL AND NEW.`status` IN ('processing', 'ready')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `entitlements` WHERE `household_id` = NEW.`household_id`
      AND `status` IN ('active', 'grace') AND `valid_from` <= unixepoch('subsec') * 1000
      AND (`valid_until` IS NULL OR `valid_until` > unixepoch('subsec') * 1000)
      AND `plan_id` IN ('nearsleep_free', 'nearsleep_plus_legacy', 'nearyou_plus', 'nearyou_family', 'nearlegacy')
  ) THEN RAISE(ABORT, 'voice_entitlement_required') END;
  SELECT CASE WHEN NEW.`creation_request_id` IS NOT NULL AND (
    SELECT `plan_id` FROM `entitlements` WHERE `household_id` = NEW.`household_id`
      AND `status` IN ('active', 'grace') AND `valid_from` <= unixepoch('subsec') * 1000
      AND (`valid_until` IS NULL OR `valid_until` > unixepoch('subsec') * 1000)
    ORDER BY CASE WHEN `plan_id` = 'nearsleep_free' THEN 0 ELSE 1 END DESC,
      CASE WHEN `status` = 'active' THEN 1 ELSE 0 END DESC, `updated_at` DESC LIMIT 1
  ) = 'nearsleep_free' THEN RAISE(ABORT, 'free_voice_clone_unavailable') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM `voices` WHERE `household_id` = NEW.`household_id` AND `status` IN ('processing', 'ready')) >= CASE (
    SELECT `plan_id` FROM `entitlements` WHERE `household_id` = NEW.`household_id`
      AND `status` IN ('active', 'grace') AND `valid_from` <= unixepoch('subsec') * 1000
      AND (`valid_until` IS NULL OR `valid_until` > unixepoch('subsec') * 1000)
    ORDER BY CASE WHEN `plan_id` = 'nearsleep_free' THEN 0 ELSE 1 END DESC,
      CASE WHEN `status` = 'active' THEN 1 ELSE 0 END DESC, `updated_at` DESC LIMIT 1
  ) WHEN 'nearyou_family' THEN 2 WHEN 'nearlegacy' THEN 5 ELSE 1 END
  THEN RAISE(ABORT, 'household_voice_limit_reached') END;
END;--> statement-breakpoint
CREATE TRIGGER `voices_validate_household_slot_update`
BEFORE UPDATE OF `status` ON `voices`
WHEN NEW.`household_id` IS NOT NULL AND NEW.`status` IN ('processing', 'ready') AND OLD.`status` NOT IN ('processing', 'ready')
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM `voices` WHERE `household_id` = NEW.`household_id` AND `status` IN ('processing', 'ready')) >= CASE (
    SELECT `plan_id` FROM `entitlements` WHERE `household_id` = NEW.`household_id`
      AND `status` IN ('active', 'grace') AND `valid_from` <= unixepoch('subsec') * 1000
      AND (`valid_until` IS NULL OR `valid_until` > unixepoch('subsec') * 1000)
    ORDER BY CASE WHEN `plan_id` = 'nearsleep_free' THEN 0 ELSE 1 END DESC,
      CASE WHEN `status` = 'active' THEN 1 ELSE 0 END DESC, `updated_at` DESC LIMIT 1
  ) WHEN 'nearyou_family' THEN 2 WHEN 'nearlegacy' THEN 5 WHEN 'nearsleep_free' THEN 1 WHEN 'nearsleep_plus_legacy' THEN 1 WHEN 'nearyou_plus' THEN 1 ELSE 0 END
  THEN RAISE(ABORT, 'household_voice_limit_reached') END;
END;--> statement-breakpoint
CREATE TRIGGER `voices_protect_live_tenant_binding`
BEFORE UPDATE OF `household_id`, `user_id` ON `voices`
WHEN OLD.`status` IN ('processing', 'ready') AND (NEW.`household_id` IS NOT OLD.`household_id` OR NEW.`user_id` IS NOT OLD.`user_id`)
BEGIN SELECT RAISE(ABORT, 'voice_tenant_binding_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `voices_revoke_superseded_consent`
AFTER UPDATE OF `current_consent_id` ON `voices`
WHEN OLD.`current_consent_id` IS NOT NULL AND NEW.`current_consent_id` IS NOT OLD.`current_consent_id`
BEGIN
  UPDATE `voice_consents`
  SET `status` = 'revoked', `revoked_at` = COALESCE(`revoked_at`, unixepoch('subsec') * 1000)
  WHERE `id` = OLD.`current_consent_id` AND `household_id` = NEW.`household_id`
    AND `voice_id` = NEW.`id` AND `status` IN ('pending_verification', 'active_verified');
END;--> statement-breakpoint
CREATE TRIGGER `voice_replacements_prepare_first_clone`
BEFORE UPDATE OF `status` ON `voice_replacements`
WHEN OLD.`status` = 'provider_created' AND NEW.`status` = 'activating'
  AND NEW.`original_provider_voice_id` LIKE 'pending:%'
BEGIN
  UPDATE `voices` SET `status` = 'ready'
  WHERE `id` = NEW.`voice_id` AND `household_id` = NEW.`household_id` AND `user_id` = NEW.`adult_user_id`
    AND `status` = 'processing' AND `provider_voice_id` = NEW.`original_provider_voice_id`
    AND `current_consent_id` = NEW.`original_consent_id`;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'voice_first_clone_activation_cas_failed') END;
END;
