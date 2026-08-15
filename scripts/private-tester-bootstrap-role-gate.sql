\set ON_ERROR_STOP on
DROP ROLE IF EXISTS nearyou_bootstrap_role_gate;
CREATE ROLE nearyou_bootstrap_role_gate NOLOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION;
GRANT cloudsqlsuperuser TO nearyou_bootstrap_role_gate WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;
GRANT nearyou_migration TO nearyou_bootstrap_role_gate WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
SET SESSION AUTHORIZATION nearyou_bootstrap_role_gate;
GRANT nearyou_migration TO CURRENT_USER WITH ADMIN TRUE, INHERIT TRUE, SET TRUE;
GRANT nearyou_migration TO CURRENT_USER WITH ADMIN TRUE, INHERIT TRUE, SET TRUE;
BEGIN;
SET LOCAL ROLE nearyou_migration;
SELECT current_user='nearyou_migration' AS role_switch_succeeded;
ROLLBACK;
RESET SESSION AUTHORIZATION;
DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles role ON role.oid=m.roleid
    JOIN pg_roles member ON member.oid=m.member
    WHERE role.rolname='nearyou_migration'
      AND member.rolname='nearyou_bootstrap_role_gate'
      AND m.inherit_option AND m.set_option AND m.admin_option
  ) THEN RAISE EXCEPTION 'bootstrap membership options invalid'; END IF;
END $$;
REVOKE nearyou_migration,cloudsqlsuperuser FROM nearyou_bootstrap_role_gate;
DROP ROLE nearyou_bootstrap_role_gate;
