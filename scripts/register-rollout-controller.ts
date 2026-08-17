const USER=/^[A-Za-z0-9_.@-]{3,200}$/,PRINCIPAL=/^service:[A-Za-z0-9_-]{3,100}$/;
export type AdminPg={transaction<T>(run:(tx:{query<T>(sql:string,args:unknown[]):Promise<{rows:T[]}>})=>Promise<T>):Promise<T>};
export type AdminTx={query<T>(sql:string,args:unknown[]):Promise<{rows:T[]}>};
type ControllerStage="verify-migration-membership"|"verify-controller-membership"|"set-migration-role"|"register-identity"|"reset-role"|"verify-membership";
async function atControllerStage<T>(stage:ControllerStage,run:()=>Promise<T>){try{return await run()}catch(error){throw new Error(`controller registration failed:${stage}`,{cause:error})}}
export async function registerRolloutController(pg:AdminPg,databaseUser:string,principal:string){
  if(!USER.test(databaseUser)||!PRINCIPAL.test(principal))throw new Error("controller registration invalid");
  return pg.transaction(async tx=>{
    return registerRolloutControllerInTransaction(tx,databaseUser,principal);
  })
}
export async function registerRolloutControllerInTransaction(tx:AdminTx,databaseUser:string,principal:string){
    if(!USER.test(databaseUser)||!PRINCIPAL.test(principal))throw new Error("controller registration invalid");
    const migration=(await atControllerStage("verify-migration-membership",()=>tx.query<{admin_option:boolean;inherit_option:boolean;set_option:boolean}>("SELECT m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE r.rolname='nearyou_migration' AND m.member=(SELECT oid FROM pg_roles WHERE rolname=current_user)",[]))).rows[0];
    if(!migration||migration.admin_option!==false||migration.inherit_option!==true||migration.set_option!==true)throw new Error("controller registration failed:verify-migration-membership");
    const target=(await atControllerStage("verify-controller-membership",()=>tx.query<{admin_option:boolean;inherit_option:boolean;set_option:boolean;sensitive_extra_count:string}>("SELECT m.admin_option,m.inherit_option,m.set_option,(SELECT count(*)::text FROM pg_auth_members x JOIN pg_roles xr ON xr.oid=x.roleid JOIN pg_roles xu ON xu.oid=x.member WHERE xu.rolname=$1 AND xr.rolname LIKE 'nearyou_%' AND xr.rolname<>'nearyou_rollout_controller') sensitive_extra_count FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE r.rolname='nearyou_rollout_controller' AND u.rolname=$1",[databaseUser]))).rows[0];
    if(!target||target.admin_option!==false||target.inherit_option!==true||target.set_option!==true||target.sensitive_extra_count!=="0")throw new Error("controller registration failed:verify-controller-membership");
    await atControllerStage("set-migration-role",()=>tx.query("SET LOCAL ROLE nearyou_migration",[]));
    const registered=(await atControllerStage("register-identity",()=>tx.query<{database_user:string;principal:string;effective:boolean}>("SELECT database_user,principal,effective FROM nearyou.register_rollout_controller_identity($1::name,$2)",[databaseUser,principal]))).rows[0];
    await atControllerStage("reset-role",()=>tx.query("RESET ROLE",[]));
    const effective=(await atControllerStage("verify-membership",()=>tx.query<{ok:boolean}>("SELECT pg_has_role($1,'nearyou_rollout_controller','USAGE') AS ok",[databaseUser]))).rows[0]?.ok;
    if(!effective||registered?.database_user!==databaseUser||registered.principal!==principal||registered.effective!==true)throw new Error("controller registration failed:verify-membership");
    return{controllerMappingVerified:true as const,artifact:{databaseUser,principal,effective:true as const}}
}
