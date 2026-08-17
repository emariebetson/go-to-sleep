BEGIN;
CREATE OR REPLACE FUNCTION nearyou.assert_private_tester_baseline_verifier() RETURNS TABLE(database_name text,database_user text,principal text,effective boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nearyou AS $$ BEGIN IF current_database()<>'nearyou' OR session_user::text<>'nearyou-pt-baseline@nearnight.iam' OR NOT pg_has_role(session_user,'nearyou_private_tester_baseline_verifier','USAGE') THEN RAISE EXCEPTION 'private tester baseline verifier session invalid'; END IF; RETURN QUERY SELECT current_database()::text,i.database_user::text,i.principal,true FROM nearyou.private_tester_baseline_verifier_identities i WHERE i.database_user=session_user; IF NOT FOUND THEN RAISE EXCEPTION 'private tester baseline verifier session invalid'; END IF; END $$;
ALTER FUNCTION nearyou.assert_private_tester_baseline_verifier() OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.assert_private_tester_baseline_verifier() FROM PUBLIC,nearyou_app,nearyou_release_verifier,nearyou_rollout_controller,nearyou_migration;
GRANT EXECUTE ON FUNCTION nearyou.assert_private_tester_baseline_verifier() TO nearyou_private_tester_baseline_verifier;
COMMIT;
