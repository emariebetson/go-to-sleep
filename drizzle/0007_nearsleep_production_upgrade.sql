CREATE TABLE `adult_onboarding_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`adult_user_id` text NOT NULL,
	`version` text NOT NULL,
	`attestation` text NOT NULL,
	`accepted_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`adult_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `adult_onboarding_household_user_version_idx` ON `adult_onboarding_acceptances` (`household_id`,`adult_user_id`,`version`);
--> statement-breakpoint
CREATE TABLE `voice_verification_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`voice_id` text NOT NULL,
	`adult_user_id` text NOT NULL,
	`onboarding_acceptance_id` text NOT NULL,
	`version` text NOT NULL,
	`phrase` text NOT NULL,
	`phrase_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`verified_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`voice_id`) REFERENCES `voices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`adult_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`onboarding_acceptance_id`) REFERENCES `adult_onboarding_acceptances`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `voice_verification_voice_status_idx` ON `voice_verification_challenges` (`voice_id`,`status`);
--> statement-breakpoint
CREATE TABLE `voice_replacements` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`voice_id` text NOT NULL,
	`challenge_id` text NOT NULL,
	`adult_user_id` text NOT NULL,
	`original_provider_voice_id` text NOT NULL,
	`original_consent_id` text NOT NULL,
	`replacement_provider_voice_id` text,
	`provider_request_id` text,
	`consent_id` text NOT NULL,
	`consent_version` text NOT NULL,
	`evidence` text,
	`status` text DEFAULT 'processing' NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`voice_id`) REFERENCES `voices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`challenge_id`) REFERENCES `voice_verification_challenges`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`adult_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`original_consent_id`) REFERENCES `voice_consents`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_replacements_challenge_idx` ON `voice_replacements` (`challenge_id`);
--> statement-breakpoint
CREATE INDEX `voice_replacements_voice_status_idx` ON `voice_replacements` (`voice_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_replacements_active_voice_idx` ON `voice_replacements` (`voice_id`) WHERE status IN ('processing','provider_created','activating','cleanup_pending');
--> statement-breakpoint
CREATE TRIGGER `voice_replacements_activate`
AFTER UPDATE OF status ON `voice_replacements`
WHEN OLD.status = 'provider_created' AND NEW.status = 'activating'
BEGIN
	SELECT CASE WHEN NEW.replacement_provider_voice_id IS NULL OR NEW.evidence IS NULL THEN RAISE(ABORT, 'voice_activation_evidence_missing') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM voices WHERE id = NEW.voice_id AND household_id = NEW.household_id
		AND user_id = NEW.adult_user_id AND status = 'ready'
		AND provider_voice_id = NEW.original_provider_voice_id AND current_consent_id = NEW.original_consent_id
	) THEN RAISE(ABORT, 'voice_activation_cas_failed') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM voice_verification_challenges WHERE id = NEW.challenge_id AND household_id = NEW.household_id
		AND voice_id = NEW.voice_id AND adult_user_id = NEW.adult_user_id AND status = 'processing'
	) THEN RAISE(ABORT, 'voice_challenge_cas_failed') END;
	INSERT INTO voice_consents (
		id, household_id, voice_id, adult_user_id, consent_version, scope, status, evidence, attested_at
	) VALUES (
		NEW.consent_id, NEW.household_id, NEW.voice_id, NEW.adult_user_id, NEW.consent_version,
		'adult_self_private_narration', 'active_verified', NEW.evidence, NEW.updated_at
	);
	UPDATE voices SET provider_voice_id = NEW.replacement_provider_voice_id, current_consent_id = NEW.consent_id
	WHERE id = NEW.voice_id AND household_id = NEW.household_id AND user_id = NEW.adult_user_id
	AND status = 'ready' AND provider_voice_id = NEW.original_provider_voice_id AND current_consent_id = NEW.original_consent_id;
	SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'voice_activation_cas_failed') END;
	UPDATE voice_verification_challenges SET status = 'verified', phrase = '', verified_at = NEW.updated_at
	WHERE id = NEW.challenge_id AND status = 'processing';
	SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'voice_challenge_cas_failed') END;
	UPDATE users SET consent_version = NEW.consent_version, consented_at = NEW.updated_at, updated_at = NEW.updated_at
	WHERE id = NEW.adult_user_id;
	UPDATE voice_replacements SET status = 'cleanup_pending' WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TABLE `voice_consent_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`voice_id` text NOT NULL,
	`consent_id` text NOT NULL,
	`consent_version` text NOT NULL,
	`session_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`finalized_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`voice_id`) REFERENCES `voices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`consent_id`) REFERENCES `voice_consents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sleep_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `voice_consent_leases_consent_status_idx` ON `voice_consent_leases` (`consent_id`,`status`);
--> statement-breakpoint
CREATE TABLE `usage_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_id` text NOT NULL,
	`entitlement_id` text NOT NULL,
	`operation` text NOT NULL,
	`quantity` integer NOT NULL,
	`weight_milliunits` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`consent_lease_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finalized_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entitlement_id`) REFERENCES `entitlements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`consent_lease_id`) REFERENCES `voice_consent_leases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_reservations_household_idempotency_idx` ON `usage_reservations` (`household_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `usage_reservations_household_status_created_idx` ON `usage_reservations` (`household_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `usage_reservations_validate_insert`
BEFORE INSERT ON `usage_reservations`
WHEN NEW.status <> 'reserved' OR NEW.quantity <= 0 OR NEW.weight_milliunits <= 0
BEGIN
	SELECT RAISE(ABORT, 'invalid_usage_reservation');
END;
--> statement-breakpoint
CREATE TRIGGER `usage_reservations_before_insert`
BEFORE INSERT ON `usage_reservations`
WHEN NEW.status = 'reserved' AND NOT EXISTS (
	SELECT 1 FROM usage_reservations WHERE household_id = NEW.household_id AND idempotency_key = NEW.idempotency_key
)
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM entitlements
		WHERE id = NEW.entitlement_id
		AND household_id = NEW.household_id
		AND status IN ('active', 'grace')
		AND valid_from <= NEW.created_at
		AND (valid_until IS NULL OR valid_until > NEW.created_at)
		AND plan_id IN ('nearsleep_free', 'nearsleep_plus_legacy', 'nearyou_plus', 'nearyou_family', 'nearlegacy')
		AND remaining_milliunits >= NEW.weight_milliunits
	) THEN RAISE(ABORT, 'allowance_exhausted') END;
END;
--> statement-breakpoint
CREATE TRIGGER `usage_reservations_after_insert`
AFTER INSERT ON `usage_reservations`
WHEN NEW.status = 'reserved'
BEGIN
	UPDATE entitlements SET remaining_milliunits = remaining_milliunits - NEW.weight_milliunits, updated_at = NEW.updated_at
	WHERE id = NEW.entitlement_id AND household_id = NEW.household_id;
	INSERT INTO usage_ledger (
		id, household_id, user_id, entitlement_id, product, operation, quantity,
		weight_milliunits, direction, idempotency_key, metadata, created_at
	) VALUES (
		'usage-reservation:' || NEW.id, NEW.household_id, NEW.user_id, NEW.entitlement_id,
		'nearsleep', NEW.operation, NEW.quantity, NEW.weight_milliunits, 'reservation',
		'reserve:' || NEW.id, json_object('reservationId', NEW.id), NEW.created_at
	);
END;
--> statement-breakpoint
CREATE TRIGGER `usage_reservations_after_release`
AFTER UPDATE OF status ON `usage_reservations`
WHEN OLD.status = 'reserved' AND NEW.status = 'released'
BEGIN
	UPDATE entitlements SET remaining_milliunits = remaining_milliunits + OLD.weight_milliunits, updated_at = NEW.updated_at
	WHERE id = OLD.entitlement_id AND household_id = OLD.household_id;
	INSERT INTO usage_ledger (
		id, household_id, user_id, entitlement_id, product, operation, quantity,
		weight_milliunits, direction, idempotency_key, metadata, created_at
	) VALUES (
		'usage-release:' || OLD.id, OLD.household_id, OLD.user_id, OLD.entitlement_id,
		'nearsleep', OLD.operation, OLD.quantity, OLD.weight_milliunits, 'release',
		'release:' || OLD.id, json_object('reservationId', OLD.id), NEW.updated_at
	);
END;
--> statement-breakpoint
CREATE TABLE `provider_spend_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`operation` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`estimated_microcents` integer NOT NULL,
	`actual_microcents` integer,
	`status` text DEFAULT 'in_flight' NOT NULL,
	`charge_committed_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_spend_household_idempotency_idx` ON `provider_spend_reservations` (`household_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `provider_spend_provider_status_created_idx` ON `provider_spend_reservations` (`provider`,`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `provider_budget_policies` (
	`provider` text PRIMARY KEY NOT NULL,
	`household_window_microcents` integer NOT NULL,
	`global_window_microcents` integer NOT NULL,
	`window_milliseconds` integer NOT NULL,
	`max_concurrent` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `provider_budget_policies` (`provider`,`household_window_microcents`,`global_window_microcents`,`window_milliseconds`,`max_concurrent`,`enabled`,`updated_at`) VALUES
	('openai', 200000000, 10000000000, 86400000, 4, true, 1786442400000),
	('elevenlabs', 1000000000, 50000000000, 86400000, 3, true, 1786442400000);
--> statement-breakpoint
CREATE TABLE `provider_circuits` (
	`provider` text PRIMARY KEY NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`open_until` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `provider_spend_validate_insert`
BEFORE INSERT ON `provider_spend_reservations`
WHEN NEW.status <> 'in_flight' OR NEW.estimated_microcents <= 0 OR NEW.actual_microcents IS NOT NULL OR NEW.charge_committed_at IS NOT NULL OR NEW.expires_at <= NEW.created_at
BEGIN
	SELECT RAISE(ABORT, 'invalid_provider_spend_reservation');
END;
--> statement-breakpoint
CREATE TRIGGER `provider_spend_validate_actual_update`
BEFORE UPDATE ON `provider_spend_reservations`
WHEN NEW.actual_microcents < 0
BEGIN
	SELECT RAISE(ABORT, 'invalid_provider_spend_actual');
END;
--> statement-breakpoint
CREATE TRIGGER `provider_spend_validate_status_update`
BEFORE UPDATE ON `provider_spend_reservations`
WHEN NOT (
	OLD.status = NEW.status OR
	(OLD.status = 'in_flight' AND NEW.status = 'charge_committed' AND NEW.charge_committed_at IS NOT NULL) OR
	(OLD.status = 'in_flight' AND NEW.status = 'released') OR
	(OLD.status = 'charge_committed' AND NEW.status = 'settled')
)
BEGIN
	SELECT RAISE(ABORT, 'invalid_provider_spend_transition');
END;
--> statement-breakpoint
CREATE TRIGGER `provider_spend_before_insert`
BEFORE INSERT ON `provider_spend_reservations`
WHEN NEW.status = 'in_flight' AND NOT EXISTS (
	SELECT 1 FROM provider_spend_reservations WHERE household_id = NEW.household_id AND idempotency_key = NEW.idempotency_key
)
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM provider_budget_policies WHERE provider = NEW.provider AND enabled = true
	) THEN RAISE(ABORT, 'provider_policy_missing') END;
	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM provider_circuits WHERE provider = NEW.provider AND open_until > NEW.created_at
	) THEN RAISE(ABORT, 'provider_circuit_open') END;
	SELECT CASE WHEN (
		SELECT count(*) FROM provider_spend_reservations
		WHERE provider = NEW.provider AND status IN ('in_flight', 'charge_committed') AND expires_at > NEW.created_at
	) >= (SELECT max_concurrent FROM provider_budget_policies WHERE provider = NEW.provider)
	THEN RAISE(ABORT, 'provider_concurrency_limit') END;
	SELECT CASE WHEN COALESCE((
		SELECT sum(CASE WHEN status = 'settled' THEN COALESCE(actual_microcents, estimated_microcents) ELSE estimated_microcents END)
		FROM provider_spend_reservations
		WHERE provider = NEW.provider AND household_id = NEW.household_id
		AND (status IN ('settled', 'charge_committed') OR (status = 'in_flight' AND expires_at > NEW.created_at))
		AND created_at >= NEW.created_at - (SELECT window_milliseconds FROM provider_budget_policies WHERE provider = NEW.provider)
	), 0) + NEW.estimated_microcents > (
		SELECT household_window_microcents FROM provider_budget_policies WHERE provider = NEW.provider
	) THEN RAISE(ABORT, 'household_spend_limit') END;
	SELECT CASE WHEN COALESCE((
		SELECT sum(CASE WHEN status = 'settled' THEN COALESCE(actual_microcents, estimated_microcents) ELSE estimated_microcents END)
		FROM provider_spend_reservations
		WHERE provider = NEW.provider
		AND (status IN ('settled', 'charge_committed') OR (status = 'in_flight' AND expires_at > NEW.created_at))
		AND created_at >= NEW.created_at - (SELECT window_milliseconds FROM provider_budget_policies WHERE provider = NEW.provider)
	), 0) + NEW.estimated_microcents > (
		SELECT global_window_microcents FROM provider_budget_policies WHERE provider = NEW.provider
	) THEN RAISE(ABORT, 'global_spend_limit') END;
END;
--> statement-breakpoint
CREATE TABLE `generation_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_id` text NOT NULL,
	`operation` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`result` text,
	`error_code` text,
	`allowance_reservation_id` text,
	`provider_spend_reservation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`allowance_reservation_id`) REFERENCES `usage_reservations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`provider_spend_reservation_id`) REFERENCES `provider_spend_reservations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `generation_operations_household_status_idx` ON `generation_operations` (`household_id`,`status`);
--> statement-breakpoint
CREATE TABLE `bedtime_queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`queued_by_user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`queued_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sleep_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bedtime_queue_household_position_idx` ON `bedtime_queue_items` (`household_id`,`position`);
--> statement-breakpoint
CREATE INDEX `bedtime_queue_household_status_idx` ON `bedtime_queue_items` (`household_id`,`status`);
--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `consent_id` text REFERENCES voice_consents(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `consent_version` text;
--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `favorite` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `repeat_minutes` integer;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `progress_percent` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `progress_stage` text DEFAULT 'queued' NOT NULL;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `reservation_id` text REFERENCES usage_reservations(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `consent_id` text REFERENCES voice_consents(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `consent_version` text;
