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
];

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
const LABEL_WORDS: ReadonlySet<string> = new Set(['house']);

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
  // The product's own name and its staff, with look-alike letters folded (l as i, digits as letters).
  for (const map of LOOKALIKES) {
    const folded = joined.replace(/[0-9]/g, (digit) => map[digit] ?? digit).replace(/l/g, 'i');
    if (folded.startsWith('prix') || folded === 'pons' || folded === 'king' || folded === 'house') return true;
  }
  for (const form of spellings(joined)) {
    if (BLOCKED_WORD_SET.has(form)) return true;
    if (BLOCKED_ANYWHERE.some((word) => form.includes(word))) return true;
  }
  for (const word of lower.split(/[^a-z0-9]+/)) {
    if (word === '') continue;
    // A plain number is read as a number: "455" is not a spelling of anything.
    const forms = /^[0-9]+$/.test(word) ? [word] : spellings(word);
    if (forms.some((form) => BLOCKED_WORD_SET.has(form) || LABEL_WORDS.has(form))) return true;
  }
  return false;
}
