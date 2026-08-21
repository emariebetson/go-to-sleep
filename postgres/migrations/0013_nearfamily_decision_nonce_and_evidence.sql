BEGIN;
CREATE TABLE nearyou.nearfamily_decision_nonces(
  issuer text NOT NULL CHECK(issuer~'^[A-Za-z0-9_:/.@-]{3,200}$'),
  key_version integer NOT NULL CHECK(key_version>0),
  nonce text NOT NULL CHECK(nonce~'^[A-Za-z0-9_-]{22,128}$'),
  request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(issuer,key_version,nonce),
  CHECK(expires_at>consumed_at AND expires_at<=consumed_at+interval '10 minutes')
);
ALTER TABLE nearyou.nearfamily_decision_nonces OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON nearyou.nearfamily_decision_nonces FROM PUBLIC,nearyou_app,nearyou_release_verifier,nearyou_rollout_controller,nearyou_private_tester_baseline_verifier,nearyou_private_tester_decision,nearyou_migration;
ALTER TABLE nearyou.nearfamily_decision_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE nearyou.nearfamily_decision_nonces FORCE ROW LEVEL SECURITY;
CREATE POLICY nearfamily_decision_nonces_owner ON nearyou.nearfamily_decision_nonces TO nearyou_release_policy_owner USING(true) WITH CHECK(true);

CREATE FUNCTION nearyou.consume_nearfamily_decision_nonce(p_issuer text,p_key_version integer,p_nonce text,p_request_sha256 text,p_expires_at timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nearyou AS $$
DECLARE inserted boolean:=false; server_now timestamptz:=statement_timestamp();
BEGIN
  IF p_issuer!~'^[A-Za-z0-9_:/.@-]{3,200}$' OR p_key_version<=0 OR p_nonce!~'^[A-Za-z0-9_-]{22,128}$' OR p_request_sha256!~'^[a-f0-9]{64}$' OR p_expires_at<=server_now OR p_expires_at>server_now+interval '10 minutes' THEN RETURN false; END IF;
  INSERT INTO nearyou.nearfamily_decision_nonces(issuer,key_version,nonce,request_sha256,expires_at,consumed_at) VALUES(p_issuer,p_key_version,p_nonce,p_request_sha256,p_expires_at,server_now) ON CONFLICT DO NOTHING RETURNING true INTO inserted;
  RETURN coalesce(inserted,false);
END $$;
ALTER FUNCTION nearyou.consume_nearfamily_decision_nonce(text,integer,text,text,timestamptz) OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.consume_nearfamily_decision_nonce(text,integer,text,text,timestamptz) FROM PUBLIC,nearyou_app,nearyou_release_verifier,nearyou_rollout_controller,nearyou_private_tester_baseline_verifier,nearyou_migration;
GRANT EXECUTE ON FUNCTION nearyou.consume_nearfamily_decision_nonce(text,integer,text,text,timestamptz) TO nearyou_private_tester_decision;

CREATE OR REPLACE FUNCTION nearyou.authorize_nearfamily_private_tester(p_household_hash text,p_release_id text,p_observed_at timestamptz) RETURNS TABLE(allowed boolean,expires_at timestamptz) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nearyou AS $$
BEGIN
  IF p_household_hash !~ '^[a-f0-9]{64}$' OR p_release_id !~ '^rel_[A-Za-z0-9_-]{8,100}$' OR p_observed_at IS NULL OR p_observed_at < statement_timestamp() - interval '5 minutes' OR p_observed_at > statement_timestamp() + interval '1 minute' THEN RETURN QUERY SELECT false,NULL::timestamptz; RETURN; END IF;
  RETURN QUERY
  SELECT count(*)>0,least(max(i.expires_at),max(to_timestamp((e.claims_projection->>'expiresAt')::double precision/1000)),max(readiness.expires_at))
  FROM nearyou.private_tester_activation_state s
  JOIN nearyou.private_tester_activation_baselines b ON b.sha256=s.promoted_baseline_sha256 AND b.release_id=s.release_id
  JOIN nearyou.release_evidence_audit e ON e.claims_digest=s.evidence_digest AND e.release_id=s.release_id
  JOIN LATERAL (
    SELECT min(to_timestamp((item->>'expiresAt')::double precision/1000)) AS expires_at
    FROM jsonb_array_elements(e.claims_projection->'productReadiness') item
    WHERE item->>'product'='nearfamily' AND item->>'releaseId'=s.release_id AND item->'controllerMapping'->>'verified'='true' AND (item->>'expiresAt')::bigint>floor(extract(epoch FROM p_observed_at)*1000)
  ) readiness ON readiness.expires_at IS NOT NULL
  JOIN nearyou.private_tester_activation_invites i ON i.product=s.product AND i.release_id=s.release_id
  WHERE s.product='nearfamily' AND s.release_id=p_release_id AND NOT s.terminal_kill AND b.dark_gates='{"nearfamily":false,"nearstory":false,"scheduler":false}'::jsonb AND jsonb_typeof(e.claims_projection->'productReadiness')='array' AND jsonb_typeof(e.claims_projection->'expiresAt')='number' AND (e.claims_projection->>'expiresAt')::bigint>floor(extract(epoch FROM p_observed_at)*1000) AND (e.claims_projection->>'expiresAt')::bigint>floor(extract(epoch FROM statement_timestamp())*1000) AND i.household_hash=p_household_hash AND i.revoked_at IS NULL AND i.expires_at>p_observed_at AND i.expires_at>statement_timestamp();
END $$;
ALTER FUNCTION nearyou.authorize_nearfamily_private_tester(text,text,timestamptz) OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.authorize_nearfamily_private_tester(text,text,timestamptz) FROM PUBLIC,nearyou_app,nearyou_release_verifier,nearyou_rollout_controller,nearyou_private_tester_baseline_verifier,nearyou_migration;
GRANT EXECUTE ON FUNCTION nearyou.authorize_nearfamily_private_tester(text,text,timestamptz) TO nearyou_private_tester_decision;
COMMIT;
