// The website budgets of docs/SPEC.md section 7.5, as a script that passes or fails.
//
//   node tools/perf/budgets.mjs <base-url> [--agent <id-or-path>] [--runs 3] [--fixtures]
//        [--pages landing,league,agent,token,methodology,sign-in,build,account]
//
// For the landing page (/), the league page (/league), one agent page (/agents/<id>), sign-in
// (/sign-in), the builder (/build) and the account page (/account) it runs Lighthouse on its phone
// profile and fails a page when
//   - any of performance, accessibility, best practices or SEO scores below 95,
//   - the largest contentful paint is 1.8 s or more,
//   - the cumulative layout shift is 0.02 or more,
//   - the page does not answer 200 with HTML, or Lighthouse cannot measure it,
//   - (landing page only) it loads 60,000 bytes or more of compressed JavaScript.
//
// For every page it also reports the compressed JavaScript, CSS and font bytes the page loads
// (each file fetched from the server without compression, then gzip level 9 and brotli level 11
// applied here, so a server that does not compress, such as astro preview, does not hide the size),
// the inline scripts of the HTML, how much of the JavaScript is the zod chunk (K5), and the
// Lighthouse timings (FCP, speed index, total blocking time).
//
// --fixtures adds the fixture query of apps/web/src/lib/fixtures to the pages that need a session
// (signed-in for the builder and the account page). Use it only on a site built with PRIX_FIXTURES=1.
// Against prixagent.com, leave it out: the builder and the account page then redirect a signed-out
// visitor to sign-in, and what is measured is the page Lighthouse lands on, which the output says.
//
// The phone profile is Lighthouse's own mobile default, which stands for a mid-range phone:
// a Moto G Power screen, a CPU slowed four times and a slow 4G connection, both simulated.
// Every run starts a fresh copy of the Chromium that Playwright installed. With several runs the
// verdict uses the median run of each number (for an even count, the worse of the middle two).
//
// The agent page: pass --agent with an id or a path. Without it the script takes the first agent
// of GET /api/league. If it finds none, the agent page counts as failed, not as skipped.
//
// Exit code: 0 when every page passes, 1 when one fails or is not measured, 2 on a usage error.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import lighthouse from 'lighthouse';
import { chromiumPath, cli, int, killTree, parseArgs, sleep, table, UsageError, writeArtifact } from './lib.mjs';
import { WEB_BUDGETS } from './limits.mjs';

const USAGE =
  'Usage: node tools/perf/budgets.mjs <base-url> [--agent <id-or-path>] [--runs 3] [--fixtures] [--pages landing,league,agent,token,methodology,sign-in,build,account]';

const ALL_PAGES = ['landing', 'league', 'agent', 'token', 'methodology', 'sign-in', 'build', 'account'];
/** The fixture state that gives the builder and the account page something to show. */
const FIXTURE_QUERY = { build: '?fixture=signed-in', account: '?fixture=signed-in-agent' };

const CATEGORY_LABELS = {
  performance: 'Perf',
  accessibility: 'A11y',
  'best-practices': 'Best',
  seo: 'SEO',
};

// The flags chrome-launcher starts Chrome with for Lighthouse, so that nothing in the
// background competes with the page being measured.
const CHROME_FLAGS = [
  '--headless=new',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-client-side-phishing-detection',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-ipc-flooding-protection',
  '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion',
  '--metrics-recording-only',
  '--mute-audio',
  '--password-store=basic',
  '--use-mock-keychain',
];

/** Starts Chromium with a fresh profile and resolves with its debugging port. */
async function launchChromium(executable) {
  const profile = await mkdtemp(join(tmpdir(), 'prix-lighthouse-'));
  const child = spawn(executable, [...CHROME_FLAGS, `--user-data-dir=${profile}`, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const close = async () => {
    if (!exited) {
      await new Promise((resolveClose) => {
        child.once('exit', resolveClose);
        killTree(child);
        setTimeout(resolveClose, 5_000);
      });
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  };
  try {
    const port = await new Promise((resolvePort, reject) => {
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`Chromium did not open a debugging port.\n${stderr}`)), 30_000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        const match = stderr.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (match) {
          clearTimeout(timer);
          resolvePort(Number(match[1]));
        }
      });
      child.on('error', reject);
      child.on('exit', () => reject(new Error(`Chromium exited before it was ready.\n${stderr}`)));
    });
    return { port, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function preflight(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    await response.arrayBuffer();
    const type = response.headers.get('content-type') ?? '';
    if (response.status !== 200) return `answered ${response.status}, not 200`;
    if (!type.includes('text/html')) return `answered with content type "${type}", not HTML`;
    return null;
  } catch (error) {
    return `did not answer (${error instanceof Error ? error.message : error})`;
  }
}

/** The path of an agent page: from --agent, or the first agent of the league. Null if there is none. */
async function agentPath(baseUrl, option) {
  if (option !== '') return { path: option.startsWith('/') ? option : `/agents/${encodeURIComponent(option)}` };
  for (const division of ['open', 'pro']) {
    try {
      const response = await fetch(new URL(`/api/league?division=${division}`, baseUrl), {
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 200) continue;
      const body = await response.json();
      const id = body?.rows?.[0]?.agentId;
      if (typeof id === 'string' && id !== '') return { path: `/agents/${encodeURIComponent(id)}` };
    } catch {
      // Try the other division, then give up below.
    }
  }
  return { path: null };
}

async function runLighthouse(url, executable) {
  const browser = await launchChromium(executable);
  try {
    const result = await lighthouse(url, {
      port: browser.port,
      output: 'json',
      logLevel: 'silent',
      onlyCategories: [...WEB_BUDGETS.categories],
    });
    if (!result?.lhr) throw new Error('Lighthouse returned no result.');
    return result.lhr;
  } finally {
    await browser.close();
  }
}

function numbersOf(lhr) {
  const scores = {};
  for (const id of WEB_BUDGETS.categories) {
    const score = lhr.categories[id]?.score;
    scores[id] = typeof score === 'number' ? Math.round(score * 100) : null;
  }
  const scripts = (lhr.audits['network-requests']?.details?.items ?? []).filter(
    (item) => item.resourceType === 'Script',
  );
  return {
    scores,
    lcpMs: lhr.audits['largest-contentful-paint']?.numericValue ?? null,
    cls: lhr.audits['cumulative-layout-shift']?.numericValue ?? null,
    fcpMs: lhr.audits['first-contentful-paint']?.numericValue ?? null,
    speedIndexMs: lhr.audits['speed-index']?.numericValue ?? null,
    tbtMs: lhr.audits['total-blocking-time']?.numericValue ?? null,
    scriptTransferBytes: scripts.reduce((sum, item) => sum + (item.transferSize ?? 0), 0),
    scriptCount: scripts.length,
  };
}

/** The median, or for an even count the worse of the middle two. Null if any run has no value. */
function typical(values, higherIsWorse) {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  const sorted = [...values].sort((a, b) => (higherIsWorse ? a - b : b - a));
  return sorted[Math.floor(sorted.length / 2)];
}

/** The audits that cost a category its points, worst first. */
function failedAudits(lhr, categoryId) {
  const category = lhr.categories[categoryId];
  if (!category) return [];
  return category.auditRefs
    .filter((ref) => ref.weight > 0)
    .map((ref) => ({ ref, audit: lhr.audits[ref.id] }))
    .filter(({ audit }) => audit && typeof audit.score === 'number' && audit.score < 0.9)
    .sort((a, b) => a.audit.score * 1 - b.audit.score * 1 || b.ref.weight - a.ref.weight)
    .slice(0, 6)
    .map(({ audit }) => `${audit.title}${audit.displayValue ? ` (${audit.displayValue})` : ''}`);
}

const ZOD_MARKERS = ['ZodError', 'invalid_type', '_zod'];

function compressed(buffer) {
  return {
    raw: buffer.length,
    gzip: gzipSync(buffer, { level: 9 }).length,
    brotli: brotliCompressSync(buffer, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

/** What the page loads, from the requests Lighthouse saw plus the inline scripts of the HTML. */
async function measureAssets(lhr, pageUrl) {
  const finalUrl = lhr.finalDisplayedUrl ?? lhr.finalUrl ?? pageUrl;
  const items = lhr.audits['network-requests']?.details?.items ?? [];
  const files = [];
  for (const item of items) {
    if (!['Script', 'Stylesheet', 'Font'].includes(item.resourceType)) continue;
    try {
      const response = await fetch(item.url, {
        headers: { 'accept-encoding': 'identity' },
        signal: AbortSignal.timeout(30_000),
      });
      const body = Buffer.from(await response.arrayBuffer());
      const text = item.resourceType === 'Font' ? '' : body.toString('utf8');
      files.push({
        kind: item.resourceType === 'Script' ? 'js' : item.resourceType === 'Stylesheet' ? 'css' : 'font',
        url: item.url,
        name: new URL(item.url).pathname.split('/').pop(),
        ...compressed(body),
        zod: item.resourceType === 'Script' && ZOD_MARKERS.some((marker) => text.includes(marker)),
      });
    } catch (error) {
      files.push({ kind: 'unreadable', url: item.url, name: item.url, error: String(error) });
    }
  }
  // Inline scripts are part of the HTML, so they cost bytes too.
  try {
    const response = await fetch(finalUrl, {
      headers: { 'accept-encoding': 'identity', accept: 'text/html' },
      signal: AbortSignal.timeout(30_000),
    });
    const html = await response.text();
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(
      ([, attributes, body]) =>
        !/\bsrc=/.test(attributes) && body.trim() !== '' && !/application\/(ld\+)?json/.test(attributes),
    );
    inline.forEach(([, , body], index) => {
      files.push({
        kind: 'js',
        inline: true,
        url: finalUrl,
        name: `inline script ${index + 1}`,
        ...compressed(Buffer.from(body, 'utf8')),
        zod: ZOD_MARKERS.some((marker) => body.includes(marker)),
      });
    });
  } catch {
    // The inline scripts are then not counted.
  }
  const of = (kind) => files.filter((file) => file.kind === kind);
  const sum = (list, key) => list.reduce((total, file) => total + (file[key] ?? 0), 0);
  const zodFiles = of('js').filter((file) => file.zod);
  return {
    finalUrl,
    files,
    js: {
      gzip: sum(of('js'), 'gzip'),
      brotli: sum(of('js'), 'brotli'),
      raw: sum(of('js'), 'raw'),
      files: of('js').length,
    },
    css: {
      gzip: sum(of('css'), 'gzip'),
      brotli: sum(of('css'), 'brotli'),
      raw: sum(of('css'), 'raw'),
      files: of('css').length,
    },
    font: { bytes: sum(of('font'), 'raw'), files: of('font').length },
    zod: { gzip: sum(zodFiles, 'gzip'), brotli: sum(zodFiles, 'brotli'), names: zodFiles.map((file) => file.name) },
  };
}

async function measurePage(page, runs, executable) {
  const problem = await preflight(page.url);
  if (problem !== null) return { ...page, measured: false, reasons: [`not measured: the page ${problem}`] };

  const lhrs = [];
  for (let i = 0; i < runs; i += 1) {
    process.stderr.write(`  ${page.name}: run ${i + 1} of ${runs}\n`);
    let lhr;
    try {
      lhr = await runLighthouse(page.url, executable);
    } catch (error) {
      return {
        ...page,
        measured: false,
        reasons: [`not measured: Lighthouse failed (${error instanceof Error ? error.message : error})`],
      };
    }
    await writeArtifact(`lighthouse/${page.name}-${i + 1}.json`, JSON.stringify(lhr));
    if (lhr.runtimeError) {
      return {
        ...page,
        measured: false,
        reasons: [`not measured: ${lhr.runtimeError.code}: ${lhr.runtimeError.message}`],
        lhrs: [lhr],
      };
    }
    lhrs.push(lhr);
    await sleep(500);
  }

  const all = lhrs.map(numbersOf);
  const scores = {};
  for (const id of WEB_BUDGETS.categories) {
    scores[id] = typical(
      all.map((run) => run.scores[id]),
      false,
    );
  }
  const lcpMs = typical(
    all.map((run) => run.lcpMs),
    true,
  );
  const cls = typical(
    all.map((run) => run.cls),
    true,
  );

  const reasons = [];
  for (const id of WEB_BUDGETS.categories) {
    if (scores[id] === null) reasons.push(`${id}: Lighthouse gave no score`);
    else if (scores[id] < WEB_BUDGETS.minCategoryScore) {
      const worst = lhrs.find((lhr) => numbersOf(lhr).scores[id] === scores[id]) ?? lhrs[0];
      const audits = failedAudits(worst, id);
      reasons.push(
        `${id} is ${scores[id]}, below ${WEB_BUDGETS.minCategoryScore}${audits.length > 0 ? `: ${audits.join('; ')}` : ''}`,
      );
    }
  }
  if (lcpMs === null) reasons.push('largest contentful paint: no value. The page may paint no content.');
  else if (lcpMs >= WEB_BUDGETS.lcpMs)
    reasons.push(`largest contentful paint is ${(lcpMs / 1000).toFixed(2)} s, not under ${WEB_BUDGETS.lcpMs / 1000} s`);
  if (cls === null) reasons.push('layout shift: no value');
  else if (cls >= WEB_BUDGETS.cls) reasons.push(`layout shift is ${cls.toFixed(3)}, not under ${WEB_BUDGETS.cls}`);

  const assets = await measureAssets(lhrs[0], page.url);
  if (page.name === 'landing' && assets.js.gzip >= WEB_BUDGETS.landingJsBytes) {
    reasons.push(
      `compressed JavaScript is ${int(assets.js.gzip)} bytes (gzip level 9), not under ${int(WEB_BUDGETS.landingJsBytes)}`,
    );
  }
  const landedOn = new URL(assets.finalUrl).pathname;
  const median = (key) =>
    typical(
      all.map((run) => run[key]),
      true,
    );

  return {
    ...page,
    measured: true,
    scores,
    lcpMs,
    cls,
    fcpMs: median('fcpMs'),
    speedIndexMs: median('speedIndexMs'),
    tbtMs: median('tbtMs'),
    assets,
    landedOn: landedOn === new URL(page.url).pathname ? null : landedOn,
    runs: all,
    scriptTransferBytes: typical(
      all.map((run) => run.scriptTransferBytes),
      true,
    ),
    reasons,
    lhrs,
  };
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2), {
    agent: '',
    runs: 3,
    pages: ALL_PAGES.join(','),
    fixtures: false,
  });
  if (positional.length !== 1) throw new UsageError('Give one base URL, such as http://127.0.0.1:4321');
  let baseUrl;
  try {
    baseUrl = new URL(positional[0]);
  } catch {
    throw new UsageError(`Not a URL: ${positional[0]}`);
  }
  if (!/^https?:$/.test(baseUrl.protocol)) throw new UsageError('The base URL must start with http:// or https://');
  const runs = Math.floor(options.runs);
  if (runs < 1) throw new UsageError('--runs must be 1 or more');
  const wanted = options.pages.split(',').map((name) => name.trim());
  for (const name of wanted) {
    if (!ALL_PAGES.includes(name)) throw new UsageError(`Unknown page: ${name}`);
  }

  const executable = await chromiumPath();
  const pages = [];
  if (wanted.includes('landing')) pages.push({ name: 'landing', path: '/' });
  if (wanted.includes('league')) pages.push({ name: 'league', path: '/league' });
  if (wanted.includes('agent')) pages.push({ name: 'agent', ...(await agentPath(baseUrl, options.agent)) });
  for (const [name, path] of [
    ['token', '/token'],
    ['methodology', '/methodology'],
    ['sign-in', '/sign-in'],
    ['build', '/build'],
    ['account', '/account'],
  ]) {
    if (wanted.includes(name))
      pages.push({ name, path: `${path}${options.fixtures ? (FIXTURE_QUERY[name] ?? '') : ''}` });
  }

  const results = [];
  for (const page of pages) {
    if (page.path === null) {
      results.push({
        ...page,
        path: '/agents/?',
        measured: false,
        reasons: ['not measured: GET /api/league gave no agent. Pass --agent <id>.'],
      });
      continue;
    }
    results.push(await measurePage({ ...page, url: new URL(page.path, baseUrl).href }, runs, executable));
  }

  const first = results.find((result) => result.measured)?.lhrs[0];
  console.log(`Website budgets, docs/SPEC.md section 7.5, against ${baseUrl.origin}`);
  if (first) {
    const settings = first.configSettings;
    console.log(
      `Conditions: Lighthouse ${first.lighthouseVersion}, ${first.environment.hostUserAgent.match(/Chrome\/[\d.]+/)?.[0] ?? 'Chromium'} (Playwright's, new headless), ` +
        `form factor ${settings.formFactor}, screen ${settings.screenEmulation.width}x${settings.screenEmulation.height} at ${settings.screenEmulation.deviceScaleFactor}x,`,
    );
    console.log(
      `  throttling ${settings.throttlingMethod}: CPU slowed ${settings.throttling.cpuSlowdownMultiplier}x, ` +
        `${settings.throttling.rttMs} ms round trip, ${Math.round(settings.throttling.throughputKbps)} kbit/s; ` +
        `${runs} run(s) per page, median used; host benchmark index ${Math.round(first.environment.benchmarkIndex)}.`,
    );
  }
  console.log(
    `Budgets: each category ${WEB_BUDGETS.minCategoryScore} or more, largest contentful paint under ${WEB_BUDGETS.lcpMs / 1000} s, layout shift under ${WEB_BUDGETS.cls}.`,
  );
  console.log('');

  const rows = [['Page', 'Path', ...WEB_BUDGETS.categories.map((id) => CATEGORY_LABELS[id]), 'LCP', 'CLS', 'Verdict']];
  for (const result of results) {
    rows.push([
      result.name,
      result.path,
      ...WEB_BUDGETS.categories.map((id) => (result.measured ? (result.scores[id] ?? '-') : '-')),
      result.measured && result.lcpMs !== null ? `${(result.lcpMs / 1000).toFixed(2)} s` : '-',
      result.measured && result.cls !== null ? result.cls.toFixed(3) : '-',
      result.reasons.length === 0 ? 'PASS' : result.measured ? 'FAIL' : 'NOT MEASURED',
    ]);
  }
  console.log(table(rows));
  for (const result of results) {
    for (const reason of result.reasons) console.log(`${result.name}: ${reason}`);
  }
  const measured = results.filter((result) => result.measured);
  if (measured.length > 0) {
    console.log('');
    console.log('What each page loads, compressed here (gzip level 9 / brotli level 11); fonts as stored');
    console.log(
      table([
        [
          'Page',
          'JS gzip',
          'JS brotli',
          'JS files',
          'CSS gzip',
          'CSS brotli',
          'Fonts',
          'zod in JS (gzip)',
          'FCP',
          'Speed index',
          'TBT',
        ],
        ...measured.map((result) => {
          const { js, css, font, zod } = result.assets;
          return [
            result.name,
            int(js.gzip),
            int(js.brotli),
            js.files,
            int(css.gzip),
            int(css.brotli),
            `${int(font.bytes)} (${font.files})`,
            js.gzip === 0 ? '-' : `${int(zod.gzip)} (${Math.round((zod.gzip / js.gzip) * 100)}%)`,
            result.fcpMs === null ? '-' : `${(result.fcpMs / 1000).toFixed(2)} s`,
            result.speedIndexMs === null ? '-' : `${(result.speedIndexMs / 1000).toFixed(2)} s`,
            result.tbtMs === null ? '-' : `${Math.round(result.tbtMs)} ms`,
          ];
        }),
      ]),
    );
    for (const result of measured) {
      if (result.landedOn)
        console.log(`  ${result.name}: the page redirected; what was measured is ${result.landedOn}.`);
      if (result.assets.zod.names.length > 0) {
        console.log(
          `  ${result.name}: zod is in ${result.assets.zod.names.join(', ')} (a file with a zod marker counts whole, so this is an upper bound).`,
        );
      }
    }
    console.log(
      `Budget: the landing page loads under ${int(WEB_BUDGETS.landingJsBytes)} bytes of compressed JavaScript (judged on gzip level 9, the stricter of the two).`,
    );
  }
  console.log('');

  const failed = results.filter((result) => result.reasons.length > 0);
  const pass = failed.length === 0 && results.length > 0;
  console.log(
    pass
      ? `PASS: ${results.length} page(s) inside every budget.`
      : `FAIL: ${failed.map((result) => result.name).join(', ')} ${failed.length === 1 ? 'is' : 'are'} outside a budget or could not be measured.`,
  );

  await writeArtifact(
    'budgets.json',
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        baseUrl: baseUrl.origin,
        runs,
        budgets: WEB_BUDGETS,
        pass,
        pages: results.map(({ lhrs, ...rest }) => rest),
      },
      null,
      2,
    )}\n`,
  );
  return pass ? 0 : 1;
}

await cli(main, USAGE);
