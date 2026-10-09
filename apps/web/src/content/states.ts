import type {
  ApiErrorCode,
  Division,
  MarketClosedReason,
  NoDecisionCode,
  PausedReason,
  RowStatus,
  SkipCode,
  SummaryStatus,
  UnrankedReason,
} from '@prix/contracts';
import { deckText } from './deck.ts';
import { facts, grouped, inWords, links } from './facts.ts';

/**
 * One sentence for every code a page can show. `editor` owns the wording.
 * Each record is exhaustive: a new code does not compile until it has a sentence.
 *
 * A sentence that anyone may read says what happened, in the past tense, as a record.
 * Where the owner of the agent can act, a second function gives the owner's next step.
 * A page shows that second sentence to the owner only: on the account page, never in public.
 */

const MIN_DAYS = inWords(facts.minTradingDaysToRank);
const MIN_DECISIONS = inWords(facts.minDecisionsToRank);
const MAX_HALTED = inWords(facts.maxHaltedFeeds);
const KEY_FAILURES = inWords(facts.keyFailuresToPause);
const MAX_OPEN = grouped(facts.maxAgentsOpen);
const MAX_PRO = grouped(facts.maxAgentsPro);

const UNCHANGED = 'so the portfolio was left unchanged';
const ASKED_AGAIN = 'The agent is asked again at its next turn.';
const IF_IT_REPEATS = 'If this keeps happening, shorten your prompt or, for a Pro agent, use a different model.';
const NOTHING_TO_DO =
  'You do not need to do anything. At its next turn, a skipped agent is asked before the agents that were asked this time.';
const PAUSE_WARNING = `After ${KEY_FAILURES} such turns in a row, Prix pauses the agent.`;

/** Why an agent that was asked made no decision. Shown in the list of decisions, to anyone. */
const NO_DECISION: Record<NoDecisionCode, string> = {
  invalid_json: `The model’s answer was not in the required format, ${UNCHANGED}.`,
  schema_mismatch: `The model’s answer could not be read as a decision, ${UNCHANGED}.`,
  unknown_symbol: `The model named a symbol that is not in the league, ${UNCHANGED}.`,
  weight_out_of_range: `The model gave a weight below 0%, above 100% or with more than two decimal places, ${UNCHANGED}.`,
  weights_exceed_100: `The model’s weights added up to more than 100%, ${UNCHANGED}.`,
  reason_invalid: `The model gave no reason with its answer, ${UNCHANGED}.`,
  provider_rejected: `The model provider rejected the owner’s key or model name, ${UNCHANGED}.`,
  provider_error: `The model provider returned an error, ${UNCHANGED}.`,
  provider_timeout: `The model did not answer in time, ${UNCHANGED}.`,
  key_unavailable: `The owner’s model key could not be read, ${UNCHANGED}.`,
};

/** What the owner can do about it. Shown to the owner only. */
const NO_DECISION_OWNER: Record<NoDecisionCode, string> = {
  invalid_json: `${ASKED_AGAIN} ${IF_IT_REPEATS}`,
  schema_mismatch: `${ASKED_AGAIN} ${IF_IT_REPEATS}`,
  unknown_symbol: 'Check that your prompt names only symbols that are in the league.',
  weight_out_of_range: 'Check that your prompt asks for weights from 0% to 100% with at most two decimal places.',
  weights_exceed_100: 'Check that the weights your prompt asks for add up to 100% or less.',
  reason_invalid: `${ASKED_AGAIN} ${IF_IT_REPEATS}`,
  provider_rejected: `Check the model key and the model name on your account page. Until your provider accepts both, every turn ends this way. ${PAUSE_WARNING}`,
  provider_error: `${ASKED_AGAIN} If this keeps happening, check your account with the provider.`,
  provider_timeout: `${ASKED_AGAIN} If this keeps happening, use a faster model.`,
  key_unavailable: `Add the model key again on your account page and choose it for your agent. ${PAUSE_WARNING}`,
};

/** Why an agent was not asked in a round. Shown in the list of decisions, to anyone. */
const SKIPPED: Record<SkipCode, string> = {
  allocation_exhausted:
    'The house model’s free daily allowance ran out before this agent’s turn, so it skipped the day and its portfolio was left unchanged.',
  not_reached: 'The round ended before this agent’s turn, so it was skipped and its portfolio was left unchanged.',
  changed_this_round:
    'The agent’s prompt or model key was changed, or the agent was resumed, after this round’s prices were read, so it was skipped and its portfolio was left unchanged.',
  internal_error:
    'A fault on Prix’s side stopped this agent’s turn, so it was skipped and its portfolio was left unchanged.',
};

/** Shown to the owner only. A skipped agent has nothing to fix. */
const SKIPPED_OWNER: Record<SkipCode, string> = {
  allocation_exhausted: NOTHING_TO_DO,
  not_reached: NOTHING_TO_DO,
  changed_this_round:
    'A change to your prompt or your model key, and a resume, take effect from the next round that starts after it, so that no strategy is set once a round’s prices are known. You do not need to do anything.',
  internal_error: `The fault is on Prix’s side and has been logged. You do not need to do anything. If it keeps happening, write to ${links.supportEmail}.`,
};

/** The short status where "Market open" normally sits. */
const MARKET_CLOSED_LABEL: Record<MarketClosedReason, string> = {
  feeds_stale: deckText('states.marketClosed'),
  rpc_unavailable: deckText('states.leaguePaused'),
  feed_invalid: deckText('states.leaguePaused'),
  held_for_review: deckText('states.leaguePaused'),
};

/** The sentence beside that status. Each says that no trades fill. */
const MARKET_CLOSED: Record<MarketClosedReason, string> = {
  feeds_stale:
    'No Stock Token price has moved for hours, as on a weekend or a stock market holiday. No round starts and no trades fill until those prices move again.',
  rpc_unavailable:
    'The league is paused because prices cannot be read from Robinhood Chain right now. No trades fill until they can be read again.',
  feed_invalid:
    'The league is paused because a price feed returned a value that cannot be trusted. No trades fill until every feed is valid again.',
  held_for_review: `The league is paused because prices held for review after a sudden move leave more than ${MAX_HALTED} symbols not trading. No trades fill until Prix has checked those prices.`,
};

/** What the rank cell says in place of a number. */
const UNRANKED_LABEL: Record<UnrankedReason, string> = {
  min_trading_days: deckText('states.notRankedYet'),
  min_decisions: deckText('states.notRankedYet'),
  inactive: deckText('states.notRanked'),
};

/** The reason, as a full sentence that is visible without a hover or a tap. */
const UNRANKED: Record<UnrankedReason, string> = {
  min_trading_days: `This agent is not ranked yet because it has fewer than ${MIN_DAYS} trading days.`,
  min_decisions: `This agent is not ranked yet because it has made fewer than ${MIN_DECISIONS} decisions.`,
  inactive: 'This agent is paused and took no part in the latest round.',
};

const PAUSED: Record<PausedReason, string> = {
  owner: 'Paused by its owner.',
  key_removed: 'Paused because its model key was deleted.',
  key_failing: `Paused because its model key or model name was not accepted in ${KEY_FAILURES} turns in a row.`,
  admin: 'Paused by Prix.',
  slot_limit: 'Paused because its owner has no free agent slot.',
};

/** Shown to the owner only. */
const PAUSED_OWNER: Record<PausedReason, string> = {
  owner: 'You paused this agent. It makes no decisions and has no rank until you resume it.',
  key_removed: 'This agent is paused because you deleted its model key. Choose another key for it and it resumes.',
  key_failing: `Prix paused this agent because your provider refused its key or model name, or the key could not be read, in ${KEY_FAILURES} turns in a row. Check both with your provider, then add a working key and choose it for the agent.`,
  admin: `Prix paused this agent, and you cannot resume it yourself. Write to ${links.supportEmail} to ask why.`,
  slot_limit: `This agent is paused because your wallet has fewer agent slots than agents. It resumes when slots return. Your slots are on /account/token.`,
};

const SUMMARY: Record<SummaryStatus, string> = {
  pending: 'A summary of this strategy is being written and appears here when it is ready.',
  ready: 'A model wrote this summary from the owner’s prompt.',
  failed: 'A summary of this strategy could not be written.',
};

/** The label of one entry in the list of decisions. A decision with no trades is "No change", from the deck. */
const ROW: Record<RowStatus, string> = {
  decided: 'Decision',
  no_decision: 'No decision',
  skipped: 'Skipped',
};

/**
 * The default sentence for an API error. A page may choose a more exact one from the deck by
 * what the person was doing, for example `errors.signInFailed`, `errors.leagueFullOpen` or
 * `errors.promptChangeLimit`. The API answers `rate_limited` both for too many requests and for
 * a prompt that was changed too often in one day, so a page that saves a prompt chooses between
 * the two sentences.
 */
const API_ERROR: Record<ApiErrorCode, string> = {
  unauthorized: 'You are not signed in, or your session has ended. Sign in to continue.',
  forbidden: 'This wallet cannot change that. Sign in with the wallet that owns it.',
  not_found: 'That page or record does not exist. Check the address, or go to the league.',
  invalid_input: 'One field was not accepted. Correct the marked field and try again.',
  rate_limited: 'Too many requests in a short time. Wait a minute and try again.',
  name_taken: 'That name is taken, or differs from a taken name only in capitals or punctuation. Choose another name.',
  name_not_allowed: 'That name is not allowed on Prix. Choose another name.',
  owner_has_agent: 'This wallet already has an agent, and each wallet can have one. Edit it on your account page.',
  league_full: `This division is full. For now the Open division takes at most ${MAX_OPEN} agents and the Pro division at most ${MAX_PRO}. Choose the other division if it has room.`,
  key_limit_reached: deckText('errors.keyLimitReached'),
  daily_limit: deckText('errors.dailyLimit'),
  no_active_season:
    'The league is not running yet, so new agents cannot join right now. The league stays readable. Try again later.',
  internal: 'Prix could not complete that because of a server fault. Try again in a minute.',
};

const DIVISION: Record<Division, string> = {
  open: deckText('common.divisionOpen'),
  pro: deckText('common.divisionPro'),
};

const DIVISION_ABOUT: Record<Division, string> = {
  open: deckText('common.divisionOpenAbout'),
  pro: deckText('common.divisionProAbout'),
};

export const noDecisionText = (code: NoDecisionCode): string => NO_DECISION[code];
export const noDecisionOwnerText = (code: NoDecisionCode): string => NO_DECISION_OWNER[code];
export const skippedText = (code: SkipCode): string => SKIPPED[code];
export const skippedOwnerText = (code: SkipCode): string => SKIPPED_OWNER[code];
export const marketClosedText = (reason: MarketClosedReason): string => MARKET_CLOSED[reason];
export const marketClosedLabel = (reason: MarketClosedReason): string => MARKET_CLOSED_LABEL[reason];
export const unrankedText = (reason: UnrankedReason): string => UNRANKED[reason];
export const unrankedLabel = (reason: UnrankedReason): string => UNRANKED_LABEL[reason];
export const pausedText = (reason: PausedReason): string => PAUSED[reason];
export const pausedOwnerText = (reason: PausedReason): string => PAUSED_OWNER[reason];
export const summaryStatusText = (status: SummaryStatus): string => SUMMARY[status];
export const rowStatusText = (status: RowStatus): string => ROW[status];
export const apiErrorText = (code: ApiErrorCode): string => API_ERROR[code];
export const divisionText = (division: Division): string => DIVISION[division];
export const divisionAboutText = (division: Division): string => DIVISION_ABOUT[division];

/** The status word for the market: "Market open", "Market closed" or "League paused". */
export function marketStatusLabel(market: { open: boolean; closedReason: MarketClosedReason | null }): string {
  if (market.open) return deckText('states.marketOpen');
  return market.closedReason ? MARKET_CLOSED_LABEL[market.closedReason] : deckText('states.marketClosed');
}

/** The one sentence for an agent's first turn, by division. A page uses it without a draft of its own. */
export const firstTurnText = (division: Division): string =>
  division === 'open' ? deckText('states.firstTurnOpen') : deckText('states.firstTurnPro');
