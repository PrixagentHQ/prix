# Performance checks

Four scripts turn the performance promises of Phase 1 into a pass or a fail. Two measure the website against `docs/SPEC.md` section 7.5. Two check that a trading day and the Workers stay inside Cloudflare's free plan, against the limits in `docs/CONTRACTS.md` section 2.

Every script prints the number, the conditions it was measured under and a line that starts with `PASS` or `FAIL`. Each writes its result as JSON to `.artifacts/perf/`, which is gitignored.

Exit codes are the same everywhere: `0` is a pass, `1` is a failed budget or something that could not be measured, `2` is a usage error or a crash.

A failed budget is a finding for the owner of the code. The budgets live in `limits.mjs` and are copied from the spec and the contract. Do not change a number here to get a pass: change the document first.

Run everything from the repository root, after `pnpm install --frozen-lockfile`. Chromium for Lighthouse: `pnpm exec playwright install chromium` if it is missing.

| Script | Checks | Measured or modelled |
|---|---|---|
| `budgets.mjs` | Lighthouse scores, LCP and CLS on eight pages; the JavaScript, CSS and font bytes each page loads | Measured on this machine, phone profile simulated |
| `bundle.mjs` | The API Worker bundle against the free plan; compressed JavaScript of the landing page | Measured from the builds |
| `capacity.mjs` | D1 rows, neurons, requests, round length and per-step limits of a trading day | D1 statements and rows measured on a local D1; models, chain and traffic are stand-ins or assumptions; CPU is an estimate |
| `siwe-cpu.mjs` | CPU time of one sign-in verification | Measured on this machine; an estimate for a Worker |

## Against a local build (before the gate)

```
PRIX_FIXTURES=1 pnpm --filter @prix/web exec astro build
pnpm --filter @prix/web exec astro preview --port 8900 --host 127.0.0.1
node tools/perf/budgets.mjs http://127.0.0.1:8900 --agent slowcompound --fixtures
node tools/perf/bundle.mjs
node tools/perf/capacity.mjs --quick
```

The fixture build answers every API call from `apps/web/src/lib/fixtures`, so the pages render without the API. `--fixtures` adds the fixture query that gives the builder and the account page a signed-in visitor. `bundle.mjs` rebuilds `apps/web` without fixtures, so run it after `budgets.mjs`, or build again. Stop the preview server when you are done.

## Against prixagent.com (once it is live)

No build, no fixtures, nothing to start:

```
node tools/perf/budgets.mjs https://prixagent.com --runs 3
node tools/perf/bundle.mjs
node tools/perf/capacity.mjs
node tools/perf/siwe-cpu.mjs
```

- `budgets.mjs` takes the agent page from `GET /api/league`, or from `--agent <id>`. Leave `--fixtures` out. The builder and the account page redirect a signed-out visitor to sign-in, so on the live site they report that they landed on `/sign-in`; measuring them signed in needs a browser session and is not done here.
- `bundle.mjs` and `capacity.mjs` measure the repository, not the live site, so they give the same answer before and after the deploy. After the deploy, compare their numbers with what Cloudflare reports: the Worker size in the dashboard, and the CPU time, D1 rows read and written and neurons used in the Workers and D1 metrics of the account. The first sign-in after a deploy is the check for `siwe-cpu.mjs`.
- Lighthouse measures from this machine over the real network path. A result from one location is a sample, not a guarantee.

## budgets.mjs

```
node tools/perf/budgets.mjs <base-url> [--agent <id-or-path>] [--runs 3] [--fixtures]
     [--pages landing,league,agent,token,methodology,sign-in,build,account]
```

It runs Lighthouse on its phone profile on the landing page, the league, an agent page, the token page, the methodology, sign-in, the builder and the account page. A page passes when all of these hold:

- Performance, accessibility, best practices and SEO each score 95 or more.
- The largest contentful paint is under 1.8 s.
- The cumulative layout shift is under 0.02.
- The page answers 200 with HTML and Lighthouse can measure it.
- Landing page only: under 60,000 bytes of compressed JavaScript.

SPEC section 7.5 names the landing page, the league and an agent page. The builder, the account page and sign-in are measured against the same numbers so that a miss is visible; the builder and the account page are `noindex` on purpose, so their SEO score is a known miss that is not a defect.

For every page it also prints the compressed JavaScript, CSS and font bytes the page loads. Each file is fetched without compression and then compressed here with gzip level 9 and brotli level 11, so a server that does not compress, such as `astro preview`, does not hide the size. Inline scripts of the HTML are counted. It prints how much of the JavaScript is in a file that carries zod (K5; a file with a zod marker counts whole, so the share is an upper bound), and Lighthouse's FCP, speed index and total blocking time.

Conditions. The phone profile is Lighthouse's mobile default, its stand-in for a mid-range phone: a 412x823 screen at 1.75x, the CPU slowed four times and a slow 4G connection (150 ms round trip, 1.6 Mbit/s), both simulated. Each run starts a fresh copy of the Chromium that Playwright installed, in new headless mode. With several runs the verdict uses the median of each number. The simulated CPU slowdown depends on the host, so the script prints Lighthouse's benchmark index; compare results only between similar machines. Full reports are in `.artifacts/perf/lighthouse/`.

## bundle.mjs

```
node tools/perf/bundle.mjs [--skip-worker] [--skip-site] [--no-build] [--path /] [--url http://host] [--html file] [--dist dir]
```

Two checks. First, the API Worker: `wrangler deploy --dry-run --outdir` in `apps/api` bundles what a deploy would upload and uploads nothing; the script gzips the output and compares it with the free plan's limit of 3 MB after gzip. Wrangler's own "Total Upload" line is printed beside it.

Second, the landing page: it builds `apps/web`, reads the HTML of the landing page, finds every script it loads (script tags, module preloads, islands, inline scripts and their static imports), gzips each file and compares the total with 60,000 bytes. Code behind a dynamic `import()` is listed apart as "on demand" and is not counted; when the two together reach the budget the script prints a `CHECK` line. `--url` reads the HTML from a server that is already running, `--no-build` reuses the existing build. `PRIX_PERF_PORT=8901` pins the port of the preview server the script starts.

## capacity.mjs

```
node tools/perf/capacity.mjs [--open 200] [--pro 50] [--strategy short|long] [--page-views 10000]
     [--sign-ins N] [--prompt-changes N] [--agent-page-share 0.3] [--cache-hit-rate 0]
     [--cpu-runs 40] [--quick] [--skip-scenarios]
```

It runs the product's own code: the D1 store of `apps/api/src/store` on a local D1 database (workerd, the same SQLite and row counters as Cloudflare), the scheduler of `packages/runtime`, the engine, the scoring and the public routes. It fills a league to the caps of `docs/CONTRACTS.md` section 15 and replays one UTC trading day one Cron Trigger at a time, reading what D1 reports for every statement.

It answers, in plain lines and one table:

- How many Open agents a day the 9,000-neuron budget carries with short strategies and with 2,000-character strategies, and what the 200-agent cap uses of it. The house model's price (26,668 and 204,805 neurons per million input and output tokens) and its measured tokens (970 in and 60 out for a short decision, 1,470 in and 70 out for a long one, 320 in and 20 out for a summary) are in `limits.mjs`; the stand-in model reports them, with the exact neurons, as Workers AI does in `usage.neurons`.
- Whether the daily round of 200 Open agents ends inside its hour at five model calls a minute, and how many minutes it has to spare.
- D1 rows read and written in a day at the caps against 5,000,000 and 100,000, and Worker requests against 100,000.
- The D1 statements, outbound calls, model calls at once and estimated CPU of every kind of scheduler step against the per-invocation limits.
- The line "Closest daily limit".

It exits 0 only when every daily limit holds, every round reaches every agent inside its hour, and no step goes over a per-invocation limit. `--quick` runs the steps that do work and counts the idle minutes at the cost of the idle step before them; leave it out for the full 1,440-step day.

Measured: D1 statements and rows, the neurons the scheduler counted, steps and minutes per round. Assumed: traffic (the options), strategy length. Estimated: CPU, from this machine. Stand-ins: the chain and the models. Until the store counts decisions and summaries apart (K1), the counted neurons are compared with the sum of both budgets (9,500).

## siwe-cpu.mjs

```
node tools/perf/siwe-cpu.mjs [--runs 200] [--cold-runs 5]
```

It times one Sign-In with Ethereum verification with viem, the version `apps/api` depends on: parse the message, check its fields, recover the signer. It reports the average of 200 runs and compares it with the 10 ms CPU limit of a free-plan request.

A pass means the average is under 10 ms. The script also times the first verification in a fresh process. That number is much larger, because the curve code builds its tables on first use, and the script prints a `RISK` line when it is over the limit. A pass here does not clear that risk.

The result is an estimate from the machine it runs on. A Worker runs the same JavaScript on different hardware. Before the gate, measure the first sign-in after a deploy on the staging Worker, from the CPU time that Cloudflare records for the request.

## live.mjs

```
node tools/perf/live.mjs [base-url] [--runs 5] [--pages /,/league] [--themes dark,light] [--profiles phone,desktop]
```

Cold-load speed of the live site with Playwright and the Chrome DevTools protocol, GET only (any other method is aborted in the browser). Per page, theme and profile it reports the median of the runs: LCP (and its min and max), CLS, total blocking time from long tasks after first paint, FCP, document response time, JavaScript, CSS, font and image bytes on the wire, the number of requests, and the HTML size on the wire and raw. The phone profile is 390 px, slow 4G (1.6 Mbit/s, 150 ms RTT) and a 4x CPU slowdown; the desktop profile is 1280 px unthrottled. Light sends the cookie prix_theme=light. It checks the budgets in limits.mjs (LCP, CLS, landing JavaScript) and exits 1 on a miss. The result goes to .artifacts/perf/live.json; a dated copy of the 2026-10-08 run is in results/. The CPU slowdown is relative to the machine that runs it, which is not a phone, and other work on that machine moves LCP by a second or more: read the min-max column. `--block font`, `--block-url <text>` and `--cpu N` are experiments that show where the time goes; they are not budget results.

## room-pictures.mjs

```
node tools/perf/room-pictures.mjs [--figures-only] [--fresh 8] [--runs 9] [--uploads 9]
     [--league-requests 24000] [--view-overshoot 1000] [--document <file>]
node --test tools/perf/room-pictures-document.test.mjs
```

Pictures in the Community chat (Phase 6.4, docs/contracts/phase-6-pictures.md), in three parts. About six minutes on a machine that does other work; `--figures-only` prints part 1 alone in a second.

1. The figures of the contract's sections 6 and 13, from the constants and functions of `packages/contracts` and typed nowhere: KV storage, KV writes, reads and deletes, D1 rows written beside the room's messages with the room's lowered cap, and the day's requests at the default cap of views and at its ceiling. Two inputs are options because no constant holds them: the league's requests of a day and the views from pages loaded before the cap. Each figure is then looked up in the document as sections 6, 13 and 16 word it (24 phrases; `room-pictures-document.mjs`), and only in its own section, because the document's history quotes older figures. `--document` names another file to compare with.
2. `roomPictureCheck` in local workerd, on the seven slow shapes of the operator's check script at the largest file (`ROOM_PICTURE_MAX_BYTES`, 262,144 bytes since revision 5) and at the 131,072 that gate 3's last rule names: the first call in a fresh isolate (a new workerd process for every sample) beside the best of later calls. The files are the contract's own (`packages/contracts/src/room-picture.shapes.mts`, `SHAPES`; none is built here), and the script stops when the check does not answer one with the expected facts.
3. Real uploads, and then views, through the API's own entry (`apps/api/src/index.ts`) in local workerd, on a local D1 with every migration and a local KV: the D1 calls, statements and rows and the KV calls of one request, and its time. `room-pictures-worker/` is that Worker; it is never deployed and makes no namespace.

Real: the entry, the app, the guard, the route, the stores, D1's own row counts, KV, WebCrypto. Stand-ins: the four limiter bindings, which always allow, and the request, which is built inside the isolate. Estimated: every time. workerd gives a Worker no CPU clock and its `performance.now()` moves in steps of 1 ms, so the CPU of a request is its wall time less its waits on D1, KV and the Cache API, good to about 2 ms for one request. Gate 3's own figure for an upload is the CPU time in production's logs.

Exit code, since the contract's revision 5 (section 14, perf's row): 1 only when a figure printed from the constants differs from the document, which includes a daily limit that the constants no longer keep where the document says they do. Everything measured on this machine that is over a threshold (the walk's first call against gate 3's 3 ms, an upload's CPU estimate against gate 3's 8 ms and the plan's 10 ms, a request's D1 and KV calls against 50, the rows an upload wrote against what the route books) is printed as a `WARNING` and leaves the exit code at 0: a laptop's estimate is not Cloudflare's figure. 2 on a usage error, a crash or a void measurement. The result goes to `.artifacts/perf/room-pictures.json` (`room-pictures-figures.json` for `--figures-only`), with `differences` and `warnings`. The test file holds the rule: it runs the script against the document and against a copy with one figure changed.

### Round 2, at the new largest size: two runs of 2026-10-12

11:04 and 11:10 UTC, the same machine and Node (the second is `results/room-pictures-2026-10-12.json`), on the second round's owners' branches merged (the upload's route with its deadline for the body, the store with `markGone` bound). Both exited 0 with every one of the 24 figures found in the document, and printed 4 and 3 warnings. **The machine was doing other work in both**: other agents' builds and suites (about 65% of the CPU in use, 21 Node processes and 6 workerd of others when read at 11:10 UTC), and the script's own clock probe, a loop of thirty million additions, took 86 ms and 74 ms where it took 59 ms on 2026-10-11. So read these as upper figures of a loaded laptop, about a quarter to a half slower on warm code than the runs below, and more on a first call.

| What | 262,144 bytes (the largest file) | 131,072 bytes (gate 3's last rule) | Against |
|---|---|---|---|
| The check, first call in a fresh isolate, the three JPEG scans (mean of 8) | 4.5 to 6.1 ms | 4.0 to 6.1 ms | 3 ms (gate 3) |
| The same, the GIF of one-byte sub-blocks | 4.0 to 6.0 ms | 3.4 to 4.6 ms | 3 ms |
| The same, both PNGs and the GIF of 255-byte sub-blocks | 1.5 to 5.25 ms | 1.9 to 3.4 ms | 3 ms |
| The check, best of later calls, slowest shape | 0.9 to 1.0 ms | 0.5 ms | |
| An upload, the first of an isolate that has served reads, CPU estimate | 13 to 42 ms | 9 to 40 ms | 8 ms (gate 3), 10 ms (plan) |
| An upload, later ones, mean CPU estimate | 6.75 to 20 ms (6.75 to 13.75 in the second run) | 4.5 to 13.5 ms (4.5 to 10.75) | 8 ms, 10 ms |
| An upload, later ones, best CPU estimate | 4 to 14 ms (4 to 9) | 3 to 11 ms (3 to 7) | 8 ms, 10 ms |
| An upload as the first request an isolate answers (one sample a shape) | 35 to 80 ms | not measured | 10 ms |
| A shown picture, later ones, mean CPU estimate | 1.1 to 4.4 ms | not measured | 10 ms |
| SHA-256 alone, later calls | 1.5 to 2.5 ms | 0.7 to 1.0 ms | |
| The body read from a stream alone, later calls | 2.6 to 6.4 ms | 1.4 to 3.6 ms | |

A stored upload made 13 D1 calls (15 statements) and one KV put, 14 of the 50 calls an invocation has, read 14 rows (an isolate's first) to 18 and wrote 11 by D1's `rows_written`, which is what `ROOM_PICTURE_POST_WRITE_ROWS` books since revision 5. A shown picture made one D1 call that read 4 or 5 rows, and one KV read. An upload that is the first request an isolate answers made 14 D1 calls (16 statements). These counts do not move with the machine's load.

**What a reader of `/chat` loads of the walker** (the contract's section 15: the split of `room-picture.ts` is not in the second round, so there is a "before" and no "after" yet). A production build of `apps/web` on the same branches, 2026-10-12 11:17 UTC (`astro build`, then every script of `apps/web/dist/client` read from disk): the contracts chunk is 13,591 bytes raw, 5,828 after gzip and 5,268 after Brotli, 80 bytes more than the 13,511 the contract names for the first round, and it holds the walker (the strings `NETSCAPE2.0`, `JFIF` and `IHDR` are in it). The list's own script (`PictureScript.astro`) is 1,713 bytes raw and 854 after gzip, and imports that chunk; so do the composer's script (8,787 raw, 3,500 gzip) and four other scripts of the site. So a signed-out reader's list script pulls 5,828 compressed bytes of contracts to use 854 of its own. Not measured: the whole of what `/chat` loads on a production build, because the preview of a production build answers 503 for `/chat` with no API beside it. On a sample build (`PRIX_FIXTURES=1`, `node tools/perf/bundle.mjs --skip-worker --path /chat`) the page loads 50.1 KB of compressed JavaScript, of which 40.2 KB is the contracts chunk; that chunk is 132,947 bytes raw there only because a sample build puts the fixtures, and the schemas they are checked with, into the browser's scripts. It is not what production serves.

What the two runs say, and what they cannot:

- **The first call of the walk is not shorter at 131,072 bytes than at 262,144** (4.0 to 6.1 ms against 4.5 to 6.1 ms for the JPEG scans): it pays for code that has never run, and that cost does not shrink with the file. Its best later call does halve (0.5 ms against 0.9 to 1.0 ms). So gate 3's last rule, if production's logs call for it, would lower a later upload of an isolate by about a third here and an isolate's first upload hardly at all.
- **Above gate 3's thresholds at both sizes on this machine, as on 2026-10-11**, and further above than then. The walker's code is the same as then (revision 5 and 6 changed no rule of `roomPictureCheck`), and its first call at 262,144 bytes measured 2.6 to 3.25 ms then against 4.5 to 6.1 ms now: that difference is this machine's load. Whether the upload's route itself costs more CPU since the second round (it now reads the body chunk by chunk against one timer) cannot be told from load on this machine: its later uploads were 5.5 to 8.6 ms then and 6.75 to 13.75 ms in the quieter of today's runs.
- A laptop does not close gate 3, and the contract does not ask it to: the gate's own figure is the CPU time of a real upload in production's logs at the drill, with the cap at 5.

### Round 1: two runs of 2026-10-11

The script's exit rule was another then (it exited 1 on the laptop's CPU estimate), and the largest file was 524,288 bytes.

Two runs of 2026-10-11, 13:05 and 13:09 UTC, Node 24.17.0 starting workerd, AMD Ryzen 7 7735HS, Windows x64 (the second is `results/room-pictures-2026-10-11.json`):

| What | 524,288 bytes | 262,144 bytes | Against |
|---|---|---|---|
| The check, first call in a fresh isolate, the three JPEG scans (mean of 8) | 3.5 to 4.25 ms | 2.6 to 3.25 ms | 3 ms (gate 3) |
| The same, the GIF of one-byte sub-blocks | 3.0 to 3.1 ms | 2.25 ms | 3 ms |
| The same, both PNGs and the GIF of 255-byte sub-blocks | 1.4 to 2.5 ms | 1.1 to 2.4 ms | 3 ms |
| The check, best of later calls, slowest shape | 1.4 ms | 0.7 ms | |
| An upload, the first of an isolate that has served reads, CPU estimate | 13 to 23 ms | 9 to 16 ms | 8 ms (gate 3), 10 ms (plan) |
| An upload, later ones, mean CPU estimate | 9 to 16 ms | 5.5 to 8.6 ms | 8 ms, 10 ms |
| An upload as the first request an isolate answers (one sample a shape) | 32 to 57 ms | not measured | 10 ms |
| A shown picture, later ones, mean CPU estimate | 0.9 to 1.9 ms | not measured | 10 ms |
| SHA-256 alone, later calls | 3.1 to 3.2 ms | 1.3 to 1.4 ms | |
| The body read from a stream alone, later calls | 6.0 to 6.1 ms | 2.8 to 4.3 ms | |

A stored upload made 13 D1 calls (15 statements) and one KV put, 14 of the 50 calls an invocation has, read 14 to 18 rows and wrote 11 by D1's `rows_written`, one more than `ROOM_PICTURE_POST_WRITE_ROWS`. A shown picture made one D1 call that read 4 or 5 rows, and one KV read.

Gate 3 fires on this machine at 524,288 bytes: the first call of the check is above 3 ms for all three JPEG scans in both runs. At 262,144 bytes the same three are at the threshold (2.6 to 3.25 ms, above it for two of them in the second run), because a first call pays for code that has never run and that cost does not shrink with the file. The upload's estimate is above 8 ms at both sizes for an isolate's first upload, and uploads are rare enough (150 a day at most) that most are the first their isolate sees. The script exited 1 in both runs: a warm upload of 524,288 bytes was 10 to 12 ms at its best for the slowest shape.

## stage2-tick.mjs

```
node tools/perf/stage2-tick.mjs [--runs 200] [--skip-slow] [--port-base 8990]
```

The tick-creating step at 25 symbols with both chains read (docs/CONTRACTS.md section 23), against the limits of one free-plan invocation: outbound requests, D1 statements, both together, connections at once and CPU. It also reports the wall time of the step.

Real: the scheduler step of `packages/runtime`, the product's `createMarket` with its real 8 s time limit and 750 ms retry pause, the store of `apps/api` on a local D1, and real HTTP requests. The market is configured as the Worker is with a keyed `RPC_URL` (4 Robinhood endpoints, 3 Arbitrum endpoints) and is given the real URLs, so its own rules decide who confirms whom; its `fetch` sends each URL to a local server on ports 8990 to 8996 that stands for it. The local D1 is on 8997. Nothing leaves the machine. Stand-ins: the two chains, answered with the market's own result encoder. CPU is the step replayed in Node with every HTTP and D1 answer from memory: an estimate, not a Worker measurement.

Ten scenarios, among them Arbitrum hanging while Robinhood answers, the most requests that still make a tick, and every endpoint failing or hanging. `--skip-slow` leaves out the three that wait for real time limits (about two minutes together). Exit 0 only when every limit holds. The result goes to `.artifacts/perf/stage2-tick.json`.

Run of 2026-10-09 08:06 UTC, Node 24.17.0, Windows x64, `--runs 200` (copy in `results/stage2-tick-2026-10-09.json`):

| What | Measured | Limit | |
|---|---|---|---|
| Outbound requests, typical step | 2 (1 Robinhood + 1 Arbitrum) | 50 | pass |
| Outbound requests, most in one step | 11 (8 Robinhood + 3 Arbitrum), also when every endpoint fails or hangs | 50 | pass |
| Arbitrum requests in one snapshot | 3 at most | 3 | pass |
| D1 statements, typical / most | 11 / 37 (7 new holds, 18 used releases) | 50 | pass |
| Requests and D1 statements together, most | 48 (11 + 37) | 50 | pass, 2 to spare |
| Requests open at once | 2 | 6 | pass |
| Wall time, Arbitrum hanging, Robinhood answering | 24.23 s; the tick is created, the 3 coins unread | none | |
| Wall time, every endpoint hanging | 67.23 s; `market_closed` | none; the alarm is every 60 s | risk |
| CPU, typical step | 5.54 ms mean, 3.69 ms median | 10 ms | estimate |
| CPU, heaviest step | 12.81 ms mean, 10.79 ms median, 27.47 ms at the 99th percentile | 10 ms | FAIL, estimate |

The CPU miss is a finding for `packages/market`. Per call on this machine: `encodeSnapshotCall` 0.70 ms for every Robinhood request, `decodeSnapshotResult` 1.14 ms for every Robinhood answer, `encodeArbitrumCall` 0.34 ms, `decodeArbitrumResult` 0.23 ms. The heaviest step makes 8 Robinhood and 3 Arbitrum requests, so 8.94 of its 12.81 ms is this encoding and decoding. The calldata of a chain is the same for every request; encoding it once instead of once per request would save about 5.6 ms there. The alarm also calls `start()` on the four other Clock objects, which these counts leave out.

Measured again on 2026-10-09 11:48 to 11:57 UTC, same machine and command, three runs one after the other, after `packages/market` began to keep each chain's calldata and to decode identical answers of one snapshot once (copy of all three in `results/stage2-tick-2026-10-09-encode-once.json`). Every count in the table above is the same in all three runs: requests, Arbitrum requests, D1 statements, requests open at once, holds.

| CPU, estimate | Before | Run 1 | Run 2 | Run 3 | Limit |
|---|---|---|---|---|---|
| Typical step, mean | 5.54 ms | 3.60 ms | 4.92 ms | 4.92 ms | 10 ms |
| Heaviest step (8 + 3 requests, heaviest writes), mean | 12.59 ms | 7.74 ms | 5.08 ms | 5.00 ms | 10 ms |
| The same step, one replay at the 99th percentile | 21.47 ms | 23.87 ms | 7.30 ms | 6.65 ms | 10 ms |
| Highest mean of any scenario | 12.81 ms | 7.74 ms | 5.55 ms | 6.02 ms | 10 ms |
| Highest 99th percentile of any scenario | 27.47 ms | 23.87 ms | 14.39 ms | 10.90 ms | 10 ms |

The mean of the heaviest step is under 10 ms in all three runs, 5.0 to 7.7 ms. Single replays still go over: the 99th percentile is the wall time of one replay on a machine that does other work, and it was over 10 ms in some scenario in every run. The spread between the runs (5.0 to 7.7 ms for the same step) is this machine, so read the result as "about half of before, with 2 to 5 ms to spare", not as a number to two decimals. A new isolate also encodes each chain's calldata once, about 1.4 to 1.6 ms here, on top of its first, unoptimised step.

This is an estimate. The first deploy must read Cloudflare's own figure: the CPU time of the Clock object's alarm invocations (dashboard, Workers, the API Worker, Durable Objects metrics, or the `cpuTime` of the alarm events in `wrangler tail`), at the 15:00 UTC tick and on a step where an endpoint fails, and whether any invocation ends with "exceeded CPU time limit". Median and 99th percentile both under 10 ms is a pass.
