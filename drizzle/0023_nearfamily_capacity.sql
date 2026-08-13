CREATE VIEW `household_capacity_projection` AS
WITH `usage` AS (
  SELECT h.`id` AS `household_id`,
    COALESCE((SELECT `plan_id` FROM `entitlements` e WHERE e.`household_id`=h.`id` AND e.`status` IN ('active','grace') AND e.`valid_from`<=unixepoch('subsec')*1000 AND (e.`valid_until` IS NULL OR e.`valid_until`>unixepoch('subsec')*1000) ORDER BY CASE WHEN e.`plan_id`='nearsleep_free' THEN 0 ELSE 1 END DESC,CASE WHEN e.`status`='active' THEN 1 ELSE 0 END DESC,e.`updated_at` DESC,e.`id` DESC LIMIT 1),'') AS `plan_id`,
    (SELECT COUNT(*) FROM `household_members` m WHERE m.`household_id`=h.`id` AND m.`status`='active')+(SELECT COUNT(*) FROM `household_invitations` i WHERE i.`household_id`=h.`id` AND i.`status`='pending' AND i.`expires_at`>unixepoch('subsec')*1000) AS `members`,
    (SELECT COUNT(*) FROM `child_profiles` c WHERE c.`household_id`=h.`id` AND c.`archived_at` IS NULL) AS `children`,
    (SELECT COUNT(*) FROM `voices` v WHERE v.`household_id`=h.`id` AND v.`status` IN ('processing','ready')) AS `voices`,
    COALESCE((SELECT SUM(a.`byte_size`) FROM `media_assets` a WHERE a.`household_id`=h.`id` AND a.`status`='ready'),0) AS `storage_bytes`
  FROM `households` h
),`limits` AS (
  SELECT *,
    CASE `plan_id` WHEN 'nearsleep_free' THEN 1 WHEN 'nearsleep_plus_legacy' THEN 1 WHEN 'nearyou_plus' THEN 2 WHEN 'nearyou_family' THEN 5 WHEN 'nearlegacy' THEN 8 ELSE 0 END AS `member_limit`,
    CASE `plan_id` WHEN 'nearsleep_free' THEN 1 WHEN 'nearsleep_plus_legacy' THEN 3 WHEN 'nearyou_plus' THEN 2 WHEN 'nearyou_family' THEN 5 WHEN 'nearlegacy' THEN 5 ELSE 0 END AS `child_limit`,
    CASE `plan_id` WHEN 'nearsleep_free' THEN 1 WHEN 'nearsleep_plus_legacy' THEN 1 WHEN 'nearyou_plus' THEN 1 WHEN 'nearyou_family' THEN 2 WHEN 'nearlegacy' THEN 5 ELSE 0 END AS `voice_limit`,
    CASE `plan_id` WHEN 'nearsleep_free' THEN 1000000000 WHEN 'nearsleep_plus_legacy' THEN 5000000000 WHEN 'nearyou_plus' THEN 5000000000 WHEN 'nearyou_family' THEN 25000000000 WHEN 'nearlegacy' THEN 100000000000 ELSE 0 END AS `storage_limit`
  FROM `usage`
)
SELECT *,CASE WHEN `members`>`member_limit` OR `children`>`child_limit` OR `voices`>`voice_limit` OR `storage_bytes`>`storage_limit` THEN 'restricted' ELSE 'within_limit' END AS `state`,
  (SELECT json_group_array(`dimension`) FROM (SELECT 'members' `dimension` WHERE `members`>`member_limit` UNION ALL SELECT 'children' WHERE `children`>`child_limit` UNION ALL SELECT 'voices' WHERE `voices`>`voice_limit` UNION ALL SELECT 'storageBytes' WHERE `storage_bytes`>`storage_limit`)) AS `exceeded_json`
FROM `limits`;
--> statement-breakpoint
CREATE TABLE `household_capacity_state` (
  `household_id` text PRIMARY KEY NOT NULL REFERENCES `households`(`id`) ON DELETE CASCADE,
  `plan_id` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('within_limit','restricted')),
  `exceeded_json` text NOT NULL CHECK (json_valid(`exceeded_json`)),
  `evaluated_at` integer NOT NULL,
  `version` integer NOT NULL CHECK (`version`>0)
);
--> statement-breakpoint
CREATE TRIGGER `household_capacity_state_insert_authoritative` BEFORE INSERT ON `household_capacity_state`
BEGIN
  SELECT CASE WHEN NEW.`version`<>1 OR NOT EXISTS(SELECT 1 FROM `household_capacity_projection` p WHERE p.`household_id`=NEW.`household_id` AND p.`plan_id`=NEW.`plan_id` AND p.`state`=NEW.`state` AND p.`exceeded_json`=NEW.`exceeded_json`) THEN RAISE(ABORT,'capacity_state_authoritative') END;
END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_state_update_authoritative` BEFORE UPDATE ON `household_capacity_state`
BEGIN
  SELECT CASE WHEN NEW.`household_id` IS NOT OLD.`household_id` OR NEW.`version`<>OLD.`version`+1 OR NOT EXISTS(SELECT 1 FROM `household_capacity_projection` p WHERE p.`household_id`=NEW.`household_id` AND p.`plan_id`=NEW.`plan_id` AND p.`state`=NEW.`state` AND p.`exceeded_json`=NEW.`exceeded_json`) THEN RAISE(ABORT,'capacity_state_authoritative') END;
END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_state_delete_guard` BEFORE DELETE ON `household_capacity_state`
WHEN EXISTS(SELECT 1 FROM `households` WHERE `id`=OLD.`household_id`)
BEGIN SELECT RAISE(ABORT,'capacity_state_authoritative'); END;
--> statement-breakpoint
INSERT INTO `household_capacity_state`(`household_id`,`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`) SELECT `household_id`,`plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,1 FROM `household_capacity_projection`;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_household_insert` AFTER INSERT ON `households` BEGIN INSERT INTO `household_capacity_state`(`household_id`,`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`) SELECT `household_id`,`plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_entitlement_insert` AFTER INSERT ON `entitlements` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) WHERE `household_id`=NEW.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_entitlement_update` AFTER UPDATE ON `entitlements` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) WHERE `household_id`=NEW.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_entitlement_delete` AFTER DELETE ON `entitlements` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=OLD.`household_id`) WHERE `household_id`=OLD.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_member_insert` AFTER INSERT ON `household_members` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) WHERE `household_id`=NEW.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_member_update` AFTER UPDATE ON `household_members` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) WHERE `household_id`=NEW.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_member_delete` AFTER DELETE ON `household_members` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=OLD.`household_id`) WHERE `household_id`=OLD.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_invitation_insert` AFTER INSERT ON `household_invitations` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) WHERE `household_id`=NEW.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_invitation_update` AFTER UPDATE ON `household_invitations` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) WHERE `household_id`=NEW.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_invitation_delete` AFTER DELETE ON `household_invitations` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=OLD.`household_id`) WHERE `household_id`=OLD.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_child_insert` AFTER INSERT ON `child_profiles` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) WHERE `household_id`=NEW.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_child_update` AFTER UPDATE ON `child_profiles` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) WHERE `household_id`=NEW.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_child_delete` AFTER DELETE ON `child_profiles` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=OLD.`household_id`) WHERE `household_id`=OLD.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_voice_insert` AFTER INSERT ON `voices` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) WHERE `household_id`=NEW.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_voice_update` AFTER UPDATE ON `voices` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) WHERE `household_id`=NEW.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_voice_delete` AFTER DELETE ON `voices` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=OLD.`household_id`) WHERE `household_id`=OLD.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_media_insert` AFTER INSERT ON `media_assets` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) WHERE `household_id`=NEW.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_media_update` AFTER UPDATE ON `media_assets` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=NEW.`household_id`) WHERE `household_id`=NEW.`household_id`; END;
--> statement-breakpoint
CREATE TRIGGER `household_capacity_after_media_delete` AFTER DELETE ON `media_assets` BEGIN UPDATE `household_capacity_state` SET (`plan_id`,`state`,`exceeded_json`,`evaluated_at`,`version`)=(SELECT `plan_id`,`state`,`exceeded_json`,unixepoch('subsec')*1000,`household_capacity_state`.`version`+1 FROM `household_capacity_projection` WHERE `household_id`=OLD.`household_id`) WHERE `household_id`=OLD.`household_id`; END;
