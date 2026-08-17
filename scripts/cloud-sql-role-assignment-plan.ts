const USER=/^[A-Za-z0-9_.@-]{3,200}$/;
export function cloudSqlRoleAssignmentPlan(input:{project:string;instance:string;observedSessionUser:string;operationId:string}){
  if(input.project!=="nearnight"||input.instance!=="nearyou-production"||!USER.test(input.observedSessionUser)||!/^op_[a-f0-9]{64}$/.test(input.operationId))throw new Error("cloud sql role assignment configuration invalid");
  const assignments=[
    {databaseUser:input.observedSessionUser,userType:"BUILT_IN",databaseRole:"nearyou_migration"},
    {databaseUser:"nearyou-readiness-ctl@nearnight.iam",userType:"CLOUD_IAM_SERVICE_ACCOUNT",databaseRole:"nearyou_rollout_controller"},
    {databaseUser:"nearyou-pt-baseline@nearnight.iam",userType:"CLOUD_IAM_SERVICE_ACCOUNT",databaseRole:"nearyou_private_tester_baseline_verifier"},
  ] as const;
  return{project:input.project,instance:input.instance,operationId:input.operationId,requiresMigrationHead:"0009_cloud_sql_verifier_identity_limit" as const,additiveOnly:true as const,assignments:assignments.map(item=>({...item,command:["gcloud","sql","users","assign-roles",item.databaseUser,`--project=${input.project}`,`--instance=${input.instance}`,`--type=${item.userType}`,`--database-roles=${item.databaseRole}`,"--quiet"],readback:["gcloud","sql","users","list",`--project=${input.project}`,`--instance=${input.instance}`,`--filter=name=${item.databaseUser}`,"--format=json(name,type,databaseRoles)"]}))};
}
export function validateCloudSqlRoleAssignmentReadback(plan:ReturnType<typeof cloudSqlRoleAssignmentPlan>,readback:unknown){
  if(!Array.isArray(readback)||readback.length!==plan.assignments.length)throw new Error("cloud sql role assignment readback invalid");
  for(const expected of plan.assignments){const row=readback.find(value=>value&&typeof value==="object"&&(value as {name?:unknown}).name===expected.databaseUser) as {name?:unknown;type?:unknown;databaseRoles?:unknown}|undefined;if(!row||row.type!==expected.userType||!Array.isArray(row.databaseRoles)||!row.databaseRoles.includes(expected.databaseRole))throw new Error("cloud sql role assignment readback invalid")}
  return{version:1,project:plan.project,instance:plan.instance,operationId:plan.operationId,migrationHead:plan.requiresMigrationHead,additiveOnly:true,assignments:plan.assignments.map(({databaseUser,userType,databaseRole})=>({databaseUser,userType,databaseRole})),reviewRequired:true as const};
}
