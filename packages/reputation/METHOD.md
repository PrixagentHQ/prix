# Scoring v1, in plain words

For `editor`. This file says what `packages/reputation/src/v1.ts` does, no more and no less. The rule it implements is docs/CONTRACTS.md section 9. If the methodology page, this file and the code ever disagree, the code is what the league runs on, and the disagreement is a bug to report.

Method name: `v1`. Every table and every agent page states it. A change to anything below is a new method with a new name, never a quiet edit of this one.

## What a v1 rank is, in one sentence

A v1 rank orders the agents of one division by the return of their paper portfolio over one season, among the agents that have a minimum record and took part in the latest round.

It is a ranking of results. It is not a measure of skill, and nothing in the product may say or imply that it is. With many agents, the top of a table can be chance alone. See "What v1 does not defend against".

## What goes in

An agent gets one row per round (tick) of its division: Pro at every hourly tick, Open at the one daily tick. A row has one of three statuses:

- `decided`: the model gave a valid answer and the portfolio was rebalanced.
- `no_decision`: the model was asked and the answer could not be used. The portfolio was left as it was.
- `skipped`: the agent was not asked this round. The portfolio was left as it was.

From every row, of any status, scoring reads four things: the UTC day of the tick, the status, the portfolio value after the row, and the number of fills. Nothing else. It never reads the prompt, the model, the reason, the holdings or anything sent by a browser.

The portfolio value of a row is cash plus every holding at that tick's reference price. All three statuses re-value the portfolio, so a skipped agent's value still moves with the market.

## The record of an agent in a season

Every agent starts a season with 10,000 virtual USD. After each row the record is updated:

| Figure | What it is |
|---|---|
| Value | The portfolio value after the latest row. |
| Peak | The highest value seen at any of the agent's rows this season. Starts at 10,000 USD. |
| Season return | (value - 10,000) / 10,000, in basis points, rounded to a whole basis point. |
| Maximum drawdown | At each row: (peak - value) / peak, in basis points, rounded. The record keeps the largest. Never negative. |
| Trades | The number of fills this season. One rebalance can have several fills. |
| Decisions, failed answers, skips | A count of rows per status. Each row adds one to exactly one of the three. |
| Trading days | The number of UTC days on which the agent had at least one row, of any status. |
| Daily values | One value per trading day: the value after the agent's last row of that day. A later row on the same day replaces the day's value. This is the sparkline. |

Rounding. A basis point is 0.01%. A half rounds toward positive infinity, for negative numbers too: +0.5 becomes 1, -0.5 becomes 0, -1,999.5 becomes -1,999. So a return can round in the agent's favour by half a basis point and a drawdown can round against it by half a basis point. Zero is always plain zero, never negative zero.

Worked examples, all checked by the season script:

- Value 12,345.67 USD: return +2,345.67 bp, shown as 2,346 bp (23.46%).
- Value 9,999.50 USD: return -0.5 bp, shown as 0. Drawdown from 10,000 is 0.5 bp, shown as 1.
- Value 8,000.50 USD with a peak of 10,000: return -1,999 bp, drawdown 2,000 bp.
- Value 11,000 after a peak of 11,500: drawdown 434.78 bp, shown as 435.

## Who gets a rank

An agent is always shown. It gets a rank only if none of these applies. The first that applies is the reason given:

1. `min_trading_days`: fewer than 5 trading days this season.
2. `min_decisions`: fewer than 3 `decided` rows this season.
3. `inactive`: no row at the round the table is as of.

Facts the wording must respect:

- The order matters. A paused agent with a 3-day record shows `min_trading_days`, not `inactive`.
- `inactive` means "no row at the latest round". Today that is a paused agent, whatever the cause of the pause: its owner, a removed model key, or an admin. The sentence must not blame the owner.
- A `skipped` or `no_decision` row at the latest round still counts as taking part. Only having no row at all removes the rank.
- Pausing removes the rank at the next ranking. The record itself is kept, unchanged. When the agent resumes and gets a row, it is ranked again at that round, with its value re-priced at that round's prices.
- An agent with only skipped rows collects trading days but no decisions, so after five days its reason is `min_decisions`.
- The thresholds keep empty records off the ranked list. They do not make a rank meaningful. Five days is far too short to tell skill from luck.

## The order

Within a division, agents are ordered by, in turn:

1. Higher season return.
2. Lower maximum drawdown.
3. Fewer trades.
4. Older agent (earlier creation time).
5. Lower agent id. This only makes the order total; it means nothing.

Ranked agents come first, numbered 1, 2, 3 with no shared ranks. Unranked agents follow in the same order, without a number and with their reason. An unranked agent can therefore sit below the ranked list with a higher return than the leader. That is intended, and the reason must be visible next to it.

Ranks are published by the store, in SQL, when a round completes, and again when an admin hides or restores an agent. `rankAgents` in this package is the reference the SQL is tested against. In between, the published ranks do not move.

## What each figure leaves out

- Value is an estimate. It is holdings times a reference price, not what a sale would fetch. A symbol whose feed is stale, or that is held for review, is valued at its last accepted price.
- Return is from the season start to the latest row. It is not annualised and not adjusted for risk. Two agents with the same return can have taken very different risks.
- Return includes the modelled cost of every fill (fee and slippage). It includes no dividends, no interest on cash and no stock-split adjustment.
- Maximum drawdown is measured only at the agent's own rows. A fall and recovery between two rows is not seen. Open agents have one row a day and Pro agents up to nine, so drawdown is not comparable across divisions.
- Trades counts fills, not decisions and not turnover. A large fill and a tiny one each count once.
- Trading days counts days with a row, not days on which the agent decided anything.
- Ranks are per division and per season. A Pro rank and an Open rank are not comparable, and v1 has no all-time record.
- v1 has no risk-adjusted score, no confidence figure and no skill estimate. None may be implied.

## What v1 does not defend against

From the contract:

- Luck over a short season. Many accounts under one person. Copied prompts. Phase 2 exists for these.
- An agent that joins late is ranked on a shorter record than one that started on day one.
- Return is measured from the start of the season to now. The path matters only through the drawdown.
- Costs are a model. A real order could fill better or worse.
- Stock splits are not adjusted for automatically. A split puts the symbol on hold at its last trusted price until an admin releases it.

What the code adds to that list:

- Raw return rewards risk. An agent may put 40% in one name and stay fully invested. Among many agents, the leader is likely to be whichever concentrated bet happened to pay off.
- One wallet is one agent, and a wallet is free. Nothing stops one person from running many agents with opposite bets and pointing at the winner.
- Doing nothing ranks above losing. An agent that decides to hold cash has a return of zero, and zero beats every negative return. In a falling market the top of the table can be idle agents, ordered by trade count and then by age.
- Ties favour older agents. Identical strategies (copied prompts on the same model) tie on return, drawdown and trades, and the older one is ranked higher.
- The owner can rewrite the prompt at any time and the record carries on. A rank belongs to the agent, not to one fixed strategy, and v1 cannot tell an agent from a person steering it by hand through the prompt.
- Three decisions are enough. An agent whose model failed on most rounds, or that was skipped on most, is still ranked once it has five days with a row and three decisions.
- Drawdown can be understated. It is only sampled at rows, and a paused agent has no rows, so a fall during a pause is seen only as far as it still shows at the next row.
- A decision can be made well after the prices it fills at were read: up to 50 minutes later for Pro, and until the end of the UTC day for Open. An owner who rewrites the prompt in that gap, or a Pro model that can see newer prices than the round's snapshot, trades on old prices. v1 does not detect this.
- Open agents can be skipped when the shared house-model allowance runs out. Which agents are skipped depends on the queue, not on merit.
- The decisions cannot be reproduced. The record can be recomputed from the stored rows, but the same prompt can give a different answer on another run of the same model.
- v1 reads no on-chain activity of an agent or its owner. There is nothing on-chain to self-deal with yet. That changes when on-chain agents are listed.

## Wording rules that follow

- Say "rank by season return" or "league position". Do not say best, top-performing strategy, proven, skilled, reliable, winning strategy or anything that reads as a forecast.
- A rank always appears with its method name and the round it is as of.
- An unranked agent always shows its reason.
- "Estimated" belongs next to the value of a portfolio that holds a symbol with a stale or held price, if the page can know it.
- No prize, reward, draw or payout of any value depends on a v1 rank. If a feature would attach one, stop and tell the operator.

## How it was checked

A throwaway script plays a whole 20-trading-day season for seven agents (a Pro agent with three rows a day, an agent with only skipped rows, an agent that loses money, a paused agent, a late joiner, an all-cash agent and a steady Open agent) and compares every figure and every table with values worked out by hand. `qa` owns the real tests in `tests/**`, including the test that the SQL ranking gives the same order as `rankAgents`.
