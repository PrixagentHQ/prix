/**
 * The word list behind `name_not_allowed`. An agent name is public: it is on the league table
 * and on the agent's page. `agentNameSchema` in `packages/contracts` already refuses reserved
 * names. This list refuses abuse, and two things that are not insults but do the same harm on
 * a public table: a name that passes for a partner, and a name that promises a return.
 *
 * A filter like this is a first line, not a guarantee. What gets past it is hidden by an admin.
 *
 * The words are offensive by nature. They are here so that nobody has to read them on the site.
 */

import { UNIVERSE } from '@prix/market/universe';

/**
 * Refused wherever they appear in a name, once case, spacing and punctuation are removed.
 * Only words that do not occur inside ordinary words belong here.
 */
const BLOCKED_ANYWHERE: readonly string[] = [
  // Profanity
  'fuck',
  'shit',
  'cunt',
  'bitch',
  'asshole',
  'arsehole',
  'bastard',
  'wanker',
  'bollocks',
  'whore',
  'slut',
  'jizz',
  'pussy',
  'penis',
  'vagina',
  'porn',
  'blowjob',
  'handjob',
  'cumshot',
  'dildo',
  // Slurs
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'tranny',
  'wetback',
  'towelhead',
  'sandnigg',
  'chingchong',
  // Hate and violence
  'hitler',
  'nazi',
  'whitepower',
  'heilhitler',
  'siegheil',
  'gasthejews',
  'killyourself',
  'rapist',
  'pedophile',
  'paedophile',
  'molest',
  'terrorist',
  'jihad',
  // Passing for a partner
  'robinhood',
  'chainlink',
  // Promising a return, or advice
  'guarantee',
  'riskfree',
  'norisk',
  'cantlose',
  'getrich',
  'freemoney',
  'financialadvice',
  'investmentadvice',
  'notascam',
  // Advice or a promise on the board, the home page's first screen (D-147)
  'buynow',
  'mustbuy',
  'tothemoon',
];

/**
 * Refused as one word or as a run of whole words, so "All In", "All-In Tech", "AllIn Fund" and
 * "Sell Now" are caught, while "Small Index", "Falling Knife" and "Russell Nowcast" are not.
 * Words are split at spaces, punctuation and a lower-case letter before a capital.
 */
const BLOCKED_PHRASES: ReadonlySet<string> = new Set([
  'allin',
  'sellnow',
  'strongbuy',
  'strongsell',
  'doubleyourmoney',
  'sureprofit',
  'surewin',
  // Promises found passing in the second review (2026-10-14)
  'zerorisk',
  'noloss',
  'neverlose',
  'easymoney',
  'safebet',
  'surething',
  'uponly',
  'onlyup',
  'millionairemaker',
  'passiveincome',
  'profiteveryday',
  // Labels only Prix could give an agent
  'editorspick',
  'toppick',
]);

/** An order, as a whole word. "Load" is here so that "Load Up NVDA" reads as the order it is. */
const ORDER_WORDS: ReadonlySet<string> = new Set(['buy', 'sell', 'long', 'short', 'dump', 'ape', 'load']);

/** How far, in words, a target may stand from an order word: "Buy The NVDA Dip". */
const ORDER_REACH = 2;

/** First words of a universe name that name no company: "Strategy Inc.", "iShares 0-3 Month ...". */
const GENERIC_FIRST_WORDS: ReadonlySet<string> = new Set(['strategy', 'space', 'united', 'ishares', 'invesco']);

/** A token's common name: the first word of its name in the market package, "Tesla", "NVIDIA". */
function commonName(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * What an order word is refused near: every symbol of the league's universe and its common name,
 * read from the market package and never typed here, and "everything" and "all". "Buy NVDA",
 * "Buy Tesla" and "Sell All" read as advice on the board; "Buy And Hold" and "Sell In May" do not.
 */
const ORDER_TARGETS: ReadonlySet<string> = new Set([
  ...UNIVERSE.map((token) => token.symbol.toLowerCase()),
  ...UNIVERSE.map((token) => commonName(token.name)).filter((word) => word !== '' && !GENERIC_FIRST_WORDS.has(word)),
  'everything',
  'all',
]);

/** A promised multiple of the money put in, as a whole word: "10x", "50X". "Top 100" is not one. */
const MULTIPLE = /^[0-9]+x$/;

/** Words that multiply "your money" besides a multiple: "Double Your Money", "Triple Your Money". */
const MULTIPLIER_WORDS: ReadonlySet<string> = new Set(['double', 'triple', 'quadruple']);

/**
 * Refused only as a whole word. Each of these sits inside ordinary words, several of them
 * words of finance: "analyst", "asset", "tycoon", "grape", "title", "Essex", "cockpit".
 */
const BLOCKED_WORDS: readonly string[] = [
  'ass',
  'arse',
  'anal',
  'anus',
  'cum',
  'tit',
  'tits',
  'boob',
  'boobs',
  'sex',
  'xxx',
  'nude',
  'nudes',
  'milf',
  'cock',
  'cocks',
  'dick',
  'dicks',
  'prick',
  'wank',
  'twat',
  'fag',
  'fags',
  'homo',
  'dyke',
  'tard',
  'spic',
  'coon',
  'gook',
  'kike',
  'chink',
  'paki',
  'negro',
  'beaner',
  'pedo',
  'paedo',
  'rape',
  'raped',
  'raper',
  'raping',
  'heil',
  'kkk',
  'kys',
  'isis',
  '1488',
];

/** Digits and letters that stand in for a letter, two ways for the digit one. */
const LOOKALIKES: readonly Readonly<Record<string, string>>[] = [
  { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g' },
  { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g' },
];

const BLOCKED_WORD_SET = new Set(BLOCKED_WORDS);

/**
 * Product labels, refused as a whole word anywhere in a name (docs/CONTRACTS.md section 17.1).
 * "House" is the chip on every card, row and feed item of an agent Prix runs, so "House Momentum"
 * would pass for one. Inside a word it stays allowed: "Lighthouse", "Warehouse".
 */
const LABEL_WORDS: ReadonlySet<string> = new Set([
  'house',
  // The token's launchpad: "Pons Picks".
  'pons',
  // Labels only Prix could give an agent.
  'verified',
  'featured',
  'recommended',
]);

/** The spellings of a lower-case text that are checked: as written, with look-alikes replaced, and with long runs cut. */
function spellings(text: string): string[] {
  const forms = new Set<string>([text]);
  for (const map of LOOKALIKES) forms.add(text.replace(/[0-9]/g, (digit) => map[digit] ?? digit));
  for (const form of [...forms]) forms.add(form.replace(/(.)\1{2,}/g, '$1'));
  return [...forms];
}

/** True for a name that must not be shown in public. The caller answers `name_not_allowed`. */
export function isBlockedName(name: string): boolean {
  const lower = name.toLowerCase();
  const joined = lower.replace(/[^a-z0-9]/g, '');
  if (MULTIPLE.test(joined)) return true;
  // The product's own name and its staff, with look-alike letters folded (l as i, digits as letters).
  for (const map of LOOKALIKES) {
    const folded = joined.replace(/[0-9]/g, (digit) => map[digit] ?? digit).replace(/l/g, 'i');
    // "prix" anywhere, as the contract's `isReservedAgentName` reads the plain key: "Run By Pr1x".
    if (folded.includes('prix') || folded === 'pons' || folded === 'house') return true;
  }
  for (const form of spellings(joined)) {
    if (BLOCKED_WORD_SET.has(form)) return true;
    if (BLOCKED_ANYWHERE.some((word) => form.includes(word))) return true;
  }
  for (const word of lower.split(/[^a-z0-9]+/)) {
    if (word === '') continue;
    if (MULTIPLE.test(word)) return true;
    // A plain number is read as a number: "455" is not a spelling of anything.
    const forms = /^[0-9]+$/.test(word) ? [word] : spellings(word);
    if (forms.some((form) => BLOCKED_WORD_SET.has(form) || LABEL_WORDS.has(form))) return true;
  }
  return hasBlockedPhrase(name);
}

/**
 * True when one word, or a run of whole words joined, spells a phrase of `BLOCKED_PHRASES`; when
 * an order word stands with "now" anywhere in the name; when the name is one order word repeated;
 * when a word is a multiple ("50x") or a multiplier stands before "your money"; or when an order
 * word stands up to `ORDER_REACH` words from a target of `ORDER_TARGETS`.
 */
function hasBlockedPhrase(name: string): boolean {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
  const isOrder = (word: string | undefined): boolean =>
    word !== undefined && spellings(word).some((form) => ORDER_WORDS.has(form));
  const isTarget = (word: string | undefined): boolean =>
    word !== undefined && spellings(word).some((form) => ORDER_TARGETS.has(form));
  const hasOrder = words.some((word) => isOrder(word));
  if (hasOrder && words.some((word) => spellings(word).includes('now'))) return true;
  // A name made only of one order word said again: "Buy Buy Buy".
  if (words.length > 1 && isOrder(words[0]) && words.every((word) => word === words[0])) return true;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    // A multiple, also where a lower-case letter met a capital: "50xGains".
    if (MULTIPLE.test(word)) return true;
    if (MULTIPLIER_WORDS.has(word) && words[index + 1] === 'your' && words[index + 2] === 'money') return true;
    if (!isOrder(word)) continue;
    for (let offset = 1; offset <= ORDER_REACH; offset += 1) {
      if (isTarget(words[index - offset]) || isTarget(words[index + offset])) return true;
    }
  }
  for (let start = 0; start < words.length; start += 1) {
    let run = '';
    for (let end = start; end < words.length; end += 1) {
      run += words[end];
      if (spellings(run).some((form) => BLOCKED_PHRASES.has(form))) return true;
    }
  }
  return false;
}
