BEGIN;
CREATE FUNCTION nearyou.load_private_canary_rollout(p_release text,p_invited_hash text,p_denied_hash text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nearyou AS $$
DECLARE s nearyou.product_rollout_state%ROWTYPE; invited_expiry timestamptz;
BEGIN
 IF p_release !~ '^rel_[A-Za-z0-9_-]{8,96}$' OR p_invited_hash !~ '^[a-f0-9]{64}$' OR p_denied_hash !~ '^[a-f0-9]{64}$' OR p_invited_hash=p_denied_hash THEN RAISE EXCEPTION 'private canary observation invalid'; END IF;
 SELECT * INTO s FROM nearyou.product_rollout_state WHERE product='nearfamily';
 SELECT expires_at INTO invited_expiry FROM nearyou.product_canary_invites WHERE product='nearfamily' AND release_id=p_release AND household_hash=p_invited_hash AND expires_at>statement_timestamp();
 RETURN jsonb_build_object('releaseId',s.release_id,'mode',s.mode,'killSwitch',s.kill_switch,'invitedAllowed',invited_expiry IS NOT NULL,'deniedAllowed',EXISTS(SELECT 1 FROM nearyou.product_canary_invites WHERE product='nearfamily' AND release_id=p_release AND household_hash=p_denied_hash AND expires_at>statement_timestamp()),'inviteExpiresAt',CASE WHEN invited_expiry IS NULL THEN 0 ELSE floor(extract(epoch from invited_expiry)*1000)::bigint END,'observedAt',floor(extract(epoch from statement_timestamp())*1000)::bigint);
END $$;
ALTER FUNCTION nearyou.load_private_canary_rollout(text,text,text) OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.load_private_canary_rollout(text,text,text) FROM PUBLIC,nearyou_app;
GRANT EXECUTE ON FUNCTION nearyou.load_private_canary_rollout(text,text,text) TO nearyou_release_verifier;
CREATE FUNCTION nearyou.load_private_story_readiness(p_release text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,nearyou AS $$
 WITH exact_row AS (
   SELECT e.canonical_product FROM nearyou.product_rollout_state s JOIN nearyou.product_readiness_evidence e
     ON e.product=s.product AND e.release_id=s.release_id AND e.evidence_digest=s.evidence_digest
   WHERE s.product='nearstory' AND s.release_id=p_release AND s.mode='canary' AND NOT s.kill_switch
     AND e.expires_at>statement_timestamp() AND e.canonical_product->>'product'='nearstory'
 ), readiness AS (SELECT CASE WHEN (SELECT count(*) FROM exact_row)=1 THEN (SELECT canonical_product FROM exact_row) ELSE NULL END product)
 SELECT jsonb_build_object('releaseId',p_release,'providerPrerequisites',product IS NOT NULL AND
   (product->'probes'->'worker'->>'passed')::boolean IS TRUE AND
   (product->'probes'->'scheduler'->>'passed')::boolean IS TRUE AND
   (product->'probes'->'processor'->>'passed')::boolean IS TRUE AND
   (product->'probes'->'provider'->>'passed')::boolean IS TRUE,
   'observedAt',floor(extract(epoch from statement_timestamp())*1000)::bigint) FROM readiness
$$;
ALTER FUNCTION nearyou.load_private_story_readiness(text) OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.load_private_story_readiness(text) FROM PUBLIC,nearyou_app;
GRANT EXECUTE ON FUNCTION nearyou.load_private_story_readiness(text) TO nearyou_release_verifier;
COMMIT;
