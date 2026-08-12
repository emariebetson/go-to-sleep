CREATE TABLE IF NOT EXISTS mobile_entitlement_events (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  product_id TEXT NOT NULL,
  entitlement_id TEXT NOT NULL,
  app_user_id_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  payload_checksum TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mobile_entitlement_order_idx ON mobile_entitlement_events(household_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS mobile_account_bindings (
  app_user_id_hash TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS integration_rights_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('youtube','upload')),
  source_id_hash TEXT NOT NULL,
  consent_version TEXT NOT NULL CHECK (consent_version = 'media-rights-v1'),
  attested_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(household_id, source_kind, source_id_hash)
);

CREATE TABLE IF NOT EXISTS encrypted_integration_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('spotify','youtube')),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version TEXT NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  UNIQUE(household_id, user_id, provider)
);
