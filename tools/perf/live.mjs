// Cold-load speed of the live site, one command, GET only.
//
//   node tools/perf/live.mjs [base-url] [--runs 3] [--pages /,/league,...] [--themes dark,light]
//                            [--profiles phone,desktop] [--agent <id>] [--out live.json]
//
// For each page x theme x profile it loads the page in a fresh browser context (cold cache)
// and reports: LCP, CLS, long-task total blocking time, JavaScript / CSS / font / image bytes
// on the wire, request count, server response time (TTFB of the document) and HTML size.
// Numbers are the median of --runs loads.
//
// Profiles (conditions are printed with the result):
//   phone    390x844, DPR 2, mobile UA, slow 4G (1.6 Mbit/s down, 750 kbit/s up, 150 ms RTT),
//            4x CPU slowdown. Same network numbers as Lighthouse's mobile preset.
//   desktop  1280x800, no throttle.
// Dark is the site's default (no cookie). Light sends the cookie prix_theme=light.
//
// Experiments: --block font (abort a resource type), --block-url JetBrains (abort URLs containing text) and --cpu 1 (override the slowdown) show where
// the time goes. They are not budget results.
//
// Safety: only GET navigations and sub-resource GETs. Any other method is aborted in the
// browser before it leaves the machine and counted as "blocked writes" in the result.
//
// Budgets (docs/SPEC.md 7.5, copied in limits.mjs): LCP < 1.8 s, CLS < 0.02, landing JS
// < 60,000 bytes compressed. TBT has no number in the spec; Lighthouse's "good" is 200 ms and
// is shown for orientation only.
//
// Exit 0 when every budget holds on every configuration, 1 when one fails, 2 on a crash.

import { chromium } from '@playwright/test';
import { cli, int, kb, parseArgs, table, UsageError, writeArtifact } from './lib.mjs';
import { WEB_BUDGETS } from './limits.mjs';

const PROFILES = {
  phone: {
    label: 'phone 390px, slow 4G (1.6 Mbit/s, 150 ms RTT), 4x CPU',
    context: {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
    },
    network: {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    },
    cpu: 4,
  },
  desktop: {
    label: 'desktop 1280px, no throttle',
    context: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    network: null,
    cpu: 1,
  },
};

const TBT_GOOD_MS = 200;
const SETTLE_MS = 2_500; // wait after `load` so LCP and late shifts are recorded
const NAV_TIMEOUT_MS = 60_000;

const observerScript = () => {
  const state = { lcp: 0, lcpEl: '', cls: 0, longTasks: [], fcp: 0 };
  window.__perf = state;
  const describe = (el) => {
    if (!el) return '';
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        state.lcp = e.startTime;
        state.lcpEl = describe(e.element) + (e.url ? ` (${e.url.split('/').slice(-1)[0]})` : '');
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) state.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) state.longTasks.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') state.fcp = e.startTime;
    }).observe({ type: 'paint', buffered: true });
  } catch {
    // an observer type is missing: the field stays 0 and the script reports it
  }
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function typeBucket(url, resourceType, mime) {
  if (resourceType === 'Document') return 'html';
  if (resourceType === 'Script') return 'js';
  if (resourceType === 'Stylesheet') return 'css';
  if (resourceType === 'Font') return 'font';
  if (resourceType === 'Image') return 'image';
  if (/\.m?js(\?|$)/.test(url) || /javascript/.test(mime ?? '')) return 'js';
  if (/\.css(\?|$)/.test(url)) return 'css';
  if (/\.woff2?(\?|$)/.test(url)) return 'font';
  return 'other';
}

async function loadOnce(browser, base, path, theme, profileName, experiment) {
  const profile = { ...PROFILES[profileName] };
  if (experiment.cpu) profile.cpu = experiment.cpu;
  const context = await browser.newContext(profile.context);
  if (theme === 'light') {
    await context.addCookies([{ name: 'prix_theme', value: 'light', url: base }]);
  }
  await context.addInitScript(observerScript);
  const page = await context.newPage();
  let blocked = 0;
  await page.route('**/*', (route) => {
    const method = route.request().method();
    if (method !== 'GET' && method !== 'HEAD') {
      blocked += 1;
      return route.abort();
    }
    if (experiment.block.has(route.request().resourceType())) return route.abort();
    if (experiment.blockUrl && route.request().url().includes(experiment.blockUrl)) return route.abort();
    return route.continue();
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (profile.network) await cdp.send('Network.emulateNetworkConditions', profile.network);
  if (profile.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });

  const reqs = new Map();
  cdp.on('Network.requestWillBeSent', (e) => {
    reqs.set(e.requestId, {
      url: e.request.url,
      method: e.request.method,
      type: e.type,
      bytes: 0,
      decoded: 0,
      status: 0,
      headers: {},
      t0: e.timestamp,
      t1: 0,
      priority: e.request.initialPriority,
    });
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    r.status = e.response.status;
    r.mime = e.response.mimeType;
    r.headers = e.response.headers;
    r.type = e.type;
  });
  cdp.on('Network.dataReceived', (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.decoded += e.dataLength;
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = reqs.get(e.requestId);
    if (r) {
      r.bytes = e.encodedDataLength;
      r.t1 = e.timestamp;
    }
  });

  const response = await page.goto(base + path, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
  const result = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      perf: window.__perf,
      ttfb: nav.responseStart - nav.requestStart,
      ttfbFromStart: nav.responseStart,
      domContentLoaded: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
    };
  });
  await context.close();

  const totals = { html: 0, js: 0, css: 0, font: 0, image: 0, other: 0 };
  const files = [];
  let count = 0;
  let htmlDecoded = 0;
  const origin = Math.min(...[...reqs.values()].map((r) => r.t0));
  let docHeaders = {};
  for (const r of reqs.values()) {
    if (r.method !== 'GET' || !r.status) continue;
    count += 1;
    const bucket = typeBucket(r.url, r.type, r.mime);
    totals[bucket] += r.bytes;
    if (bucket === 'html' && r === [...reqs.values()][0]) {
      htmlDecoded = r.decoded;
      docHeaders = Object.fromEntries(
        [
          'content-type',
          'content-encoding',
          'content-length',
          'cache-control',
          'cf-cache-status',
          'server-timing',
          'vary',
          'age',
        ].map((h) => [h, r.headers[h] ?? '']),
      );
    }
    files.push({
      url: r.url.replace(base, ''),
      bucket,
      status: r.status,
      wireBytes: r.bytes,
      decodedBytes: r.decoded,
      encoding: r.headers['content-encoding'] ?? '',
      cache: r.headers['cf-cache-status'] ?? '',
      cacheControl: r.headers['cache-control'] ?? '',
      startMs: Math.round((r.t0 - origin) * 1000),
      endMs: Math.round((r.t1 - origin) * 1000),
    });
  }
  const { perf } = result;
  const tbt = perf.longTasks.reduce((sum, [start, dur]) => (start >= perf.fcp ? sum + Math.max(0, dur - 50) : sum), 0);
  const docWire = files.find((f) => f.bucket === 'html')?.wireBytes ?? 0;
  const docEnc = files.find((f) => f.bucket === 'html')?.encoding ?? '';
  return {
    status: response?.status() ?? 0,
    lcpMs: perf.lcp,
    lcpElement: perf.lcpEl,
    cls: perf.cls,
    tbtMs: tbt,
    longTasks: perf.longTasks.length,
    fcpMs: perf.fcp,
    ttfbMs: result.ttfb,
    loadMs: result.load,
    requests: count,
    jsBytes: totals.js,
    cssBytes: totals.css,
    fontBytes: totals.font,
    imageBytes: totals.image,
    otherBytes: totals.other,
    htmlWireBytes: docWire,
    htmlBytes: htmlDecoded,
    htmlEncoding: docEnc,
    totalBytes: Object.values(totals).reduce((a, b) => a + b, 0),
    blockedWrites: blocked,
    docHeaders,
    files,
  };
}

function summarise(runs) {
  const keys = [
    'lcpMs',
    'cls',
    'tbtMs',
    'longTasks',
    'fcpMs',
    'ttfbMs',
    'loadMs',
    'requests',
    'jsBytes',
    'cssBytes',
    'fontBytes',
    'imageBytes',
    'otherBytes',
    'htmlWireBytes',
    'htmlBytes',
    'totalBytes',
  ];
  const out = {};
  for (const key of keys) out[key] = median(runs.map((r) => r[key]));
  out.lcpMin = Math.min(...runs.map((r) => r.lcpMs));
  out.lcpMax = Math.max(...runs.map((r) => r.lcpMs));
  out.lcpElement = runs[0].lcpElement;
  out.status = runs[0].status;
  out.htmlEncoding = runs[0].htmlEncoding;
  out.blockedWrites = runs.reduce((a, r) => a + r.blockedWrites, 0);
  out.docHeaders = runs[0].docHeaders;
  out.files = runs[0].files;
  out.runs = runs.length;
  return out;
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2), {
    runs: 3,
    pages: '',
    themes: 'dark,light',
    profiles: 'phone,desktop',
    agent: '2ynmb7yiulmp',
    out: 'live.json',
    // Experiments, to find where the time goes: abort a resource type (font, script, image) or
    // override the CPU slowdown. Results of an experiment are not budget results.
    block: '',
    blockUrl: '',
    cpu: 0,
  });
  const experiment = {
    block: new Set(options.block ? options.block.split(',') : []),
    cpu: options.cpu,
    blockUrl: options.blockUrl,
  };
  const base = (positional[0] ?? 'https://prixagent.com').replace(/\/$/, '');
  const pages = options.pages
    ? options.pages.split(',')
    : ['/', '/league', `/agents/${options.agent}`, '/token', '/methodology', '/build'];
  const themes = options.themes.split(',');
  const profiles = options.profiles.split(',');
  for (const p of profiles) if (!PROFILES[p]) throw new UsageError(`Unknown profile ${p}`);

  const browser = await chromium.launch();
  const version = browser.version();
  const results = [];
  for (const profile of profiles) {
    for (const theme of themes) {
      for (const path of pages) {
        const runs = [];
        for (let i = 0; i < options.runs; i += 1) {
          try {
            runs.push(await loadOnce(browser, base, path, theme, profile, experiment));
          } catch (error) {
            console.error(`  ${profile} ${theme} ${path} run ${i + 1}: ${error.message}`);
          }
        }
        if (runs.length === 0) {
          results.push({ path, theme, profile, error: 'no run finished' });
          continue;
        }
        const s = summarise(runs);
        results.push({ path, theme, profile, ...s });
        console.log(
          `${profile.padEnd(7)} ${theme.padEnd(5)} ${path.padEnd(24)} LCP ${int(s.lcpMs)} ms  CLS ${s.cls.toFixed(4)}  TBT ${int(s.tbtMs)} ms  JS ${kb(s.jsBytes)}`,
        );
      }
    }
  }
  await browser.close();

  const conditions = {
    base,
    experiment:
      experiment.block.size || experiment.cpu || experiment.blockUrl
        ? { blocked: [...experiment.block], cpu: experiment.cpu, blockUrl: experiment.blockUrl }
        : 'none',
    date: new Date().toISOString(),
    runsPerConfig: options.runs,
    statistic: 'median of runs, cold cache, new browser context each run',
    chromium: version,
    host: `${process.platform} ${process.arch}, ${process.version}`,
    profiles: Object.fromEntries(profiles.map((p) => [p, PROFILES[p].label])),
    method: 'GET only; other methods aborted in the browser',
    note: 'Measured from one machine over its real network path, so server response time includes that path. CPU throttle is relative to this machine, which is not a phone.',
  };

  const failures = [];
  for (const r of results) {
    if (r.error) {
      failures.push(`${r.profile} ${r.theme} ${r.path}: ${r.error}`);
      continue;
    }
    if (r.lcpMs >= WEB_BUDGETS.lcpMs)
      failures.push(`${r.profile} ${r.theme} ${r.path}: LCP ${int(r.lcpMs)} ms >= ${WEB_BUDGETS.lcpMs} ms`);
    if (r.cls >= WEB_BUDGETS.cls)
      failures.push(`${r.profile} ${r.theme} ${r.path}: CLS ${r.cls.toFixed(4)} >= ${WEB_BUDGETS.cls}`);
    if (r.path === '/' && r.jsBytes >= WEB_BUDGETS.landingJsBytes)
      failures.push(`${r.profile} ${r.theme} /: JS ${int(r.jsBytes)} B >= ${int(WEB_BUDGETS.landingJsBytes)} B`);
  }

  const rows = [
    [
      'profile',
      'theme',
      'page',
      'LCP ms',
      'LCP min-max',
      'CLS',
      'TBT ms',
      'FCP ms',
      'TTFB ms',
      'JS',
      'CSS',
      'font',
      'img',
      'reqs',
      'HTML wire/raw',
    ],
  ];
  for (const r of results) {
    if (r.error) continue;
    rows.push([
      r.profile,
      r.theme,
      r.path,
      int(r.lcpMs),
      `${int(r.lcpMin)}-${int(r.lcpMax)}`,
      r.cls.toFixed(4),
      int(r.tbtMs),
      int(r.fcpMs),
      int(r.ttfbMs),
      kb(r.jsBytes),
      kb(r.cssBytes),
      kb(r.fontBytes),
      kb(r.imageBytes),
      int(r.requests),
      `${kb(r.htmlWireBytes)}/${kb(r.htmlBytes)}`,
    ]);
  }
  console.log(`\n${table(rows)}\n`);
  console.log(
    `Conditions: ${JSON.stringify(conditions.profiles)}; ${conditions.runsPerConfig} runs, median; ${conditions.chromium}`,
  );
  console.log(
    `Budgets: LCP < ${WEB_BUDGETS.lcpMs} ms, CLS < ${WEB_BUDGETS.cls}, landing JS < ${int(WEB_BUDGETS.landingJsBytes)} B compressed (TBT ${TBT_GOOD_MS} ms is Lighthouse's "good", not a spec budget).`,
  );
  const file = await writeArtifact(
    options.out,
    JSON.stringify({ conditions, budgets: WEB_BUDGETS, results, failures }, null, 2),
  );
  console.log(`Wrote ${file}`);
  if (failures.length) {
    for (const f of failures) console.log(`  ${f}`);
    console.log(`FAIL ${failures.length} budget miss(es)`);
    return 1;
  }
  console.log('PASS every budget holds on every configuration');
  return 0;
}

cli(main);
