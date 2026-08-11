ALTER TABLE `children` ADD `normalized_nickname` text;--> statement-breakpoint
ALTER TABLE `children` ADD `pronunciation` text;--> statement-breakpoint
CREATE UNIQUE INDEX `children_user_normalized_nickname_idx` ON `children` (`user_id`,`normalized_nickname`);--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `pronunciation` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `frequency_layers` text DEFAULT '[]' NOT NULL;