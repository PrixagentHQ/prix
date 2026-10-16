import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * The tests of `platform` that sit beside the code they prove and need the Workers runtime: the room's
 * D1 store on a local D1 database, and the entry's cache rules for the room through what it exports.
 * Run from the repository root:
 *   pnpm exec vitest run --config apps/api/vitest.workers.config.ts
 *
 * Neither the root's `pnpm test` nor `pnpm test:workers` collects them: those read tests/** only.
 * The database is declared here, as in tests/vitest.workers.config.ts, and its schema is the whole of
 * infra/migrations, applied by that folder's setup file before each test file runs.
 */
const root = path.join(import.meta.dirname, '..', '..');

export default defineConfig({
  root,
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(root, 'infra', 'migrations'));
      // The Worker's own config as text, for the entry's test that compares a binding's figures with the
      // contract's constants: a test inside the Workers runtime has no file system to read it from.
      const wrangler = await readFile(path.join(root, 'apps', 'api', 'wrangler.jsonc'), 'utf8');
      return {
        miniflare: {
          compatibilityDate: '2026-08-22',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          bindings: { TEST_MIGRATIONS: migrations, WRANGLER_JSONC: wrangler },
        },
      };
    }),
  ],
  test: {
    include: ['apps/api/src/**/*.d1.test.ts'],
    setupFiles: ['tests/workers/apply-migrations.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
