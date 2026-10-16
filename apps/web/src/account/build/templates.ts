import { text } from '../../content/index.ts';

/**
 * The strategy templates of the Build page (D-155): Prix's own starting texts, in the spirit of
 * the house agents. A template is a title, one line that says what it does (never how well: no
 * return, no rank, no figure), and the prompt it puts in the field. Every word is the deck's
 * (apps/web/src/content/deck-templates.ts), in the order of its `BUILD_TEMPLATE_IDS`.
 *
 * Server only: this file reads the copy deck and must not reach a browser script. The page renders
 * each prompt into an attribute, which Astro escapes, and the script reads it back as plain text.
 */

export interface StrategyTemplate {
  /** A stable name for the template, for the page and its tests. Never shown. */
  id: string;
  title: string;
  line: string;
  prompt: string;
}

export function strategyTemplates(): StrategyTemplate[] {
  return [
    {
      id: 'big-tech',
      title: text('builder.templateBigTechTitle', 'Equal-weight big tech'),
      line: text(
        'builder.templateBigTechLine',
        'Holds AAPL, MSFT, GOOGL, AMZN, META and NVDA in equal parts, with the rest in cash.',
      ),
      prompt: text(
        'builder.templateBigTechPrompt',
        'Hold AAPL, MSFT, GOOGL, AMZN, META and NVDA at 14% each and keep the rest in cash. Change a holding only when it is more than three points away from 14%.',
      ),
    },
    {
      id: 'index-core',
      title: text('builder.templateIndexCoreTitle', 'Index core with cash'),
      line: text(
        'builder.templateIndexCoreLine',
        'Holds SPY and QQQ as a core and keeps cash above a set part of the portfolio.',
      ),
      prompt: text(
        'builder.templateIndexCorePrompt',
        'Hold SPY at 35% and QQQ at 25%, and keep the rest in cash. Never let cash fall below 40% of the portfolio. Change a holding only when it is more than three points away from the weight given here.',
      ),
    },
    {
      id: 'semis',
      title: text('builder.templateSemisTitle', 'Semiconductor basket'),
      line: text('builder.templateSemisLine', 'Holds NVDA, AMD, MU and INTC in equal parts, with the rest in cash.'),
      prompt: text(
        'builder.templateSemisPrompt',
        'Hold NVDA, AMD, MU and INTC at 20% each and keep the rest in cash. Change a holding only when it is more than three points away from 20%.',
      ),
    },
    {
      id: 'down-days',
      title: text('builder.templateDownDaysTitle', 'Adding on down days, capped'),
      line: text(
        'builder.templateDownDaysLine',
        'Holds a core of SPY and adds to it after a down day, up to a set cap.',
      ),
      prompt: text(
        'builder.templateDownDaysPrompt',
        'Hold SPY at 25% and keep the rest in cash. After a trading day on which SPY fell more than 2%, raise SPY by five points, to at most 40%. Once SPY’s return over the last five trading days is above zero again, bring it back to 25%.',
      ),
    },
    {
      id: 'momentum',
      title: text('builder.templateMomentumTitle', 'Capped momentum'),
      line: text(
        'builder.templateMomentumLine',
        'Holds the symbols that rose most over recent trading days, each under a cap.',
      ),
      prompt: text(
        'builder.templateMomentumPrompt',
        'Each round, hold the four symbols with the highest return over the last five trading days, at 15% each, and keep the rest in cash. Never hold more than 15% of the portfolio in one symbol. Never hold SGOV or USO. While no return is known yet, hold cash only.',
      ),
    },
    {
      id: 'treasury',
      title: text('builder.templateTreasuryTitle', 'Mostly SGOV and cash'),
      line: text(
        'builder.templateTreasuryLine',
        'Keeps most of the portfolio in SGOV and cash, with a small part in SPY.',
      ),
      prompt: text(
        'builder.templateTreasuryPrompt',
        'Keep 40% in SGOV at all times. Hold SPY at 15% and keep the rest in cash. Change a holding only when it is more than three points away from the weight given here.',
      ),
    },
    {
      id: 'crypto-proxies',
      title: text('builder.templateCryptoProxiesTitle', 'Crypto proxy stocks'),
      line: text(
        'builder.templateCryptoProxiesLine',
        'Holds COIN, MSTR and CRCL in equal parts, and moves any that drop sharply to cash.',
      ),
      prompt: text(
        'builder.templateCryptoProxiesPrompt',
        'Hold COIN, MSTR and CRCL at 20% each and keep the rest in cash. If one of them fell more than 8% over the last trading day, hold cash in its place until the next round.',
      ),
    },
    {
      id: 'btc-eth',
      title: text('builder.templateBtcEthTitle', 'Bitcoin and Ethereum'),
      line: text('builder.templateBtcEthLine', 'Holds BTC and ETH at set weights and keeps the rest in cash.'),
      prompt: text(
        'builder.templateBtcEthPrompt',
        'Hold BTC at 25% and ETH at 15%, and keep the rest in cash. Change a holding only when it is more than five points away from the weight given here.',
      ),
    },
  ];
}

/**
 * The holder templates of the Build page (D-161): eight more starting texts, more involved than the
 * first eight, for a signed-in wallet at tier 1 or above. The page renders them only when the
 * server's read of the session's entitlements says so (BuildPage.astro); every other page holds
 * neither their titles nor their texts. Each follows the rules of the first set, and reads only
 * what an agent's decision call is given (packages/runtime/src/prompts.ts): the returns of each
 * symbol over 1, 5 and 20 trading days, the halted symbols, and the portfolio's cash and weights.
 * None relies on a moving average, a volatility, a drawdown or anything the agent does not see.
 */
export function holderTemplates(): StrategyTemplate[] {
  return [
    {
      id: 'group-rotation',
      title: text('builder.templateGroupRotationTitle', 'Rotation across groups'),
      line: text(
        'builder.templateGroupRotationLine',
        'Holds the group of stocks that rose most over recent weeks, with SPY beside it.',
      ),
      prompt: text(
        'builder.templateGroupRotationPrompt',
        'Each round, work out the average return over the last twenty trading days of each of these groups: chips (NVDA, AMD, MU, INTC), platforms (AAPL, MSFT, GOOGL, AMZN, META) and crypto stocks (COIN, MSTR, CRCL). Hold the members of the group with the highest average in equal parts that add up to 40%, hold SPY at 20%, and keep the rest in cash. Leave out of an average any symbol whose return over the last twenty trading days is null. While no group has a known return, hold SPY at 20% and keep the rest in cash.',
      ),
    },
    {
      id: 'index-trend',
      title: text('builder.templateIndexTrendTitle', 'Index trend switch'),
      line: text(
        'builder.templateIndexTrendLine',
        'Holds SPY and QQQ while SPY has risen over recent weeks, and SGOV while it has not.',
      ),
      prompt: text(
        'builder.templateIndexTrendPrompt',
        'While SPY’s return over the last twenty trading days is above zero, hold SPY at 35% and QQQ at 25%, and keep the rest in cash. While that return is zero or below, or still null, hold SGOV at 40% and keep the rest in cash. Change a holding only when it is more than three points away from the weight given here.',
      ),
    },
    {
      id: 'dual-momentum',
      title: text('builder.templateDualMomentumTitle', 'Strongest leader, or SGOV'),
      line: text(
        'builder.templateDualMomentumLine',
        'Holds the one of SPY, QQQ and BTC that rose most over recent weeks, or SGOV.',
      ),
      prompt: text(
        'builder.templateDualMomentumPrompt',
        'Each round, compare the returns over the last twenty trading days of SPY, QQQ and BTC. Hold the one with the highest return at 40% if that return is above SGOV’s return over the same days, and otherwise hold SGOV at 40%. Keep the rest in cash. Leave out any symbol whose return over the last twenty trading days is null, and while SGOV’s return is null, compare with zero.',
      ),
    },
    {
      id: 'crypto-trend',
      title: text('builder.templateCryptoTrendTitle', 'Crypto trend with cash'),
      line: text(
        'builder.templateCryptoTrendLine',
        'Holds BTC, ETH and SOL while each has risen over recent weeks, and cash otherwise.',
      ),
      prompt: text(
        'builder.templateCryptoTrendPrompt',
        'Hold BTC, ETH and SOL at 15% each, and keep the rest in cash. Hold cash in place of any of them whose return over the last twenty trading days is zero or below, or that fell more than 10% over the last five trading days. While a symbol has no return over the last twenty trading days yet, judge it by its return over the last five, and while it has neither, hold cash in its place.',
      ),
    },
    {
      id: 'pullbacks',
      title: text('builder.templatePullbacksTitle', 'Pullbacks in big tech'),
      line: text(
        'builder.templatePullbacksLine',
        'Holds big tech names that dipped over recent days while rising over recent weeks.',
      ),
      prompt: text(
        'builder.templatePullbacksPrompt',
        'Each round, from AAPL, MSFT, GOOGL, AMZN, META and NVDA, take the names whose return over the last twenty trading days is above zero, and of those hold the two with the lowest return over the last five trading days, at 15% each. Hold SPY at 30% and keep the rest in cash. When fewer than two names are left, hold cash in place of each missing one. Leave out any name whose return over the last twenty or the last five trading days is null.',
      ),
    },
    {
      id: 'strength-tilt',
      title: text('builder.templateStrengthTiltTitle', 'Big tech tilted to strength'),
      line: text(
        'builder.templateStrengthTiltLine',
        'Holds the big tech names, with more weight on those that rose more than SPY.',
      ),
      prompt: text(
        'builder.templateStrengthTiltPrompt',
        'Hold AAPL, MSFT, GOOGL, AMZN, META and NVDA, and keep the rest in cash. Each round, hold at 12% each name whose return over the last twenty trading days is above SPY’s return over the same days, and at 6% each of the others. While SPY’s return or a name’s return over the last twenty trading days is null, hold that name at 6%.',
      ),
    },
    {
      id: 'banded-mix',
      title: text('builder.templateBandedMixTitle', 'Mixed assets with bands'),
      line: text(
        'builder.templateBandedMixLine',
        'Holds stocks, SGOV and crypto at set weights, and changes a holding only past a band.',
      ),
      prompt: text(
        'builder.templateBandedMixPrompt',
        'Hold SPY at 30%, QQQ at 15%, SGOV at 30%, BTC at 8% and ETH at 5%, and keep the rest in cash. Change a holding only when it has moved away from its weight by more than a fifth of that weight. When BTC and ETH together are more than 18% of the portfolio, bring both back to their weights in the same round. Leave a halted symbol as it is and change the others.',
      ),
    },
    {
      id: 'chips-brake',
      title: text('builder.templateChipsBrakeTitle', 'Chips with a brake'),
      line: text(
        'builder.templateChipsBrakeLine',
        'Holds NVDA, AMD, MU and INTC, and cuts any that fell sharply over recent days.',
      ),
      prompt: text(
        'builder.templateChipsBrakePrompt',
        'Hold NVDA, AMD, MU and INTC at 15% each and keep the rest in cash. Hold at 5% instead any of them that fell more than 10% over the last five trading days, or more than 4% over the last trading day. While both of those returns are null for a symbol, hold it at 15%. Change a holding only when it is more than two points away from the weight these rules give it.',
      ),
    },
  ];
}

/**
 * The words around the holder templates: the title and hint over them, for a wallet at tier 1 or
 * above, and for every other reader one quiet line and a link to the token page, which name no
 * holder template. The lock is the server's read, never a flag of the page.
 */
export function holderTemplateWords() {
  return {
    title: text('builder.templatesHolderTitle', 'Templates for holders'),
    hint: text(
      'builder.templatesHolderHint',
      'For wallets holding 10,000 $PRIX or more. Each sets more rules for the agent than a template above, and the league’s limits are the same for every agent.',
    ),
    locked: text('builder.templatesHolderLocked', 'Eight more templates for wallets holding 10,000 $PRIX.'),
    lockedLink: text('builder.templatesHolderLockedLink', 'How the tiers work'),
  };
}

/**
 * The section's own words, and the sentences its script shows. The script holds no words of its
 * own. `use`, `filled`, `consequence`, `consequenceSignedOut`, `kept` and `notKept` keep their
 * `{title}` slot: the page
 * fills `use` for each button, and the script fills the others with the chosen template's title.
 */
export function templateWords() {
  return {
    title: text('builder.templatesTitle', 'Start from a template'),
    hint: text(
      'builder.templatesHint',
      'Choosing one puts its text in the strategy prompt. You can change every word before you build the agent.',
    ),
    note: text('builder.templatesNote', 'A template is a starting text, not advice.'),
    use: text('builder.templateUse', 'Use the template {title}'),
    question: text('builder.templateReplaceTitle', 'Replace your text?'),
    consequence: text(
      'builder.templateReplaceBody',
      'The strategy prompt holds text you wrote. The template {title} takes its place, and your text is not kept.',
    ),
    // Signed out no strategy prompt is on the page: the question speaks of the text kept for it.
    consequenceSignedOut: text(
      'builder.templateReplaceBodySignedOut',
      'The text kept for your strategy prompt is text you wrote. The template {title} takes its place, and your text is not kept.',
    ),
    replace: text('builder.templateReplaceConfirm', 'Replace my text'),
    keep: text('builder.templateReplaceCancel', 'Keep my text'),
    filled: text('builder.templateAdded', 'The template {title} is in the strategy prompt. Edit it as you like.'),
    // Signed out: a choice is kept in this tab's builder draft, for the field after the sign-in.
    hintSignedOut: text(
      'builder.templatesHintSignedOut',
      'Choosing one keeps its text for the strategy prompt, ready after you sign in. You can change every word before you build the agent.',
    ),
    kept: text('builder.templateKept', '{title} is ready for the strategy prompt.'),
    // The status line's link after `kept`: it carries the next step, so the sentence does not (DC3-2).
    keptSignIn: text('builder.templateKeptSignIn', 'Sign in to continue'),
    notKept: text(
      'builder.templateNotKept',
      '{title} could not be kept in this browser. Sign in, then choose it again.',
    ),
  };
}
