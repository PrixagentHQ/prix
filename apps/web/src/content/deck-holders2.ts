import type { HOLDERS2_PAGE_WORDS } from '@prix/contracts';

/**
 * The holders' second wave (Phase 6.8, docs/contracts/phase-6-holders-2.md section 7): the Holder mark
 * and the day caps by holding in the Community chat, the lounge block on /following, and the decision
 * tape on /tape. `editor` owns this file; `deck.ts` spreads it. The one key this wave changes in the
 * Community chat's own words, `social.roomRefusalWalletDay`, stays in deck-social.ts.
 *
 * Every string is the contract's `HOLDERS2_PAGE_WORDS`, word for word: a change is a contract revision.
 * The type below fails to compile when a string here and the contract's differ.
 *
 * What these strings keep to:
 * - Holding gives access to a feature, never a return. A sentence names whole $PRIX, never a share of
 *   the supply, a price or a value, and never asks anyone to acquire the token.
 * - The mark is "Holder" and nothing more: no tier, no figure, never "verified".
 * - The lounge is a place to talk about Prix, never a source of trade calls or advice.
 * - The tape shows records of paper decisions. No rank, no good or bad, and the not-advice line on
 *   every view. Holders see a decision when it is made; others see it a day later; an agent linked to
 *   Prix Live is held until 20:00 UTC for everyone.
 *
 * Slots: `{count}` in `tape.scale` is TAPE_ROWS, the most decisions the tape shows.
 */

type OwnKey = Exclude<keyof typeof HOLDERS2_PAGE_WORDS, 'social.roomRefusalWalletDay'>;
type OwnWords = { readonly [K in OwnKey]: (typeof HOLDERS2_PAGE_WORDS)[K] };

export const holders2Strings = {
  // The Community chat (section 2): the mark beside a holder's short address, and the caps by holding,
  // under the composer exactly when `me` answers `dayCap`.
  'social.roomHolderMark': 'Holder',
  'social.roomHolderMarkLabel': 'This wallet holds $PRIX, as Prix last read it.',
  'social.roomDayCaps':
    'A wallet writes up to 30 messages a day, 60 from 10,000 $PRIX, 90 from 100,000 and 120 from 1,000,000.',

  // The lounge block on /following, below the follow alerts' Telegram settings (section 4.7).
  'lounge.title': 'Prix Community on Telegram',
  'lounge.description':
    'Prix’s Community group on Telegram. A new member joins by a request that @PrixagentBot approves when the wallet linked to their Telegram account holds at least 10,000 $PRIX. It is a place to talk about Prix, never a source of trade calls or advice.',
  'lounge.join': 'Ask to join',
  'lounge.joinNote':
    'Telegram sends your request to @PrixagentBot, which lets you in when the wallet linked to your Telegram account holds at least 10,000 $PRIX.',
  'lounge.linkFirst': 'Link Telegram on this page first. The bot lets in the Telegram account linked to this wallet.',
  'lounge.notHolder':
    'A new member joins Prix Community on Telegram with a wallet that holds at least 10,000 $PRIX. A new holding counts about an hour after Prix first sees it.',
  'lounge.leaving':
    'Once a day Prix reads every member’s wallet again. A member whose wallet holds less than 10,000 $PRIX, or whose Telegram account is no longer linked to it, is removed and may ask to join again later.',

  // The decision tape, /tape (section 3.2), and its one link from /league.
  'tape.title': 'Decision tape',
  'tape.description':
    'Every agent’s newest decisions in one place: what each paper portfolio changed and the reason its agent gave, newest first.',
  'tape.viewLive': 'Your wallet holds at least 10,000 $PRIX, so paper decisions show here when they are made.',
  'tape.viewDelayed':
    'Decisions appear here 24 hours after they are made. A wallet that holds at least 10,000 $PRIX sees them as they are made.',
  'tape.viewOpen': 'Decisions appear here as they are made.',
  'tape.liveHold':
    'An agent linked to Prix Live shows each day’s decisions from 20:00 UTC, for everyone, holders included.',
  'tape.notAdvice':
    'These are decisions of AI agents that run paper portfolios. Reasons are written by a model from each owner’s strategy. Nothing here is advice.',
  'tape.scale': 'Each agent decides at most a few times a day, so the newest {count} decisions reach back a few days.',
  'tape.empty': 'No decision to show yet.',
  'tape.fromLeague': 'See every agent’s newest decisions on the tape',
} as const satisfies OwnWords;
