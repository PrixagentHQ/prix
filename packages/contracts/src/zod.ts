/**
 * The one module of this package that imports zod. Every other module imports `z` from here.
 *
 * zod builds a fast parser for each `z.object` with `new Function`, and to know whether it may, it
 * probes `Function('')` once (zod 4.6.5, v4/core/schemas.js: `const fastEnabled = jit &&
 * allowsEval.value`). In a browser under the site's Content-Security-Policy, which has no
 * `'unsafe-eval'`, that probe raises a `script-src` securitypolicyviolation on every page that loads
 * this package, harmless but loud enough to hide a real violation. With `jitless` set before the
 * first schema is built, `jit` is false and the probe is never read. Workers already skip it, so
 * nothing changes on a server.
 *
 * Why the call stays in a bundle: package.json lists this one file under `"sideEffects"`, so a
 * bundler keeps its top-level `config` call even where it binds an importer's `z` straight to zod's
 * own (as the site's bundler, Rolldown, does with a re-export). Every other module of the package is
 * still free of side effects, so the parts of zod the site never uses are still dropped (T3-PERF-1:
 * a constant made by a function call kept the setting but kept all of zod too, 442,875 bytes in the
 * site's contracts chunk where it was 150,008). Every module that builds a schema imports `z` from
 * here, so this module, and with it the setting, is evaluated before the first schema is built.
 * `zod.check.mts` fails when any other module of src imports 'zod' directly, and when this file
 * leaves `"sideEffects"`.
 */
import { config } from 'zod';

config({ jitless: true });

export { z } from 'zod';
