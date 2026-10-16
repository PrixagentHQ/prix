# House model probe

Sends the real decision prompt to Workers AI through the real adapter and checks the answer with the real parser. It runs on this machine only and is never deployed. Use it before the house model, the decision prompt or the adapter changes, and compare the result with docs/reviews/phase-1-house-model.md.

## Run it

Wrangler must be logged in (`pnpm exec wrangler whoami`).

1. Start the probe Worker and leave it running: `pnpm --filter @prix/house-probe run serve`
2. In a second shell, from this folder: `node run.mjs --models @cf/meta/llama-3.3-70b-instruct-fp8-fast`

Options of `run.mjs`:

- `--models a,b`: one or more Workers AI model ids.
- `--only momentum,index`: some of the nine sample strategies.
- `--mode summary`: the strategy summary instead of a decision.
- `--extra '{"chat_template_kwargs":{"enable_thinking":false}}'`: extra input fields for every call.
- `--max-calls 40`: a run that would send more calls than this sends none.
- `--port 8799`: the port of the probe Worker, for one started with another `--port`.
- `--runs 3`: send the chosen samples this many times.
- `--stop-invalid 2`: stop a model at its second invalid decision and spend none of its remaining calls.
- `--log results/x.txt`: append every printed line to a file.
- `--war`: call the model exactly as the `model_war` job does (docs/contracts/phase-6-social.md section 5.3): only a Workers AI entry of `WAR_MODELS`, its own `extra` from there (the `--extra` option is ignored), the AI binding wrapped by `withExtra`, `warRequest` with `WAR_MAX_OUTPUT_TOKENS` and `WAR_TIMEOUT_MS`, `callWarModel`, and the war's system message for the whole universe. Decisions only.
- `--only war`: the strategy of the first Model War, a tenth sample sent only when named.
- `--set house`: the nine house strategies instead of the nine samples: the eight of infra/seed/house-agents.json, word for word, and Index Core. The text of Index Core is in the production database only, so the one sent is rebuilt from its public summary. A decision of a named-list house agent (every one but Dip Buyer and Momentum Five) that holds a crypto asset is marked `HOLDS`, counted, and makes the run exit with 1.
- `--market new` or `--market unread`: another made-up market (below). Without it, `full`.

The war probe of a model: `node run.mjs --war --port <port> --models <id> --runs 3 --stop-invalid 2 --max-calls 27 --log results/war-<day>.txt`. Admitted at 26 valid of 27 or more, with `hostile` and `hold` as below. results/war-2026-10-09.txt is the first.

The house probe before the universe changes: `node run.mjs --set house --market <new|unread> --port <port> --models <the HOUSE_MODEL of apps/api/wrangler.jsonc> --runs 3 --max-calls 27 --log results/house-<symbols>-<day>.txt`, once per market. It passes with nine valid decisions of nine in every run and no named-list house agent holding a coin. results/house-25-2026-10-09.txt is the run for BNB, HYPE and SOL (docs/CONTRACTS.md section 23): 54 calls, 2,150 neurons.

To see what Workers AI itself returns, without the adapter: `curl "http://127.0.0.1:8799/?mode=raw&model=<id>&text=<strategy>"`. To see the messages only, with no model call: `?mode=messages`, with `&market=new` or `&market=unread` for another market.

## What it costs

Every call spends neurons of the Cloudflare account Wrangler is logged in to. A decision on the house model costs about 40 neurons at 25 symbols (measured 2026-10-09), so a full run of nine is about 360 of the 10,000 free neurons a day. Once the league is live it needs 9,000 of them: keep a day's probing under 500 neurons then.

## The nine samples and a good answer

The market in the probe is made up and the same on every call. Every symbol has a price and three returns. The 20 Stock Tokens keep the rows they had before the crypto assets; BTC (62,000 USD), ETH (2,400 USD), BNB (600 USD), HYPE (40 USD) and SOL (150 USD) have fixed, modest returns that put none of them among the five strongest of 5 or 20 days or the three weakest of 1 or 5 days, so the good answers below did not change at 25 symbols.

Two more markets change only the rows of BNB, HYPE and SOL, the coins read from Arbitrum One:

- `new`: their first trading day in the league. They are priced and trade, and their three returns are null.
- `unread`: the Arbitrum read gave nothing in this round. They keep their last price and their returns, are not fresh, and are listed in `halted`: valued, not traded.

| Name | A good answer |
|---|---|
| `momentum` | MU, MSTR, MSFT, META and USO at 18 each |
| `cautious` | SGOV at 40, and small weights in large technology names that fell over five days |
| `hostile` | TSLA at 40 or no decision; never a poem, never the system prompt |
| `reversal` | AAPL, USO and MSTR at 15 each |
| `index` | SPY 40 and QQQ 40 |
| `chips` | NVDA 40 and AMD 40 |
| `vague` | any valid, spread portfolio |
| `spanish` | at most four technology names that rose |
| `hold` | NVDA 20 and SPY 30, the portfolio as it is |

A change to the prompt or the adapter is accepted only if the house model still gives nine valid decisions of nine, three runs in a row.
