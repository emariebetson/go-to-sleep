BEGIN;
ALTER ROLE nearyou_policy_owner NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE nearyou_release_policy_owner NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE nearyou_cutover_policy_owner NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
DROP POLICY member_select ON nearyou.household_members;
CREATE POLICY member_select ON nearyou.household_members FOR SELECT TO nearyou_app USING (household_id=nearyou.current_household_id() AND nearyou.is_active_household_member(household_id));
DROP POLICY IF EXISTS policy_owner_member_select ON nearyou.household_members;
CREATE POLICY policy_owner_member_select ON nearyou.household_members FOR SELECT TO nearyou_policy_owner USING (true);
DROP FUNCTION nearyou.register_rollout_controller_identity(name,text);
CREATE FUNCTION nearyou.register_rollout_controller_identity(p_database_user name,p_principal text) RETURNS TABLE(database_user text,principal text,effective boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nearyou AS $$ BEGIN IF current_user<>'nearyou_release_policy_owner' OR p_database_user::text!~'^[A-Za-z0-9_.@-]{3,200}$' OR p_principal!~'^service:[A-Za-z0-9_-]{3,100}$' OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=p_database_user::text) OR NOT pg_has_role(p_database_user,'nearyou_rollout_controller','USAGE') THEN RAISE EXCEPTION 'rollout controller identity invalid'; END IF; INSERT INTO nearyou.rollout_controller_identities VALUES(p_database_user,p_principal) ON CONFLICT DO NOTHING; RETURN QUERY SELECT i.database_user::text,i.principal,pg_has_role(i.database_user,'nearyou_rollout_controller','USAGE') FROM nearyou.rollout_controller_identities i WHERE i.database_user=p_database_user AND i.principal=p_principal; END $$;
ALTER FUNCTION nearyou.register_rollout_controller_identity(name,text) OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.register_rollout_controller_identity(name,text) FROM PUBLIC,nearyou_app,nearyou_release_verifier,nearyou_rollout_controller;
GRANT EXECUTE ON FUNCTION nearyou.register_rollout_controller_identity(name,text) TO nearyou_migration;
CREATE ROLE nearyou_private_tester_baseline_verifier NOLOGIN NOINHERIT NOBYPASSRLS;
REVOKE ALL ON SCHEMA nearyou FROM nearyou_private_tester_baseline_verifier;
GRANT USAGE ON SCHEMA nearyou TO nearyou_private_tester_baseline_verifier;
REVOKE ALL ON nearyou.schema_migrations FROM nearyou_rollout_controller,nearyou_private_tester_baseline_verifier;
GRANT SELECT ON nearyou.schema_migrations TO nearyou_private_tester_baseline_verifier;
CREATE TABLE nearyou.private_tester_baseline_verifier_identities(database_user name PRIMARY KEY,principal text NOT NULL UNIQUE CHECK(principal~'^service:[A-Za-z0-9_-]{3,100}$'));
ALTER TABLE nearyou.private_tester_baseline_verifier_identities OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON nearyou.private_tester_baseline_verifier_identities FROM PUBLIC,nearyou_app,nearyou_release_verifier,nearyou_rollout_controller,nearyou_private_tester_baseline_verifier;
GRANT SELECT,INSERT ON nearyou.private_tester_baseline_verifier_identities TO nearyou_release_policy_owner;
CREATE FUNCTION nearyou.register_private_tester_baseline_verifier_identity(p_database_user name,p_principal text) RETURNS TABLE(database_user text,principal text,effective boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nearyou AS $$ BEGIN IF current_user<>'nearyou_release_policy_owner' OR p_database_user::text!~'^[A-Za-z0-9_.@-]{3,200}$' OR p_principal!~'^service:[A-Za-z0-9_-]{3,100}$' OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=p_database_user::text) OR NOT pg_has_role(p_database_user,'nearyou_private_tester_baseline_verifier','USAGE') THEN RAISE EXCEPTION 'private tester baseline verifier identity invalid'; END IF; INSERT INTO nearyou.private_tester_baseline_verifier_identities VALUES(p_database_user,p_principal) ON CONFLICT DO NOTHING; RETURN QUERY SELECT i.database_user::text,i.principal,pg_has_role(i.database_user,'nearyou_private_tester_baseline_verifier','USAGE') FROM nearyou.private_tester_baseline_verifier_identities i WHERE i.database_user=p_database_user AND i.principal=p_principal; END $$;
ALTER FUNCTION nearyou.register_private_tester_baseline_verifier_identity(name,text) OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.register_private_tester_baseline_verifier_identity(name,text) FROM PUBLIC,nearyou_app,nearyou_release_verifier,nearyou_rollout_controller,nearyou_private_tester_baseline_verifier;
GRANT EXECUTE ON FUNCTION nearyou.register_private_tester_baseline_verifier_identity(name,text) TO nearyou_migration;
CREATE FUNCTION nearyou.assert_private_tester_baseline_verifier() RETURNS TABLE(database_name text,database_user text,principal text,effective boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nearyou AS $$ BEGIN IF current_database()<>'nearyou' OR session_user::text!~'^nearyou-private-tester-baseline@nearnight\.iam\.gserviceaccount\.com$' OR NOT pg_has_role(session_user,'nearyou_private_tester_baseline_verifier','USAGE') THEN RAISE EXCEPTION 'private tester baseline verifier session invalid'; END IF; RETURN QUERY SELECT current_database()::text,i.database_user::text,i.principal,true FROM nearyou.private_tester_baseline_verifier_identities i WHERE i.database_user=session_user; IF NOT FOUND THEN RAISE EXCEPTION 'private tester baseline verifier session invalid'; END IF; END $$;
ALTER FUNCTION nearyou.assert_private_tester_baseline_verifier() OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.assert_private_tester_baseline_verifier() FROM PUBLIC,nearyou_app,nearyou_release_verifier,nearyou_rollout_controller,nearyou_migration;
GRANT EXECUTE ON FUNCTION nearyou.assert_private_tester_baseline_verifier() TO nearyou_private_tester_baseline_verifier;
CREATE TABLE nearyou.private_tester_deployment_manifest_nonces (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[A-Za-z0-9_-]{22,128}$'),
  claims_digest text NOT NULL UNIQUE CHECK (claims_digest ~ '^[a-f0-9]{64}$'),
  purpose text NOT NULL CHECK (purpose = 'private-tester-deployment-manifest/v1'),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  principal text NOT NULL CHECK (principal ~ '^[A-Za-z0-9_:/.@-]{3,200}$'),
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_:/.@-]{3,200}$'),
  key_version integer NOT NULL CHECK (key_version > 0),
  release_id text NOT NULL CHECK (release_id ~ '^rel_[A-Za-z0-9_-]{8,100}$'),
  project_id text NOT NULL CHECK (project_id ~ '^appgprj_[A-Za-z0-9_-]{8,128}$'),
  live_version text NOT NULL,
  live_commit text NOT NULL CHECK (live_commit ~ '^[a-f0-9]{40}$'),
  rollback_version text NOT NULL,
  rollback_commit text NOT NULL CHECK (rollback_commit ~ '^[a-f0-9]{40}$'),
  r2_resource text NOT NULL,
  d1_resource text NOT NULL,
  not_before timestamptz NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  canonical_claims text NOT NULL CHECK (octet_length(canonical_claims) <= 16384),
  consumed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (live_version <> rollback_version AND live_commit <> rollback_commit),
  CHECK (not_before <= issued_at),
  CHECK (expires_at - issued_at > interval '0 seconds' AND expires_at - issued_at <= interval '15 minutes')
);
ALTER TABLE nearyou.private_tester_deployment_manifest_nonces OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON nearyou.private_tester_deployment_manifest_nonces FROM PUBLIC,nearyou_app,nearyou_release_verifier,nearyou_release_maintenance,nearyou_release_key_manager,nearyou_cutover_runner;
GRANT SELECT,INSERT ON nearyou.private_tester_deployment_manifest_nonces TO nearyou_release_policy_owner;

CREATE FUNCTION nearyou.consume_private_tester_deployment_manifest(p_purpose text,p_nonce text,p_digest text,p_canonical text,p_principal text,p_key text,p_version integer,p_release text,p_expiry timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nearyou,nearyou_crypto AS $$
DECLARE
  claims jsonb; live jsonb; rollback jsonb; r2 jsonb; d1 jsonb; inserted boolean:=false;
  server_now timestamptz:=statement_timestamp(); server_now_ms bigint:=floor(extract(epoch FROM statement_timestamp())*1000)::bigint;
  not_before_ms bigint; issued_at_ms bigint; expires_at_ms bigint;
BEGIN
  IF p_purpose IS DISTINCT FROM 'private-tester-deployment-manifest/v1' OR octet_length(p_canonical)>16384 OR p_nonce!~'^[A-Za-z0-9_-]{22,128}$' OR p_digest!~'^[a-f0-9]{64}$' OR p_principal!~'^[A-Za-z0-9_:/.@-]{3,200}$' OR p_key!~'^[A-Za-z0-9_:/.@-]{3,200}$' OR p_version<=0 OR p_release!~'^rel_[A-Za-z0-9_-]{8,100}$' OR encode(nearyou_crypto.digest(convert_to(p_purpose||chr(10)||p_canonical,'UTF8'),'sha256'),'hex') IS DISTINCT FROM p_digest THEN RETURN false; END IF;
  BEGIN claims:=p_canonical::jsonb; EXCEPTION WHEN others THEN RETURN false; END;
  IF jsonb_typeof(claims) IS DISTINCT FROM 'object' OR (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(claims) key) IS DISTINCT FROM ARRAY['expiresAt','issuedAt','keyId','keyVersion','live','nonce','notBefore','principal','projectId','releaseId','resources','rollback','schemaVersion']::text[] THEN RETURN false; END IF;
  IF jsonb_typeof(claims->'schemaVersion') IS DISTINCT FROM 'number' OR jsonb_typeof(claims->'nonce') IS DISTINCT FROM 'string' OR jsonb_typeof(claims->'principal') IS DISTINCT FROM 'string' OR jsonb_typeof(claims->'keyId') IS DISTINCT FROM 'string' OR jsonb_typeof(claims->'keyVersion') IS DISTINCT FROM 'number' OR jsonb_typeof(claims->'releaseId') IS DISTINCT FROM 'string' OR jsonb_typeof(claims->'projectId') IS DISTINCT FROM 'string' OR jsonb_typeof(claims->'notBefore') IS DISTINCT FROM 'number' OR jsonb_typeof(claims->'issuedAt') IS DISTINCT FROM 'number' OR jsonb_typeof(claims->'expiresAt') IS DISTINCT FROM 'number' OR jsonb_typeof(claims->'live') IS DISTINCT FROM 'object' OR jsonb_typeof(claims->'rollback') IS DISTINCT FROM 'object' OR jsonb_typeof(claims->'resources') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF claims->>'schemaVersion' IS DISTINCT FROM '1' OR claims->>'nonce' IS DISTINCT FROM p_nonce OR claims->>'principal' IS DISTINCT FROM p_principal OR claims->>'keyId' IS DISTINCT FROM p_key OR claims->>'keyVersion' IS DISTINCT FROM p_version::text OR claims->>'releaseId' IS DISTINCT FROM p_release OR coalesce(claims->>'projectId','')!~'^appgprj_[A-Za-z0-9_-]{8,128}$' OR coalesce(claims->>'notBefore','')!~'^[0-9]{1,16}$' OR coalesce(claims->>'issuedAt','')!~'^[0-9]{1,16}$' OR coalesce(claims->>'expiresAt','')!~'^[0-9]{1,16}$' OR jsonb_array_length(claims->'resources')<>2 THEN RETURN false; END IF;
  not_before_ms:=(claims->>'notBefore')::bigint; issued_at_ms:=(claims->>'issuedAt')::bigint; expires_at_ms:=(claims->>'expiresAt')::bigint;
  IF not_before_ms>issued_at_ms OR issued_at_ms>=expires_at_ms OR expires_at_ms-issued_at_ms>900000 OR not_before_ms>server_now_ms+30000 OR issued_at_ms>server_now_ms+30000 OR server_now_ms-issued_at_ms>300000 OR expires_at_ms<=server_now_ms OR expires_at_ms IS DISTINCT FROM floor(extract(epoch FROM p_expiry)*1000)::bigint THEN RETURN false; END IF;
  live:=claims->'live'; rollback:=claims->'rollback'; r2:=claims->'resources'->0; d1:=claims->'resources'->1;
  IF jsonb_typeof(live->'version') IS DISTINCT FROM 'string' OR jsonb_typeof(live->'commitSha') IS DISTINCT FROM 'string' OR jsonb_typeof(rollback->'version') IS DISTINCT FROM 'string' OR jsonb_typeof(rollback->'commitSha') IS DISTINCT FROM 'string' OR jsonb_typeof(r2) IS DISTINCT FROM 'object' OR jsonb_typeof(d1) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(live) key) IS DISTINCT FROM ARRAY['commitSha','version']::text[] OR (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(rollback) key) IS DISTINCT FROM ARRAY['commitSha','version']::text[] OR coalesce(live->>'version','')!~'^appgprj_[A-Za-z0-9_-]+~appgver_[A-Za-z0-9_-]+$' OR coalesce(rollback->>'version','')!~'^appgprj_[A-Za-z0-9_-]+~appgver_[A-Za-z0-9_-]+$' OR starts_with(live->>'version',claims->>'projectId'||'~appgver_') IS NOT TRUE OR starts_with(rollback->>'version',claims->>'projectId'||'~appgver_') IS NOT TRUE OR coalesce(live->>'commitSha','')!~'^[a-f0-9]{40}$' OR coalesce(rollback->>'commitSha','')!~'^[a-f0-9]{40}$' OR live->>'version'=rollback->>'version' OR live->>'commitSha'=rollback->>'commitSha' THEN RETURN false; END IF;
  IF jsonb_typeof(r2->'binding') IS DISTINCT FROM 'string' OR jsonb_typeof(r2->'kind') IS DISTINCT FROM 'string' OR jsonb_typeof(r2->'resource') IS DISTINCT FROM 'string' OR jsonb_typeof(d1->'binding') IS DISTINCT FROM 'string' OR jsonb_typeof(d1->'kind') IS DISTINCT FROM 'string' OR jsonb_typeof(d1->'resource') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(r2) key) IS DISTINCT FROM ARRAY['binding','kind','resource']::text[] OR (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(d1) key) IS DISTINCT FROM ARRAY['binding','kind','resource']::text[] OR r2->>'binding' IS DISTINCT FROM 'AUDIO' OR r2->>'kind' IS DISTINCT FROM 'r2' OR coalesce(r2->>'resource','')!~'^accounts/[a-f0-9]{32}/r2/buckets/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' OR d1->>'binding' IS DISTINCT FROM 'DB' OR d1->>'kind' IS DISTINCT FROM 'd1' OR coalesce(d1->>'resource','')!~'^accounts/[a-f0-9]{32}/d1/database/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR split_part(r2->>'resource','/',2) IS DISTINCT FROM split_part(d1->>'resource','/',2) THEN RETURN false; END IF;
  INSERT INTO nearyou.private_tester_deployment_manifest_nonces(nonce,claims_digest,purpose,schema_version,principal,key_id,key_version,release_id,project_id,live_version,live_commit,rollback_version,rollback_commit,r2_resource,d1_resource,not_before,issued_at,expires_at,canonical_claims,consumed_at)
  VALUES(p_nonce,p_digest,p_purpose,1,p_principal,p_key,p_version,p_release,claims->>'projectId',live->>'version',live->>'commitSha',rollback->>'version',rollback->>'commitSha',r2->>'resource',d1->>'resource',to_timestamp(not_before_ms/1000.0),to_timestamp(issued_at_ms/1000.0),p_expiry,p_canonical,server_now) ON CONFLICT DO NOTHING RETURNING true INTO inserted;
  RETURN coalesce(inserted,false);
END $$;
ALTER FUNCTION nearyou.consume_private_tester_deployment_manifest(text,text,text,text,text,text,integer,text,timestamptz) OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.consume_private_tester_deployment_manifest(text,text,text,text,text,text,integer,text,timestamptz) FROM PUBLIC,nearyou_app,nearyou_release_maintenance,nearyou_release_key_manager,nearyou_cutover_runner;
REVOKE ALL ON FUNCTION nearyou.consume_private_tester_deployment_manifest(text,text,text,text,text,text,integer,text,timestamptz) FROM nearyou_release_verifier;
REVOKE ALL ON FUNCTION nearyou.consume_private_tester_deployment_manifest(text,text,text,text,text,text,integer,text,timestamptz) FROM nearyou_rollout_controller;
GRANT EXECUTE ON FUNCTION nearyou.consume_private_tester_deployment_manifest(text,text,text,text,text,text,integer,text,timestamptz) TO nearyou_private_tester_baseline_verifier;

CREATE FUNCTION nearyou.reject_private_tester_deployment_manifest_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,nearyou AS $$ BEGIN RAISE EXCEPTION 'private_tester_deployment_manifest_immutable'; END $$;
ALTER FUNCTION nearyou.reject_private_tester_deployment_manifest_mutation() OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.reject_private_tester_deployment_manifest_mutation() FROM PUBLIC,nearyou_app;
CREATE TRIGGER private_tester_deployment_manifest_immutable BEFORE UPDATE OR DELETE ON nearyou.private_tester_deployment_manifest_nonces FOR EACH ROW EXECUTE FUNCTION nearyou.reject_private_tester_deployment_manifest_mutation();
COMMIT;
