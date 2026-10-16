import { BPS, MAX_WEIGHT_BPS, REASON_MAX } from './constants.ts';
import type { TokenSymbol } from './primitives.ts';
import { z } from './zod.ts';

/**
 * What a model must return at a tick: target weights as percentages and one sentence.
 *
 *   {"targets": {"NVDA": 21, "MSFT": 18}, "reason": "Adds to the strongest position."}
 *
 * A symbol that is left out has a target of zero. Whatever the targets do not use is cash.
 */
export const decisionOutputSchema = z.strictObject({
  targets: z.record(z.string(), z.number()),
  reason: z.string(),
});
export type DecisionOutput = z.infer<typeof decisionOutputSchema>;

/**
 * The JSON Schema of the same shape, for providers that take one. It asks the model for the
 * position cap; `parseDecisionOutput` cuts a weight that is above it all the same.
 */
export const decisionOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['targets', 'reason'],
  properties: {
    targets: {
      type: 'object',
      description:
        'Target weight per symbol, in percent of the portfolio. Numbers from 0 to 40 with at most two decimal places. The sum must not exceed 100.',
      additionalProperties: { type: 'number', minimum: 0, maximum: MAX_WEIGHT_BPS / 100 },
    },
    reason: { type: 'string', description: 'One sentence that says why.' },
  },
} as const;

/** Why an agent that was asked produced no decision. The portfolio is left untouched. */
export const noDecisionCodeSchema = z.enum([
  'invalid_json',
  'schema_mismatch',
  'unknown_symbol',
  'weight_out_of_range',
  'weights_exceed_100',
  /**
   * The weights are not all zero and every weight that is not zero is 1% or less as written: the
   * model most likely wrote fractions (0.6 for sixty percent). Refused, never scaled up.
   */
  'weights_look_like_fractions',
  'reason_invalid',
  /** The provider refused the key or the model name: HTTP 401, 403 or 404. The owner must fix it. */
  'provider_rejected',
  'provider_error',
  'provider_timeout',
  'key_unavailable',
]);
export type NoDecisionCode = z.infer<typeof noDecisionCodeSchema>;

/** Why an agent was not asked at a tick. */
/**
 * `changed_this_round`: the strategy changed after the tick's snapshot, so the agent sits the
 * round out. `internal_error`: the engine could not process the agent, and the failure is logged.
 */
export const skipCodeSchema = z.enum(['allocation_exhausted', 'not_reached', 'changed_this_round', 'internal_error']);
export type SkipCode = z.infer<typeof skipCodeSchema>;

export type DecisionParse =
  | { ok: true; targetsBps: Record<TokenSymbol, number>; reason: string }
  | { ok: false; code: NoDecisionCode; detail: string };

function fail(code: NoDecisionCode, detail: string): DecisionParse {
  return { ok: false, code, detail };
}

/**
 * The one place that decides whether model output is a valid decision.
 *
 * Rules, in order:
 * 1. The whole text, trimmed, must parse as JSON. Nothing is repaired: no code fences, no prose.
 * 2. It must be an object with exactly `targets` and `reason`.
 * 3. Every key of `targets` must be a symbol of the universe.
 * 4. Every weight must be a number from 0 to 100 with at most two decimal places.
 * 5. Weights that are not all zero must have at least one weight above 1 as written, before the
 *    cap. When every weight that is not zero is from 0.01 to 1, the answer is read as fractions
 *    written for percents (0.6 for sixty percent; 0.6 and 0.6; 0.5, 0.5 and 0.01) and refused
 *    with `weights_look_like_fractions`. Nothing is scaled up: the agent keeps what it
 *    holds for the round, which is the safe side. All weights at
 *    zero, everything to cash, stays a valid decision. An answer with one weight above 1 beside
 *    small ones (21 and 0.6) cannot be told from a deliberate small position and stays valid.
 * 6. The weights as written must not add up to more than 100.
 * 7. The reason has its whitespace collapsed and every control and format character removed,
 *    including the ones that reorder text or hide it. It must not be empty. A reason longer
 *    than REASON_MAX characters is cut and ends with an ellipsis.
 *
 * A valid weight above the position cap is then cut to the cap: 50 becomes 40, and the rest
 * stays in cash. The cap is a rule of the portfolio, not of the output. A strategy such as
 * "half in each of two funds" is common, most models answer it with 50 and 50, and the same
 * decision under the rules is 40 and 40.
 *
 * Zero weights are dropped from the result. Weights are returned in basis points.
 */
export function parseDecisionOutput(raw: string, symbols: readonly TokenSymbol[]): DecisionParse {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return fail('invalid_json', 'The output is not a single JSON object.');
  }

  const parsed = decisionOutputSchema.safeParse(value);
  if (!parsed.success) {
    return fail('schema_mismatch', 'The output must be an object with exactly "targets" and "reason".');
  }

  // Read the keys from the raw JSON value, not from the schema's output: a key such as
  // "__proto__" is an own property of the parsed JSON but is lost when an object is rebuilt,
  // and a lost key would pass as "not there" instead of failing rule 3.
  const rawTargets = (value as { targets: Record<string, number> }).targets;
  const allowed = new Set(symbols);
  const keys = Object.keys(rawTargets);
  // Rule 3 is checked for every key before rule 4 for any, so the code of a refusal does not
  // depend on the order in which the model wrote its keys.
  const unknown = keys.find((symbol) => !allowed.has(symbol));
  if (unknown !== undefined) {
    return fail('unknown_symbol', `${unknown.slice(0, 20)} is not in the universe.`);
  }
  const targetsBps: Record<TokenSymbol, number> = {};
  let totalBps = 0;
  let largestBps = 0;
  for (const symbol of keys) {
    const percent = Object.getOwnPropertyDescriptor(rawTargets, symbol)?.value as number;
    if (!Number.isFinite(percent) || percent < 0 || percent > BPS / 100) {
      return fail('weight_out_of_range', `The weight for ${symbol} must be from 0 to ${BPS / 100}.`);
    }
    const bps = Math.round(percent * 100);
    if (Math.abs(percent * 100 - bps) > 1e-6) {
      return fail('weight_out_of_range', `The weight for ${symbol} has more than two decimal places.`);
    }
    // The sum is taken of the weights as written, before the cap: output that asks for more
    // than the whole portfolio is not a decision, whatever the cap would make of it.
    totalBps += bps;
    largestBps = Math.max(largestBps, bps);
    const capped = Math.min(bps, MAX_WEIGHT_BPS);
    if (capped > 0) targetsBps[symbol] = capped;
  }
  // Rule 5: when every weight that is not zero is from 1 to 100 basis points as written, before
  // the cap, the answer is fractions written for percents ("60% in SPY" answered with 0.6).
  // Reading the largest weight, not the total, also refuses fractions that add up to more than
  // one (0.6 and 0.6) and a stray small weight beside them (0.5, 0.5 and 0.01). A strategy that
  // truly wants 1% or less in each position is refused too. One weight above 1 beside small
  // ones (21 and 0.6) cannot be told from a deliberate small position and stays valid.
  if (largestBps > 0 && largestBps <= BPS / 100) {
    return fail('weights_look_like_fractions', 'Write each weight as a percent: 60 means sixty percent, not 0.6.');
  }
  if (totalBps > BPS) {
    return fail('weights_exceed_100', 'The weights add up to more than 100.');
  }

  const cleaned = parsed.data.reason
    // Control and format characters, including the ones that reorder text or hide it.
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) {
    return fail('reason_invalid', 'The reason is empty.');
  }
  const reason = cleaned.length > REASON_MAX ? `${cleaned.slice(0, REASON_MAX - 1).trimEnd()}…` : cleaned;

  return { ok: true, targetsBps, reason };
}
