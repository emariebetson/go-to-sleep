DROP TRIGGER `household_capacity_after_household_insert`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_entitlement_insert`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_entitlement_update`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_entitlement_delete`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_member_insert`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_member_update`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_member_delete`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_invitation_insert`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_invitation_update`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_invitation_delete`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_child_insert`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_child_update`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_child_delete`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_voice_insert`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_voice_update`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_voice_delete`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_media_insert`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_media_update`;
--> statement-breakpoint
DROP TRIGGER `household_capacity_after_media_delete`;
--> statement-breakpoint
DROP TABLE `household_capacity_state`;
--> statement-breakpoint
DROP TRIGGER `child_profiles_validate_household_capacity_insert`;
--> statement-breakpoint
DROP TRIGGER `child_profiles_validate_household_capacity_restore`;
--> statement-breakpoint
DROP TRIGGER `voices_validate_household_slot_insert`;
--> statement-breakpoint
DROP TRIGGER `voices_validate_household_slot_update`;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_guard_invitation_insert` BEFORE INSERT ON `household_invitations`
WHEN NEW.`status`='pending' AND EXISTS(SELECT 1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id` AND `state`='restricted')
BEGIN SELECT RAISE(ABORT,'household_capacity_restricted');

END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_guard_invitation_restore` BEFORE UPDATE OF `status` ON `household_invitations`
WHEN OLD.`status`<>'pending' AND NEW.`status`='pending' AND EXISTS(SELECT 1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id` AND `state`='restricted')
BEGIN SELECT RAISE(ABORT,'household_capacity_restricted');

END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_guard_member_insert` BEFORE INSERT ON `household_members`
WHEN NEW.`status`='active' AND NOT EXISTS(SELECT 1 FROM `household_members` WHERE `id`=NEW.`id`) AND EXISTS(SELECT 1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id` AND `state`='restricted')
BEGIN SELECT RAISE(ABORT,'household_capacity_restricted');

END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_guard_member_restore` BEFORE UPDATE OF `status` ON `household_members`
WHEN OLD.`status`<>'active' AND NEW.`status`='active' AND EXISTS(SELECT 1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id` AND `state`='restricted')
BEGIN SELECT RAISE(ABORT,'household_capacity_restricted');

END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_guard_child_insert` BEFORE INSERT ON `child_profiles`
WHEN NEW.`archived_at` IS NULL AND EXISTS(SELECT 1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id` AND `state`='restricted')
BEGIN SELECT RAISE(ABORT,'household_capacity_restricted');

END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_guard_child_restore` BEFORE UPDATE OF `archived_at` ON `child_profiles`
WHEN OLD.`archived_at` IS NOT NULL AND NEW.`archived_at` IS NULL AND EXISTS(SELECT 1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id` AND `state`='restricted')
BEGIN SELECT RAISE(ABORT,'household_capacity_restricted');

END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_guard_voice_insert` BEFORE INSERT ON `voices`
WHEN NEW.`household_id` IS NOT NULL AND NEW.`status` IN ('processing','ready') AND EXISTS(SELECT 1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id` AND `state`='restricted')
BEGIN SELECT RAISE(ABORT,'household_capacity_restricted');

END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_guard_voice_restore` BEFORE UPDATE OF `status` ON `voices`
WHEN OLD.`status` NOT IN ('processing','ready') AND NEW.`status` IN ('processing','ready') AND EXISTS(SELECT 1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id` AND `state`='restricted')
BEGIN SELECT RAISE(ABORT,'household_capacity_restricted');

END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_guard_storage_reservation` BEFORE INSERT ON `household_storage_reservations`
WHEN NEW.`status`='reserved' AND EXISTS(SELECT 1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id` AND `state`='restricted')
BEGIN SELECT RAISE(ABORT,'household_capacity_restricted');

END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_guard_media_ready` BEFORE UPDATE OF `status` ON `media_assets`
WHEN OLD.`status`='processing' AND NEW.`status`='ready' AND EXISTS(SELECT 1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id` AND `state`='restricted')
BEGIN SELECT RAISE(ABORT,'household_capacity_restricted');

END;
--> statement-breakpoint
CREATE TRIGGER `child_profiles_validate_household_capacity_insert` BEFORE INSERT ON `child_profiles`
WHEN NEW.`archived_at` IS NULL
BEGIN SELECT CASE WHEN (SELECT `children`>=`child_limit` FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) THEN RAISE(ABORT,'household_child_limit_reached') END;
END;
--> statement-breakpoint
CREATE TRIGGER `child_profiles_validate_household_capacity_restore` BEFORE UPDATE OF `archived_at` ON `child_profiles`
WHEN OLD.`archived_at` IS NOT NULL AND NEW.`archived_at` IS NULL
BEGIN SELECT CASE WHEN (SELECT `children`>=`child_limit` FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) THEN RAISE(ABORT,'household_child_limit_reached') END;
END;
--> statement-breakpoint
CREATE TRIGGER `voices_validate_household_slot_insert` BEFORE INSERT ON `voices`
WHEN NEW.`household_id` IS NOT NULL AND NEW.`status` IN ('processing','ready')
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id` AND `plan_id`<>'') THEN RAISE(ABORT,'voice_entitlement_required') END;
SELECT CASE WHEN NEW.`creation_request_id` IS NOT NULL AND (SELECT `plan_id` FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`)='nearsleep_free' THEN RAISE(ABORT,'free_voice_clone_unavailable') END;
SELECT CASE WHEN (SELECT `voices`>=`voice_limit` FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) THEN RAISE(ABORT,'household_voice_limit_reached') END;
END;
--> statement-breakpoint
CREATE TRIGGER `voices_validate_household_slot_update` BEFORE UPDATE OF `status` ON `voices`
WHEN NEW.`household_id` IS NOT NULL AND NEW.`status` IN ('processing','ready') AND OLD.`status` NOT IN ('processing','ready')
BEGIN SELECT CASE WHEN (SELECT `voices`>=`voice_limit` FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) THEN RAISE(ABORT,'household_voice_limit_reached') END;
END;
