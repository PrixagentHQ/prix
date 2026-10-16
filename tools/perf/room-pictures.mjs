// Pictures in the room (Phase 6.4, docs/contracts/phase-6-pictures.md): what they cost of the free plan,
// and how long the check and an upload take in workerd.
//
//   node tools/perf/room-pictures.mjs [--figures-only] [--fresh 8] [--runs 9] [--uploads 9]
//        [--league-requests 24000] [--view-overshoot 1000] [--document <file>]
//
// Part 1 prints the figures of the contract's sections 6 and 13 from the contract's constants and its own
// functions, and looks each up in the document (`--document`, by default docs/contracts/phase-6-pictures.md).
// Nothing is typed again here; a figure the document holds and no constant does is named as that, or it
// is measured in part 3.
//
// Part 2 times `roomPictureCheck` in local workerd on the largest file of each slow shape of the operator's
// check script (packages/contracts/src/room-picture.shapes.mts, `SHAPES`; none is built here): the FIRST
// call in a fresh isolate (a new workerd process for every sample) beside the best of `--runs` more calls
// in that isolate. Gate 3 of the contract judges the first call.
//
// Part 3 sends real uploads, and then views, through the API's own entry in local workerd, on a local D1
// and a local KV, and reads what each asked for: D1 calls, statements and rows, KV calls, and time.
//
// Every time here is THIS MACHINE'S, in local workerd: the same V8 and the same code as a deployed
// Worker, on other hardware. workerd gives a Worker no CPU clock, so the CPU of a request is its wall
// time less the time it waited on D1, KV and the Cache API (room-pictures-worker/worker.mjs says how).
// Gate 3's own figure for an upload is the CPU time in production's logs, which nothing here replaces.
//
// Nothing leaves the machine and nothing touches a Cloudflare account: no namespace is made, no Worker
// is deployed. The Workers started here are stopped before the script ends.
//
// Exit code (the contract's section 14, perf's row, since revision 5): 1 only when a figure this script
// prints from the constants differs from the document, which includes a daily limit that the constants no
// longer keep where the document says they do; 0 otherwise. Everything measured on this machine is printed
// and judged, and what is over a threshold is a WARNING that leaves the exit code at 0: a laptop's CPU
// estimate is not Cloudflare's figure, and gate 3's own figure is production's logs at the drill. 2 on a
// usage error, a crash or a void measurement (a file that is not what the check script times, a request
// answered otherwise than expected).

import { readdir, readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { ROOM_MESSAGES_PER_DAY_DEFAULT, ROOM_MESSAGES_PER_DAY_MAX } from '../../packages/contracts/src/phase6-room.ts';
import {
  ROOM_PICTURE_DELETES_PER_CALL,
  ROOM_PICTURE_FETCH_HEADERS,
  ROOM_PICTURE_POST_WRITE_ROWS,
  ROOM_PICTURE_PRUNE_ROWS,
  ROOM_PICTURE_RATE_PER_MINUTE,
  ROOM_PICTURE_REPORT_WRITE_ROWS,
  ROOM_PICTURE_REPORTS_PER_DAY,
  ROOM_PICTURE_STORAGE_DAYS,
  ROOM_PICTURE_STORAGE_LIMIT_BYTES,
  ROOM_PICTURE_SWEEP_PER_RUN,
  ROOM_PICTURE_VIEW_SAMPLE,
  ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT,
  ROOM_PICTURE_VIEWS_PER_DAY_MAX,
  ROOM_PICTURES_PER_DAY_DEFAULT,
  ROOM_PICTURES_PER_DAY_MAX,
  ROOM_PICTURES_PER_HOUR,
  ROOM_ROWS_PER_DAY,
  ROOM_ROWS_PER_MESSAGE,
  roomDailyCapBesidePictures,
  roomPictureRowsWorst,
  roomPictureStorageWorstBytes,
} from '../../packages/contracts/src/phase6-room-pictures.ts';
import { SHAPES } from '../../packages/contracts/src/room-picture.shapes.mts';
import {
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURE_UPLOAD_CONTENT_TYPE,
  ROOM_PICTURES_PATH,
  ROOM_PICTURES_PER_WALLET_PER_DAY,
  roomPictureCheck,
  roomPicturePath,
} from '../../packages/contracts/src/room-picture.ts';
import { cli, int, PERF_DIR, parseArgs, REPO_ROOT, table, writeArtifact } from './lib.mjs';
import { FREE_PLAN } from './limits.mjs';
import { splitSql } from './local-d1.mjs';
import { differencesFromDocument, exitCodeOf } from './room-pictures-document.mjs';

const USAGE =
  'Usage: node tools/perf/room-pictures.mjs [--figures-only] [--fresh 8] [--runs 9] [--uploads 9]\n' +
  '       [--league-requests 24000] [--view-overshoot 1000] [--document <file>]';

/** The document the figures are compared with, and the options at which it prints its day of requests. */
const DOCUMENT = resolve(REPO_ROOT, 'docs', 'contracts', 'phase-6-pictures.md');
const DOCUMENT_ASSUMES = Object.freeze({ leagueRequests: 24_000, viewOvershoot: 1_000 });

/**
 * Cloudflare's free-plan limits of KV, as the contract's section 13 quotes them from
 * developers.cloudflare.com/kv/platform/limits/ and /pricing/ (read by the operator's drafter on 2026-10-11).
 * limits.mjs holds the Worker's and D1's; KV is used by nothing but pictures, so its limits are here.
 */
const KV_FREE = Object.freeze({ readsPerDay: 100_000, writesPerDay: 1_000, deletesPerDay: 1_000, listsPerDay: 1_000 });

/**
 * Gate 3 of the contract's section 16, which no constant holds: the two thresholds, and the size its last
 * rule (revision 6) names if an upload's CPU time in production's logs at the drill is above the second.
 * Part 1 looks all three up in the document, so a change there stops this script with exit 1.
 */
const GATE3 = Object.freeze({ walkFirstMs: 3, uploadMs: 8, fallbackBytes: 131_072 });

const ORIGIN = 'https://prix.test';
const ms = (value) => `${value.toFixed(2)} ms`;
const pct = (part, whole) => `${((part / whole) * 100).toFixed(1)}%`;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const verdict = (ok) => (ok ? 'PASS' : 'FAIL');

// --- part 1: the figures of sections 6 and 13 ------------------------------------------------------------

function figures(options) {
  const failures = [];
  // A limit the document says is kept: when the constants no longer keep it, that is a difference from it.
  const check = (ok, what) => {
    if (!ok) failures.push(`${what}: over the limit by the constants, where the document says it is kept`);
    return verdict(ok);
  };
  /** Each figure below as the document words it: `{ section, what, says }` (room-pictures-document.mjs). */
  const claims = [];
  const claim = (section, what, says) => claims.push({ section, what, says });
  const whole = (part, of) => `${Math.round((part / of) * 100)}%`;
  const caps = [
    {
      name: 'defaults',
      pictures: ROOM_PICTURES_PER_DAY_DEFAULT,
      views: ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT,
    },
    {
      name: 'the ceiling of pictures',
      pictures: ROOM_PICTURES_PER_DAY_MAX,
      views: ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT,
    },
    {
      name: 'both ceilings',
      pictures: ROOM_PICTURES_PER_DAY_MAX,
      views: ROOM_PICTURE_VIEWS_PER_DAY_MAX,
    },
  ];

  console.log('PART 1. The plan, from the constants of packages/contracts (sections 6 and 13 of the contract).');
  console.log('');
  console.log(
    `Caps: ${ROOM_PICTURES_PER_WALLET_PER_DAY} pictures a wallet a day, ${ROOM_PICTURES_PER_HOUR} an hour for the room, ` +
      `${ROOM_PICTURES_PER_DAY_DEFAULT} a day by default and ${ROOM_PICTURES_PER_DAY_MAX} at most; ` +
      `${int(ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT)} views a day by default and ${int(ROOM_PICTURE_VIEWS_PER_DAY_MAX)} at most; ` +
      `a file of at most ${int(ROOM_PICTURE_MAX_BYTES)} bytes, kept ${ROOM_PICTURE_TTL_SECONDS / 86_400} days.`,
  );
  console.log('');

  // Section 6: storage.
  console.log('KV storage (section 6): the days whose pictures can be in KV, times the cap, times the largest file.');
  const storageRows = [
    ['Pictures a day', 'Largest file', 'Bytes held at most', `Of ${int(ROOM_PICTURE_STORAGE_LIMIT_BYTES)}`, ''],
  ];
  const storage = [];
  for (const cap of [ROOM_PICTURES_PER_DAY_DEFAULT, ROOM_PICTURES_PER_DAY_MAX]) {
    const bytes = roomPictureStorageWorstBytes(cap);
    storage.push({ pictures: cap, fileBytes: ROOM_PICTURE_MAX_BYTES, bytes });
    storageRows.push([
      cap,
      int(ROOM_PICTURE_MAX_BYTES),
      int(bytes),
      pct(bytes, ROOM_PICTURE_STORAGE_LIMIT_BYTES),
      check(bytes < ROOM_PICTURE_STORAGE_LIMIT_BYTES, `KV storage at ${cap} pictures a day`),
    ]);
  }
  // Derived here from the same constants, for the size gate 3's last rule names: not a figure of the contract.
  for (const cap of [ROOM_PICTURES_PER_DAY_DEFAULT, ROOM_PICTURES_PER_DAY_MAX]) {
    const bytes = ROOM_PICTURE_STORAGE_DAYS * cap * GATE3.fallbackBytes;
    storage.push({ pictures: cap, fileBytes: GATE3.fallbackBytes, bytes });
    storageRows.push([
      cap,
      `${int(GATE3.fallbackBytes)} (gate 3's last rule)`,
      int(bytes),
      pct(bytes, ROOM_PICTURE_STORAGE_LIMIT_BYTES),
      verdict(bytes < ROOM_PICTURE_STORAGE_LIMIT_BYTES),
    ]);
  }
  console.log(table(storageRows));
  const perDay = ROOM_PICTURES_PER_DAY_MAX * ROOM_PICTURE_MAX_BYTES;
  const storageMost = roomPictureStorageWorstBytes(ROOM_PICTURES_PER_DAY_MAX);
  const storageDefault = roomPictureStorageWorstBytes(ROOM_PICTURES_PER_DAY_DEFAULT);
  claim(6, 'the days counted', `(\`ROOM_PICTURE_STORAGE_DAYS\` = ${ROOM_PICTURE_STORAGE_DAYS})`);
  claim(
    6,
    'KV storage at the ceiling',
    `${ROOM_PICTURE_STORAGE_DAYS} × ${ROOM_PICTURES_PER_DAY_MAX} × ${int(ROOM_PICTURE_MAX_BYTES)} = ${int(storageMost)} bytes, ${whole(storageMost, ROOM_PICTURE_STORAGE_LIMIT_BYTES)} of the plan`,
  );
  claim(
    6,
    'KV storage at the default',
    `At the default cap of ${ROOM_PICTURES_PER_DAY_DEFAULT} it is ${int(storageDefault)} bytes`,
  );
  claim(
    6,
    'the days of the ceiling that fit',
    `${Math.floor(ROOM_PICTURE_STORAGE_LIMIT_BYTES / perDay)} such days fit under`,
  );
  claim(
    13,
    'KV storage, the budget’s row',
    `${int(storageMost)} bytes at the ceiling; ${int(storageDefault)} at the default`,
  );
  console.log(
    `${ROOM_PICTURE_STORAGE_DAYS} days are counted (a span of ${ROOM_PICTURE_TTL_SECONDS / 86_400} days touches ` +
      `${ROOM_PICTURE_TTL_SECONDS / 86_400 + 1} UTC days, and one for a late expiry). At the ceiling a day is ${int(perDay)} bytes: ` +
      `${Math.floor(ROOM_PICTURE_STORAGE_LIMIT_BYTES / perDay)} such days fit under the limit.`,
  );
  console.log('');

  // Section 13: KV operations.
  console.log('KV operations of a day (section 13). KV is used by nothing else on the site.');
  const perWriter = (ROOM_PICTURE_TTL_SECONDS / 86_400 + 1) * ROOM_PICTURES_PER_WALLET_PER_DAY;
  const kvRows = [['Operation', 'At the defaults', 'At the ceilings', 'Limit', '']];
  kvRows.push([
    'Writes: one put for each picture counted',
    ROOM_PICTURES_PER_DAY_DEFAULT,
    ROOM_PICTURES_PER_DAY_MAX,
    int(KV_FREE.writesPerDay),
    check(ROOM_PICTURES_PER_DAY_MAX <= KV_FREE.writesPerDay, 'KV writes at the ceiling'),
  ]);
  kvRows.push([
    'Reads: one for each shown picture (admins’ looks come on top)',
    int(ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT),
    int(ROOM_PICTURE_VIEWS_PER_DAY_MAX),
    int(KV_FREE.readsPerDay),
    check(ROOM_PICTURE_VIEWS_PER_DAY_MAX <= KV_FREE.readsPerDay, 'KV reads at the ceiling'),
  ]);
  // Derived here: every picture that can still hold bytes, removed in one UTC day.
  const removableDefault = (ROOM_PICTURE_TTL_SECONDS / 86_400 + 1) * ROOM_PICTURES_PER_DAY_DEFAULT;
  const removableMax = (ROOM_PICTURE_TTL_SECONDS / 86_400 + 1) * ROOM_PICTURES_PER_DAY_MAX;
  kvRows.push([
    'Deletes, if every picture that still has bytes were removed in one day (derived here)',
    int(removableDefault),
    int(removableMax),
    int(KV_FREE.deletesPerDay),
    removableMax <= KV_FREE.deletesPerDay ? 'PASS' : 'OVER at the ceiling',
  ]);
  kvRows.push(['Lists: the port has no list', 0, 0, int(KV_FREE.listsPerDay), 'PASS']);
  console.log(table(kvRows));
  claim(
    13,
    'KV writes',
    `| KV writes, of ${int(KV_FREE.writesPerDay)} | ${ROOM_PICTURES_PER_DAY_MAX} at the cap's ceiling; ${ROOM_PICTURES_PER_DAY_DEFAULT} at the default |`,
  );
  claim(
    13,
    'KV reads',
    `| KV reads, of ${int(KV_FREE.readsPerDay)} | ${int(ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT)} at the default cap of views, ${int(ROOM_PICTURE_VIEWS_PER_DAY_MAX)} at its ceiling`,
  );
  claim(13, 'KV deletes of one mute', `a mute at most ${ROOM_PICTURE_DELETES_PER_CALL} deletes`);
  console.log(
    `One admin call deletes at most ${ROOM_PICTURE_DELETES_PER_CALL} keys (${ROOM_PICTURES_PER_WALLET_PER_DAY} a day on ` +
      `${ROOM_PICTURE_TTL_SECONDS / 86_400 + 1} UTC days: ${perWriter}); a run of the sweep tries at most ${ROOM_PICTURE_SWEEP_PER_RUN}.`,
  );
  if (removableMax > KV_FREE.deletesPerDay) {
    console.log(
      `NOTE: ${int(removableMax)} removals in one day at the ceiling are more than KV's ${int(KV_FREE.deletesPerDay)} deletes. ` +
        'The contract says what then happens (section 13: the rest fail and are swept the next day; D1 refuses them meanwhile). ' +
        'It is not counted as a failure here.',
    );
  }
  console.log('');

  // Section 13: D1 rows written.
  console.log('D1 rows written in a day beside the room’s messages (section 13), from `roomPictureRowsWorst`.');
  const rowRows = [
    [
      'Caps',
      'Pictures',
      'Views’ samples',
      'Reports, views under way',
      'Pictures’ rows',
      'Messages’ cap',
      'Messages’ rows',
      'Sum',
      `Of ${int(ROOM_ROWS_PER_DAY)}`,
      '',
    ],
  ];
  const rows = [];
  for (const cap of caps) {
    const worst = roomPictureRowsWorst(cap.pictures, cap.views);
    // The split is the function's own, read by asking it with a cap of nothing: no term is typed here.
    const forPictures = worst - roomPictureRowsWorst(0, cap.views);
    const forViews = roomPictureRowsWorst(0, cap.views) - roomPictureRowsWorst(0, 0);
    const forReports = roomPictureRowsWorst(0, 0);
    const messages = roomDailyCapBesidePictures(ROOM_MESSAGES_PER_DAY_DEFAULT, cap.pictures, cap.views);
    const sum = worst + messages * ROOM_ROWS_PER_MESSAGE;
    rows.push({ ...cap, worst, forPictures, forViews, forReports, messagesCap: messages, sum });
    rowRows.push([
      `${cap.name} (${cap.pictures}, ${int(cap.views)})`,
      int(forPictures),
      int(forViews),
      int(forReports),
      int(worst),
      messages,
      int(messages * ROOM_ROWS_PER_MESSAGE),
      int(sum),
      pct(sum, ROOM_ROWS_PER_DAY),
      check(sum <= ROOM_ROWS_PER_DAY, `D1 rows written at ${cap.name}`),
    ]);
  }
  console.log(table(rowRows));
  const [atDefaults, atPictures, atBoth] = rows;
  const pictureRows = ROOM_PICTURE_POST_WRITE_ROWS + ROOM_PICTURE_PRUNE_ROWS;
  claim(
    13,
    'D1 rows written at the defaults',
    `${int(atDefaults.worst)} at the defaults (${atDefaults.pictures} pictures, ${int(atDefaults.views)} views): ${int(atDefaults.forPictures)} for pictures`,
  );
  // The function's fixed term holds the reports' rows and the 50 of views under way together, and no
  // constant divides them: the document's "850 for views" and "700 for reports" are looked up by their parts.
  claim(13, 'the rows of the views’ samples', `(${int(atDefaults.forViews)} samples and`);
  claim(
    13,
    'the rows of the counted reports',
    `for reports (${ROOM_PICTURE_REPORTS_PER_DAY} at ${ROOM_PICTURE_REPORT_WRITE_ROWS},`,
  );
  claim(
    13,
    'D1 rows written at the ceilings',
    `${int(atPictures.worst)} at ${atPictures.pictures} pictures; ${int(atBoth.worst)} at ${atBoth.pictures} pictures and ${int(atBoth.views)} views`,
  );
  claim(
    13,
    'the rows a stored upload is booked at',
    `is booked at ${ROOM_PICTURE_POST_WRITE_ROWS} (\`ROOM_PICTURE_POST_WRITE_ROWS\`)`,
  );
  claim(
    13,
    'the rows of a picture with its prune',
    `the ${ROOM_PICTURE_PRUNE_ROWS} the prune deletes of it (\`ROOM_PICTURE_PRUNE_ROWS\`) a picture is ${pictureRows} rows, ${pictureRows - ROOM_ROWS_PER_MESSAGE} more than the ${ROOM_ROWS_PER_MESSAGE} of a message`,
  );
  claim(
    13,
    'the room’s cap of messages beside pictures',
    `of ${ROOM_MESSAGES_PER_DAY_DEFAULT} messages, ${atDefaults.messagesCap} at the defaults, ${atPictures.messagesCap} at ${atPictures.pictures} pictures, ${atBoth.messagesCap} at ${atBoth.pictures} pictures and ${int(atBoth.views)} views`,
  );
  claim(
    13,
    'the day’s rows at the defaults',
    `${int(atDefaults.sum)} of the ${int(ROOM_ROWS_PER_DAY)} at the defaults`,
  );
  claim(13, 'the room’s rows of a day', `The room has about ${int(ROOM_ROWS_PER_DAY)} rows a day`);
  console.log(
    `A picture is booked at ${ROOM_PICTURE_POST_WRITE_ROWS} rows by the route and a counted report at ${ROOM_PICTURE_REPORT_WRITE_ROWS}; ` +
      `a message costs ${ROOM_ROWS_PER_MESSAGE}; a view is counted once in ${ROOM_PICTURE_VIEW_SAMPLE}; ` +
      `${ROOM_PICTURE_REPORTS_PER_DAY} reports a day are counted. The room's cap of messages is ${ROOM_MESSAGES_PER_DAY_DEFAULT} by default ` +
      `(${ROOM_MESSAGES_PER_DAY_MAX} at most) and is lowered beside pictures by \`roomDailyCapBesidePictures\`.`,
  );
  const worstOfAll = Math.max(...rows.map((each) => each.sum));
  console.log(
    `Of the plan's ${int(FREE_PLAN.d1RowsWrittenPerDay)} rows written a day the room with pictures takes at most ${int(worstOfAll)} ` +
      `(${pct(worstOfAll, FREE_PLAN.d1RowsWrittenPerDay)}).`,
  );
  console.log('');

  // Section 13: requests.
  console.log('Worker requests of a day (section 13): league + 2 x R page views of the room + V shown pictures.');
  console.log(
    `ASSUMED, not from a constant: the league's ${int(options.leagueRequests)} requests a day (--league-requests; the plan design's figure, ` +
      `not read from the dashboard: gate 4) and ${int(options.viewOvershoot)} views from pages loaded before the cap was reached (--view-overshoot; the document's allowance).`,
  );
  const limit = FREE_PLAN.workerRequestsPerDay;
  const without = Math.floor((limit - options.leagueRequests) / 2);
  const requestRows = [
    ['Views’ cap', 'Shown at most', 'Of the day', 'Error 1027 at R =', 'Without pictures', 'Cap reached at'],
  ];
  const requests = [];
  for (const views of [ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT, ROOM_PICTURE_VIEWS_PER_DAY_MAX]) {
    const shown = views + options.viewOvershoot;
    const at = Math.floor((limit - options.leagueRequests - shown) / 2);
    // The cap is reached after cap / sample counted draws, each one in `sample` views: a negative binomial.
    const hits = views / ROOM_PICTURE_VIEW_SAMPLE;
    const deviation = Math.sqrt(hits * (1 - 1 / ROOM_PICTURE_VIEW_SAMPLE)) * ROOM_PICTURE_VIEW_SAMPLE;
    requests.push({
      views,
      shown,
      share: shown / limit,
      error1027AtRoomViews: at,
      withoutPictures: without,
      deviation,
    });
    requestRows.push([
      int(views),
      int(shown),
      pct(shown, limit),
      int(at),
      int(without),
      `${int(views)} views, give or take ${int(deviation)}`,
    ]);
  }
  console.log(table(requestRows));
  // The document prints its day of requests at two assumptions that no constant holds; at any other the
  // figures above are this run's own and are not looked up.
  if (
    options.leagueRequests === DOCUMENT_ASSUMES.leagueRequests &&
    options.viewOvershoot === DOCUMENT_ASSUMES.viewOvershoot
  ) {
    const [byDefault, byCeiling] = requests;
    claim(
      13,
      'the day’s requests at the default cap of views',
      `Error 1027 for everyone at R = ${int(byDefault.error1027AtRoomViews)} with pictures at their cap, against ${int(byDefault.withoutPictures)} without: pictures take at most ${whole(byDefault.shown, limit)} of the day`,
    );
    claim(
      13,
      'the day’s requests at the ceiling of views',
      `at its ceiling of ${int(byCeiling.views)} pictures take at most ${whole(byCeiling.shown, limit)} of the day, and Error 1027 comes at R = ${int(byCeiling.error1027AtRoomViews)}`,
    );
    claim(
      13,
      'the spread of the sampled cap of views',
      `give or take about ${int(Math.round(byDefault.deviation / 100) * 100)} (one standard deviation)`,
    );
  } else {
    console.log(
      `NOTE: the document prints these at ${int(DOCUMENT_ASSUMES.leagueRequests)} league requests and ${int(DOCUMENT_ASSUMES.viewOvershoot)} late views; at this run's options they are not compared with it.`,
    );
  }
  const uploads = ROOM_PICTURES_PER_DAY_MAX + ROOM_PICTURE_REPORTS_PER_DAY;
  console.log(
    `On top: one request for each upload and each report. Stored uploads and counted reports are at most ${ROOM_PICTURES_PER_DAY_MAX} + ${ROOM_PICTURE_REPORTS_PER_DAY} = ${uploads} ` +
      `(${pct(uploads, limit)} of the day); a refused upload or report is a request too, and only the limiter and the zone's rule bound those.`,
  );
  const network = ROOM_PICTURE_RATE_PER_MINUTE * 1_440;
  console.log(
    `One network at the \`picture\` rule (${ROOM_PICTURE_RATE_PER_MINUTE} a minute) is at most ${int(network)} requests a day, ${pct(network, limit)} of the day.`,
  );
  claim(13, 'one network at the picture rule', `One network at the \`picture\` rule is ${int(network)} requests a day`);
  claim(
    16,
    'gate 3’s thresholds',
    `${GATE3.walkFirstMs} ms for the first call of the walk and ${GATE3.uploadMs} ms for an upload`,
  );
  claim(
    16,
    'gate 3’s last rule',
    `above ${GATE3.uploadMs} ms, the largest file becomes ${int(GATE3.fallbackBytes)} bytes`,
  );
  claim(16, 'the largest file', `\`ROOM_PICTURE_MAX_BYTES\` is ${int(ROOM_PICTURE_MAX_BYTES)} since revision 5`);
  console.log('');
  return { failures, claims, storage, rows, requests, removableMax };
}

// --- the Worker in local workerd -------------------------------------------------------------------------

async function startWorker() {
  const { unstable_startWorker: start } = await import('wrangler');
  const worker = await start({
    config: resolve(PERF_DIR, 'room-pictures-worker', 'wrangler.jsonc'),
    dev: { persist: false, server: { port: 0 }, inspector: false, logLevel: 'error', watch: false, remote: false },
  });
  await worker.ready;
  const url = String(await worker.url).replace(/\/$/, '');
  async function post(path, body, type = 'application/octet-stream') {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const answer = await response.json();
    if (response.status !== 200)
      throw new Error(`The perf Worker failed at ${path}: ${answer.message ?? response.status}`);
    return answer;
  }
  return { post, stop: () => worker.dispose() };
}

/** Every statement of infra/migrations, in name order, as `wrangler d1 migrations apply` runs them. */
async function migrationStatements() {
  const dir = resolve(REPO_ROOT, 'infra', 'migrations');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const statements = [];
  for (const file of files) statements.push(...splitSql(await readFile(resolve(dir, file), 'utf8')));
  return { files, statements };
}

/** The seven files at `total` bytes, each checked against the rule in Node before anything is timed. */
function filesOf(total) {
  return SHAPES.map((shape) => {
    const file = shape.make(total);
    const answer = roomPictureCheck(file);
    const right =
      file.length === total &&
      answer.ok &&
      answer.type === shape.facts.type &&
      answer.width === shape.facts.width &&
      answer.height === shape.facts.height &&
      answer.frames === shape.facts.frames;
    if (!right) {
      throw new Error(
        `The fixture ${shape.key} at ${total} bytes is not what the check script times: ${file.length} bytes, ` +
          `${answer.ok ? JSON.stringify({ ...answer, bytes: answer.bytes.length }) : `refused as ${answer.problem}`}. The measurement is void.`,
      );
    }
    return { ...shape, file };
  });
}

// --- part 2: the walk ------------------------------------------------------------------------------------

async function measureWalk(total, options) {
  const files = filesOf(total);
  const results = files.map((each) => ({ key: each.key, what: each.what, firstMs: [], bestMs: [] }));
  for (let sample = 0; sample < options.fresh; sample += 1) {
    // One workerd process for each shape, started together and asked one at a time: starting is the slow
    // part, and a process that waits uses no CPU.
    const workers = await Promise.all(files.map(() => startWorker()));
    try {
      for (let index = 0; index < files.length; index += 1) {
        const answer = await workers[index].post(`/__perf/walk?runs=${options.runs}`, files[index].file);
        if (!answer.ok || answer.sent !== total) {
          throw new Error(`workerd refused ${files[index].key} as ${answer.problem}. The measurement is void.`);
        }
        results[index].firstMs.push(answer.firstMs);
        results[index].bestMs.push(answer.bestMs);
      }
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
  }
  return results.map((each) => ({
    ...each,
    firstMeanMs: mean(each.firstMs),
    firstMaxMs: Math.max(...each.firstMs),
    firstMinMs: Math.min(...each.firstMs),
    bestOfAllMs: Math.min(...each.bestMs),
  }));
}

function printWalk(total, results, options) {
  console.log(
    `\`roomPictureCheck\` on a file of ${int(total)} bytes, in local workerd. First call: one in each of ${options.fresh} fresh isolates for each shape ` +
      `(their mean, and the fastest and slowest; workerd's clock moves in steps of 1 ms, so one sample is good to 1 ms and the mean is the figure). ` +
      `Best: the fastest of ${options.runs} runs of ten more calls in an isolate, a call of it.`,
  );
  const rows = [['Shape', 'First call, mean', 'fastest', 'slowest', 'Best', `Gate 3 (${GATE3.walkFirstMs} ms)`]];
  for (const each of results) {
    rows.push([
      each.what,
      ms(each.firstMeanMs),
      ms(each.firstMinMs),
      ms(each.firstMaxMs),
      ms(each.bestOfAllMs),
      each.firstMeanMs > GATE3.walkFirstMs
        ? 'above'
        : each.firstMaxMs > GATE3.walkFirstMs
          ? 'mean under, a sample above'
          : 'under',
    ]);
  }
  console.log(table(rows));
  console.log('');
}

// --- part 3: an upload and a view through the entry ------------------------------------------------------

/** The two shapes whose walk is slowest, for the steps timed alone. */
const STEP_SHAPES = ['jpeg-stuffed', 'gif-1'];

/** The requests the site sends all day, sent before the first upload so that only the pictures' own code is new to the isolate. */
const WARM_UP_ROUNDS = 5;
const ROOM_READ = '/api/social/room';

/**
 * `count` uploads and then as many views in one fresh isolate for each shape. With `warmUp` the isolate has
 * first answered the room's read and a writer's `me` a few times, as an isolate of the live site has; with
 * none the first upload is the first request the entry ever answered.
 */
async function measureUploads(total, count, migrations, warmUp) {
  const files = filesOf(total);
  const results = [];
  for (const each of files) {
    const worker = await startWorker();
    try {
      await worker.post('/__perf/sql', JSON.stringify({ statements: migrations.statements }), 'application/json');
      const { cookies } = await worker.post('/__perf/seed', JSON.stringify({ wallets: count }), 'application/json');
      if (warmUp) {
        for (let round = 0; round < WARM_UP_ROUNDS; round += 1) {
          for (const spec of [
            { method: 'GET', path: ROOM_READ, headers: {} },
            { method: 'GET', path: `${ROOM_READ}/me`, headers: { Cookie: cookies[0] } },
          ]) {
            const answer = await worker.post(
              `/__perf/call?spec=${encodeURIComponent(JSON.stringify(spec))}`,
              new Uint8Array(0),
            );
            if (answer.status !== 200)
              throw new Error(
                `The warm-up read of ${spec.path} was answered ${answer.status}. The measurement is void.`,
              );
          }
        }
      }
      const uploads = [];
      for (const cookie of cookies) {
        const spec = {
          method: 'POST',
          path: ROOM_PICTURES_PATH,
          headers: {
            Origin: ORIGIN,
            Cookie: cookie,
            'Content-Type': ROOM_PICTURE_UPLOAD_CONTENT_TYPE,
            'Sec-Fetch-Site': 'same-origin',
          },
        };
        const answer = await worker.post(`/__perf/call?spec=${encodeURIComponent(JSON.stringify(spec))}`, each.file);
        if (answer.status !== 201) {
          throw new Error(
            `The upload of ${each.key} was answered ${answer.status} ${JSON.stringify(answer.json)}. The measurement is void.`,
          );
        }
        uploads.push(answer);
      }
      const id = uploads.at(-1).json.message.id;
      const views = [];
      for (let view = 0; view < count; view += 1) {
        const spec = { method: 'GET', path: roomPicturePath(id), headers: { ...ROOM_PICTURE_FETCH_HEADERS } };
        const answer = await worker.post(
          `/__perf/call?spec=${encodeURIComponent(JSON.stringify(spec))}`,
          new Uint8Array(0),
        );
        if (answer.status !== 200 || answer.bytes !== total) {
          throw new Error(
            `The view of ${each.key} was answered ${answer.status} with ${answer.bytes} bytes. The measurement is void.`,
          );
        }
        views.push(answer);
      }
      results.push({ key: each.key, what: each.what, uploads, views });
    } finally {
      await worker.stop();
    }
  }
  return results;
}

/** The first call, and the mean and the best of the rest, for one figure of a list of answers. */
function firstAndBest(answers, field) {
  const rest = answers.slice(1).map((answer) => answer[field]);
  const first = answers[0][field];
  return rest.length === 0 ? { first, mean: first, best: first } : { first, mean: mean(rest), best: Math.min(...rest) };
}

function printUploads(total, results, count) {
  console.log(
    `An upload of ${int(total)} bytes through the API's entry in local workerd: ${count} uploads in one fresh isolate for each shape, each by another wallet, ` +
      'after the isolate answered ten ordinary reads. CPU is wall time less the waits on D1, KV and the Cache API, an estimate good to about 2 ms for one request; wall is its upper bound.',
  );
  const rows = [
    [
      'Shape',
      'First upload: CPU',
      'wall',
      'The rest: mean CPU',
      'best CPU',
      'mean wall',
      `Gate 3 (${GATE3.uploadMs} ms)`,
      `Plan (${FREE_PLAN.cpuMsPerHttpRequest} ms)`,
    ],
  ];
  for (const each of results) {
    const cpu = firstAndBest(each.uploads, 'cpuMs');
    const wall = firstAndBest(each.uploads, 'wallMs');
    rows.push([
      each.what,
      ms(cpu.first),
      ms(wall.first),
      ms(cpu.mean),
      ms(cpu.best),
      ms(wall.mean),
      cpu.first > GATE3.uploadMs ? (cpu.mean > GATE3.uploadMs ? 'first and mean above' : 'first above') : 'under',
      cpu.best >= FREE_PLAN.cpuMsPerHttpRequest
        ? 'best OVER'
        : cpu.first >= FREE_PLAN.cpuMsPerHttpRequest
          ? 'first over'
          : 'under',
    ]);
  }
  console.log(table(rows));
  console.log('');
}

function printCounts(results) {
  // What a stored upload and a view ask of the bindings is the same for every shape; the first is shown
  // and a shape that differs is named.
  const shape = (answer) =>
    [
      answer.d1Calls,
      answer.d1Statements,
      answer.rowsRead,
      answer.rowsWritten,
      answer.kvPuts,
      answer.kvGets,
      answer.kvDeletes,
      answer.cacheCalls,
    ].join('/');
  const upload = results[0].uploads.at(-1);
  const firstUpload = results[0].uploads[0];
  const view = results[0].views.at(-1);
  const rows = [
    [
      'One request',
      'D1 calls',
      'statements',
      'rows read',
      'rows written',
      'KV puts',
      'KV gets',
      'KV deletes',
      'Cache API',
      'D1 + KV calls',
      `Of ${FREE_PLAN.subrequestsPerInvocation}`,
    ],
  ];
  const line = (name, answer) => {
    const calls = answer.d1Calls + answer.kvPuts + answer.kvGets + answer.kvDeletes;
    rows.push([
      name,
      answer.d1Calls,
      answer.d1Statements,
      answer.rowsRead,
      answer.rowsWritten,
      answer.kvPuts,
      answer.kvGets,
      answer.kvDeletes,
      answer.cacheCalls,
      calls,
      verdict(calls <= FREE_PLAN.subrequestsPerInvocation),
    ]);
    return calls;
  };
  const most = Math.max(
    line('A stored upload, the isolate’s first', firstUpload),
    line('A stored upload, a later one', upload),
    line('A shown picture', view),
  );
  console.log(
    'What one request asks of D1 and KV, counted in workerd from D1’s own `meta` (the limiter’s calls are stand-ins and not counted).',
  );
  console.log(table(rows));
  const odd = results.filter(
    (each) => shape(each.uploads.at(-1)) !== shape(upload) || shape(each.views.at(-1)) !== shape(view),
  );
  if (odd.length > 0)
    console.log(`NOTE: the counts differ for ${odd.map((each) => each.key).join(', ')}; the JSON holds each.`);
  console.log('');
  return { upload, firstUpload, view, mostCalls: most };
}

// --- main ------------------------------------------------------------------------------------------------

async function main() {
  const { options } = parseArgs(process.argv.slice(2), {
    figuresOnly: false,
    fresh: 8,
    runs: 9,
    uploads: 9,
    leagueRequests: DOCUMENT_ASSUMES.leagueRequests,
    viewOvershoot: DOCUMENT_ASSUMES.viewOvershoot,
    document: DOCUMENT,
  });
  options.fresh = Math.max(1, Math.floor(options.fresh));
  options.runs = Math.max(1, Math.floor(options.runs));
  // More than the hour's cap of pictures cannot be stored in one hour of one database.
  options.uploads = Math.max(2, Math.min(Math.floor(options.uploads), ROOM_PICTURES_PER_HOUR));

  const startedAt = new Date().toISOString();
  console.log(`Pictures in the room: the plan's figures and the time of the check. ${startedAt} (UTC).`);
  console.log('');
  const plan = figures(options);
  // The one thing that decides the exit code: what the constants print against what the document says.
  const differences = [
    ...plan.failures,
    ...differencesFromDocument(await readFile(options.document, 'utf8'), plan.claims),
  ];
  console.log(
    `Looked up in ${options.document}: ${plan.claims.length} figures as sections 6, 13 and 16 word them. ` +
      (differences.length === 0 ? 'Each is there.' : `${differences.length} differ:`),
  );
  for (const difference of differences) console.log(`  DIFFERS: ${difference}.`);
  console.log('');
  /** What this machine measured over a threshold: printed, kept in the JSON, and never the exit code. */
  const warnings = [];
  const warn = (text) => {
    warnings.push(text);
    console.log(`WARNING: ${text}`);
  };
  const result = { measuredAt: startedAt, options, plan, differences, gate3: null };

  if (!options.figuresOnly) {
    console.log('PART 2. The walk in workerd. THIS MACHINE’S TIMES, not Cloudflare’s.');
    console.log(
      `Conditions: local workerd started by Wrangler, compatibility date as the API's; Node ${process.version} only starts it; ` +
        `${cpus()[0]?.model.trim() ?? 'unknown CPU'}, ${process.platform} ${process.arch}.`,
    );
    // A clock that stood still while code ran would make every figure below nothing.
    const probe = await startWorker();
    let moved;
    try {
      moved = (await probe.post('/__perf/clock', new Uint8Array(0))).movedMs;
    } finally {
      await probe.stop();
    }
    if (!(moved > 0))
      throw new Error('The clock of this workerd does not move while code runs. Nothing can be timed here.');
    console.log(`The clock moves while code runs: ${ms(moved)} over a loop of thirty million additions.`);
    console.log('');

    const walkMost = await measureWalk(ROOM_PICTURE_MAX_BYTES, options);
    printWalk(ROOM_PICTURE_MAX_BYTES, walkMost, options);
    const walkFallback = await measureWalk(GATE3.fallbackBytes, options);
    printWalk(GATE3.fallbackBytes, walkFallback, options);

    console.log('PART 3. An upload and a view through the route, in workerd. THIS MACHINE’S TIMES, not Cloudflare’s.');
    console.log('');
    const migrations = await migrationStatements();
    const uploadMost = await measureUploads(ROOM_PICTURE_MAX_BYTES, options.uploads, migrations, true);
    printUploads(ROOM_PICTURE_MAX_BYTES, uploadMost, options.uploads);
    const uploadFallback = await measureUploads(GATE3.fallbackBytes, options.uploads, migrations, true);
    printUploads(GATE3.fallbackBytes, uploadFallback, options.uploads);

    // The worst case an isolate can meet: the upload is the first request its entry ever answers.
    const uploadCold = await measureUploads(ROOM_PICTURE_MAX_BYTES, 2, migrations, false);
    console.log(
      `An upload of ${int(ROOM_PICTURE_MAX_BYTES)} bytes as the FIRST request a fresh isolate's entry answers (it builds the entry's wiring and runs every line for the first time; one sample for each shape).`,
    );
    const coldRows = [['Shape', 'CPU', 'wall', `Plan (${FREE_PLAN.cpuMsPerHttpRequest} ms)`]];
    for (const each of uploadCold) {
      const first = each.uploads[0];
      coldRows.push([
        each.what,
        ms(first.cpuMs),
        ms(first.wallMs),
        first.cpuMs >= FREE_PLAN.cpuMsPerHttpRequest ? 'over' : 'under',
      ]);
    }
    console.log(table(coldRows));
    console.log('');

    // The steps whose work grows with the file, each alone: what the size gate 3 names can change.
    const stepRows = [
      [
        'File',
        'Bytes',
        'Check, later calls',
        'SHA-256: first',
        'later',
        'Body read: first',
        'later',
        'The three, later',
      ],
    ];
    const stepResults = [];
    for (const total of [ROOM_PICTURE_MAX_BYTES, GATE3.fallbackBytes]) {
      for (const each of filesOf(total).filter((shape) => STEP_SHAPES.includes(shape.key))) {
        const worker = await startWorker();
        try {
          const answer = await worker.post('/__perf/steps', each.file);
          if (!answer.ok) throw new Error(`workerd refused ${each.key} as ${answer.problem}. The measurement is void.`);
          stepResults.push({
            key: each.key,
            bytes: total,
            walk: answer.walk,
            sha256: answer.sha256,
            bodyRead: answer.bodyRead,
          });
          stepRows.push([
            each.key,
            int(total),
            ms(answer.walk.meanMs),
            ms(answer.sha256.firstMs),
            ms(answer.sha256.meanMs),
            ms(answer.bodyRead.firstMs),
            ms(answer.bodyRead.meanMs),
            ms(answer.walk.meanMs + answer.sha256.meanMs + answer.bodyRead.meanMs),
          ]);
        } finally {
          await worker.stop();
        }
      }
    }
    console.log(
      'The steps of an upload that grow with the file, each alone in a fresh isolate, with no D1 and no KV: wall time is CPU here. Later calls are the mean of ten.',
    );
    console.log(table(stepRows));
    console.log('');
    result.steps = stepResults;

    const viewRows = [['Shape', 'First view: CPU', 'wall', 'The rest: mean CPU', 'best CPU', 'mean wall']];
    for (const each of uploadMost) {
      const cpu = firstAndBest(each.views, 'cpuMs');
      const wall = firstAndBest(each.views, 'wallMs');
      viewRows.push([each.what, ms(cpu.first), ms(wall.first), ms(cpu.mean), ms(cpu.best), ms(wall.mean)]);
    }
    console.log(
      `A shown picture of ${int(ROOM_PICTURE_MAX_BYTES)} bytes through the bytes route, in the isolate that stored it.`,
    );
    console.log(table(viewRows));
    console.log('');

    const counts = printCounts(uploadMost);
    if (counts.mostCalls > FREE_PLAN.subrequestsPerInvocation) {
      warn(
        `one request made ${counts.mostCalls} D1 and KV calls in local workerd, more than the plan's ${FREE_PLAN.subrequestsPerInvocation} an invocation. A finding for api-core and platform.`,
      );
    }
    console.log(
      `At the caps that is, by these counts: ${int(counts.view.rowsRead * ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT)} D1 rows read a day for ${int(ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT)} views ` +
        `(${int(counts.view.rowsRead * ROOM_PICTURE_VIEWS_PER_DAY_MAX)} for ${int(ROOM_PICTURE_VIEWS_PER_DAY_MAX)}), of ${int(FREE_PLAN.d1RowsReadPerDay)}; ` +
        `${int(counts.view.kvGets * ROOM_PICTURE_VIEWS_PER_DAY_MAX)} KV reads for ${int(ROOM_PICTURE_VIEWS_PER_DAY_MAX)} views, of ${int(KV_FREE.readsPerDay)}; ` +
        `${int(counts.upload.kvPuts * ROOM_PICTURES_PER_DAY_MAX)} KV writes for ${ROOM_PICTURES_PER_DAY_MAX} uploads, of ${int(KV_FREE.writesPerDay)}.`,
    );
    const mostWritten = Math.max(counts.upload.rowsWritten, counts.firstUpload.rowsWritten);
    console.log(
      `An upload wrote ${counts.upload.rowsWritten} rows by D1's own \`rows_written\`, and the isolate's first ${counts.firstUpload.rowsWritten}; the route books ${ROOM_PICTURE_POST_WRITE_ROWS} ` +
        `(ROOM_PICTURE_POST_WRITE_ROWS). ${mostWritten > ROOM_PICTURE_POST_WRITE_ROWS ? 'MORE than it books.' : 'Inside what it books.'}`,
    );
    if (mostWritten > ROOM_PICTURE_POST_WRITE_ROWS) {
      warn(
        `a stored upload wrote ${mostWritten} D1 rows in local workerd where ROOM_PICTURE_POST_WRITE_ROWS books ${ROOM_PICTURE_POST_WRITE_ROWS}. A finding for the operator and platform.`,
      );
    }
    console.log('');

    // Gate 3.
    const slowestWalk = walkMost.reduce((a, b) => (b.firstMeanMs > a.firstMeanMs ? b : a));
    const slowestWalkSample = Math.max(...walkMost.map((each) => each.firstMaxMs));
    const above = walkMost.filter((each) => each.firstMeanMs > GATE3.walkFirstMs).map((each) => each.key);
    const uploadFigures = uploadMost.map((each) => ({ key: each.key, ...firstAndBest(each.uploads, 'cpuMs') }));
    const slowestUpload = uploadFigures.reduce((a, b) => (b.first > a.first ? b : a));
    const slowestMean = uploadFigures.reduce((a, b) => (b.mean > a.mean ? b : a));
    const slowestBest = uploadFigures.reduce((a, b) => (b.best > a.best ? b : a));
    const slowestCold = uploadCold.reduce((a, b) => (b.uploads[0].cpuMs > a.uploads[0].cpuMs ? b : a));
    const walkFires = slowestWalk.firstMeanMs > GATE3.walkFirstMs;
    const uploadFires = slowestUpload.first > GATE3.uploadMs;
    const fallbackWalk = walkFallback.reduce((a, b) => (b.firstMeanMs > a.firstMeanMs ? b : a));
    const fallbackFigures = uploadFallback.map((each) => ({ key: each.key, ...firstAndBest(each.uploads, 'cpuMs') }));
    const fallbackUpload = fallbackFigures.reduce((a, b) => (b.first > a.first ? b : a));
    const fallbackMean = fallbackFigures.reduce((a, b) => (b.mean > a.mean ? b : a));
    console.log(
      `GATE 3 (section 16), at the largest file of ${int(ROOM_PICTURE_MAX_BYTES)} bytes: ${GATE3.walkFirstMs} ms for the first call of the walk, ${GATE3.uploadMs} ms for an upload. ` +
        'THIS MACHINE’S ESTIMATE: the gate’s own figure is the CPU time of a real upload in production’s logs at the drill.',
    );
    console.log(
      `  The walk: the slowest shape's first call is ${ms(slowestWalk.firstMeanMs)} (${slowestWalk.key}, the mean of ${options.fresh} fresh isolates; ` +
        `the slowest single sample of any shape is ${ms(slowestWalkSample)}). ${walkFires ? `ABOVE ${GATE3.walkFirstMs} ms, for ${above.join(', ')}` : `Not above ${GATE3.walkFirstMs} ms`}.`,
    );
    console.log(
      `  An upload: the first upload of an isolate that has served reads is at most ${ms(slowestUpload.first)} of CPU (${slowestUpload.key}); the later ones are at most ${ms(slowestMean.mean)} at their mean (${slowestMean.key}) ` +
        `and ${ms(slowestBest.best)} at their best (${slowestBest.key}); as an isolate's very first request it is ${ms(slowestCold.uploads[0].cpuMs)} (${slowestCold.key}). ` +
        `${uploadFires ? 'ABOVE' : 'Not above'} ${GATE3.uploadMs} ms on this machine by the first upload.`,
    );
    const fires = walkFires || uploadFires;
    console.log(
      `  The size the gate's last rule names, ${int(GATE3.fallbackBytes)} bytes: the slowest first call of the walk is ${ms(fallbackWalk.firstMeanMs)} (${fallbackWalk.key}), ` +
        `${fallbackWalk.firstMeanMs > GATE3.walkFirstMs ? 'STILL ABOVE' : 'not above'} ${GATE3.walkFirstMs} ms; the slowest first upload is ${ms(fallbackUpload.first)} (${fallbackUpload.key}), ` +
        `${fallbackUpload.first > GATE3.uploadMs ? 'STILL ABOVE' : 'not above'} ${GATE3.uploadMs} ms, and the later ones ${ms(fallbackMean.mean)} at their mean (${fallbackMean.key}).`,
    );
    console.log('');
    if (walkFires) {
      warn(
        `the first call of the walk at ${int(ROOM_PICTURE_MAX_BYTES)} bytes is ${ms(slowestWalk.firstMeanMs)} here for ${slowestWalk.key}, above gate 3's ${GATE3.walkFirstMs} ms (${above.join(', ')}). An estimate from this machine.`,
      );
    }
    if (uploadFires) {
      warn(
        `an isolate's first upload at ${int(ROOM_PICTURE_MAX_BYTES)} bytes is ${ms(slowestUpload.first)} of CPU here for ${slowestUpload.key}, above gate 3's ${GATE3.uploadMs} ms. An estimate from this machine; ` +
          `if production's logs at the drill say the same, the largest file becomes ${int(GATE3.fallbackBytes)} bytes (the gate's last rule).`,
      );
    }
    if (slowestBest.best >= FREE_PLAN.cpuMsPerHttpRequest) {
      warn(
        `the CPU of a warm upload, ${ms(slowestBest.best)} at its best for ${slowestBest.key}, is not under the plan's ${FREE_PLAN.cpuMsPerHttpRequest} ms. An estimate from this machine.`,
      );
    }
    if (
      slowestUpload.first >= FREE_PLAN.cpuMsPerHttpRequest ||
      slowestCold.uploads[0].cpuMs >= FREE_PLAN.cpuMsPerHttpRequest
    ) {
      warn(
        `an isolate's first upload takes ${ms(slowestUpload.first)} of CPU here after ordinary reads and ${ms(slowestCold.uploads[0].cpuMs)} as its very first request, ` +
          `against the plan's ${FREE_PLAN.cpuMsPerHttpRequest} ms. Uploads are rare (at most ${ROOM_PICTURES_PER_DAY_MAX} a day), so most uploads are the first their isolate sees. ` +
          'Past step 5 an exceeded limit leaves a count with no message (section 13). An estimate from this machine.',
      );
    }
    console.log('');
    result.gate3 = {
      fires,
      walkFires,
      uploadFires,
      walkFirstMs: slowestWalk.firstMeanMs,
      walkShapesAbove: above,
      walkFirstSlowestSampleMs: slowestWalkSample,
      uploadFirstCpuMs: slowestUpload.first,
      uploadLaterMeanCpuMs: slowestMean.mean,
      uploadLaterBestCpuMs: slowestBest.best,
      uploadAsFirstRequestCpuMs: slowestCold.uploads[0].cpuMs,
      atFallback: {
        walkFirstMs: fallbackWalk.firstMeanMs,
        uploadFirstCpuMs: fallbackUpload.first,
        uploadLaterMeanCpuMs: fallbackMean.mean,
      },
    };
    result.clockMovedMs = moved;
    result.walk = { [ROOM_PICTURE_MAX_BYTES]: walkMost, [GATE3.fallbackBytes]: walkFallback };
    const slim = (list) =>
      list.map((each) => ({
        key: each.key,
        uploads: each.uploads.map(({ json, ...rest }) => rest),
        views: each.views.map(({ json, ...rest }) => rest),
      }));
    result.uploads = {
      [ROOM_PICTURE_MAX_BYTES]: slim(uploadMost),
      [GATE3.fallbackBytes]: slim(uploadFallback),
      asFirstRequest: slim(uploadCold),
    };
    result.conditions = {
      node: process.version,
      cpu: cpus()[0]?.model.trim(),
      platform: process.platform,
      arch: process.arch,
    };
  }

  result.warnings = warnings;
  // A run of the figures alone never overwrites the last measurement.
  const file = await writeArtifact(
    options.figuresOnly ? 'room-pictures-figures.json' : 'room-pictures.json',
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(
    differences.length === 0
      ? 'PASS: every figure printed from the constants is the document’s, and every daily limit holds at the contract’s caps.'
      : `FAIL: ${differences.length} of the figures printed from the constants differ from the document: ${differences.join('; ')}.`,
  );
  if (!options.figuresOnly) {
    console.log(
      warnings.length === 0
        ? 'No warning: nothing measured on this machine is over a threshold.'
        : `${warnings.length} WARNING${warnings.length === 1 ? '' : 'S'} above from this machine’s measurements. They do not change the exit code (the contract’s section 14).`,
    );
  }
  console.log(`Written to ${file}.`);
  return exitCodeOf({ differences, warnings });
}

await cli(main, USAGE);
