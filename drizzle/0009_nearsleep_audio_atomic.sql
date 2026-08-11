ALTER TABLE `sleep_sessions` ADD `consent_lease_id` text REFERENCES voice_consent_leases(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `allowance_reservation_id` text REFERENCES usage_reservations(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `sessions_consent_lease_idx` ON `sleep_sessions` (`consent_lease_id`);--> statement-breakpoint
CREATE INDEX `sessions_allowance_reservation_idx` ON `sleep_sessions` (`allowance_reservation_id`);--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_validate_generation_transition`
BEFORE UPDATE OF status ON `sleep_sessions`
WHEN OLD.status <> NEW.status
  AND NEW.status = 'ready'
  AND (NEW.allowance_reservation_id IS NOT NULL OR NEW.consent_lease_id IS NOT NULL)
  AND OLD.status <> 'generating'
BEGIN
  SELECT RAISE(ABORT, 'invalid_session_generation_transition');
END;--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_protect_ready_generation`
BEFORE UPDATE OF status, audio_key, completed_at, consent_id, consent_version, consent_lease_id, allowance_reservation_id, voice_id, narration_kind ON `sleep_sessions`
WHEN OLD.status = 'ready'
  AND (OLD.allowance_reservation_id IS NOT NULL OR OLD.consent_lease_id IS NOT NULL)
  AND (
    NEW.status IS NOT OLD.status
    OR NEW.audio_key IS NOT OLD.audio_key
    OR NEW.completed_at IS NOT OLD.completed_at
    OR NEW.consent_id IS NOT OLD.consent_id
    OR NEW.consent_version IS NOT OLD.consent_version
    OR NEW.consent_lease_id IS NOT OLD.consent_lease_id
    OR NEW.allowance_reservation_id IS NOT OLD.allowance_reservation_id
    OR NEW.voice_id IS NOT OLD.voice_id
    OR NEW.narration_kind IS NOT OLD.narration_kind
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_session_generation_transition');
END;--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_validate_generation_finalize`
BEFORE UPDATE OF status ON `sleep_sessions`
WHEN OLD.status = 'generating'
  AND NEW.status = 'ready'
  AND (NEW.allowance_reservation_id IS NOT NULL OR NEW.consent_lease_id IS NOT NULL)
  AND (
    NEW.household_id IS NULL
    OR NEW.completed_at IS NULL
    OR length(trim(COALESCE(NEW.audio_key, ''))) = 0
    OR substr(NEW.audio_key, 1, length('audio/' || NEW.household_id || '/')) <> 'audio/' || NEW.household_id || '/'
    OR NOT EXISTS (
      SELECT 1
      FROM usage_reservations
      WHERE usage_reservations.id = NEW.allowance_reservation_id
        AND usage_reservations.household_id = NEW.household_id
        AND usage_reservations.user_id = NEW.user_id
        AND usage_reservations.operation = 'nearsleep_audio_generation'
        AND usage_reservations.status = 'reserved'
        AND usage_reservations.consent_lease_id IS NEW.consent_lease_id
    )
    OR (
      NEW.narration_kind = 'parent_clone'
      AND (
        NEW.voice_id IS NULL
        OR NEW.consent_id IS NULL
        OR NEW.consent_version IS NULL
        OR NEW.consent_lease_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM voice_consent_leases
          JOIN voices ON voices.id = voice_consent_leases.voice_id
          JOIN voice_consents ON voice_consents.id = voice_consent_leases.consent_id
          WHERE voice_consent_leases.id = NEW.consent_lease_id
            AND voice_consent_leases.household_id = NEW.household_id
            AND voice_consent_leases.session_id = NEW.id
            AND voice_consent_leases.voice_id = NEW.voice_id
            AND voice_consent_leases.consent_id = NEW.consent_id
            AND voice_consent_leases.consent_version = NEW.consent_version
            AND voice_consent_leases.status = 'consumed'
            AND voice_consent_leases.finalized_at IS NOT NULL
            AND voice_consent_leases.expires_at > voice_consent_leases.finalized_at
            AND voices.household_id = NEW.household_id
            AND voices.status = 'ready'
            AND voices.current_consent_id = voice_consent_leases.consent_id
            AND voice_consents.household_id = NEW.household_id
            AND voice_consents.voice_id = NEW.voice_id
            AND voice_consents.status = 'active_verified'
            AND voice_consents.consent_version = NEW.consent_version
        )
      )
    )
    OR (
      NEW.narration_kind = 'demo_narrator'
      AND (
        NEW.voice_id IS NOT NULL
        OR NEW.consent_id IS NOT NULL
        OR NEW.consent_version IS NOT NULL
        OR NEW.consent_lease_id IS NOT NULL
      )
    )
    OR NEW.narration_kind NOT IN ('parent_clone', 'demo_narrator')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_session_generation_finalize');
END;--> statement-breakpoint
CREATE TRIGGER `sleep_sessions_commit_generation_allowance`
AFTER UPDATE OF status ON `sleep_sessions`
WHEN OLD.status = 'generating'
  AND NEW.status = 'ready'
  AND NEW.allowance_reservation_id IS NOT NULL
BEGIN
  UPDATE usage_reservations
  SET status = 'committed', finalized_at = NEW.completed_at, updated_at = NEW.completed_at
  WHERE id = NEW.allowance_reservation_id
    AND household_id = NEW.household_id
    AND user_id = NEW.user_id
    AND operation = 'nearsleep_audio_generation'
    AND status = 'reserved'
    AND consent_lease_id IS NEW.consent_lease_id;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'invalid_session_generation_finalize') END;
END;
