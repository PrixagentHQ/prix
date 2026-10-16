/**
 * Strategy templates on the Build page (D-155): eight starting texts of Prix's own, above the prompt
 * field, so that a reader can start from one in one tap and edit it before building the agent.
 * `editor` owns this file; `deck.ts` spreads it. The keys are in the `builder` area, which the Build
 * page (web-account) reads.
 *
 * What these strings keep to:
 * - A template says what it does, never how well. No return, no rank, no "best" and no figure of any
 *   kind stands in a title or a line: neither digits nor a count in words.
 * - A line says what the text tells the agent, never what the agent will certainly do: "keeps cash
 *   above", not "never lets cash fall below" (TPL2-WORDS-1). An agent's model can still decide otherwise.
 * - A template's prompt is a set of rules for an agent, written as the house agents' prompts are
 *   (infra/seed/house-agents.json). It reads the inputs an agent is given (weights, cash and the
 *   returns over 1, 5 and 20 trading days, packages/runtime/src/prompts.ts) and nothing else. Its
 *   figures are weights and thresholds only, each at most the cap of one holding (MAX_WEIGHT_BPS),
 *   never an amount of money, a price or a result.
 * - No template promises, forecasts or advises, names a person, a firm's outlook or a price target,
 *   or addresses the reader. None uses "buy" or "sell": a template holds, adds, raises or moves to cash.
 * - It passes `promptSchema` (packages/contracts/src/agents.ts): the page puts it into the prompt
 *   field as plain text, exactly as written here.
 * - The section says once that a template is a starting text, not advice.
 * - The section shows twice: in the signed-in form, where choosing a template fills the field, and in
 *   the sign-in card for a reader who has not signed in, where choosing one keeps its text in this tab's
 *   builder draft for after sign-in (T-1). That card has its own hint, its own two status lines and
 *   its own body for the question, since no strategy prompt is on that page (DC-T5); the note stays
 *   once on the page.
 * - A word that names one item of a set ("one of them", "moves one to cash") is a pronoun, not a count.
 *
 * templates.test.ts beside this file holds every rule above.
 *
 * Slots: `{title}` is the chosen template's title, as `builder.template<Name>Title` gives it.
 *
 * The holder templates (D-161): a second set of eight, in `HOLDER_TEMPLATE_IDS`, with more rules each,
 * shown only to a signed-in wallet at tier 1 or above, which the server decides. They keep every rule
 * above, and three more:
 * - Each reads only the facts the decision call gives the agent (packages/runtime/src/prompts.ts): per
 *   symbol, the returns over the last 1, 5 and 20 trading days, any of which may be null; the percent of
 *   the portfolio in cash and in each holding; the halted symbols. The agent sees no volatility, no
 *   moving average, no price history, no earlier decision and no record of its own: no template asks
 *   for one, and each says what to do while a return it reads is null. `HOLDER_TEMPLATE_FACTS` names
 *   what each reads, and templates.test.ts holds it.
 * - None says or implies that it is better than the first set, or that holding $PRIX improves an
 *   agent: the hint says the league's limits are the same for every agent.
 * - The line for a reader under tier 1 is the operator's own sentence, word for word, and names neither a
 *   title nor a prompt of this set. Its figure is tier 1 of the default thresholds over the supply.
 */

/** The templates in the order the page shows them. Each id names three keys: Title, Line and Prompt. */
export const BUILD_TEMPLATE_IDS = [
  'BigTech',
  'IndexCore',
  'Semis',
  'DownDays',
  'Momentum',
  'Treasury',
  'CryptoProxies',
  'BtcEth',
] as const;

export type BuildTemplateId = (typeof BUILD_TEMPLATE_IDS)[number];

/**
 * The holder templates in the order the page shows them (D-161), only to a signed-in wallet at tier 1 or
 * above. Each id names three keys, as a first-set id does; no id is in both lists.
 */
export const HOLDER_TEMPLATE_IDS = [
  'GroupRotation',
  'IndexTrend',
  'DualMomentum',
  'CryptoTrend',
  'Pullbacks',
  'StrengthTilt',
  'BandedMix',
  'ChipsBrake',
] as const;

export type HolderTemplateId = (typeof HOLDER_TEMPLATE_IDS)[number];

/** A fact of the decision call (packages/runtime/src/prompts.ts) that a holder template reads. */
export type DecisionFact = 'return1d' | 'return5d' | 'return20d' | 'holdingsPercent' | 'cashPercent' | 'halted';

/**
 * What each holder template reads of the decision call, and for which symbols. A return is the
 * symbol's percent return over the last 1, 5 or 20 trading days, null while the league has fewer
 * earlier trading days of it. `holdingsPercent` and `cashPercent` are the portfolio's parts in percent.
 */
export const HOLDER_TEMPLATE_FACTS: Record<
  HolderTemplateId,
  readonly { fact: DecisionFact; symbols: readonly string[] }[]
> = {
  GroupRotation: [
    {
      fact: 'return20d',
      symbols: ['NVDA', 'AMD', 'MU', 'INTC', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'COIN', 'MSTR', 'CRCL'],
    },
  ],
  IndexTrend: [
    { fact: 'return20d', symbols: ['SPY'] },
    { fact: 'holdingsPercent', symbols: ['SPY', 'QQQ', 'SGOV'] },
  ],
  DualMomentum: [{ fact: 'return20d', symbols: ['SPY', 'QQQ', 'BTC', 'SGOV'] }],
  CryptoTrend: [
    { fact: 'return20d', symbols: ['BTC', 'ETH', 'SOL'] },
    { fact: 'return5d', symbols: ['BTC', 'ETH', 'SOL'] },
  ],
  Pullbacks: [
    { fact: 'return20d', symbols: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA'] },
    { fact: 'return5d', symbols: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA'] },
  ],
  StrengthTilt: [{ fact: 'return20d', symbols: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'SPY'] }],
  BandedMix: [
    { fact: 'holdingsPercent', symbols: ['SPY', 'QQQ', 'SGOV', 'BTC', 'ETH'] },
    { fact: 'halted', symbols: ['SPY', 'QQQ', 'SGOV', 'BTC', 'ETH'] },
  ],
  ChipsBrake: [
    { fact: 'return5d', symbols: ['NVDA', 'AMD', 'MU', 'INTC'] },
    { fact: 'return1d', symbols: ['NVDA', 'AMD', 'MU', 'INTC'] },
    { fact: 'holdingsPercent', symbols: ['NVDA', 'AMD', 'MU', 'INTC'] },
  ],
};

/** The three deck keys of one template, of either set. */
export function buildTemplateKeys(id: BuildTemplateId | HolderTemplateId): {
  title: string;
  line: string;
  prompt: string;
} {
  return {
    title: `builder.template${id}Title`,
    line: `builder.template${id}Line`,
    prompt: `builder.template${id}Prompt`,
  };
}

export const templateStrings = {
  // --- the section ---
  'builder.templatesTitle': 'Start from a template',
  'builder.templatesHint':
    'Choosing one puts its text in the strategy prompt. You can change every word before you build the agent.',
  'builder.templatesNote': 'A template is a starting text, not advice.',
  /** The accessible name of a template's button, where its visible text is the title and the line. */
  'builder.templateUse': 'Use the template {title}',
  /** Said once the text is in the field, through a polite live region. */
  'builder.templateAdded': 'The template {title} is in the strategy prompt. Edit it as you like.',

  // --- the same section for a reader who has not signed in (T-1): the text waits in this tab's draft ---
  /** In place of `builder.templatesHint` in the sign-in card. */
  'builder.templatesHintSignedOut':
    'Choosing one keeps its text for the strategy prompt, ready after you sign in. You can change every word before you build the agent.',
  /** Said once the text is kept in the builder draft, through a polite live region. The next step is the link beside it. */
  'builder.templateKept': '{title} is ready for the strategy prompt.',
  /** The words of the sign-in link beside `builder.templateKept`, so that the step is said once (DC3-2). */
  'builder.templateKeptSignIn': 'Sign in to continue',
  /** Said when this browser's storage refuses the draft: nothing was kept. */
  'builder.templateNotKept': '{title} could not be kept in this browser. Sign in, then choose it again.',

  // --- the question before a template replaces text the person typed ---
  'builder.templateReplaceTitle': 'Replace your text?',
  'builder.templateReplaceBody':
    'The strategy prompt holds text you wrote. The template {title} takes its place, and your text is not kept.',
  /** In place of `builder.templateReplaceBody` in the sign-in card, where no strategy prompt is on the page (DC-T5). */
  'builder.templateReplaceBodySignedOut':
    'The text kept for your strategy prompt is text you wrote. The template {title} takes its place, and your text is not kept.',
  'builder.templateReplaceConfirm': 'Replace my text',
  'builder.templateReplaceCancel': 'Keep my text',

  // --- the eight templates ---
  'builder.templateBigTechTitle': 'Equal-weight big tech',
  'builder.templateBigTechLine': 'Holds AAPL, MSFT, GOOGL, AMZN, META and NVDA in equal parts, with the rest in cash.',
  'builder.templateBigTechPrompt':
    'Hold AAPL, MSFT, GOOGL, AMZN, META and NVDA at 14% each and keep the rest in cash. Change a holding only when it is more than three points away from 14%.',

  'builder.templateIndexCoreTitle': 'Index core with cash',
  'builder.templateIndexCoreLine': 'Holds SPY and QQQ as a core and keeps cash above a set part of the portfolio.',
  'builder.templateIndexCorePrompt':
    'Hold SPY at 35% and QQQ at 25%, and keep the rest in cash. Never let cash fall below 40% of the portfolio. Change a holding only when it is more than three points away from the weight given here.',

  'builder.templateSemisTitle': 'Semiconductor basket',
  'builder.templateSemisLine': 'Holds NVDA, AMD, MU and INTC in equal parts, with the rest in cash.',
  'builder.templateSemisPrompt':
    'Hold NVDA, AMD, MU and INTC at 20% each and keep the rest in cash. Change a holding only when it is more than three points away from 20%.',

  'builder.templateDownDaysTitle': 'Adding on down days, capped',
  'builder.templateDownDaysLine': 'Holds a core of SPY and adds to it after a down day, up to a set cap.',
  'builder.templateDownDaysPrompt':
    'Hold SPY at 25% and keep the rest in cash. After a trading day on which SPY fell more than 2%, raise SPY by five points, to at most 40%. Once SPY’s return over the last five trading days is above zero again, bring it back to 25%.',

  'builder.templateMomentumTitle': 'Capped momentum',
  'builder.templateMomentumLine': 'Holds the symbols that rose most over recent trading days, each under a cap.',
  'builder.templateMomentumPrompt':
    'Each round, hold the four symbols with the highest return over the last five trading days, at 15% each, and keep the rest in cash. Never hold more than 15% of the portfolio in one symbol. Never hold SGOV or USO. While no return is known yet, hold cash only.',

  'builder.templateTreasuryTitle': 'Mostly SGOV and cash',
  'builder.templateTreasuryLine': 'Keeps most of the portfolio in SGOV and cash, with a small part in SPY.',
  'builder.templateTreasuryPrompt':
    'Keep 40% in SGOV at all times. Hold SPY at 15% and keep the rest in cash. Change a holding only when it is more than three points away from the weight given here.',

  'builder.templateCryptoProxiesTitle': 'Crypto proxy stocks',
  'builder.templateCryptoProxiesLine':
    'Holds COIN, MSTR and CRCL in equal parts, and moves any that drop sharply to cash.',
  'builder.templateCryptoProxiesPrompt':
    'Hold COIN, MSTR and CRCL at 20% each and keep the rest in cash. If one of them fell more than 8% over the last trading day, hold cash in its place until the next round.',

  'builder.templateBtcEthTitle': 'Bitcoin and Ethereum',
  'builder.templateBtcEthLine': 'Holds BTC and ETH at set weights and keeps the rest in cash.',
  'builder.templateBtcEthPrompt':
    'Hold BTC at 25% and ETH at 15%, and keep the rest in cash. Change a holding only when it is more than five points away from the weight given here.',

  // --- the holder templates (D-161): shown only to a signed-in wallet at tier 1 or above ---
  /** The heading of the second set, under the first. */
  'builder.templatesHolderTitle': 'Templates for holders',
  /** Under that heading. It says why the set shows, and that it changes no limit of the league. */
  'builder.templatesHolderHint':
    'For wallets holding 10,000 $PRIX or more. Each sets more rules for the agent than a template above, and the league’s limits are the same for every agent.',
  /** The operator's own sentence, word for word, in place of the set for a reader signed out or under tier 1. */
  'builder.templatesHolderLocked': 'Eight more templates for wallets holding 10,000 $PRIX.',
  /** The words of the link to /token beside `builder.templatesHolderLocked`. */
  'builder.templatesHolderLockedLink': 'How the tiers work',

  'builder.templateGroupRotationTitle': 'Rotation across groups',
  'builder.templateGroupRotationLine':
    'Holds the group of stocks that rose most over recent weeks, with SPY beside it.',
  'builder.templateGroupRotationPrompt':
    'Each round, work out the average return over the last twenty trading days of each of these groups: chips (NVDA, AMD, MU, INTC), platforms (AAPL, MSFT, GOOGL, AMZN, META) and crypto stocks (COIN, MSTR, CRCL). Hold the members of the group with the highest average in equal parts that add up to 40%, hold SPY at 20%, and keep the rest in cash. Leave out of an average any symbol whose return over the last twenty trading days is null. While no group has a known return, hold SPY at 20% and keep the rest in cash.',

  'builder.templateIndexTrendTitle': 'Index trend switch',
  'builder.templateIndexTrendLine':
    'Holds SPY and QQQ while SPY has risen over recent weeks, and SGOV while it has not.',
  'builder.templateIndexTrendPrompt':
    'While SPY’s return over the last twenty trading days is above zero, hold SPY at 35% and QQQ at 25%, and keep the rest in cash. While that return is zero or below, or still null, hold SGOV at 40% and keep the rest in cash. Change a holding only when it is more than three points away from the weight given here.',

  'builder.templateDualMomentumTitle': 'Strongest leader, or SGOV',
  'builder.templateDualMomentumLine': 'Holds the one of SPY, QQQ and BTC that rose most over recent weeks, or SGOV.',
  'builder.templateDualMomentumPrompt':
    'Each round, compare the returns over the last twenty trading days of SPY, QQQ and BTC. Hold the one with the highest return at 40% if that return is above SGOV’s return over the same days, and otherwise hold SGOV at 40%. Keep the rest in cash. Leave out any symbol whose return over the last twenty trading days is null, and while SGOV’s return is null, compare with zero.',

  'builder.templateCryptoTrendTitle': 'Crypto trend with cash',
  'builder.templateCryptoTrendLine':
    'Holds BTC, ETH and SOL while each has risen over recent weeks, and cash otherwise.',
  'builder.templateCryptoTrendPrompt':
    'Hold BTC, ETH and SOL at 15% each, and keep the rest in cash. Hold cash in place of any of them whose return over the last twenty trading days is zero or below, or that fell more than 10% over the last five trading days. While a symbol has no return over the last twenty trading days yet, judge it by its return over the last five, and while it has neither, hold cash in its place.',

  'builder.templatePullbacksTitle': 'Pullbacks in big tech',
  'builder.templatePullbacksLine': 'Holds big tech names that dipped over recent days while rising over recent weeks.',
  'builder.templatePullbacksPrompt':
    'Each round, from AAPL, MSFT, GOOGL, AMZN, META and NVDA, take the names whose return over the last twenty trading days is above zero, and of those hold the two with the lowest return over the last five trading days, at 15% each. Hold SPY at 30% and keep the rest in cash. When fewer than two names are left, hold cash in place of each missing one. Leave out any name whose return over the last twenty or the last five trading days is null.',

  'builder.templateStrengthTiltTitle': 'Big tech tilted to strength',
  'builder.templateStrengthTiltLine': 'Holds the big tech names, with more weight on those that rose more than SPY.',
  'builder.templateStrengthTiltPrompt':
    'Hold AAPL, MSFT, GOOGL, AMZN, META and NVDA, and keep the rest in cash. Each round, hold at 12% each name whose return over the last twenty trading days is above SPY’s return over the same days, and at 6% each of the others. While SPY’s return or a name’s return over the last twenty trading days is null, hold that name at 6%.',

  'builder.templateBandedMixTitle': 'Mixed assets with bands',
  'builder.templateBandedMixLine':
    'Holds stocks, SGOV and crypto at set weights, and changes a holding only past a band.',
  'builder.templateBandedMixPrompt':
    'Hold SPY at 30%, QQQ at 15%, SGOV at 30%, BTC at 8% and ETH at 5%, and keep the rest in cash. Change a holding only when it has moved away from its weight by more than a fifth of that weight. When BTC and ETH together are more than 18% of the portfolio, bring both back to their weights in the same round. Leave a halted symbol as it is and change the others.',

  'builder.templateChipsBrakeTitle': 'Chips with a brake',
  'builder.templateChipsBrakeLine': 'Holds NVDA, AMD, MU and INTC, and cuts any that fell sharply over recent days.',
  'builder.templateChipsBrakePrompt':
    'Hold NVDA, AMD, MU and INTC at 15% each and keep the rest in cash. Hold at 5% instead any of them that fell more than 10% over the last five trading days, or more than 4% over the last trading day. While both of those returns are null for a symbol, hold it at 15%. Change a holding only when it is more than two points away from the weight these rules give it.',
} as const satisfies Record<string, string>;
