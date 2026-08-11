ALTER TABLE `users` ADD `subscription_price_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `subscription_event_created_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `checkout_pending_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `last_credited_invoice_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `last_credited_period_start` integer;