BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS nearyou;
REVOKE ALL ON SCHEMA nearyou FROM PUBLIC;

DO $$ BEGIN
  CREATE ROLE nearyou_migration NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE nearyou_policy_owner NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE nearyou_app NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE nearyou_billing_worker NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE nearyou_job_worker NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE nearyou_migration NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
ALTER ROLE nearyou_policy_owner NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
ALTER ROLE nearyou_app NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
ALTER ROLE nearyou_billing_worker NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
ALTER ROLE nearyou_job_worker NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA nearyou TO nearyou_app, nearyou_billing_worker, nearyou_job_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA nearyou REVOKE ALL ON TABLES FROM PUBLIC;

CREATE TABLE nearyou.release_evidence (
  release_id text NOT NULL,
  schema_checksum text NOT NULL CHECK (schema_checksum ~ '^[a-f0-9]{64}$'),
  backfill_checksum text NOT NULL CHECK (backfill_checksum ~ '^[a-f0-9]{64}$'),
  gate text NOT NULL CHECK (gate IN ('backfill', 'shadow_reads', 'rls_negative_test', 'media_worker')),
  status text NOT NULL CHECK (status IN ('pending', 'verified', 'invalidated')) DEFAULT 'pending',
  artifact_checksum text,
  verified_by text,
  verified_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (release_id, gate)
);

CREATE TABLE nearyou.households (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE nearyou.household_members (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES nearyou.households(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'adult_manager', 'contributor', 'listener')),
  status text NOT NULL CHECK (status IN ('active', 'invited', 'suspended', 'left')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (household_id, user_id)
);

CREATE TABLE nearyou.tenant_records (
  household_id text NOT NULL REFERENCES nearyou.households(id) ON DELETE CASCADE,
  source_table text NOT NULL,
  source_id text NOT NULL,
  payload jsonb NOT NULL,
  source_updated_at timestamptz,
  source_checksum text NOT NULL,
  backfill_sequence bigint NOT NULL,
  PRIMARY KEY (household_id, source_table, source_id)
);

CREATE TABLE nearyou.mobile_entitlement_events (
  event_id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES nearyou.households(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  product_id text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload_checksum text NOT NULL,
  processed_at timestamptz NOT NULL,
  UNIQUE (household_id, occurred_at, event_id)
);

CREATE TABLE nearyou.durable_jobs (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES nearyou.households(id) ON DELETE CASCADE,
  type text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','processing','review_required','completed','failed','canceled')),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  lease_token text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (household_id, type, idempotency_key)
);

CREATE INDEX tenant_records_backfill_sequence_idx ON nearyou.tenant_records(backfill_sequence);
CREATE INDEX durable_jobs_claim_idx ON nearyou.durable_jobs(status, next_attempt_at, created_at);
CREATE INDEX mobile_entitlement_order_idx ON nearyou.mobile_entitlement_events(household_id, occurred_at DESC);

CREATE FUNCTION nearyou.current_household_id() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT nullif(current_setting('app.household_id', true), '') $$;

CREATE FUNCTION nearyou.current_user_id() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;
REVOKE ALL ON FUNCTION nearyou.current_household_id(), nearyou.current_user_id() FROM PUBLIC;

CREATE FUNCTION nearyou.is_active_household_member(candidate_household_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nearyou, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM nearyou.household_members
    WHERE household_id = candidate_household_id
      AND user_id = nearyou.current_user_id()
      AND status = 'active'
  )
$$;
REVOKE ALL ON FUNCTION nearyou.is_active_household_member(text) FROM PUBLIC;

CREATE FUNCTION nearyou.is_household_manager(candidate_household_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = nearyou, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM nearyou.household_members
    WHERE household_id = candidate_household_id
      AND user_id = nearyou.current_user_id()
      AND status = 'active'
      AND role IN ('owner', 'adult_manager')
  )
$$;
REVOKE ALL ON FUNCTION nearyou.is_household_manager(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA nearyou TO nearyou_policy_owner;
GRANT SELECT ON nearyou.household_members TO nearyou_policy_owner;
GRANT EXECUTE ON FUNCTION nearyou.current_household_id(), nearyou.current_user_id() TO nearyou_policy_owner;

ALTER TABLE nearyou.households ENABLE ROW LEVEL SECURITY;
ALTER TABLE nearyou.households FORCE ROW LEVEL SECURITY;
ALTER TABLE nearyou.household_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE nearyou.household_members FORCE ROW LEVEL SECURITY;
ALTER TABLE nearyou.tenant_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE nearyou.tenant_records FORCE ROW LEVEL SECURITY;
ALTER TABLE nearyou.mobile_entitlement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nearyou.mobile_entitlement_events FORCE ROW LEVEL SECURITY;
ALTER TABLE nearyou.durable_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nearyou.durable_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY household_select ON nearyou.households FOR SELECT
  USING (id = nearyou.current_household_id() AND nearyou.is_active_household_member(id));
CREATE POLICY member_select ON nearyou.household_members FOR SELECT TO nearyou_app
  USING (household_id = nearyou.current_household_id() AND nearyou.is_active_household_member(household_id));
CREATE POLICY policy_owner_member_select ON nearyou.household_members FOR SELECT TO nearyou_policy_owner
  USING (true);
CREATE POLICY tenant_record_select ON nearyou.tenant_records FOR SELECT
  USING (household_id = nearyou.current_household_id() AND nearyou.is_active_household_member(household_id));
CREATE POLICY tenant_record_app_mutation ON nearyou.tenant_records FOR ALL TO nearyou_app
  USING (household_id = nearyou.current_household_id() AND nearyou.is_household_manager(household_id))
  WITH CHECK (household_id = nearyou.current_household_id() AND nearyou.is_household_manager(household_id));
CREATE POLICY mobile_event_select ON nearyou.mobile_entitlement_events FOR SELECT
  USING (household_id = nearyou.current_household_id() AND nearyou.is_active_household_member(household_id))
;
CREATE POLICY mobile_event_service_mutation ON nearyou.mobile_entitlement_events FOR ALL TO nearyou_billing_worker
  USING (household_id = nearyou.current_household_id())
  WITH CHECK (household_id = nearyou.current_household_id());
CREATE POLICY durable_job_select ON nearyou.durable_jobs FOR SELECT
  USING (household_id = nearyou.current_household_id() AND nearyou.is_active_household_member(household_id));
CREATE POLICY durable_job_worker_mutation ON nearyou.durable_jobs FOR ALL TO nearyou_job_worker
  USING (household_id = nearyou.current_household_id()) WITH CHECK (household_id = nearyou.current_household_id());

GRANT EXECUTE ON FUNCTION nearyou.current_household_id(), nearyou.current_user_id(), nearyou.is_active_household_member(text), nearyou.is_household_manager(text) TO nearyou_app, nearyou_billing_worker, nearyou_job_worker;
GRANT SELECT ON nearyou.households, nearyou.household_members, nearyou.tenant_records, nearyou.mobile_entitlement_events, nearyou.durable_jobs TO nearyou_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON nearyou.tenant_records TO nearyou_app;
GRANT SELECT, INSERT, UPDATE ON nearyou.mobile_entitlement_events TO nearyou_billing_worker;
GRANT SELECT, INSERT, UPDATE ON nearyou.durable_jobs TO nearyou_job_worker;

ALTER FUNCTION nearyou.is_active_household_member(text) OWNER TO nearyou_policy_owner;
ALTER FUNCTION nearyou.is_household_manager(text) OWNER TO nearyou_policy_owner;

COMMIT;
