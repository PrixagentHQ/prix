/*! The crawler follows the idea of "Web crawlers" by Slava Rybin (@rybinfx), 2026-10-01,
https://x.com/rybinfx/status/2105700296760688790. Drawn and coded by Prix. */

/**
 * The crawler's own bundle (docs/DESIGN.md section 30). Vite builds it apart from every page
 * script, as a bundled worker script, so it shares no module with the layout's script and the
 * layout's script holds no `import()`: it stays inline, and Vite adds no preload helper to it.
 * crawler/gate.ts adds this file as a plain script, with the first pointer's place on it.
 */
import { start } from './crawler.ts';

const me = document.currentScript;
start(Number(me?.dataset.x ?? 0), Number(me?.dataset.y ?? 0));
