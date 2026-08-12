import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrations = ["0000_nearnight_foundation.sql", "0001_google_apple_auth.sql", "0002_sharp_shinobi_shaw.sql", "0003_white_groot.sql", "0004_salty_sugar_man.sql", "0005_pronunciation_frequency_layers.sql", "0006_nearyou_shared_foundation.sql", "0007_nearsleep_production_upgrade.sql", "0008_nearsleep_live_integration.sql", "0009_nearsleep_audio_atomic.sql", "0010_child_profile_pronunciation.sql", "0011_household_billing_accounts.sql", "0012_nearsleep_library_privacy.sql", "0013_nearstory_parent_beta.sql", "0014_nearlegacy_archive.sql"];

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of migrations) {
    const sql = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) db.exec(statement);
  }
  const now = Date.now();
  for (const [id, email] of [["u1", "one@example.test"], ["u2", "two@example.test"], ["u3", "three@example.test"]]) db.prepare("INSERT INTO users (id,email,subscription_status,credits_remaining,created_at,updated_at) VALUES (?,?,'active',1,?,?)").run(id, email, now, now);
  for (const [household, owner] of [["h1", "u1"], ["h2", "u2"]]) {
    db.prepare("INSERT INTO households (id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(household, household, owner, now, now);
    db.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'owner','active',?,?)").run(`m-${household}`, household, owner, now, now);
    db.prepare("INSERT INTO entitlements (id,household_id,plan_id,source,status,allowance_milliunits,remaining_milliunits,valid_from,created_at,updated_at) VALUES (?,?,'nearlegacy','manual','active',300000,300000,?,?,?)").run(`e-${household}`, household, now, now, now);
  }
  db.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,created_at,updated_at) VALUES ('m3','h1','u3','adult_manager','active',?,?)").run(now, now);
  db.prepare("INSERT INTO contributors (id,household_id,adult_user_id,display_name,status,created_at,updated_at) VALUES ('c1','h1','u1','Grandma','active',?,?),('c2','h2','u2','Grandpa','active',?,?)").run(now, now, now, now);
  return { db, now };
}

function insertConsent(db, values = {}) {
  const row = { id: "lc1", household: "h1", contributor: "c1", user: "u1", supersedes: null, version: "legacy-consent-v1", kind: "recording", purpose: "private_archive", status: "active", evidence: "private/h1/consent/lc1", ...values };
  row.checksum = values.checksum || Buffer.from(`evidence:${row.id}`).toString("hex").padEnd(64,"0").slice(0,64);
  if (!("evidence" in values)) row.evidence = `private/${row.household}/consent/${row.id}`;
  const now = Date.now(), challenge = `challenge:${row.id}`, probe = `probe:${row.id}`, media = `evidence:${row.id}`;
  db.prepare("INSERT INTO legacy_liveness_challenges (id,household_id,contributor_id,user_id,kind,phrase,phrase_hash,status,expires_at,created_at) VALUES (?,?,?,?,?,'Silver moon over quiet water',?,'issued',?,?)")
    .run(challenge,row.household,row.contributor,row.user,row.kind,"c".repeat(64),now+60000,now);
  db.prepare("INSERT INTO legacy_media_probe_receipts (id,household_id,challenge_id,user_id,contributor_id,kind,consent_kind,checksum,byte_size,content_type,duration_ms,phrase_matched,live_speaker_verified,processor_receipt_hash,status,expires_at,created_at) VALUES (?,?,?,?,?,'consent_evidence',?,?,10,'audio/webm',5000,1,1,?,'verified',?,?)")
    .run(probe,row.household,challenge,row.user,row.contributor,row.kind,row.checksum,Buffer.from(`receipt:${row.id}`).toString("hex").padEnd(64,"0").slice(0,64),now+60000,now);
  db.prepare("INSERT INTO media_assets (id,household_id,owner_user_id,kind,status,storage_key,content_type,byte_size,checksum,private,created_at,updated_at) VALUES (?,?,?,'evidence','processing',?,'audio/webm',10,?,1,?,?)")
    .run(media,row.household,row.user,row.evidence,row.checksum,now,now);
  db.prepare("INSERT INTO household_storage_reservations (id,household_id,media_asset_id,byte_size,status,created_at,updated_at) VALUES (?,?,?,10,'reserved',?,?)").run(`storage:${media}`,row.household,media,now,now);
  db.prepare("INSERT INTO task2c_media_integrity (media_asset_id,byte_size,checksum,verified_at) VALUES (?,10,?,?)").run(media,row.checksum,now);
  db.prepare("UPDATE media_assets SET status='ready',updated_at=? WHERE id=?").run(now,media);
  db.prepare("INSERT INTO legacy_consents (id,household_id,contributor_id,attesting_user_id,supersedes_consent_id,version,kind,audience,purpose,posthumous_use,status,evidence_key,evidence_checksum,evidence_media_asset_id,liveness_challenge_id,media_probe_receipt_id,attested_at) VALUES (?,?,?,?,?,?,?,'household',?,0,?,?,?,?,?,?,?)")
    .run(row.id, row.household, row.contributor, row.user, row.supersedes, row.version, row.kind, row.purpose, row.status, row.evidence, row.checksum, media, challenge, probe, now);
}

test("actual SQLite enforces tenant-bound immutable versioned consent and safe supersession", () => {
  const { db } = fixture();
  insertConsent(db);
  assert.throws(() => db.prepare("UPDATE legacy_consents SET purpose='private_archive_narration' WHERE id='lc1'").run(), /legacy_consent_history_immutable/);
  assert.throws(() => insertConsent(db, { id: "cross", household: "h2", contributor: "c1", user: "u2" }), /foreign key|legacy_consent/i);
  assert.throws(() => insertConsent(db, { id: "wrong", version: "legacy-synthetic-v1" }), /legacy_consent_scope_invalid|legacy_active_consent_exists/);
  insertConsent(db, { id: "lc2", supersedes: "lc1", evidence: "private/h1/consent/lc2", checksum: "b".repeat(64) });
  assert.equal(db.prepare("SELECT status FROM legacy_consents WHERE id='lc1'").get().status, "superseded");
  assert.equal(db.prepare("SELECT status FROM legacy_consents WHERE id='lc2'").get().status, "active");
});

test("revocation and death state fence only bound in-flight jobs and release reservations", () => {
  const { db, now } = fixture();
  insertConsent(db, { id: "lc1", version: "legacy-consent-v1", kind: "transcription", purpose: "private_archive" });
  insertConsent(db, { id: "lc-other", household: "h2", contributor: "c2", user: "u2", version: "legacy-consent-v1", kind: "transcription", purpose: "private_archive", evidence: "private/h2/consent/lc", checksum: "b".repeat(64) });
  for (const [suffix, household, user, consent, contributor] of [["one", "h1", "u1", "lc1", "c1"], ["two", "h2", "u2", "lc-other", "c2"]]) {
    db.prepare("INSERT INTO usage_reservations (id,household_id,user_id,entitlement_id,operation,quantity,weight_milliunits,idempotency_key,request_hash,status,created_at,updated_at) VALUES (?,?,?,?, 'archive_transcription',1,1000,?,?,'reserved',?,?)").run(`r-${suffix}`, household, user, `e-${household}`, `k-${suffix}`, `hash-${suffix}`, now, now);
    db.prepare("INSERT INTO provider_spend_reservations (id,household_id,user_id,provider,operation,idempotency_key,estimated_microcents,status,expires_at,created_at,updated_at) VALUES (?,?,?,'elevenlabs','archive_transcription',?,250000,'in_flight',?,?,?)").run(`p-${suffix}`, household, user, `pk-${suffix}`, now + 300000, now, now);
    db.prepare("INSERT INTO jobs (id,household_id,requested_by_user_id,type,status,idempotency_key,request_hash,input,reservation_id,created_at,updated_at) VALUES (?,?,?,'archive_transcription','running',?,?, '{}',?,?,?)").run(`j-${suffix}`, household, user, `jk-${suffix}`, `jh-${suffix}`, `r-${suffix}`, now, now);
    db.prepare("INSERT INTO legacy_job_bindings (id,household_id,job_id,contributor_id,consent_id,reservation_id,provider_spend_reservation_id,operation,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'transcription','active',?,?)").run(`b-${suffix}`, household, `j-${suffix}`, contributor, consent, `r-${suffix}`, `p-${suffix}`, now, now);
  }
  db.prepare("UPDATE legacy_consents SET status='revoked',revoked_at=? WHERE id='lc1'").run(now);
  assert.deepEqual({ ...db.prepare("SELECT status,error_code FROM jobs WHERE id='j-one'").get() }, { status: "canceled", error_code: "legacy_consent_inactive" });
  assert.equal(db.prepare("SELECT status FROM usage_reservations WHERE id='r-one'").get().status, "released");
  assert.equal(db.prepare("SELECT status FROM provider_spend_reservations WHERE id='p-one'").get().status, "released");
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='j-two'").get().status, "running");
  assert.throws(() => db.prepare("UPDATE legacy_job_bindings SET status='published' WHERE id='b-one'").run(), /legacy_consent_inactive/);
});

test("custodian bootstrap and successor appointment are non-self-escalating", () => {
  const { db, now } = fixture();
  db.prepare("INSERT INTO legacy_custodians (id,household_id,user_id,role,status,appointed_by_user_id,accepted_at,created_at,updated_at) VALUES ('cust1','h1','u1','primary','active','u1',?,?,?)").run(now, now, now);
  assert.throws(() => db.prepare("INSERT INTO legacy_custodians (id,household_id,user_id,role,status,appointed_by_user_id,created_at,updated_at) VALUES ('bad','h1','u3','primary','active','u3',?,?)").run(now, now), /legacy_custodian_appointment_unauthorized/);
  db.prepare("INSERT INTO legacy_custodians (id,household_id,user_id,role,status,appointed_by_user_id,created_at,updated_at) VALUES ('next','h1','u3','successor','pending','u1',?,?)").run(now, now);
  assert.throws(() => db.prepare("UPDATE legacy_custodians SET status='active',accepted_at=?,updated_at=? WHERE id='next'").run(now,now), /legacy_custodian_transition_invalid/);
  db.prepare("INSERT INTO account_reauth_challenges (id,user_id,initial_session_id,verified_session_id,status,expires_at,created_at,verified_at) VALUES ('accept-auth','u3','old','accept-session','verified',?,?,?)").run(now+60000,now,now);
  db.prepare("INSERT INTO legacy_custodian_acceptances (id,household_id,custodian_id,user_id,request_hash,reauth_challenge_id,reauth_session_id,created_at) VALUES ('accept','h1','next','u3',?,'accept-auth','accept-session',?)").run("a".repeat(64),now);
  assert.equal(db.prepare("SELECT status FROM legacy_custodians WHERE id='next'").get().status, "active");
  db.prepare("INSERT INTO account_reauth_challenges (id,user_id,initial_session_id,verified_session_id,status,expires_at,created_at,verified_at) VALUES ('transfer-auth','u1','old2','transfer-session','verified',?,?,?)").run(now+60000,now,now);
  db.prepare("INSERT INTO legacy_custodian_transfers (id,household_id,from_custodian_id,to_custodian_id,requested_by_user_id,status,reauth_challenge_id,reauth_session_id,created_at) VALUES ('transfer','h1','cust1','next','u1','requested','transfer-auth','transfer-session',?)").run(now);
  assert.deepEqual({ ...db.prepare("SELECT role,status FROM legacy_custodians WHERE id='cust1'").get() }, { role: "primary", status: "revoked" });
  assert.deepEqual({ ...db.prepare("SELECT role,status FROM legacy_custodians WHERE id='next'").get() }, { role: "primary", status: "active" });
  assert.throws(() => db.prepare("INSERT INTO legacy_custodian_transfers (id,household_id,from_custodian_id,to_custodian_id,requested_by_user_id,status,reauth_challenge_id,reauth_session_id,created_at) VALUES ('race','h1','cust1','next','u1','requested','transfer-auth','transfer-session',?)").run(now), /legacy_custodian_transfer_unauthorized|UNIQUE/);
});

test("account erasure deidentifies cross-household Legacy history without deleting the other archive", () => {
  const { db, now } = fixture();
  db.prepare("DELETE FROM household_members WHERE id='m3'").run();
  db.prepare("INSERT INTO contributors (id,household_id,adult_user_id,display_name,status,created_at,updated_at) VALUES ('c3','h2','u1','Former contributor','active',?,?)").run(now,now);
  db.prepare("INSERT INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES ('audit-u1','h2','u1','archive_viewed','archive','h2',?,?)").run("a".repeat(64),now);
  db.prepare("INSERT INTO legacy_query_receipts (id,household_id,requested_by_user_id,question_hash,supported,answer_kind,status,answer_text,answer_checksum,created_at,completed_at) VALUES ('query-u1','h2','u1',?,0,'no_evidence','ready','No source',?,?,?)").run("b".repeat(64),"c".repeat(64),now,now);
  db.prepare("INSERT INTO legacy_upload_operations (id,household_id,requested_by_user_id,kind,request_hash,storage_key,checksum,byte_size,status,target_id,created_at,updated_at) VALUES ('upload-u1','h2','u1','photo',?,'legacy/h2/photo/11111111-1111-4111-8111-111111111111.jpg',?,10,'committed','11111111-1111-4111-8111-111111111111',?,?)").run("d".repeat(64),"e".repeat(64),now,now);
  db.prepare("INSERT INTO account_reauth_challenges (id,user_id,initial_session_id,verified_session_id,status,expires_at,created_at,verified_at) VALUES ('export-u1','u1','old','export-session','verified',?,?,?)").run(now+60000,now,now);
  db.prepare("INSERT INTO legacy_export_operations (id,household_id,requested_by_user_id,request_hash,status,snapshot_at,part_count,expires_at,reauth_challenge_id,reauth_session_id,created_at,updated_at) VALUES ('export-op','h2','u1',?,'queued',?,0,?,'export-u1','export-session',?,?)").run("f".repeat(64),now,now+60000,now,now);
  db.prepare("INSERT INTO legacy_custodians (id,household_id,user_id,role,status,appointed_by_user_id,accepted_at,created_at,updated_at) VALUES ('h2-primary','h2','u2','primary','active','u2',?,?,?)").run(now,now,now);
  db.prepare("INSERT INTO household_members (id,household_id,user_id,role,status,created_at,updated_at) VALUES ('h2-u1','h2','u1','contributor','active',?,?)").run(now,now);
  db.prepare("INSERT INTO legacy_custodians (id,household_id,user_id,role,status,appointed_by_user_id,created_at,updated_at) VALUES ('h2-successor','h2','u1','successor','pending','u2',?,?)").run(now,now);
  db.prepare("DELETE FROM household_members WHERE id='h2-u1'").run();
  db.prepare("INSERT INTO account_reauth_challenges (id,user_id,initial_session_id,verified_session_id,status,expires_at,created_at,verified_at) VALUES ('erase-u1','u1','old2','erase-session','verified',?,?,?)").run(now+60000,now,now);
  db.prepare("INSERT INTO account_deletion_operations (id,user_id,household_id,subject_receipt_hash,idempotency_key,request_hash,reauth_challenge_id,reauth_session_id,status,stage,attempt_token,export_policy,grace_until,snapshot,created_at,updated_at) VALUES ('erase-op','u1','h1',?,'erase-key',?,'erase-u1','erase-session','processing','cleanup','erase-token','skip',?,'{}',?,?)").run("1".repeat(64),"2".repeat(64),now,now,now);
  db.prepare("UPDATE account_deletion_operations SET status='finalizing',updated_at=? WHERE id='erase-op'").run(now+1);
  assert.equal(db.prepare("SELECT count(*) value FROM users WHERE id='u1'").get().value,0);
  assert.equal(db.prepare("SELECT count(*) value FROM households WHERE id='h2'").get().value,1);
  assert.equal(db.prepare("SELECT adult_user_id FROM contributors WHERE id='c3'").get().adult_user_id,null);
  assert.equal(db.prepare("SELECT actor_user_id FROM legacy_audit_events WHERE id='audit-u1'").get().actor_user_id,null);
  assert.equal(db.prepare("SELECT requested_by_user_id FROM legacy_query_receipts WHERE id='query-u1'").get().requested_by_user_id,null);
  assert.equal(db.prepare("SELECT requested_by_user_id FROM legacy_upload_operations WHERE id='upload-u1'").get().requested_by_user_id,null);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
});
