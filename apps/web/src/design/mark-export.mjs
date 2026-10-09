// Writes the files of the mark of Prix, "Seat", from the paths in seat.ts:
//
//   favicon.svg        the 32 pixel cut; ink on a light tab, near white on a dark one
//   favicon-16.png     the 16 pixel cut on a light ground, for a browser that asks for a PNG
//   favicon-32.png     the 32 pixel cut, the same
//   favicon-16-dark.png, favicon-32-dark.png   the same cuts in the dark inks, for a dark tab
//   apple-touch-icon.png   180 pixels, dark inks on the dark ground, app icon radius
//   mark-512.png      the $PRIX token image: the mark on the dark ground, full bleed, so a
//                      wallet or a launchpad that cuts the picture to a circle cuts only ground
//
//   node apps/web/src/design/mark-export.mjs
//
// Node strips the types of seat.ts itself (Node 22.18 or later). The PNGs are rendered in
// Playwright's Chromium at device scale 1, so the 16 and 32 pixel files are real 1x renders.

import { copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { SEAT, SEAT_16, SEAT_32, SEAT_INKS } from './seat.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');

/** One cut of the mark as a standalone SVG, in the inks of one ground. */
function symbolSvg(cut, inks) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cut.grid} ${cut.grid}" width="${cut.grid}" height="${cut.grid}">` +
    `<path fill="${inks.square}" d="${cut.square}"/><path fill="${inks.seat}" d="${cut.seat}"/></svg>`
  );
}

/** The favicon: the 32 cut, whose inks follow the theme of the browser. */
const faviconSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>Prix</title>` +
  `<style>.i{fill:${SEAT_INKS.light.square}}.a{fill:${SEAT_INKS.light.seat}}` +
  `@media (prefers-color-scheme:dark){.i{fill:${SEAT_INKS.dark.square}}.a{fill:${SEAT_INKS.dark.seat}}}</style>` +
  `<path class="i" d="${SEAT_32.square}"/><path class="a" d="${SEAT_32.seat}"/></svg>\n`;

/**
 * The token: the master on the dark ground, centred, at the scale of study D2-2 (11.13 pixels
 * per unit), so its farthest ink sits inside 80% of the radius of the circle a launchpad cuts.
 */
function tokenSvg() {
  const k = 11.1306;
  const offset = 256 - (SEAT.grid / 2) * k;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
    `<rect width="512" height="512" fill="${SEAT_INKS.dark.ground}"/>` +
    `<g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${k.toFixed(2)})">` +
    `<path fill="${SEAT_INKS.dark.square}" d="${SEAT.square}"/><path fill="${SEAT_INKS.dark.seat}" d="${SEAT.seat}"/>` +
    `</g></svg>`
  );
}

/**
 * The apple-touch-icon: 180 pixels, the mark in the dark inks on the dark ground, at the scale of
 * the token (the mark covers 69.5% of the side) and with the iOS app icon radius (22.37%).
 */
function appleSvg() {
  const size = 180;
  const k = (size * 11.1306) / 512;
  const offset = size / 2 - (SEAT.grid / 2) * k;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}" rx="${(size * 0.2237).toFixed(1)}" fill="${SEAT_INKS.dark.ground}"/>` +
    `<g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${k.toFixed(3)})">` +
    `<path fill="${SEAT_INKS.dark.square}" d="${SEAT.square}"/><path fill="${SEAT_INKS.dark.seat}" d="${SEAT.seat}"/>` +
    `</g></svg>`
  );
}

writeFileSync(join(here, 'favicon.svg'), faviconSvg);
console.log(join(here, 'favicon.svg'));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  /** Renders an SVG to a PNG of `size` pixels; transparent around the ink unless the SVG fills its ground. */
  async function png(svg, size, target) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
    await page.screenshot({ path: target, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(target);
  }
  await png(symbolSvg(SEAT_16, SEAT_INKS.light), 16, join(here, 'favicon-16.png'));
  await png(symbolSvg(SEAT_32, SEAT_INKS.light), 32, join(here, 'favicon-32.png'));
  // Dark-ground cuts: the dark inks, for a tab of a dark browser (the square is near white there).
  await png(symbolSvg(SEAT_16, SEAT_INKS.dark), 16, join(here, 'favicon-16-dark.png'));
  await png(symbolSvg(SEAT_32, SEAT_INKS.dark), 32, join(here, 'favicon-32-dark.png'));
  await png(appleSvg(), 180, join(here, 'apple-touch-icon.png'));
  await png(tokenSvg(), 512, join(here, 'mark-512.png'));
} finally {
  await browser.close();
}

const launch = join(repo, 'docs', 'assets', 'prix-token-512.png');
copyFileSync(join(here, 'mark-512.png'), launch);
console.log(launch);
