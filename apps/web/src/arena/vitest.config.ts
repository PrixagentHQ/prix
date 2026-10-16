import { defineConfig } from 'vitest/config';

// The unit tests of the arena's pure helpers. Run: pnpm exec vitest run --config apps/web/src/arena/vitest.config.ts
export default defineConfig({
  test: {
    root: 'apps/web/src/arena',
    include: ['**/*.test.ts'],
    // Rendered by Astro's container under its own config (tape/vitest.config.ts).
    exclude: ['**/node_modules/**', 'tape/render.test.ts'],
    environment: 'node',
  },
});
