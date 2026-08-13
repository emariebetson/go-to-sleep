export type CatalogRow={kind:string;identity:string;definition:string};
export const LIVE_CATALOG_QUERY=`SELECT kind,identity,definition FROM (
SELECT 'schema' kind,n.nspname identity,concat_ws('|',pg_get_userbyid(n.nspowner),n.nspacl) definition FROM pg_namespace n WHERE n.nspname='nearyou'
UNION ALL SELECT 'table',n.nspname||'.'||c.relname,concat_ws('|',pg_get_userbyid(c.relowner),c.relrowsecurity,c.relforcerowsecurity,c.relacl) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nearyou' AND c.relkind IN('r','p')
UNION ALL SELECT 'column',n.nspname||'.'||c.relname||'.'||a.attnum,format('%s|%s|%s',a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nearyou' AND a.attnum>0 AND NOT a.attisdropped
UNION ALL SELECT 'constraint',n.nspname||'.'||c.relname||'.'||x.conname,pg_get_constraintdef(x.oid,true) FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nearyou'
UNION ALL SELECT 'index',schemaname||'.'||tablename||'.'||indexname,indexdef FROM pg_indexes WHERE schemaname='nearyou'
UNION ALL SELECT 'trigger',n.nspname||'.'||c.relname||'.'||t.tgname,concat_ws('|',t.tgenabled,pg_get_triggerdef(t.oid,true)) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nearyou' AND NOT t.tgisinternal
UNION ALL SELECT 'policy',schemaname||'.'||tablename||'.'||policyname,concat_ws('|',cmd,qual,with_check) FROM pg_policies WHERE schemaname='nearyou'
UNION ALL SELECT 'function',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',concat_ws('|',p.prosecdef,pg_get_userbyid(p.proowner),p.proconfig,p.proacl,pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='nearyou'
UNION ALL SELECT 'sequence',n.nspname||'.'||c.relname,concat_ws('|',pg_get_userbyid(c.relowner),c.relacl) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nearyou' AND c.relkind='S'
UNION ALL SELECT 'extension',e.extname,concat_ws('|',e.extversion,n.nspname) FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
UNION ALL SELECT 'role',rolname,concat_ws('|',rolsuper,rolcreaterole,rolcreatedb,rolcanlogin,rolbypassrls) FROM pg_roles WHERE rolname LIKE 'nearyou%'
UNION ALL SELECT 'membership',member.rolname||'->'||role.rolname,concat_ws('|',admin.rolname,m.admin_option,m.inherit_option,m.set_option) FROM pg_auth_members m JOIN pg_roles role ON role.oid=m.roleid JOIN pg_roles member ON member.oid=m.member LEFT JOIN pg_roles admin ON admin.oid=m.grantor WHERE role.rolname LIKE 'nearyou%' OR member.rolname LIKE 'nearyou%'
) observed ORDER BY kind COLLATE "C",identity COLLATE "C",definition COLLATE "C"`;
export async function collectLiveCatalog(pg:{query<T>(sql:string,args?:unknown[]):Promise<{rows:T[]}>}){const rows=(await pg.query<CatalogRow>(LIVE_CATALOG_QUERY,[])).rows;if(!rows.length)throw new Error("migration catalog empty");return rows}
