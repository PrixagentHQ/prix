import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

/** Builds the schema of infra/migrations in the local D1 database before the tests of a file run. */
const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
