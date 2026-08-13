CREATE TABLE cutover_source_state (
  release_id TEXT PRIMARY KEY NOT NULL,
  write_mode TEXT NOT NULL CHECK(write_mode IN ('writable','bootstrapping','frozen','committed')),
  high_water INTEGER NOT NULL CHECK(high_water>=0),
  digest_index_version INTEGER NOT NULL DEFAULT 0 CHECK(digest_index_version>=0),
  digest_status TEXT NOT NULL DEFAULT 'pending' CHECK(digest_status IN('pending','ready')),
  freeze_operation_id TEXT,
  freeze_token TEXT,
  source_checksum TEXT CHECK(source_checksum IS NULL OR length(source_checksum)=64), source_row_count INTEGER CHECK(source_row_count IS NULL OR source_row_count>=0),
  updated_at INTEGER NOT NULL,
  CHECK((write_mode IN('writable','bootstrapping') AND freeze_operation_id IS NULL AND freeze_token IS NULL) OR (write_mode IN ('frozen','committed') AND freeze_operation_id IS NOT NULL AND freeze_token IS NOT NULL))
);
CREATE TABLE cutover_maintenance_fence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),active INTEGER NOT NULL CHECK(active IN(0,1)),operation_id TEXT,registry_version INTEGER,registry_checksum TEXT,updated_at INTEGER NOT NULL,CHECK((active=0 AND operation_id IS NULL) OR (active=1 AND operation_id IS NOT NULL AND registry_version IS NOT NULL AND length(registry_checksum)=64)));
INSERT INTO cutover_maintenance_fence(singleton,active,updated_at) VALUES(1,0,0);
CREATE TABLE cutover_domain_inventory(operation_id TEXT PRIMARY KEY,registry_version INTEGER NOT NULL,registry_checksum TEXT NOT NULL CHECK(length(registry_checksum)=64),table_cursor INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL CHECK(status IN('running','reconciled','complete','aborted')),overall_checksum TEXT,completion_attestation TEXT CHECK(completion_attestation IS NULL OR length(completion_attestation)=64),row_count INTEGER NOT NULL DEFAULT 0,baseline_release_id TEXT,baseline_checksum TEXT,updated_at INTEGER NOT NULL);
CREATE TRIGGER cutover_domain_inventory_delete_guard BEFORE DELETE ON cutover_domain_inventory BEGIN SELECT RAISE(ABORT,'cutover inventory immutable'); END;
CREATE TRIGGER cutover_domain_inventory_update_guard BEFORE UPDATE ON cutover_domain_inventory BEGIN SELECT CASE WHEN OLD.operation_id<>NEW.operation_id OR OLD.registry_version<>NEW.registry_version OR OLD.registry_checksum<>NEW.registry_checksum OR OLD.table_cursor<>NEW.table_cursor OR NOT ((OLD.status='running' AND NEW.status='reconciled' AND OLD.overall_checksum IS NULL AND NEW.overall_checksum IS NOT NULL AND OLD.completion_attestation IS NULL AND NEW.completion_attestation IS NOT NULL AND NEW.row_count>=0 AND NEW.baseline_release_id IS NULL AND NEW.baseline_checksum IS NULL) OR (OLD.status='running' AND NEW.status='aborted' AND OLD.baseline_release_id IS NULL AND NEW.baseline_release_id IS NULL AND NEW.baseline_checksum IS NULL) OR (OLD.status='reconciled' AND NEW.status='complete' AND OLD.overall_checksum=NEW.overall_checksum AND OLD.completion_attestation=NEW.completion_attestation AND OLD.row_count=NEW.row_count AND OLD.baseline_release_id IS NULL AND NEW.baseline_release_id IS NOT NULL AND NEW.baseline_checksum IS NOT NULL)) THEN RAISE(ABORT,'cutover inventory lifecycle invalid') END; END;
CREATE TABLE cutover_domain_inventory_tables(operation_id TEXT NOT NULL,table_name TEXT NOT NULL,table_index INTEGER NOT NULL,first_count INTEGER NOT NULL,first_checksum TEXT NOT NULL CHECK(length(first_checksum)=64),second_count INTEGER,second_checksum TEXT,cursor TEXT,status TEXT NOT NULL CHECK(status IN('scanned','reconciled')),PRIMARY KEY(operation_id,table_name));
CREATE TRIGGER cutover_inventory_table_insert_guard BEFORE INSERT ON cutover_domain_inventory_tables BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cutover_domain_inventory i JOIN cutover_maintenance_fence f ON f.operation_id=i.operation_id WHERE i.operation_id=NEW.operation_id AND i.status='running' AND f.active=1) THEN RAISE(ABORT,'cutover inventory table phase invalid') END; END;
CREATE TRIGGER cutover_inventory_table_update_guard BEFORE UPDATE ON cutover_domain_inventory_tables BEGIN SELECT CASE WHEN NOT (OLD.operation_id=NEW.operation_id AND OLD.table_name=NEW.table_name AND OLD.table_index=NEW.table_index AND OLD.first_count=NEW.first_count AND OLD.first_checksum=NEW.first_checksum AND OLD.status='scanned' AND NEW.status='reconciled' AND NEW.second_count=OLD.first_count AND NEW.second_checksum=OLD.first_checksum AND (SELECT coalesce(sum(row_count),0) FROM cutover_domain_inventory_pages p WHERE p.operation_id=OLD.operation_id AND p.pass=2 AND p.table_name=OLD.table_name)=NEW.second_count AND NOT EXISTS(SELECT 1 FROM cutover_domain_inventory_pages p WHERE p.operation_id=OLD.operation_id AND p.pass=2 AND p.table_name=OLD.table_name AND NOT EXISTS(SELECT 1 FROM cutover_domain_inventory_pages q WHERE q.operation_id=p.operation_id AND q.pass=1 AND q.table_name=p.table_name AND q.from_cursor=p.from_cursor AND q.to_cursor=p.to_cursor AND q.page_checksum=p.page_checksum AND q.row_count=p.row_count))) THEN RAISE(ABORT,'cutover inventory table lifecycle invalid') END; END;
CREATE TRIGGER cutover_inventory_table_delete_guard BEFORE DELETE ON cutover_domain_inventory_tables WHEN NOT EXISTS(SELECT 1 FROM cutover_domain_inventory_abort_authorizations a WHERE a.operation_id=OLD.operation_id AND a.consumed_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'cutover inventory table immutable'); END;
CREATE TABLE cutover_domain_inventory_pages(operation_id TEXT NOT NULL,pass INTEGER NOT NULL CHECK(pass IN(1,2)),table_index INTEGER NOT NULL CHECK(table_index>=0),page_ordinal INTEGER NOT NULL CHECK(page_ordinal>=0),table_name TEXT NOT NULL,from_cursor TEXT NOT NULL,to_cursor TEXT NOT NULL,page_checksum TEXT NOT NULL CHECK(length(page_checksum)=64),pg_grant_digest TEXT CHECK(pg_grant_digest IS NULL OR length(pg_grant_digest)=64),row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 500),event_from INTEGER,event_to INTEGER,PRIMARY KEY(operation_id,pass,table_index,page_ordinal),UNIQUE(operation_id,pass,table_index,from_cursor));
CREATE TABLE cutover_domain_inventory_page_authorizations(operation_id TEXT NOT NULL,pass INTEGER NOT NULL,table_name TEXT NOT NULL,from_cursor TEXT NOT NULL,to_cursor TEXT NOT NULL,page_checksum TEXT NOT NULL,row_count INTEGER NOT NULL,event_from INTEGER,event_to INTEGER,status TEXT NOT NULL CHECK(status IN('populating','complete')),PRIMARY KEY(operation_id,pass,table_name,from_cursor));
CREATE TRIGGER cutover_inventory_page_authorization_insert_guard BEFORE INSERT ON cutover_domain_inventory_page_authorizations BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cutover_domain_inventory i JOIN cutover_maintenance_fence f ON f.operation_id=i.operation_id WHERE i.operation_id=NEW.operation_id AND i.status='running' AND f.active=1 AND NEW.pass IN(1,2) AND NEW.row_count BETWEEN 1 AND 500 AND NEW.status='populating') THEN RAISE(ABORT,'cutover inventory page phase invalid') END; END;
CREATE TRIGGER cutover_inventory_page_authorization_update_guard BEFORE UPDATE ON cutover_domain_inventory_page_authorizations BEGIN SELECT CASE WHEN NOT (OLD.operation_id=NEW.operation_id AND OLD.pass=NEW.pass AND OLD.table_name=NEW.table_name AND OLD.from_cursor=NEW.from_cursor AND OLD.to_cursor=NEW.to_cursor AND OLD.page_checksum=NEW.page_checksum AND OLD.row_count=NEW.row_count AND OLD.event_from IS NEW.event_from AND OLD.event_to IS NEW.event_to AND OLD.status='populating' AND NEW.status='complete') THEN RAISE(ABORT,'cutover inventory page authorization immutable') END; END;
CREATE TRIGGER cutover_inventory_page_update_guard BEFORE UPDATE ON cutover_domain_inventory_pages BEGIN SELECT RAISE(ABORT,'cutover inventory page immutable'); END;
CREATE TRIGGER cutover_inventory_page_delete_guard BEFORE DELETE ON cutover_domain_inventory_pages WHEN NOT EXISTS(SELECT 1 FROM cutover_domain_inventory_abort_authorizations a WHERE a.operation_id=OLD.operation_id AND a.consumed_at IS NOT NULL AND a.expires_at>=a.consumed_at) BEGIN SELECT RAISE(ABORT,'cutover inventory page immutable'); END;
CREATE TRIGGER cutover_inventory_page_insert_guard BEFORE INSERT ON cutover_domain_inventory_pages BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cutover_domain_inventory_page_authorizations a WHERE a.operation_id=NEW.operation_id AND a.pass=NEW.pass AND a.table_name=NEW.table_name AND a.from_cursor=NEW.from_cursor AND a.to_cursor=NEW.to_cursor AND a.page_checksum=NEW.page_checksum AND a.row_count=NEW.row_count AND a.event_from IS NEW.event_from AND a.event_to IS NEW.event_to AND a.status='populating' AND (NEW.pass=2 OR (SELECT count(*) FROM cutover_domain_inventory_events e WHERE e.operation_id=NEW.operation_id AND e.table_name=NEW.table_name AND e.sequence BETWEEN NEW.event_from AND NEW.event_to)=NEW.row_count)) THEN RAISE(ABORT,'cutover inventory page authorization invalid') END; END;
CREATE TRIGGER cutover_inventory_page_ordinal_guard BEFORE INSERT ON cutover_domain_inventory_pages BEGIN SELECT CASE WHEN NEW.page_ordinal<>(SELECT count(*) FROM cutover_domain_inventory_pages p WHERE p.operation_id=NEW.operation_id AND p.pass=NEW.pass AND p.table_index=NEW.table_index) OR EXISTS(SELECT 1 FROM cutover_domain_inventory_pages p WHERE p.operation_id=NEW.operation_id AND p.pass=NEW.pass AND p.table_index=NEW.table_index AND p.table_name<>NEW.table_name) THEN RAISE(ABORT,'cutover inventory page ordinal invalid') END; END;
CREATE TRIGGER cutover_inventory_page_complete AFTER INSERT ON cutover_domain_inventory_pages BEGIN UPDATE cutover_domain_inventory_page_authorizations SET status='complete' WHERE operation_id=NEW.operation_id AND pass=NEW.pass AND table_name=NEW.table_name AND from_cursor=NEW.from_cursor AND status='populating'; SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'cutover inventory page completion invalid') END; END;
CREATE TABLE cutover_domain_inventory_events(operation_id TEXT NOT NULL,sequence INTEGER NOT NULL,table_name TEXT NOT NULL,row_key TEXT NOT NULL,payload TEXT NOT NULL,row_checksum TEXT NOT NULL CHECK(length(row_checksum)=64),baseline_tenant TEXT NOT NULL,baseline_id TEXT NOT NULL CHECK(length(baseline_id)=64),baseline_digest TEXT NOT NULL CHECK(length(baseline_digest)=64),PRIMARY KEY(operation_id,sequence),UNIQUE(operation_id,table_name,row_key));
CREATE TRIGGER cutover_inventory_event_insert_guard BEFORE INSERT ON cutover_domain_inventory_events BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cutover_domain_inventory_page_authorizations a WHERE a.operation_id=NEW.operation_id AND a.pass=1 AND a.table_name=NEW.table_name AND a.status='populating' AND NEW.sequence BETWEEN a.event_from AND a.event_to) THEN RAISE(ABORT,'cutover inventory event phase invalid') END; END;
CREATE TABLE cutover_domain_baseline_seals(operation_id TEXT PRIMARY KEY,release_id TEXT NOT NULL UNIQUE,row_count INTEGER NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL CHECK(status IN('running','complete')),checksum TEXT,updated_at INTEGER NOT NULL);
CREATE TRIGGER cutover_domain_baseline_insert_guard BEFORE INSERT ON cutover_domain_baseline_seals BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cutover_domain_inventory i JOIN cutover_maintenance_fence f ON f.operation_id=i.operation_id WHERE i.operation_id=NEW.operation_id AND i.status='reconciled' AND f.active=1 AND i.row_count=NEW.row_count) THEN RAISE(ABORT,'cutover baseline phase invalid') END; END;
CREATE TABLE cutover_domain_baseline_pages(operation_id TEXT NOT NULL,from_cursor INTEGER NOT NULL,to_cursor INTEGER NOT NULL,page_checksum TEXT NOT NULL CHECK(length(page_checksum)=64),pg_grant_digest TEXT CHECK(pg_grant_digest IS NULL OR length(pg_grant_digest)=64),row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 500),PRIMARY KEY(operation_id,from_cursor));
CREATE TRIGGER cutover_domain_baseline_page_insert_guard BEFORE INSERT ON cutover_domain_baseline_pages BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cutover_domain_baseline_seals z JOIN cutover_maintenance_fence f ON f.operation_id=z.operation_id WHERE z.operation_id=NEW.operation_id AND z.status='running' AND z.cursor=NEW.from_cursor AND NEW.to_cursor=NEW.from_cursor+NEW.row_count AND NEW.to_cursor<=z.row_count AND f.active=1 AND (SELECT count(*) FROM cutover_domain_inventory_events e WHERE e.operation_id=z.operation_id AND e.sequence>NEW.from_cursor AND e.sequence<=NEW.to_cursor)=NEW.row_count AND (SELECT count(*) FROM cutover_source_rows r JOIN cutover_domain_inventory_events e ON e.operation_id=z.operation_id AND e.sequence=r.source_sequence AND e.baseline_tenant=r.household_id AND e.table_name=r.source_table AND e.baseline_id=r.source_id AND e.baseline_digest=r.canonical_row_digest WHERE r.release_id=z.release_id AND e.sequence>NEW.from_cursor AND e.sequence<=NEW.to_cursor)=NEW.row_count) THEN RAISE(ABORT,'cutover baseline page authorization invalid') END; END;
CREATE TRIGGER cutover_domain_baseline_page_update_guard BEFORE UPDATE ON cutover_domain_baseline_pages BEGIN SELECT RAISE(ABORT,'cutover baseline page immutable'); END;
CREATE TRIGGER cutover_domain_baseline_page_delete_guard BEFORE DELETE ON cutover_domain_baseline_pages BEGIN SELECT RAISE(ABORT,'cutover baseline page immutable'); END;
CREATE TRIGGER cutover_domain_baseline_seal_guard BEFORE UPDATE ON cutover_domain_baseline_seals BEGIN SELECT CASE WHEN NOT (OLD.operation_id=NEW.operation_id AND OLD.release_id=NEW.release_id AND OLD.row_count=NEW.row_count AND ((OLD.status='running' AND NEW.status='running' AND NEW.cursor>OLD.cursor AND NEW.cursor<=OLD.row_count AND OLD.checksum IS NULL AND NEW.checksum IS NULL AND EXISTS(SELECT 1 FROM cutover_domain_baseline_pages p WHERE p.operation_id=OLD.operation_id AND p.from_cursor=OLD.cursor AND p.to_cursor=NEW.cursor)) OR (OLD.status='running' AND NEW.status='complete' AND OLD.cursor=OLD.row_count AND NEW.cursor=OLD.cursor AND OLD.checksum IS NULL AND length(NEW.checksum)=64))) THEN RAISE(ABORT,'cutover baseline lifecycle invalid') END; END;
CREATE TABLE cutover_domain_inventory_abort_authorizations(authorization_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,registry_checksum TEXT NOT NULL CHECK(length(registry_checksum)=64),inventory_checksum TEXT,admin_principal TEXT NOT NULL,nonce_hash TEXT NOT NULL UNIQUE CHECK(length(nonce_hash)=64),expires_at INTEGER NOT NULL,consumed_at INTEGER);
CREATE TRIGGER cutover_inventory_abort_authorization_delete_guard BEFORE DELETE ON cutover_domain_inventory_abort_authorizations BEGIN SELECT RAISE(ABORT,'cutover abort authorization immutable'); END;
CREATE TRIGGER cutover_inventory_abort_authorization_update_guard BEFORE UPDATE ON cutover_domain_inventory_abort_authorizations BEGIN SELECT CASE WHEN NOT (OLD.authorization_id=NEW.authorization_id AND OLD.operation_id=NEW.operation_id AND OLD.registry_checksum=NEW.registry_checksum AND OLD.inventory_checksum IS NEW.inventory_checksum AND OLD.admin_principal=NEW.admin_principal AND OLD.nonce_hash=NEW.nonce_hash AND OLD.expires_at=NEW.expires_at AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND NEW.consumed_at<=OLD.expires_at) THEN RAISE(ABORT,'cutover abort authorization immutable') END; END;
CREATE TABLE cutover_domain_inventory_abort_audit(operation_id TEXT PRIMARY KEY,registry_checksum TEXT NOT NULL CHECK(length(registry_checksum)=64),inventory_checksum TEXT,authorization_digest TEXT NOT NULL CHECK(length(authorization_digest)=64),deleted_events INTEGER NOT NULL,deleted_pages INTEGER NOT NULL,aborted_at INTEGER NOT NULL);
CREATE TRIGGER cutover_inventory_abort_audit_update_guard BEFORE UPDATE ON cutover_domain_inventory_abort_audit BEGIN SELECT RAISE(ABORT,'cutover abort audit immutable'); END;
CREATE TRIGGER cutover_inventory_abort_audit_delete_guard BEFORE DELETE ON cutover_domain_inventory_abort_audit BEGIN SELECT RAISE(ABORT,'cutover abort audit immutable'); END;
CREATE TRIGGER cutover_inventory_event_update_guard BEFORE UPDATE ON cutover_domain_inventory_events BEGIN SELECT RAISE(ABORT,'cutover inventory immutable'); END;
CREATE TRIGGER cutover_inventory_event_delete_guard BEFORE DELETE ON cutover_domain_inventory_events WHEN NOT EXISTS(SELECT 1 FROM cutover_domain_inventory_abort_authorizations a WHERE a.operation_id=OLD.operation_id AND a.consumed_at IS NOT NULL AND a.consumed_at IS NOT NULL AND a.expires_at>=a.consumed_at) BEGIN SELECT RAISE(ABORT,'cutover inventory immutable'); END;
CREATE TABLE cutover_source_operations (
  release_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('freeze','rollback_apply','freeze_commit')),
  operation_id TEXT NOT NULL,
  token TEXT NOT NULL,
  expected_high_water INTEGER NOT NULL CHECK(expected_high_water>=0),
  high_water INTEGER NOT NULL CHECK(high_water>=expected_high_water),
  status TEXT NOT NULL CHECK(status IN ('frozen','applied','committed')),
  source_checksum TEXT CHECK(source_checksum IS NULL OR length(source_checksum)=64), source_row_count INTEGER CHECK(source_row_count IS NULL OR source_row_count>=0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(release_id,kind,operation_id)
);
CREATE TRIGGER cutover_source_state_initialize_empty_digest AFTER INSERT ON cutover_source_state WHEN NEW.high_water=0 BEGIN UPDATE cutover_source_state SET digest_status='ready',source_checksum='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',source_row_count=0 WHERE release_id=NEW.release_id AND digest_index_version=0; END;
CREATE TABLE cutover_digest_bootstrap(release_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,high_water INTEGER NOT NULL CHECK(high_water>0),source_count INTEGER NOT NULL CHECK(source_count>=0),cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor>=0),status TEXT NOT NULL CHECK(status IN('populating','running','complete')),manifest_checksum TEXT,updated_at INTEGER NOT NULL);
CREATE TRIGGER cutover_digest_bootstrap_lifecycle_guard BEFORE UPDATE ON cutover_digest_bootstrap BEGIN
 SELECT CASE WHEN OLD.release_id<>NEW.release_id OR OLD.operation_id<>NEW.operation_id OR OLD.high_water<>NEW.high_water OR OLD.source_count<>NEW.source_count THEN RAISE(ABORT,'cutover bootstrap identity immutable') END;
 SELECT CASE WHEN NOT ((OLD.status='populating' AND NEW.status='running' AND OLD.cursor=0 AND NEW.cursor=0 AND OLD.manifest_checksum IS NULL AND NEW.manifest_checksum IS NULL) OR (OLD.status='running' AND NEW.status='running' AND NEW.cursor>=OLD.cursor AND NEW.cursor<=OLD.high_water AND OLD.manifest_checksum IS NULL AND NEW.manifest_checksum IS NULL) OR (OLD.status='running' AND NEW.status='complete' AND OLD.cursor=OLD.high_water AND NEW.cursor=OLD.cursor AND OLD.manifest_checksum IS NULL AND NEW.manifest_checksum IS NOT NULL AND length(NEW.manifest_checksum)=64)) THEN RAISE(ABORT,'cutover bootstrap lifecycle invalid') END;
END;
CREATE TABLE cutover_digest_bootstrap_pages(release_id TEXT NOT NULL,operation_id TEXT NOT NULL,from_cursor INTEGER NOT NULL,to_cursor INTEGER NOT NULL,page_checksum TEXT NOT NULL CHECK(length(page_checksum)=64),pg_grant_digest TEXT CHECK(pg_grant_digest IS NULL OR length(pg_grant_digest)=64),row_count INTEGER NOT NULL CHECK(row_count>0),PRIMARY KEY(release_id,operation_id,from_cursor));
CREATE TABLE cutover_digest_bootstrap_source(release_id TEXT NOT NULL,operation_id TEXT NOT NULL,sequence INTEGER NOT NULL,household_id TEXT NOT NULL,source_table TEXT NOT NULL,source_id TEXT NOT NULL,deleted INTEGER NOT NULL CHECK(deleted IN(0,1)),payload TEXT,PRIMARY KEY(release_id,operation_id,sequence));
CREATE TABLE cutover_digest_bootstrap_assertions(release_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,high_water INTEGER NOT NULL);
CREATE TRIGGER cutover_digest_bootstrap_source_insert_guard BEFORE INSERT ON cutover_digest_bootstrap_source BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cutover_digest_bootstrap b WHERE b.release_id=NEW.release_id AND b.operation_id=NEW.operation_id AND b.status='populating') THEN RAISE(ABORT,'cutover bootstrap source sealed') END; END;
CREATE TRIGGER cutover_digest_bootstrap_source_update_guard BEFORE UPDATE ON cutover_digest_bootstrap_source BEGIN SELECT RAISE(ABORT,'cutover bootstrap source immutable'); END;
CREATE TRIGGER cutover_digest_bootstrap_source_delete_guard BEFORE DELETE ON cutover_digest_bootstrap_source BEGIN SELECT RAISE(ABORT,'cutover bootstrap source immutable'); END;
CREATE TRIGGER cutover_digest_bootstrap_snapshot_complete BEFORE INSERT ON cutover_digest_bootstrap_assertions BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cutover_digest_bootstrap b WHERE b.release_id=NEW.release_id AND b.operation_id=NEW.operation_id AND b.status='populating' AND b.high_water=NEW.high_water AND b.source_count=NEW.high_water AND (SELECT count(*) FROM cutover_digest_bootstrap_source x WHERE x.release_id=b.release_id AND x.operation_id=b.operation_id)=b.high_water AND (SELECT min(sequence) FROM cutover_digest_bootstrap_source x WHERE x.release_id=b.release_id AND x.operation_id=b.operation_id)=1 AND (SELECT max(sequence) FROM cutover_digest_bootstrap_source x WHERE x.release_id=b.release_id AND x.operation_id=b.operation_id)=b.high_water) THEN RAISE(ABORT,'cutover bootstrap source incomplete') END; END;
CREATE TRIGGER cutover_digest_bootstrap_snapshot_seal AFTER INSERT ON cutover_digest_bootstrap_assertions BEGIN UPDATE cutover_digest_bootstrap SET status='running' WHERE release_id=NEW.release_id AND operation_id=NEW.operation_id AND status='populating'; SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'cutover bootstrap seal failed') END; END;
CREATE TRIGGER cutover_digest_bootstrap_assertion_update_guard BEFORE UPDATE ON cutover_digest_bootstrap_assertions BEGIN SELECT RAISE(ABORT,'cutover bootstrap seal immutable'); END;
CREATE TRIGGER cutover_digest_bootstrap_assertion_delete_guard BEFORE DELETE ON cutover_digest_bootstrap_assertions BEGIN SELECT RAISE(ABORT,'cutover bootstrap seal immutable'); END;
CREATE TABLE cutover_change_log (
  release_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  household_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
  payload TEXT,
  created_at INTEGER NOT NULL,
  CHECK((deleted=1 AND payload IS NULL) OR (deleted=0 AND payload IS NOT NULL)),
  PRIMARY KEY(release_id,sequence)
);
CREATE TABLE cutover_source_rows (
 release_id TEXT NOT NULL, household_id TEXT NOT NULL, source_table TEXT NOT NULL, source_id TEXT NOT NULL,
 canonical_row_digest TEXT NOT NULL CHECK(canonical_row_digest GLOB '[0-9a-f]*' AND length(canonical_row_digest)=64), deleted INTEGER NOT NULL CHECK(deleted IN(0,1)), source_sequence INTEGER NOT NULL CHECK(source_sequence>0),
 PRIMARY KEY(release_id,household_id,source_table,source_id)
);
CREATE TRIGGER cutover_source_rows_write_guard BEFORE INSERT ON cutover_source_rows BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cutover_source_state s WHERE s.release_id=NEW.release_id AND ((s.write_mode='writable' AND s.high_water+1=NEW.source_sequence) OR (s.write_mode='bootstrapping' AND EXISTS(SELECT 1 FROM cutover_digest_bootstrap b WHERE b.release_id=s.release_id AND b.status='running' AND NEW.source_sequence>b.cursor AND NEW.source_sequence<=b.high_water))) OR (s.write_mode='bootstrapping' AND EXISTS(SELECT 1 FROM cutover_domain_baseline_seals z JOIN cutover_domain_inventory_events e ON e.operation_id=z.operation_id AND e.sequence=NEW.source_sequence AND e.baseline_tenant=NEW.household_id AND e.table_name=NEW.source_table AND e.baseline_id=NEW.source_id AND e.baseline_digest=NEW.canonical_row_digest WHERE z.release_id=s.release_id AND z.status='running' AND NEW.source_sequence>z.cursor AND NEW.source_sequence<=z.row_count))) THEN RAISE(ABORT,'cutover source digest fenced') END; END;
CREATE TRIGGER cutover_source_rows_update_guard BEFORE UPDATE ON cutover_source_rows BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cutover_source_state s WHERE s.release_id=NEW.release_id AND ((s.write_mode='writable' AND s.high_water+1=NEW.source_sequence AND NEW.source_sequence>OLD.source_sequence) OR (s.write_mode='bootstrapping' AND EXISTS(SELECT 1 FROM cutover_digest_bootstrap b WHERE b.release_id=s.release_id AND b.status='running' AND NEW.source_sequence>b.cursor AND NEW.source_sequence<=b.high_water))) OR (s.write_mode='bootstrapping' AND EXISTS(SELECT 1 FROM cutover_domain_baseline_seals z JOIN cutover_domain_inventory_events e ON e.operation_id=z.operation_id AND e.sequence=NEW.source_sequence AND e.baseline_tenant=NEW.household_id AND e.table_name=NEW.source_table AND e.baseline_id=NEW.source_id AND e.baseline_digest=NEW.canonical_row_digest WHERE z.release_id=s.release_id AND z.status='running' AND NEW.source_sequence>z.cursor AND NEW.source_sequence<=z.row_count))) THEN RAISE(ABORT,'cutover source digest fenced') END; END;
CREATE INDEX cutover_change_log_release_sequence_idx ON cutover_change_log(release_id,sequence);
CREATE TABLE cutover_write_assertions (
  release_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  asserted_at INTEGER NOT NULL,
  PRIMARY KEY(release_id,sequence)
);
CREATE TRIGGER cutover_change_log_write_guard
BEFORE INSERT ON cutover_change_log
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cutover_source_state
    WHERE release_id=NEW.release_id
      AND write_mode='writable'
      AND high_water+1=NEW.sequence
  ) THEN RAISE(ABORT,'cutover source write fenced') END;
END;
CREATE TRIGGER cutover_domain_write_cardinality_guard
BEFORE INSERT ON cutover_write_assertions
BEGIN
  SELECT CASE WHEN changes()!=1 OR NOT EXISTS (
    SELECT 1 FROM cutover_source_state s
    JOIN cutover_change_log l ON l.release_id=s.release_id AND l.sequence=NEW.sequence
    WHERE s.release_id=NEW.release_id
      AND s.write_mode='writable'
      AND s.high_water+1=NEW.sequence
  ) THEN RAISE(ABORT,'cutover domain mutation cardinality invalid') END;
END;
CREATE TRIGGER cutover_completion_operation_guard
BEFORE INSERT ON cutover_source_operations
WHEN NEW.kind IN ('freeze_commit','rollback_apply')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM cutover_source_state s
    JOIN cutover_source_operations f ON f.release_id=s.release_id AND f.kind='freeze' AND f.operation_id=s.freeze_operation_id
    WHERE s.release_id=NEW.release_id AND s.write_mode='frozen' AND s.freeze_token=NEW.token AND s.high_water=NEW.high_water
      AND f.token=NEW.token AND f.high_water=NEW.high_water AND f.status='frozen'
      AND NEW.operation_id=(CASE NEW.kind WHEN 'freeze_commit' THEN 'commit:' ELSE 'unfreeze:' END)||f.operation_id
      AND NEW.expected_high_water=NEW.high_water
      AND NEW.status=(CASE NEW.kind WHEN 'freeze_commit' THEN 'committed' ELSE 'applied' END)
  ) THEN RAISE(ABORT,'cutover freeze completion state invalid') END;
END;
CREATE TRIGGER cutover_operation_delete_guard BEFORE DELETE ON cutover_source_operations BEGIN SELECT RAISE(ABORT,'cutover operation immutable'); END;
CREATE TRIGGER cutover_operation_update_guard BEFORE UPDATE ON cutover_source_operations
BEGIN
 SELECT CASE WHEN NOT (OLD.kind='freeze' AND OLD.status='frozen' AND NEW.status='committed' AND OLD.release_id=NEW.release_id AND OLD.kind=NEW.kind AND OLD.operation_id=NEW.operation_id AND OLD.token=NEW.token AND OLD.expected_high_water=NEW.expected_high_water AND OLD.high_water=NEW.high_water AND OLD.created_at=NEW.created_at AND EXISTS(SELECT 1 FROM cutover_source_state s JOIN cutover_source_operations c ON c.release_id=s.release_id AND c.kind='freeze_commit' AND c.operation_id='commit:'||OLD.operation_id AND c.token=OLD.token AND c.high_water=OLD.high_water WHERE s.release_id=OLD.release_id AND s.write_mode='frozen' AND s.freeze_operation_id=OLD.operation_id AND s.freeze_token=OLD.token AND s.high_water=OLD.high_water)) THEN RAISE(ABORT,'cutover operation immutable') END;
END;
