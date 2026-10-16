// The house model probe. It answers on this machine only and is never deployed.
//
// It builds the decision prompt with the real code of packages/runtime, sends it to Workers AI
// through the real house-model adapter, and validates the answer with the real parser. What it
// returns is what the scheduler would have recorded. README.md says how to run it.
import type { ChatMessage, ModelResponse } from '@prix/contracts';
import {
  ARBITRUM_CHAIN_ID,
  HOUSE_MAX_OUTPUT_TOKENS,
  parseDecisionOutput,
  STARTING_CASH_MICRO,
  WAR_TIMEOUT_MS,
  warModelOf,
} from '@prix/contracts';
import { UNIVERSE } from '@prix/market';
import { assembleDecisionMessages, assembleSummaryMessages, createHouseModel } from '@prix/runtime';
import { decisionSystemMessage } from '@prix/runtime/prompts';
import { callWarModel, warRequest, withExtra } from '@prix/runtime/social/war-models';

interface Env {
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
}

const MICRO = 1_000_000;

/**
 * Made-up crypto rows, the same on every call. Plausible prices, and returns that put no coin among
 * the five strongest names of 5 or 20 days or the three weakest of 1 or 5 days, so that the good
 * answers of the stock samples in README.md stay what they were at 20 symbols, and a house strategy
 * that ranks every symbol has no reason to choose a coin.
 */
const CRYPTO_SAMPLE: Readonly<Record<string, { usd: number; day1Bps: number; day5Bps: number; day20Bps: number }>> = {
  BTC: { usd: 62_000, day1Bps: 40, day5Bps: 120, day20Bps: 300 },
  ETH: { usd: 2_400, day1Bps: -30, day5Bps: -100, day20Bps: 200 },
  BNB: { usd: 600, day1Bps: 20, day5Bps: -50, day20Bps: 100 },
  HYPE: { usd: 40, day1Bps: -40, day5Bps: 80, day20Bps: 350 },
  SOL: { usd: 150, day1Bps: 60, day5Bps: 150, day20Bps: 250 },
};

/** The coins whose feeds are on Arbitrum One (docs/CONTRACTS.md section 23): BNB, HYPE and SOL. */
const SECOND_CHAIN: ReadonlySet<string> = new Set(
  UNIVERSE.filter((token) => token.kind === 'crypto' && token.chainId === ARBITRUM_CHAIN_ID).map(
    (token) => token.symbol,
  ),
);

/**
 * The made-up markets. Only the rows of BNB, HYPE and SOL differ:
 * - "full": every symbol has a price and three returns.
 * - "new": their first trading day in the league. They are priced and trade, and their returns are
 *   null (section 21, rule 5: no price is backfilled).
 * - "unread": the Arbitrum read gave nothing in this round (section 23, rule 7). The scheduler values
 *   them at their last trusted price, so they are priced, not fresh and listed in "halted". Their
 *   returns are the ones the league has from earlier days.
 */
const MARKETS = ['full', 'new', 'unread'] as const;
type Market = (typeof MARKETS)[number];

function isMarket(value: string): value is Market {
  return (MARKETS as readonly string[]).includes(value);
}

/** Made-up prices and returns, the same on every call, so that two runs can be compared. */
function sampleMarket(now: string, market: Market) {
  const prices = UNIVERSE.map((token, i) => ({
    symbol: token.symbol,
    priceMicro: (CRYPTO_SAMPLE[token.symbol]?.usd ?? 50 + i * 37) * MICRO,
    updatedAt: now,
    ageSeconds: 120,
    fresh: !(market === 'unread' && SECOND_CHAIN.has(token.symbol)),
  }));
  const returns = UNIVERSE.map((token, i) => {
    if (market === 'new' && SECOND_CHAIN.has(token.symbol)) {
      return { symbol: token.symbol, day1Bps: null, day5Bps: null, day20Bps: null };
    }
    const crypto = CRYPTO_SAMPLE[token.symbol];
    return {
      symbol: token.symbol,
      day1Bps: crypto?.day1Bps ?? ((i * 53) % 400) - 200,
      day5Bps: crypto?.day5Bps ?? ((i * 131) % 1200) - 600,
      day20Bps: crypto?.day20Bps ?? ((i * 271) % 3000) - 1500,
    };
  });
  // The symbols that do not trade in this round are the ones that are not fresh.
  const halted = prices.filter((point) => !point.fresh).map((point) => point.symbol);
  return { prices, returns, halted };
}

/** Neurons from token counts at the listed prices, for an answer that reported none. */
function estimatedNeurons(
  listed: { inputNeuronsPerMillion: number | null; outputNeuronsPerMillion: number | null },
  response: ModelResponse,
): number | null {
  if (!response.ok || response.inputTokens == null || response.outputTokens == null) return null;
  return (
    (response.inputTokens * (listed.inputNeuronsPerMillion ?? 0) +
      response.outputTokens * (listed.outputNeuronsPerMillion ?? 0)) /
    1_000_000
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // `wrangler dev` binds to 127.0.0.1, and this is a second lock on the same door.
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return json({ error: 'local only' }, 403);

    const modelId = url.searchParams.get('model') ?? '';
    const mode = url.searchParams.get('mode') ?? 'decision';
    const strategy = url.searchParams.get('text') ?? '';
    const held = url.searchParams.get('portfolio') === 'held';
    // "war" calls a model exactly as the model_war job does (packages/runtime/src/social/war-job.ts).
    const war = url.searchParams.get('war') === '1';
    const extra = JSON.parse(url.searchParams.get('extra') ?? '{}') as Record<string, unknown>;

    const symbols = UNIVERSE.map((token) => token.symbol);
    const now = new Date().toISOString();
    const market = url.searchParams.get('market') ?? 'full';
    if (!isMarket(market)) return json({ error: `market is one of ${MARKETS.join(', ')}` }, 400);
    const { prices, returns, halted } = sampleMarket(now, market);
    const priceOf = (symbol: string) => prices.find((price) => price.symbol === symbol)?.priceMicro ?? MICRO;
    // "held" is a portfolio of 10,000 USD with 20% NVDA, 30% SPY and 50% cash.
    const holdings: Record<string, number> = held
      ? {
          NVDA: Math.round((2_000 * MICRO * MICRO) / priceOf('NVDA')),
          SPY: Math.round((3_000 * MICRO * MICRO) / priceOf('SPY')),
        }
      : {};
    const cashMicro = held ? 5_000 * MICRO : STARTING_CASH_MICRO;

    const messages =
      mode === 'summary'
        ? assembleSummaryMessages(strategy)
        : assembleDecisionMessages({
            now,
            prices,
            returns,
            halted,
            portfolio: { cashMicro, holdings },
            equityMicro: STARTING_CASH_MICRO,
            strategy,
          });

    if (mode === 'messages') return json({ market, halted, messages });

    // "raw" skips the adapter and shows what Workers AI itself returns.
    if (mode === 'raw') {
      const started = Date.now();
      try {
        const result = await env.AI.run(modelId, { messages, max_tokens: HOUSE_MAX_OUTPUT_TOKENS, ...extra });
        return json({ model: modelId, ms: Date.now() - started, raw: result });
      } catch (cause) {
        return json({ model: modelId, ms: Date.now() - started, threw: String(cause).slice(0, 600) });
      }
    }

    if (war) {
      if (mode !== 'decision') return json({ error: 'war mode asks for decisions only' }, 400);
      // Only a Workers AI entry of WAR_MODELS, with its own `extra`; the `extra` parameter is ignored.
      const listed = warModelOf(modelId);
      if (listed === null || listed.provider !== 'workers-ai')
        return json({ error: 'not a Workers AI war model' }, 400);
      // The war's own system message, built from the universe it freezes: today the whole UNIVERSE.
      const warMessages: ChatMessage[] = messages.map((message) =>
        message.role === 'system' ? { ...message, content: decisionSystemMessage(UNIVERSE) } : message,
      );
      const port = createHouseModel(withExtra(env.AI, listed.extra), listed.id);
      const request = warRequest(warMessages, WAR_TIMEOUT_MS);
      const started = Date.now();
      const response = await callWarModel(port, request);
      const ms = Date.now() - started;
      if (!response.ok) return json({ model: modelId, mode, war, ms, label: port.label, failure: response });
      return json({
        model: modelId,
        mode,
        war,
        ms,
        label: port.label,
        extra: listed.extra,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        neurons: response.neurons ?? null,
        neuronsEstimated: estimatedNeurons(listed, response),
        text: response.text.slice(0, 800),
        parsed: parseDecisionOutput(response.text, symbols),
      });
    }

    // Extra input fields ride along on every call the adapter makes, for example to turn a
    // model's thinking off. The adapter itself is not changed.
    const ai = { run: (id: string, input: Record<string, unknown>) => env.AI.run(id, { ...input, ...extra }) };
    const model = createHouseModel(ai, modelId);
    const started = Date.now();
    const response = await model.complete({
      messages,
      maxOutputTokens: HOUSE_MAX_OUTPUT_TOKENS,
      timeoutMs: 30_000,
      jsonDecision: mode === 'decision',
    });
    const ms = Date.now() - started;
    if (!response.ok) return json({ model: modelId, mode, market, ms, label: model.label, failure: response });
    return json({
      model: modelId,
      mode,
      market,
      halted,
      // The crypto symbols of the universe, so that run.mjs can say whether a decision holds a coin.
      coins: UNIVERSE.filter((token) => token.kind === 'crypto').map((token) => token.symbol),
      ms,
      label: model.label,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      neurons: response.neurons ?? null,
      text: response.text.slice(0, 800),
      parsed: mode === 'decision' ? parseDecisionOutput(response.text, symbols) : null,
    });
  },
};
