\set ON_ERROR_STOP on
\if :{?verifier_database_url}
\else
\echo 'verifier_database_url is required'
\quit
\endif
\connect :verifier_database_url
BEGIN;
SET LOCAL ROLE nearyou_private_tester_baseline_verifier;
SELECT * FROM nearyou.assert_private_tester_baseline_verifier();
SELECT id,checksum FROM nearyou.schema_migrations ORDER BY id COLLATE "C";
SELECT nearyou.consume_private_tester_deployment_manifest('private-tester-deployment-manifest/v1','invalid','invalid','{}','invalid','invalid',0,'invalid',statement_timestamp()) IS FALSE AS invalid_nonce_rejected;
DO $$
BEGIN
  IF has_table_privilege('nearyou_rollout_controller','nearyou.schema_migrations','SELECT') THEN RAISE EXCEPTION 'controller can read migration ledger'; END IF;
  IF has_function_privilege('nearyou_rollout_controller','nearyou.consume_private_tester_deployment_manifest(text,text,text,text,text,text,integer,text,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'controller can consume baseline nonce'; END IF;
  IF NOT has_schema_privilege('nearyou_private_tester_baseline_verifier','nearyou','USAGE') OR NOT has_table_privilege('nearyou_private_tester_baseline_verifier','nearyou.schema_migrations','SELECT') OR NOT has_function_privilege('nearyou_private_tester_baseline_verifier','nearyou.consume_private_tester_deployment_manifest(text,text,text,text,text,text,integer,text,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'baseline verifier ACL missing'; END IF;
  IF has_table_privilege('nearyou_private_tester_baseline_verifier','nearyou.product_rollout_state','SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('nearyou_private_tester_baseline_verifier','nearyou.private_tester_deployment_manifest_nonces','SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'baseline verifier mutation ACL widened'; END IF;
END $$;
\set ON_ERROR_STOP off
SELECT * FROM nearyou.private_tester_baseline_verifier_identities;
\if :ERROR
\echo 'raw mapping SELECT denied as expected'
\else
\echo 'raw mapping SELECT unexpectedly allowed'
\quit
\endif
ROLLBACK;
