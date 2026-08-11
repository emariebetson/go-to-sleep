ALTER TABLE `child_profiles` ADD `pronunciation` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `child_profiles`
SET `pronunciation` = COALESCE((
  SELECT `children`.`pronunciation`
  FROM `children`
  WHERE `children`.`id` = `child_profiles`.`legacy_child_id`
    AND `children`.`household_id` = `child_profiles`.`household_id`
), '')
WHERE `legacy_child_id` IS NOT NULL;
