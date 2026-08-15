const USER=/^[A-Za-z0-9_.@-]{3,200}$/,PRINCIPAL=/^service:[A-Za-z0-9_-]{3,100}$/;
export type AdminPg={transaction<T>(run:(tx:{query<T>(sql:string,args:unknown[]):Promise<{rows:T[]}>})=>Promise<T>):Promise<T>};
export async function registerRolloutController(pg:AdminPg,databaseUser:string,principal:string){
  if(!USER.test(databaseUser)||!PRINCIPAL.test(principal))throw new Error("controller registration invalid");
  return pg.transaction(async tx=>{
    await tx.query("GRANT nearyou_migration TO CURRENT_USER WITH ADMIN TRUE, INHERIT TRUE, SET TRUE",[]);
    await tx.query(`GRANT nearyou_rollout_controller TO "${databaseUser.replaceAll('"','""')}" WITH INHERIT TRUE, SET TRUE`,[]);
    await tx.query("SET LOCAL ROLE nearyou_migration",[]);
    const registered=(await tx.query<{database_user:string;principal:string;effective:boolean}>("SELECT database_user,principal,effective FROM nearyou.register_rollout_controller_identity($1::name,$2)",[databaseUser,principal])).rows[0];
    await tx.query("RESET ROLE",[]);
    const effective=(await tx.query<{ok:boolean}>("SELECT pg_has_role($1,'nearyou_rollout_controller','USAGE') AS ok",[databaseUser])).rows[0]?.ok;
    if(!effective||registered?.database_user!==databaseUser||registered.principal!==principal||registered.effective!==true)throw new Error("controller registration failed");
    return{controllerMappingVerified:true as const,artifact:{databaseUser,principal,effective:true as const}}
  })
}
