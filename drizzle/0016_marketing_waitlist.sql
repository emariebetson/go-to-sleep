CREATE TABLE IF NOT EXISTS `marketing_waitlist_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`email_lookup_hash` text NOT NULL,
	`email_ciphertext` text NOT NULL,
	`email_iv` text NOT NULL,
	`consent_version` text NOT NULL,
	`consented_at` integer NOT NULL,
	`unsubscribed_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `marketing_waitlist_contacts_email_lookup_hash_unique` ON `marketing_waitlist_contacts` (`email_lookup_hash`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `marketing_waitlist_interests` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`product` text NOT NULL,
	`signup_source` text NOT NULL,
	`joined_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `marketing_waitlist_contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `marketing_waitlist_interest_contact_product_idx` ON `marketing_waitlist_interests` (`contact_id`,`product`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `marketing_waitlist_sync` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`contact_version` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_token` text,
	`lease_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `marketing_waitlist_contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `marketing_waitlist_sync_contact_version_idx` ON `marketing_waitlist_sync` (`contact_id`,`contact_version`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `marketing_waitlist_sync_status_next_idx` ON `marketing_waitlist_sync` (`status`,`next_attempt_at`);
