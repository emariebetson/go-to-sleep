CREATE TABLE `deletion_reconciliations` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`status` text DEFAULT 'cleanup_pending' NOT NULL,
	`storage_keys` text DEFAULT '[]' NOT NULL,
	`provider_references` text DEFAULT '[]' NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `deletion_reconciliations_scope_status_idx` ON `deletion_reconciliations` (`scope`,`scope_id`,`status`);--> statement-breakpoint
ALTER TABLE `stripe_events` ADD `event_created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `stripe_events` ADD `status` text DEFAULT 'processing' NOT NULL;--> statement-breakpoint
ALTER TABLE `stripe_events` ADD `error_code` text;--> statement-breakpoint
ALTER TABLE `stripe_events` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `stripe_events`
SET `status` = 'completed', `event_created_at` = `processed_at`, `updated_at` = `processed_at`
WHERE `event_created_at` = 0 AND `updated_at` = 0;--> statement-breakpoint
CREATE TRIGGER `voice_consent_leases_validate_insert`
BEFORE INSERT ON `voice_consent_leases`
WHEN NEW.status <> 'active'
  OR NEW.expires_at <= NEW.created_at
  OR (NEW.session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sleep_sessions
    WHERE sleep_sessions.id = NEW.session_id
      AND sleep_sessions.household_id = NEW.household_id
  ))
  OR NOT EXISTS (
    SELECT 1
    FROM voices
    JOIN voice_consents ON voice_consents.id = voices.current_consent_id
    WHERE voices.id = NEW.voice_id
      AND voices.household_id = NEW.household_id
      AND voices.status = 'ready'
      AND voice_consents.id = NEW.consent_id
      AND voice_consents.voice_id = NEW.voice_id
      AND voice_consents.household_id = NEW.household_id
      AND voice_consents.consent_version = NEW.consent_version
      AND voice_consents.status = 'active_verified'
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_voice_consent_lease');
END;--> statement-breakpoint
CREATE TRIGGER `voice_consent_leases_validate_transition`
BEFORE UPDATE OF status ON `voice_consent_leases`
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'active' AND NEW.status IN ('revoked', 'expired'))
  OR (
    OLD.status = 'active'
    AND NEW.status = 'consumed'
    AND NEW.finalized_at IS NOT NULL
    AND NEW.expires_at > NEW.finalized_at
    AND NEW.expires_at > unixepoch('subsec') * 1000
    AND EXISTS (
      SELECT 1
      FROM voices
      JOIN voice_consents ON voice_consents.id = voices.current_consent_id
      WHERE voices.id = NEW.voice_id
        AND voices.household_id = NEW.household_id
        AND voices.status = 'ready'
        AND voice_consents.id = NEW.consent_id
        AND voice_consents.voice_id = NEW.voice_id
        AND voice_consents.household_id = NEW.household_id
        AND voice_consents.consent_version = NEW.consent_version
        AND voice_consents.status = 'active_verified'
    )
  )
  OR (OLD.status = 'consumed' AND NEW.status = 'revoked')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_voice_consent_lease_transition');
END;--> statement-breakpoint
CREATE TRIGGER `voice_consent_leases_validate_session_update`
BEFORE UPDATE OF session_id ON `voice_consent_leases`
WHEN NEW.session_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM sleep_sessions
  WHERE sleep_sessions.id = NEW.session_id
    AND sleep_sessions.household_id = NEW.household_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_voice_consent_lease_session');
END;--> statement-breakpoint
CREATE TRIGGER `voice_consent_leases_release_allowance`
AFTER UPDATE OF status ON `voice_consent_leases`
WHEN NEW.status IN ('revoked', 'expired') AND OLD.status IN ('active', 'consumed')
BEGIN
  UPDATE usage_reservations
  SET status = 'released', finalized_at = COALESCE(finalized_at, NEW.finalized_at, unixepoch('subsec') * 1000), updated_at = unixepoch('subsec') * 1000
  WHERE consent_lease_id = NEW.id AND status = 'reserved';
END;--> statement-breakpoint
CREATE TRIGGER `voice_consents_revoke_generation_leases`
AFTER UPDATE OF status ON `voice_consents`
WHEN NEW.status = 'revoked' AND OLD.status <> 'revoked'
BEGIN
  UPDATE voice_consent_leases
  SET status = 'revoked', finalized_at = COALESCE(finalized_at, NEW.revoked_at, unixepoch('subsec') * 1000)
  WHERE consent_id = NEW.id AND status IN ('active', 'consumed');
END;--> statement-breakpoint
CREATE TRIGGER `voices_revoke_generation_leases`
AFTER UPDATE OF status ON `voices`
WHEN NEW.status = 'deleted' AND OLD.status <> 'deleted'
BEGIN
  UPDATE voice_consent_leases
  SET status = 'revoked', finalized_at = COALESCE(finalized_at, NEW.deleted_at, unixepoch('subsec') * 1000)
  WHERE voice_id = NEW.id AND status IN ('active', 'consumed');
END;--> statement-breakpoint
CREATE TRIGGER `usage_reservations_validate_consent_lease`
BEFORE INSERT ON `usage_reservations`
WHEN NEW.consent_lease_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM voice_consent_leases
  JOIN voices ON voices.id = voice_consent_leases.voice_id
  JOIN voice_consents ON voice_consents.id = voice_consent_leases.consent_id
  WHERE voice_consent_leases.id = NEW.consent_lease_id
    AND voice_consent_leases.household_id = NEW.household_id
    AND voice_consent_leases.status = 'active'
    AND voice_consent_leases.expires_at > NEW.created_at
    AND voices.household_id = NEW.household_id
    AND voices.status = 'ready'
    AND voices.current_consent_id = voice_consent_leases.consent_id
    AND voice_consents.status = 'active_verified'
    AND voice_consents.consent_version = voice_consent_leases.consent_version
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_voice_consent_lease');
END;--> statement-breakpoint
CREATE TRIGGER `usage_reservations_validate_status_transition`
BEFORE UPDATE OF status ON `usage_reservations`
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'reserved' AND NEW.status = 'released')
  OR (
    OLD.status = 'reserved'
    AND NEW.status = 'committed'
    AND (
      NEW.consent_lease_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM voice_consent_leases
        JOIN voices ON voices.id = voice_consent_leases.voice_id
        JOIN voice_consents ON voice_consents.id = voice_consent_leases.consent_id
        WHERE voice_consent_leases.id = NEW.consent_lease_id
          AND voice_consent_leases.household_id = NEW.household_id
          AND voice_consent_leases.status = 'consumed'
          AND voice_consent_leases.expires_at > voice_consent_leases.finalized_at
          AND voices.household_id = NEW.household_id
          AND voices.status = 'ready'
          AND voices.current_consent_id = voice_consent_leases.consent_id
          AND voice_consents.status = 'active_verified'
          AND voice_consents.consent_version = voice_consent_leases.consent_version
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_usage_reservation_transition');
END;--> statement-breakpoint
CREATE TRIGGER `generation_operations_validate_insert`
BEFORE INSERT ON `generation_operations`
WHEN length(NEW.operation) = 0
  OR length(NEW.request_hash) = 0
  OR NEW.status <> 'processing'
  OR NEW.result IS NOT NULL
  OR NEW.error_code IS NOT NULL
  OR NEW.completed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid_generation_operation');
END;--> statement-breakpoint
CREATE TRIGGER `generation_operations_validate_update`
BEFORE UPDATE OF status, result, error_code, completed_at ON `generation_operations`
WHEN NEW.status NOT IN ('processing', 'succeeded', 'failed')
  OR (OLD.status <> 'processing' AND (NEW.status <> OLD.status OR NEW.result IS NOT OLD.result OR NEW.error_code IS NOT OLD.error_code))
  OR (NEW.result IS NOT NULL AND json_valid(NEW.result) = 0)
  OR (NEW.status = 'succeeded' AND (NEW.result IS NULL OR NEW.error_code IS NOT NULL OR NEW.completed_at IS NULL))
  OR (NEW.status = 'failed' AND (length(COALESCE(NEW.error_code, '')) = 0 OR NEW.result IS NOT NULL OR NEW.completed_at IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'invalid_generation_operation');
END;--> statement-breakpoint
CREATE TRIGGER `deletion_reconciliations_validate_insert`
BEFORE INSERT ON `deletion_reconciliations`
WHEN NEW.scope NOT IN ('voice', 'session', 'account')
  OR NEW.status NOT IN ('cleanup_pending', 'cleanup_verified', 'failed', 'completed')
  OR json_valid(NEW.storage_keys) = 0
  OR json_type(NEW.storage_keys) <> 'array'
  OR json_valid(NEW.provider_references) = 0
  OR json_type(NEW.provider_references) <> 'array'
BEGIN
  SELECT RAISE(ABORT, 'invalid_deletion_reconciliation');
END;
