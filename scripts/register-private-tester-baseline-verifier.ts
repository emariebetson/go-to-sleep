import type { AdminPg,AdminTx } from "./register-rollout-controller";
const USER=/^[A-Za-z0-9_.@-]{3,200}$/,PRINCIPAL=/^service:[A-Za-z0-9_-]{3,100}$/;
type VerifierStage="verify-migration-membership"|"verify-verifier-membership"|"set-migration-role"|"register-identity"|"reset-role"|"verify-membership";
async function atVerifierStage<T>(stage:VerifierStage,run:()=>Promise<T>){try{return await run()}catch(error){throw new Error(`baseline verifier registration failed:${stage}`,{cause:error})}}
export async function registerPrivateTesterBaselineVerifier(pg:AdminPg,databaseUser:string,principal:string){
  if(!USER.test(databaseUser)||!PRINCIPAL.test(principal))throw new Error("baseline verifier registration invalid");
  return pg.transaction(async tx=>{
    return registerPrivateTesterBaselineVerifierInTransaction(tx,databaseUser,principal);
  })
}
export async function registerPrivateTesterBaselineVerifierInTransaction(tx:AdminTx,databaseUser:string,principal:string){
  if(!USER.test(databaseUser)||!PRINCIPAL.test(principal))throw new Error("baseline verifier registration invalid");
    const migration=(await atVerifierStage("verify-migration-membership",()=>tx.query<{admin_option:boolean;inherit_option:boolean;set_option:boolean}>("SELECT m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE r.rolname='nearyou_migration' AND m.member=(SELECT oid FROM pg_roles WHERE rolname=current_user)",[]))).rows[0];
    if(!migration||migration.admin_option!==false||migration.inherit_option!==true||migration.set_option!==true)throw new Error("baseline verifier registration failed:verify-migration-membership");
    const target=(await atVerifierStage("verify-verifier-membership",()=>tx.query<{admin_option:boolean;inherit_option:boolean;set_option:boolean;sensitive_extra_count:string}>("SELECT m.admin_option,m.inherit_option,m.set_option,(SELECT count(*)::text FROM pg_auth_members x JOIN pg_roles xr ON xr.oid=x.roleid JOIN pg_roles xu ON xu.oid=x.member WHERE xu.rolname=$1 AND xr.rolname LIKE 'nearyou_%' AND xr.rolname<>'nearyou_private_tester_baseline_verifier') sensitive_extra_count FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE r.rolname='nearyou_private_tester_baseline_verifier' AND u.rolname=$1",[databaseUser]))).rows[0];
    if(!target||target.admin_option!==false||target.inherit_option!==true||target.set_option!==true||target.sensitive_extra_count!=="0")throw new Error("baseline verifier registration failed:verify-verifier-membership");
    await atVerifierStage("set-migration-role",()=>tx.query("SET LOCAL ROLE nearyou_migration",[]));
    const registered=(await atVerifierStage("register-identity",()=>tx.query<{database_user:string;principal:string;effective:boolean}>("SELECT database_user,principal,effective FROM nearyou.register_private_tester_baseline_verifier_identity($1::name,$2)",[databaseUser,principal]))).rows[0];
    await atVerifierStage("reset-role",()=>tx.query("RESET ROLE",[]));
    const effective=(await atVerifierStage("verify-membership",()=>tx.query<{ok:boolean}>("SELECT pg_has_role($1,'nearyou_private_tester_baseline_verifier','USAGE') AS ok",[databaseUser]))).rows[0]?.ok;
    if(!effective||registered?.database_user!==databaseUser||registered.principal!==principal||registered.effective!==true)throw new Error("baseline verifier registration failed:verify-membership");
    return{baselineVerifierMappingVerified:true as const,artifact:{databaseUser,principal,effective:true as const}}
}
