CREATE TRIGGER `child_profiles_household_binding_immutable` BEFORE UPDATE OF `household_id` ON `child_profiles`
WHEN NEW.`household_id` IS NOT OLD.`household_id`
BEGIN SELECT RAISE(ABORT,'household_binding_immutable');

END;
--> statement-breakpoint
CREATE TRIGGER `household_members_household_binding_immutable` BEFORE UPDATE OF `household_id` ON `household_members`
WHEN NEW.`household_id` IS NOT OLD.`household_id`
BEGIN SELECT RAISE(ABORT,'household_binding_immutable');

END;
--> statement-breakpoint
CREATE TRIGGER `household_invitations_household_binding_immutable` BEFORE UPDATE OF `household_id` ON `household_invitations`
WHEN NEW.`household_id` IS NOT OLD.`household_id`
BEGIN SELECT RAISE(ABORT,'household_binding_immutable');

END;
