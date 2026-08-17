CREATE TABLE mobile_oauth_sessions(id TEXT PRIMARY KEY,provider TEXT NOT NULL CHECK(provider IN('apple','google')),state_hash TEXT NOT NULL UNIQUE CHECK(length(state_hash)=64),nonce_hash TEXT NOT NULL CHECK(length(nonce_hash)=64),verifier_hash TEXT NOT NULL CHECK(length(verifier_hash)=64),redirect_uri TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER,created_at INTEGER NOT NULL,CHECK(expires_at>created_at));
--> statement-breakpoint
CREATE TABLE mobile_entitlement_projection(household_id TEXT NOT NULL,entitlement_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('active','grace','expired','revoked','canceled')),product_id TEXT NOT NULL,environment TEXT NOT NULL CHECK(environment IN('SANDBOX','PRODUCTION')),last_occurred_at INTEGER NOT NULL,last_event_id TEXT NOT NULL,rights_version INTEGER NOT NULL DEFAULT 1 CHECK(rights_version>0),valid_until INTEGER,updated_at INTEGER NOT NULL,PRIMARY KEY(household_id,entitlement_id));
--> statement-breakpoint
CREATE TABLE mobile_entitlement_event_claims(id TEXT PRIMARY KEY,payload_checksum TEXT NOT NULL CHECK(length(payload_checksum)=64),canonical_payload TEXT NOT NULL CHECK(length(canonical_payload) BETWEEN 2 AND 262144),canonical_payload_checksum TEXT NOT NULL CHECK(length(canonical_payload_checksum)=64),status TEXT NOT NULL CHECK(status IN('processing','completed','ignored','failed','dead_letter')),attempt_token TEXT,attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),lease_expires_at INTEGER,next_attempt_at INTEGER,error_code TEXT CHECK(error_code IS NULL OR length(error_code)<=120),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,CHECK((status='processing')=(attempt_token IS NOT NULL)));
--> statement-breakpoint
CREATE INDEX mobile_entitlement_projection_order ON mobile_entitlement_projection(household_id,last_occurred_at,last_event_id);
--> statement-breakpoint
CREATE INDEX mobile_entitlement_retry ON mobile_entitlement_event_claims(status,next_attempt_at,lease_expires_at);
--> statement-breakpoint
CREATE TRIGGER mobile_entitlement_projection_order_guard BEFORE UPDATE ON mobile_entitlement_projection WHEN NEW.last_occurred_at<OLD.last_occurred_at OR (NEW.last_occurred_at=OLD.last_occurred_at AND NEW.last_event_id<=OLD.last_event_id) BEGIN SELECT RAISE(ABORT,'mobile entitlement ordering conflict');
END;
--> statement-breakpoint
ALTER TABLE mobile_account_bindings ADD COLUMN app_id TEXT NOT NULL DEFAULT 'unbound';
--> statement-breakpoint
ALTER TABLE mobile_account_bindings ADD COLUMN environment TEXT NOT NULL DEFAULT 'SANDBOX' CHECK(environment IN('SANDBOX','PRODUCTION'));
--> statement-breakpoint
ALTER TABLE mobile_account_bindings ADD COLUMN binding_version INTEGER NOT NULL DEFAULT 1 CHECK(binding_version>0);
--> statement-breakpoint
ALTER TABLE mobile_account_bindings ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','revoked'));
