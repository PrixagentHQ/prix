import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The editor's own tests of the copy, beside it. The suite of `qa` (tests/unit/content.test.ts and
 * tests/social/words.test.ts) checks the rules every string keeps; the files here pin what a contract
 * asks of one group of sentences, and read each sentence from the deck.
 *
 * Run: pnpm exec vitest run --config apps/web/src/content/vitest.config.ts
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.test.ts'],
    environment: 'node',
  },
});
