CREATE TABLE `operational_outcome_outbox` (
 `id` text PRIMARY KEY NOT NULL,
 `product` text NOT NULL CHECK (`product` IN ('nearstory','nearlegacy')),
 `operation` text NOT NULL CHECK (`operation` IN ('attempt_started','terminal')),
 `job_id` text NOT NULL,
 `household_id` text NOT NULL,
 `attempt_token` text NOT NULL,
 `request_hash` text NOT NULL CHECK (length(`request_hash`)=64),
 `release_id` text NOT NULL,
 `release_version` integer NOT NULL CHECK (`release_version`>0),
 `terminal_status` text CHECK (`terminal_status` IN ('succeeded','failed','dead_letter')),
 `delivery_status` text NOT NULL DEFAULT 'pending' CHECK (`delivery_status` IN ('pending','leased','delivered','dead_letter')),
 `attempts` integer NOT NULL DEFAULT 0 CHECK (`attempts` BETWEEN 0 AND 12),
 `lease_token` text,
 `lease_expires_at` integer,
 `next_attempt_at` integer NOT NULL,
 `payload_checksum` text NOT NULL CHECK (length(`payload_checksum`)=64),
 `created_at` integer NOT NULL,
 `updated_at` integer NOT NULL,
 `delivered_at` integer,
 UNIQUE (`product`,`job_id`,`attempt_token`,`operation`)
);
--> statement-breakpoint
CREATE INDEX `operational_outcome_outbox_due_idx` ON `operational_outcome_outbox` (`delivery_status`,`next_attempt_at`);
