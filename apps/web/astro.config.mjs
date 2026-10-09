import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

// Fixture mode is decided when the site is built or the dev server starts, never at run time:
// a production build contains no fixture and no code path that reads one.
const fixtures = process.env.PRIX_FIXTURES === '1';

export default defineConfig({
  site: 'https://prixagent.com',
  output: 'server',
  // No image binding: the site ships no raster images, and the binding would be a remote resource.
  adapter: cloudflare({ imageService: 'passthrough' }),
  // The API owns the session. Without this the adapter provisions a KV namespace on deploy.
  session: false,
  // Nothing renders code blocks, and the default highlighter writes style attributes, which
  // the Content-Security-Policy below blocks.
  markdown: { syntaxHighlight: false },
  security: {
    // Astro adds script-src and style-src with a hash for every script and style it ships, and
    // sends the policy as a response header on every page it renders. Inline event handlers and
    // style attributes are therefore blocked. Astro applies no policy in `astro dev`: build and
    // preview to see it.
    csp: {
      algorithm: 'SHA-256',
      directives: [
        "default-src 'none'",
        "base-uri 'none'",
        "connect-src 'self'",
        "font-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        // Images come from this site only. No page uses a data: image: the favicon is a file.
        "img-src 'self'",
        "manifest-src 'self'",
        // The service worker of the push notes is loaded from this site only.
        "worker-src 'self'",
      ],
    },
  },
  vite: {
    define: {
      __PRIX_FIXTURES__: JSON.stringify(fixtures),
    },
    build: {
      rollupOptions: {
        output: {
          // One chunk for all of packages/contracts: split apart, its index, scoring and
          // phase2-reputation modules import each other in a cycle and evaluate in the wrong order.
          manualChunks(id) {
            return id.split('\\').join('/').includes('/packages/contracts/') ? 'contracts' : undefined;
          },
        },
      },
    },
  },
});
