BEGIN;
DO $role$ BEGIN
  CREATE ROLE nearyou_private_tester_decision NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $role$;
GRANT USAGE ON SCHEMA nearyou TO nearyou_private_tester_decision;
REVOKE nearyou_private_tester_decision FROM nearyou_rollout_controller;
REVOKE nearyou_rollout_controller FROM nearyou_private_tester_decision;
REVOKE ALL ON nearyou.private_tester_activation_baselines,nearyou.private_tester_activation_state,nearyou.private_tester_activation_invites,nearyou.private_tester_activation_audit FROM nearyou_private_tester_decision;
CREATE FUNCTION nearyou.authorize_nearfamily_private_tester(p_household_hash text,p_release_id text,p_observed_at timestamptz) RETURNS TABLE(allowed boolean,expires_at timestamptz) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nearyou AS $$
BEGIN
  IF p_household_hash !~ '^[a-f0-9]{64}$'
    OR p_release_id !~ '^rel_[A-Za-z0-9_-]{8,100}$'
    OR p_observed_at IS NULL
    OR p_observed_at < statement_timestamp() - interval '5 minutes'
    OR p_observed_at > statement_timestamp() + interval '1 minute' THEN
    RETURN QUERY SELECT false,NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT count(*)>0,max(i.expires_at)
  FROM nearyou.private_tester_activation_state s
  JOIN nearyou.private_tester_activation_invites i ON i.product=s.product AND i.release_id=s.release_id
  WHERE s.product='nearfamily'
    AND s.release_id=p_release_id
    AND NOT s.terminal_kill
    AND i.household_hash=p_household_hash
    AND i.release_id=p_release_id
    AND i.revoked_at IS NULL
    AND i.expires_at>p_observed_at
    AND i.expires_at>statement_timestamp();
END $$;
ALTER FUNCTION nearyou.authorize_nearfamily_private_tester(text,text,timestamptz) OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.authorize_nearfamily_private_tester(text,text,timestamptz) FROM PUBLIC,nearyou_app,nearyou_release_verifier,nearyou_rollout_controller,nearyou_private_tester_baseline_verifier,nearyou_migration;
GRANT EXECUTE ON FUNCTION nearyou.authorize_nearfamily_private_tester(text,text,timestamptz) TO nearyou_private_tester_decision;
COMMIT;
