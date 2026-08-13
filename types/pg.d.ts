declare module "pg" {
  export class Pool {
    constructor(options: { connectionString: string | undefined; ssl: { rejectUnauthorized: boolean } });
    query<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  }
}
