BEGIN;
DO $$ BEGIN CREATE ROLE nearyou_release_policy_owner NOLOGIN NOINHERIT BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE nearyou_release_verifier NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE nearyou_release_key_manager NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE nearyou_release_maintenance NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE nearyou_release_policy_owner NOLOGIN NOINHERIT BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE nearyou_release_verifier NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE nearyou_release_key_manager NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE nearyou_release_maintenance NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

CREATE SCHEMA IF NOT EXISTS nearyou_crypto;
REVOKE ALL ON SCHEMA nearyou_crypto FROM PUBLIC;
ALTER EXTENSION pgcrypto SET SCHEMA nearyou_crypto;
GRANT USAGE ON SCHEMA nearyou_crypto TO nearyou_release_policy_owner;

CREATE TABLE nearyou.release_signing_keys (
  principal text NOT NULL CHECK (principal ~ '^[A-Za-z0-9_:/.@-]{3,200}$'),
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_:/.@-]{3,200}$'),
  version integer NOT NULL CHECK (version > 0),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('active','retiring','revoked')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  revoked_at timestamptz,
  usage text NOT NULL CHECK (usage = 'release-evidence'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (valid_from < valid_until),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  PRIMARY KEY (principal,key_id,version)
);
CREATE TABLE nearyou.consumed_evidence_nonces (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[A-Za-z0-9_-]{22,128}$'),
  claims_digest text NOT NULL UNIQUE CHECK (claims_digest ~ '^[a-f0-9]{64}$'),
  principal text NOT NULL CHECK (principal ~ '^[A-Za-z0-9_:/.@-]{3,200}$'),
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_:/.@-]{3,200}$'),
  key_version integer NOT NULL CHECK (key_version > 0),
  release_id text NOT NULL CHECK (release_id ~ '^[A-Za-z0-9_:/.@-]{3,200}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (expires_at > consumed_at AND expires_at <= consumed_at + interval '10 minutes')
);
CREATE TABLE nearyou.release_evidence_audit (
  nonce_hash text PRIMARY KEY CHECK (nonce_hash ~ '^[a-f0-9]{64}$'),
  claims_digest text NOT NULL UNIQUE CHECK (claims_digest ~ '^[a-f0-9]{64}$'),
  principal text NOT NULL,
  key_id text NOT NULL,
  key_version integer NOT NULL,
  release_id text NOT NULL,
  consumed_at timestamptz NOT NULL
);
CREATE TABLE nearyou.release_signing_key_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  principal text NOT NULL,
  key_id text NOT NULL,
  version integer NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  previous_status text,
  status text NOT NULL CHECK (status IN ('active','retiring','revoked')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
REVOKE ALL ON nearyou.release_signing_keys, nearyou.consumed_evidence_nonces, nearyou.release_evidence_audit, nearyou.release_signing_key_audit FROM PUBLIC, nearyou_release_verifier, nearyou_release_maintenance, nearyou_release_key_manager;
GRANT USAGE ON SCHEMA nearyou TO nearyou_release_policy_owner, nearyou_release_verifier, nearyou_release_key_manager, nearyou_release_maintenance;
GRANT SELECT ON nearyou.release_signing_keys TO nearyou_release_verifier;
GRANT SELECT,INSERT,UPDATE ON nearyou.release_signing_keys TO nearyou_release_policy_owner;
GRANT INSERT ON nearyou.release_signing_key_audit TO nearyou_release_policy_owner;
GRANT USAGE ON SEQUENCE nearyou.release_signing_key_audit_audit_id_seq TO nearyou_release_policy_owner;
GRANT SELECT,INSERT,DELETE ON nearyou.consumed_evidence_nonces TO nearyou_release_policy_owner;
GRANT INSERT ON nearyou.release_evidence_audit TO nearyou_release_policy_owner;

CREATE FUNCTION nearyou.register_release_signing_key(p_principal text,p_key text,p_version integer,p_fingerprint text,p_valid_from timestamptz,p_valid_until timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=nearyou,pg_temp AS $$
BEGIN
  IF p_principal !~ '^[A-Za-z0-9_:/.@-]{3,200}$' OR p_key !~ '^[A-Za-z0-9_:/.@-]{3,200}$' OR p_version <= 0 OR p_fingerprint !~ '^[a-f0-9]{64}$' OR p_valid_from >= p_valid_until OR p_valid_until <= statement_timestamp() THEN RETURN false; END IF;
  INSERT INTO nearyou.release_signing_keys(principal,key_id,version,fingerprint,status,valid_from,valid_until,usage)
  VALUES(p_principal,p_key,p_version,p_fingerprint,'active',p_valid_from,p_valid_until,'release-evidence') ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO nearyou.release_signing_key_audit(principal,key_id,version,fingerprint,previous_status,status,valid_from,valid_until)
  VALUES(p_principal,p_key,p_version,p_fingerprint,NULL,'active',p_valid_from,p_valid_until);
  RETURN true;
END $$;
ALTER FUNCTION nearyou.register_release_signing_key(text,text,integer,text,timestamptz,timestamptz) OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.register_release_signing_key(text,text,integer,text,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nearyou.register_release_signing_key(text,text,integer,text,timestamptz,timestamptz) TO nearyou_release_key_manager;

CREATE FUNCTION nearyou.transition_release_signing_key(p_principal text,p_key text,p_version integer,p_status text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=nearyou,pg_temp AS $$
DECLARE prior nearyou.release_signing_keys%ROWTYPE;
BEGIN
  IF p_status NOT IN ('retiring','revoked') THEN RETURN false; END IF;
  SELECT * INTO prior FROM nearyou.release_signing_keys WHERE principal=p_principal AND key_id=p_key AND version=p_version FOR UPDATE;
  IF NOT FOUND OR prior.status='revoked' OR (prior.status='retiring' AND p_status<>'revoked') THEN RETURN false; END IF;
  UPDATE nearyou.release_signing_keys SET status=p_status,revoked_at=CASE WHEN p_status='revoked' THEN statement_timestamp() ELSE NULL END WHERE principal=p_principal AND key_id=p_key AND version=p_version;
  INSERT INTO nearyou.release_signing_key_audit(principal,key_id,version,fingerprint,previous_status,status,valid_from,valid_until)
  VALUES(prior.principal,prior.key_id,prior.version,prior.fingerprint,prior.status,p_status,prior.valid_from,prior.valid_until);
  RETURN true;
END $$;
ALTER FUNCTION nearyou.transition_release_signing_key(text,text,integer,text) OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.transition_release_signing_key(text,text,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nearyou.transition_release_signing_key(text,text,integer,text) TO nearyou_release_key_manager;

CREATE FUNCTION nearyou.reject_release_signing_key_rewrite() RETURNS trigger LANGUAGE plpgsql SET search_path=nearyou,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.principal IS DISTINCT FROM NEW.principal OR OLD.key_id IS DISTINCT FROM NEW.key_id OR OLD.version IS DISTINCT FROM NEW.version OR OLD.fingerprint IS DISTINCT FROM NEW.fingerprint OR OLD.valid_from IS DISTINCT FROM NEW.valid_from OR OLD.valid_until IS DISTINCT FROM NEW.valid_until OR OLD.usage IS DISTINCT FROM NEW.usage OR OLD.created_at IS DISTINCT FROM NEW.created_at OR NEW.status NOT IN ('retiring','revoked') OR OLD.status='revoked' OR (OLD.status='retiring' AND NEW.status<>'revoked') THEN RAISE EXCEPTION 'release_signing_key_immutable'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION nearyou.reject_release_signing_key_rewrite() FROM PUBLIC;
CREATE TRIGGER release_signing_key_immutable BEFORE UPDATE OR DELETE ON nearyou.release_signing_keys FOR EACH ROW EXECUTE FUNCTION nearyou.reject_release_signing_key_rewrite();

CREATE FUNCTION nearyou.consume_evidence_nonce(p_nonce text,p_digest text,p_principal text,p_key text,p_version integer,p_release text,p_expiry timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=nearyou,pg_temp AS $$
DECLARE inserted boolean := false; server_now timestamptz := statement_timestamp();
BEGIN
  IF p_nonce !~ '^[A-Za-z0-9_-]{22,128}$' OR p_digest !~ '^[a-f0-9]{64}$' OR p_principal !~ '^[A-Za-z0-9_:/.@-]{3,200}$' OR p_key !~ '^[A-Za-z0-9_:/.@-]{3,200}$' OR p_release !~ '^[A-Za-z0-9_:/.@-]{3,200}$' OR p_version <= 0 OR p_expiry <= server_now OR p_expiry > server_now + interval '10 minutes' THEN RETURN false; END IF;
  INSERT INTO nearyou.consumed_evidence_nonces(nonce,claims_digest,principal,key_id,key_version,release_id,expires_at,consumed_at)
  VALUES(p_nonce,p_digest,p_principal,p_key,p_version,p_release,p_expiry,server_now) ON CONFLICT DO NOTHING RETURNING true INTO inserted;
  IF inserted THEN INSERT INTO nearyou.release_evidence_audit(nonce_hash,claims_digest,principal,key_id,key_version,release_id,consumed_at) VALUES(encode(nearyou_crypto.digest(p_nonce,'sha256'),'hex'),p_digest,p_principal,p_key,p_version,p_release,server_now); END IF;
  RETURN coalesce(inserted,false);
END $$;
ALTER FUNCTION nearyou.consume_evidence_nonce(text,text,text,text,integer,text,timestamptz) OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.consume_evidence_nonce(text,text,text,text,integer,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nearyou.consume_evidence_nonce(text,text,text,text,integer,text,timestamptz) TO nearyou_release_verifier;

CREATE FUNCTION nearyou.cleanup_evidence_nonces(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=nearyou,pg_temp AS $$
DECLARE removed integer;
BEGIN
  IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'cleanup limit invalid'; END IF;
  WITH expired AS (SELECT nonce FROM nearyou.consumed_evidence_nonces WHERE expires_at <= statement_timestamp() ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT p_limit), deleted AS (DELETE FROM nearyou.consumed_evidence_nonces n USING expired e WHERE n.nonce=e.nonce RETURNING 1) SELECT count(*) INTO removed FROM deleted;
  RETURN removed;
END $$;
ALTER FUNCTION nearyou.cleanup_evidence_nonces(integer) OWNER TO nearyou_release_policy_owner;
REVOKE ALL ON FUNCTION nearyou.cleanup_evidence_nonces(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nearyou.cleanup_evidence_nonces(integer) TO nearyou_release_maintenance;

CREATE FUNCTION nearyou.reject_release_audit_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=nearyou,pg_temp AS $$ BEGIN RAISE EXCEPTION 'release_evidence_audit_immutable'; END $$;
REVOKE ALL ON FUNCTION nearyou.reject_release_audit_mutation() FROM PUBLIC;
CREATE TRIGGER release_evidence_audit_immutable BEFORE UPDATE OR DELETE ON nearyou.release_evidence_audit FOR EACH ROW EXECUTE FUNCTION nearyou.reject_release_audit_mutation();
CREATE TRIGGER release_signing_key_audit_immutable BEFORE UPDATE OR DELETE ON nearyou.release_signing_key_audit FOR EACH ROW EXECUTE FUNCTION nearyou.reject_release_audit_mutation();
COMMIT;
