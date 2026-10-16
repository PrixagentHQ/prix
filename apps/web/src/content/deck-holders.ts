/**
 * The holders' poll, /polls (D-158 C, docs/contracts/phase-6-holders.md sections 4.5 and 8). `editor` owns
 * this file; `deck.ts` spreads it. Every string here is the contract's HOLDERS_COPY word for word: a change
 * is a contract revision, and holders.test.ts beside this file fails on any difference.
 *
 * What these strings keep to:
 * - It is the "Holders' poll", never "governance", a "DAO" or a "vote on the token", and a result is
 *   "Chosen", never a "winner".
 * - The options are strategies Prix writes for a paper Model War. Nothing here is advice, and holding $PRIX
 *   gives access to features, never a return.
 * - A vote counts only if its wallet still holds when Prix counts the votes after the close, so the page
 *   labels the count before the close "votes cast" and the result after it "counted".
 * - The poll's question and its options' names come from HOLDER_POLLS, never from this deck.
 *
 * Slots the page fills: `{amount}` the tier-1 threshold in whole tokens (`minTokens` of GET /api/polls),
 * `{time}` a time as formatTick writes it, `{count}` a number of votes, `{option}` and `{options}` the
 * options' names from HOLDER_POLLS.
 *
 * The words of /admin/holders sit in the `admin` area of deck.ts, as the contract asks. Their keys are
 * listed below in ADMIN_HOLDERS_KEYS, so that holders.test.ts can hold them to the rules of section 8.
 */
export const holdersStrings = {
  'polls.title': "Holders' poll",
  'polls.lead':
    'Holders choose between options Prix writes for its paper league. A wallet has one vote, which it can change until the close, and it counts only if the wallet still holds at least {amount} $PRIX when Prix counts the votes after the close.',
  'polls.closesAt': 'Closes {time} UTC',
  'polls.closedAt': 'Closed {time} UTC',
  'polls.castCount': '{count} votes cast',
  'polls.castCountOne': '1 vote cast',
  'polls.castNote':
    'Votes cast so far. A vote counts only if its wallet still holds at least {amount} $PRIX when Prix counts the votes after the close. Once an hour, Prix may remove the votes of wallets that no longer hold it.',
  'polls.counting': 'Closed. The votes are being counted.',
  'polls.countFailed': 'The count could not be completed; Prix will say what happens.',
  'polls.prixWallets': "Prix's own wallets do not vote.",
  'polls.countedCount': '{count} counted',
  'polls.countedCountOne': '1 counted',
  'polls.countedNote':
    'Counted from wallets that still held at least {amount} $PRIX when Prix counted, after the close ({time} UTC).',
  'polls.chosen': 'Chosen: {option}',
  'polls.tie': 'A tie between {options}. Prix picks one of them and says which in its posts.',
  'polls.noneCounted': 'No vote was counted.',
  'polls.optionLink': 'See the agent',
  'polls.vote': 'Vote for this one',
  'polls.yourVote': 'Your vote',
  'polls.changeNote': 'You can change your vote until the poll closes.',
  'polls.signIn': 'Sign in to vote',
  'polls.needTokens':
    'Voting needs at least {amount} $PRIX in the signed-in wallet. A new holding counts about an hour after Prix first sees it.',
  'polls.gateOff': 'Voting opens when $PRIX tiers are on.',
  'polls.saved': 'Vote saved.',
  'polls.refusedClosed': 'This poll is closed.',
  'polls.refusedNotOpen': 'This poll is not open yet.',
  'polls.refusedFull': 'This poll is full for now. Try again in an hour.',
  'polls.refusedUnknownOption': 'That option is not part of this poll. Reload the page.',
  'polls.refusedRateLimited': 'Too many requests. Wait a minute and try again.',
  'polls.failed': 'Your vote was not saved. Try again.',
  'polls.notAdvice':
    'The options are strategies Prix wrote for a paper Model War. Nothing here is investment advice, and holding $PRIX gives access to features, never a return.',
  'polls.closedTitle': 'Closed polls',
  'polls.noneOpen': 'No poll is open right now.',
  'polls.loadFailed': 'The poll did not load. Reload the page to try again.',
  'polls.navLink': "Holders' poll",
} as const satisfies Record<string, string>;

/**
 * The keys of /admin/holders (web-account, `apps/web/src/account/admin/holders/**`), whose strings are in the
 * `admin` area of deck.ts. A page reads each with a literal `text(` call, as the copy gate asks.
 *
 * - The tally's outcomes: `admin.holdersTally<Outcome>` for each outcome of pollTallyOutcomeSchema (Done,
 *   Already, Waiting, Open, Failed); `admin.holdersTallyFailed` names the step in `{step}`, one of
 *   `admin.holdersTallyStep<Step>` for each of POLL_TALLY_FAIL_STEPS (Results, List, Read, Block, Write).
 * - The webhook's three fields: `admin.holdersWebhookUrl`, `admin.holdersWebhookPending` and
 *   `admin.holdersWebhookLastError`, with `admin.holdersWebhookNone` for an empty error.
 * - The webhook's watch: `admin.holdersWatchMoved` names the time in `{time}`.
 */
export const ADMIN_HOLDERS_KEYS = [
  'admin.holdersTitle',
  'admin.holdersDescription',
  'admin.holdersIntro',
  'admin.holdersWebhookTitle',
  'admin.holdersWebhookIntro',
  'admin.holdersWebhookSet',
  'admin.holdersWebhookSetting',
  'admin.holdersWebhookDoneTitle',
  'admin.holdersWebhookDoneBody',
  'admin.holdersWebhookFailedTitle',
  'admin.holdersWebhookFailedBody',
  'admin.holdersWebhookUrl',
  'admin.holdersWebhookPending',
  'admin.holdersWebhookLastError',
  'admin.holdersWebhookNone',
  'admin.holdersWatchTitle',
  'admin.holdersWatchQuiet',
  'admin.holdersWatchMoved',
  'admin.holdersWatchFailed',
  'admin.holdersTallyTitle',
  'admin.holdersTallyIntro',
  'admin.holdersTallyNoPoll',
  'admin.holdersTallyRun',
  'admin.holdersTallyRunning',
  'admin.holdersTallyDone',
  'admin.holdersTallyAlready',
  'admin.holdersTallyWaiting',
  'admin.holdersTallyOpen',
  'admin.holdersTallyFailed',
  'admin.holdersTallyStepResults',
  'admin.holdersTallyStepList',
  'admin.holdersTallyStepRead',
  'admin.holdersTallyStepBlock',
  'admin.holdersTallyStepWrite',
  'admin.holdersTallyRequestFailed',
] as const;
