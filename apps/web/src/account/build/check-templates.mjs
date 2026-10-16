// Looks at the strategy templates of /build on a SAMPLE build (PRIX_FIXTURES=1), under the page's own
// Content-Security-Policy, the one Astro writes for the built page (D-155, TPL-3). The page's scripts
// are never replaced: the browser runs what the build ships, under the header the build sends.
// Read-only: it only GETs pages of the origin it is given, and it refuses any origin that is not local.
//
//   PRIX_FIXTURES=1 pnpm --filter @prix/web exec astro build
//   pnpm --filter @prix/web exec astro preview --port 4397 --host 127.0.0.1
//   node apps/web/src/account/build/check-templates.mjs http://127.0.0.1:4397 [directory for screenshots]
//
// It prints one line for each failed check, then a count, and exits 1 when one fails. At 360, 768 and
// 1440 pixels wide:
//   - the page arrives with a Content-Security-Policy header, and no `securitypolicyviolation` event
//     fires, signed out or signed in, before or after a template is chosen;
//   - signed out (`?fixture=signed-out`): the sign-in card holds the eight templates; choosing one
//     keeps its text as the prompt of this tab's builder draft beside the draft's other fields, the
//     status line says so, focus stays on the template, and nothing is marked as chosen; then the same
//     tab, signed in (`?fixture=signed-in`), has that text in the strategy prompt;
//   - signed in: choosing a template fills the strategy prompt with its text;
//   - the holder templates (D-161): at tier 1 (`&tokenfixture=tier1`, the fixture API's answer) the
//     section holds sixteen and choosing a holder template fills the field; at tier 0, at tier 0 with
//     forged flags in the query, and signed out, the HTML holds none of the titles, lines or texts
//     read at tier 1, eight templates and one locked line that links to /token;
//   - on a phone, signed out, at 390x664 and 360x640: a tap on the first template shows the status
//     line inside the window with focus left on the template, and its "Sign in" link moves focus to
//     the card's Sign in button and asks the wallet nothing;
//   - the status line keeps at least 8 pixels of padding below its words once it speaks (DC3-1);
//   - no sideways scroll, and every box inside the window;
//   - the contracts chunk that /build loads is at most 170,000 bytes (T3-PERF-1), so a change that
//     stops the bundler dropping the unused parts of zod cannot come back unseen.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [origin, shots] = process.argv.slice(2);
if (!origin || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('local only');
if (shots) mkdirSync(shots, { recursive: true });

const WIDTHS = [360, 768, 1440];
const PHONES = [
  [390, 664],
  [360, 640],
];
const DRAFT = 'prix.builder-draft';
/** The most bytes the client contracts chunk may hold (T3-PERF-1: about 150,000 when zod is trimmed). */
const CONTRACTS_BUDGET = 170_000;
/** A built chunk of packages/contracts, as Rolldown names it: `_astro/contracts.<hash>.js`. */
const CONTRACTS_CHUNK = /\/_astro\/contracts[.-][^/]*\.js$/;
let failed = 0;
let checks = 0;
const check = (ok, message, detail = '') => {
  checks++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${message}${detail ? ` (${detail})` : ''}`);
  }
};

// Recorded in the page before any of its own scripts run. An init script is the browser's, not the
// page's, so the policy does not apply to it and it changes nothing the page ships.
const RECORD = `(() => {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    window.__cspViolations.push(event.violatedDirective + ' ' + (event.blockedURI || 'inline') + ' ' + (event.sourceFile || '') + ':' + (event.lineNumber || 0));
  }, true);
})();`;

// A wallet stand-in, the browser's own like RECORD: it answers nothing and records each request, so
// the check can show that a control asks the wallet for nothing.
const WALLET = `(() => {
  window.__walletCalls = [];
  window.ethereum = {
    request: (call) => {
      window.__walletCalls.push(call && call.method);
      return new Promise(() => {});
    },
  };
})();`;

/** Waits up to three seconds for `test` to hold in the page. */
async function waitFor(page, test, arg) {
  try {
    await page.waitForFunction(test, arg, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function load(page, fixture, width, label, extra = '') {
  const response = await page.goto(`${origin}/build?fixture=${fixture}${extra}`, { waitUntil: 'load' });
  check(response?.status() === 200, `${label}: /build answers 200`, String(response?.status()));
  const policy = response?.headers()['content-security-policy'] ?? '';
  check(/script-src/.test(policy) && /default-src 'none'/.test(policy), `${label}: the page carries its CSP header`);
  // Give the page's module time to run before anything is pressed.
  await page.waitForLoadState('networkidle').catch(() => {});
  return { width };
}

/** The status line's bottom padding in pixels, in the section of the sign-in card. */
async function statusPadding(page) {
  return page.evaluate(() => {
    const box = document.querySelector('[data-templates-keep] .tpl-status');
    return box ? Number.parseFloat(getComputedStyle(box).paddingBottom) : -1;
  });
}

async function violations(page) {
  return page.evaluate(() => window.__cspViolations ?? null);
}

async function fits(page, label) {
  const fit = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const items = [...document.querySelectorAll('.tpl-item')];
    return {
      scroll: (document.scrollingElement?.scrollWidth ?? width) - width,
      outside: items.filter((item) => {
        const box = item.getBoundingClientRect();
        return box.left < 0 || box.right > width;
      }).length,
    };
  });
  check(fit.scroll <= 0, `${label}: no sideways scroll`, `${fit.scroll}px`);
  check(fit.outside === 0, `${label}: every box inside the window`, `${fit.outside} outside`);
}

const browser = await chromium.launch();
try {
  // The contracts chunk /build loads, signed out and signed in, measured as the browser receives it
  // once decoded: the bytes it must parse.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const chunks = new Map();
    page.on('response', async (response) => {
      const path = new URL(response.url()).pathname;
      if (!CONTRACTS_CHUNK.test(path) || chunks.has(path)) return;
      chunks.set(path, -1);
      try {
        chunks.set(path, (await response.body()).length);
      } catch {
        // Left at -1: the check below names it.
      }
    });
    for (const fixture of ['signed-out', 'signed-in']) {
      await load(page, fixture, 1440, `the contracts chunk, ${fixture}`);
    }
    // Every body is read before the sizes are judged.
    for (let tries = 0; tries < 30 && [...chunks.values()].includes(-1); tries++) await page.waitForTimeout(100);
    check(chunks.size > 0, '/build loads a contracts chunk', 'none seen: has the chunk been renamed?');
    for (const [path, bytes] of chunks) {
      check(
        bytes >= 0 && bytes <= CONTRACTS_BUDGET,
        `the contracts chunk is at most ${CONTRACTS_BUDGET} bytes`,
        `${path}: ${bytes} bytes`,
      );
      console.log(`contracts chunk ${path}: ${bytes} bytes (budget ${CONTRACTS_BUDGET})`);
    }
    await context.close();
  }

  for (const width of WIDTHS) {
    // Signed out, then the same tab signed in.
    {
      const label = `signed out at ${width}`;
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.addInitScript(RECORD);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await load(page, 'signed-out', width, label);
      check((await page.locator('form[data-build]').count()) === 0, `${label}: no build form before the sign-in`);
      const section = page.locator('[data-templates][data-templates-keep]');
      check((await section.count()) === 1, `${label}: one templates section in the sign-in card`);
      check((await section.locator('button[data-template]').count()) === 8, `${label}: eight templates`);
      await fits(page, label);
      // A draft of this tab with another field in it, as if the person had typed a name earlier.
      await page.evaluate((key) => window.sessionStorage.setItem(key, JSON.stringify({ name: 'Check Name' })), DRAFT);
      const button = section.locator('button[data-template]').nth(1);
      const text = (await button.getAttribute('data-template')) ?? '';
      await button.click();
      const keptOk = await waitFor(
        page,
        ([key, expected]) => {
          try {
            const draft = JSON.parse(window.sessionStorage.getItem(key) ?? '{}');
            return draft.prompt === expected && draft.name === 'Check Name';
          } catch {
            return false;
          }
        },
        [DRAFT, text],
      );
      check(keptOk, `${label}: choosing a template keeps its text in the draft, beside the draft's name`);
      const status = (await section.locator('[data-template-status]').textContent()) ?? '';
      check(
        status.trim() !== '' && (await section.locator('[data-template-status]').isVisible()),
        `${label}: the status line speaks`,
        status,
      );
      const padding = await statusPadding(page);
      check(padding >= 8, `${label}: the status line keeps at least 8 pixels below its words`, `${padding}px`);
      check(
        await page.evaluate(() => document.activeElement?.hasAttribute('data-template') === true),
        `${label}: focus stays on the template`,
      );
      check(
        (await page.locator('[data-templates] [aria-current]').count()) === 0,
        `${label}: nothing marked as chosen`,
      );
      if (shots) await page.screenshot({ path: join(shots, `build-signed-out-${width}.png`), fullPage: true });
      check(
        JSON.stringify(await violations(page)) === '[]',
        `${label}: no CSP violation`,
        JSON.stringify(await violations(page)),
      );

      const afterLabel = `signed in after the sign-in at ${width}`;
      await load(page, 'signed-in', width, afterLabel);
      const restored = await waitFor(
        page,
        (expected) => document.querySelector('textarea[name="prompt"]')?.value === expected,
        text,
      );
      check(restored, `${afterLabel}: the strategy prompt holds the template's text`);
      check(
        JSON.stringify(await violations(page)) === '[]',
        `${afterLabel}: no CSP violation`,
        JSON.stringify(await violations(page)),
      );
      check(errors.length === 0, `${label}: no script error`, errors.join(' | '));
      await context.close();
    }

    // Signed in, from an empty tab.
    {
      const label = `signed in at ${width}`;
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.addInitScript(RECORD);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await load(page, 'signed-in', width, label);
      const section = page.locator('form[data-build] [data-templates]');
      check((await section.count()) === 1, `${label}: one templates section in the form`);
      await fits(page, label);
      const button = section.locator('button[data-template]').first();
      const text = (await button.getAttribute('data-template')) ?? '';
      await button.click();
      const filled = await waitFor(
        page,
        (expected) => document.querySelector('textarea[name="prompt"]')?.value === expected,
        text,
      );
      check(filled, `${label}: choosing a template fills the strategy prompt`);
      check(
        (await page.locator('[data-templates] [aria-current]').count()) === 0,
        `${label}: nothing marked as chosen`,
      );
      if (shots) await page.screenshot({ path: join(shots, `build-signed-in-${width}.png`), fullPage: true });
      check(
        JSON.stringify(await violations(page)) === '[]',
        `${label}: no CSP violation`,
        JSON.stringify(await violations(page)),
      );
      check(errors.length === 0, `${label}: no script error`, errors.join(' | '));
      await context.close();
    }

    // The holder templates (D-161): at tier 1 the server renders eight more in the same section, and
    // choosing one fills the field as the first eight do. At tier 0, and at tier 0 with every flag a
    // page could forge, the page holds one locked line with a link to /token and no holder title or
    // text: the strings collected at tier 1 are looked for in the tier-0 HTML.
    {
      const label = `signed in at tier 1 at ${width}`;
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.addInitScript(RECORD);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await load(page, 'signed-in', width, label, '&tokenfixture=tier1');
      const section = page.locator('form[data-build] [data-templates]');
      check((await section.count()) === 1, `${label}: one templates section in the form`);
      check((await section.locator('button[data-template]').count()) === 16, `${label}: sixteen templates`);
      const holderList = section.locator('[data-templates-holder]');
      check((await holderList.count()) === 1, `${label}: the holder list is in the section`);
      check((await page.locator('[data-templates-locked]').count()) === 0, `${label}: no locked line`);
      await fits(page, label);
      const holderStrings = await holderList.evaluate((list) =>
        [...list.querySelectorAll('button[data-template]')].flatMap((button) => [
          button.dataset.template ?? '',
          button.dataset.templateName ?? '',
          button.querySelector('.tpl-item-line')?.textContent?.trim() ?? '',
        ]),
      );
      check(holderStrings.length === 24 && !holderStrings.includes(''), `${label}: each holder template has its words`);
      const button = holderList.locator('button[data-template]').nth(2);
      const text = (await button.getAttribute('data-template')) ?? '';
      await button.click();
      const filled = await waitFor(
        page,
        (expected) => document.querySelector('textarea[name="prompt"]')?.value === expected,
        text,
      );
      check(filled, `${label}: choosing a holder template fills the strategy prompt`);
      check(
        (await page.locator('[data-templates] [aria-current]').count()) === 0,
        `${label}: nothing marked as chosen`,
      );
      if (shots) await page.screenshot({ path: join(shots, `build-holder-${width}.png`), fullPage: true });
      check(
        JSON.stringify(await violations(page)) === '[]',
        `${label}: no CSP violation`,
        JSON.stringify(await violations(page)),
      );
      check(errors.length === 0, `${label}: no script error`, errors.join(' | '));

      for (const [lockedLabel, extra] of [
        [`signed in at tier 0 at ${width}`, '&tokenfixture=tier0'],
        [`signed in at tier 0 with forged flags at ${width}`, '&tokenfixture=tier0&tier=1&holder=1&entitlements=1'],
        [`signed out at ${width}, for the holder templates`, ''],
      ]) {
        const fixture = lockedLabel.startsWith('signed out') ? 'signed-out' : 'signed-in';
        await context.clearCookies();
        await load(page, fixture, width, lockedLabel, extra);
        const html = await page.content();
        const leaked = holderStrings.filter((value) => value !== '' && html.includes(value));
        check(leaked.length === 0, `${lockedLabel}: no holder template's title, line or text`, leaked[0] ?? '');
        check((await page.locator('[data-templates-holder]').count()) === 0, `${lockedLabel}: no holder list`);
        check(
          (await page.locator('[data-templates] button[data-template]').count()) === 8,
          `${lockedLabel}: eight templates`,
        );
        const locked = page.locator('[data-templates-locked]');
        check((await locked.count()) === 1 && (await locked.isVisible()), `${lockedLabel}: one locked line, shown`);
        check(
          (await locked.locator('a[href="/token"]').count()) === 1,
          `${lockedLabel}: the locked line links to the token page`,
        );
        await fits(page, lockedLabel);
        if (shots) {
          const name = fixture === 'signed-out' ? 'out' : extra.includes('holder=1') ? 'forged' : 'tier0';
          await page.screenshot({ path: join(shots, `build-locked-${name}-${width}.png`), fullPage: true });
        }
        check(
          JSON.stringify(await violations(page)) === '[]',
          `${lockedLabel}: no CSP violation`,
          JSON.stringify(await violations(page)),
        );
      }
      check(errors.length === 0, `holder pages at ${width}: no script error`, errors.join(' | '));
      await context.close();
    }
  }

  // A phone, signed out (DC-T1, DC-T2): a tap on the first template shows its status line inside the
  // window, focus stays on the template, and the line's "Sign in" link moves focus to the card's Sign
  // in button and asks the wallet nothing. A wallet stand-in records every request made of it.
  for (const [width, height] of PHONES) {
    const label = `signed out on a phone at ${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.addInitScript(RECORD);
    await page.addInitScript(WALLET);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await load(page, 'signed-out', width, label);
    const section = page.locator('[data-templates][data-templates-keep]');
    await section.locator('button[data-template]').first().tap();
    const shown = await waitFor(page, () => {
      const box = document.querySelector('[data-templates-keep] .tpl-status');
      const line = box?.querySelector('[data-template-status]');
      if (!box || !line?.textContent?.trim()) return false;
      const rect = box.getBoundingClientRect();
      return rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight + 0.5;
    });
    check(shown, `${label}: the status line is inside the window after a tap`);
    const padding = await statusPadding(page);
    check(padding >= 8, `${label}: the status line keeps at least 8 pixels below its words`, `${padding}px`);
    check(
      await page.evaluate(() => document.activeElement?.hasAttribute('data-template') === true),
      `${label}: focus stays on the template`,
    );
    const link = section.locator('a[data-template-sign-in]');
    check(await link.isVisible(), `${label}: the status line offers Sign in`);
    if (shots) await page.screenshot({ path: join(shots, `build-signed-out-phone-${width}x${height}.png`) });
    const asked = await page.evaluate(() => window.__walletCalls.length);
    await link.tap();
    check(
      await page.evaluate(() => document.activeElement?.hasAttribute('data-sign-in-button') === true),
      `${label}: Sign in moves focus to the card's Sign in button`,
    );
    check(
      (await page.evaluate(() => window.__walletCalls.length)) === asked,
      `${label}: Sign in asks the wallet nothing`,
      JSON.stringify(await page.evaluate(() => window.__walletCalls)),
    );
    check(
      JSON.stringify(await violations(page)) === '[]',
      `${label}: no CSP violation`,
      JSON.stringify(await violations(page)),
    );
    check(errors.length === 0, `${label}: no script error`, errors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`${checks - failed} of ${checks} checks passed`);
process.exit(failed ? 1 : 0);
