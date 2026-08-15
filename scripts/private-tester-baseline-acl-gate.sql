\set ON_ERROR_STOP on
\if :{?verifier_database_url}
\else
\echo 'verifier_database_url is required'
\quit 3
\endif
\connect :verifier_database_url
BEGIN;
SET LOCAL ROLE nearyou_private_tester_baseline_verifier;
SELECT * FROM nearyou.assert_private_tester_baseline_verifier();
SELECT id,checksum FROM nearyou.schema_migrations ORDER BY id COLLATE "C";
DO $$
BEGIN
  IF nearyou.consume_private_tester_deployment_manifest('private-tester-deployment-manifest/v1','invalid','invalid','{}','invalid','invalid',0,'invalid',statement_timestamp()) IS DISTINCT FROM false THEN RAISE EXCEPTION 'invalid manifest nonce unexpectedly accepted'; END IF;
  IF has_table_privilege('nearyou_rollout_controller','nearyou.schema_migrations','SELECT') THEN RAISE EXCEPTION 'controller can read migration ledger'; END IF;
  IF has_function_privilege('nearyou_rollout_controller','nearyou.consume_private_tester_deployment_manifest(text,text,text,text,text,text,integer,text,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'controller can consume baseline nonce'; END IF;
  IF has_table_privilege('nearyou_rollout_controller','nearyou.private_tester_baseline_verifier_identities','SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('nearyou_rollout_controller','nearyou.private_tester_deployment_manifest_nonces','SELECT,INSERT,UPDATE,DELETE') OR has_function_privilege('nearyou_rollout_controller','nearyou.assert_private_tester_baseline_verifier()','EXECUTE') OR has_function_privilege('nearyou_rollout_controller','nearyou.register_private_tester_baseline_verifier_identity(name,text)','EXECUTE') THEN RAISE EXCEPTION 'controller baseline ACL widened'; END IF;
  IF has_function_privilege('nearyou_release_verifier','nearyou.consume_private_tester_deployment_manifest(text,text,text,text,text,text,integer,text,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'generic release verifier can consume baseline nonce'; END IF;
  IF has_table_privilege('nearyou_release_verifier','nearyou.private_tester_baseline_verifier_identities','SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('nearyou_release_verifier','nearyou.private_tester_deployment_manifest_nonces','SELECT,INSERT,UPDATE,DELETE') OR has_function_privilege('nearyou_release_verifier','nearyou.assert_private_tester_baseline_verifier()','EXECUTE') THEN RAISE EXCEPTION 'generic release verifier baseline ACL widened'; END IF;
  IF NOT has_schema_privilege('nearyou_private_tester_baseline_verifier','nearyou','USAGE') OR NOT has_table_privilege('nearyou_private_tester_baseline_verifier','nearyou.schema_migrations','SELECT') OR NOT has_function_privilege('nearyou_private_tester_baseline_verifier','nearyou.consume_private_tester_deployment_manifest(text,text,text,text,text,text,integer,text,timestamptz)','EXECUTE') OR NOT has_function_privilege('nearyou_private_tester_baseline_verifier','nearyou.assert_private_tester_baseline_verifier()','EXECUTE') THEN RAISE EXCEPTION 'baseline verifier ACL missing'; END IF;
  IF has_table_privilege('nearyou_private_tester_baseline_verifier','nearyou.product_rollout_state','SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('nearyou_private_tester_baseline_verifier','nearyou.private_tester_deployment_manifest_nonces','SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('nearyou_private_tester_baseline_verifier','nearyou.private_tester_baseline_verifier_identities','SELECT,INSERT,UPDATE,DELETE') OR has_function_privilege('nearyou_private_tester_baseline_verifier','nearyou.register_private_tester_baseline_verifier_identity(name,text)','EXECUTE') THEN RAISE EXCEPTION 'baseline verifier mutation ACL widened'; END IF;
END $$;
\set ON_ERROR_STOP off
SELECT * FROM nearyou.private_tester_baseline_verifier_identities;
\if :ERROR
\echo 'raw mapping SELECT denied as expected'
\else
\set ON_ERROR_STOP on
DO $$ BEGIN RAISE EXCEPTION 'raw mapping SELECT unexpectedly allowed'; END $$;
\endif
ROLLBACK;
\set ON_ERROR_STOP on
