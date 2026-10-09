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
