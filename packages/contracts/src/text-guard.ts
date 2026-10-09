/**
 * What text written by a model may not say in public: a strategy summary and the reason of a
 * decision are shown on the home page, the board and the feeds (docs/CONTRACTS.md section 17).
 * The owner's prompt steers the model, so the text is treated as hostile.
 *
 * The lists hold abuse and the claims Prix never makes: a promise of a return and advice.
 * Unlike an agent's name, a model's text may name Robinhood Chain or Chainlink: those are facts
 * of the league. Whoever applies the guard refuses the whole text; it is never edited.
 *
 * The words are offensive by nature. They are here so that nobody has to read them on the site.
 */

/** Refused wherever they appear inside a word, case and spacing aside. */
export const ABUSE_ANYWHERE: readonly string[] = [
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
  'porn',
  'blowjob',
  'handjob',
  'cumshot',
  'dildo',
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'tranny',
  'wetback',
  'towelhead',
  'chingchong',
  'hitler',
  'nazi',
  'whitepower',
  'siegheil',
  'gasthejews',
  'killyourself',
  'rapist',
  'pedophile',
  'paedophile',
  'molest',
];

/** Refused only as a whole word: each sits inside ordinary words. */
export const ABUSE_WORDS: readonly string[] = [
  'ass',
  'arse',
  'cum',
  'tits',
  'cock',
  'dick',
  'twat',
  'fag',
  'dyke',
  'spic',
  'coon',
  'gook',
  'kike',
  'chink',
  'paki',
  'rape',
  'raped',
  'raping',
  'kkk',
  'kys',
];

/**
 * A promise of a return, or advice. Matched against the text in lower case with every run of
 * characters that are not letters or digits read as one space.
 */
export const CLAIM_PATTERNS: readonly RegExp[] = [
  /\bguarantee/,
  /\brisk ?free\b/,
  /\bno risk\b/,
  /\bcan ?t lose\b/,
  /\bcannot lose\b/,
  /\bget rich\b/,
  /\bfree money\b/,
  /\bsure thing\b/,
  /\bfinancial advice\b/,
  /\binvestment advice\b/,
  /\bnot a scam\b/,
  /\byou should (buy|sell)\b/,
  /\b(buy|sell) now\b/,
];

export type ModelTextProblem = 'abuse' | 'claim';

/** Null for text that may be shown. Pure; never throws. */
export function modelTextProblem(text: string): ModelTextProblem | null {
  const lower = text.toLowerCase();
  const spaced = ` ${lower.replace(/[^a-z0-9]+/g, ' ').trim()} `;
  if (CLAIM_PATTERNS.some((pattern) => pattern.test(spaced))) return 'claim';
  const joined = lower.replace(/[^a-z0-9]/g, '');
  if (ABUSE_ANYWHERE.some((word) => joined.includes(word))) return 'abuse';
  const words = new Set(spaced.trim().split(' '));
  if (ABUSE_WORDS.some((word) => words.has(word))) return 'abuse';
  return null;
}
