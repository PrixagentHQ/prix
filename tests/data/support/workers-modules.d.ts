/**
 * The two virtual modules of the Workers test pool, declared by hand so that `tsc` can check
 * tests/data/store.d1.test.ts, which tests/tsconfig.json does not exclude (it only excludes
 * tests/workers). Only what that test uses. The runtime provides the real modules.
 */
declare module 'cloudflare:test' {
  export function applyD1Migrations(db: D1Database, migrations: unknown[]): Promise<void>;
}
declare module 'cloudflare:workers' {
  export const env: unknown;
}
