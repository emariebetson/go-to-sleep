ALTER TABLE `sleep_sessions` ADD `content_type` text DEFAULT 'story' NOT NULL;--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `sleep_sessions` ADD `source_title` text;