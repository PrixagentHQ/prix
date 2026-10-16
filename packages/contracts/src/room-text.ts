import { ABUSE_ANYWHERE, ABUSE_WORDS, CLAIM_PATTERNS } from './text-guard.ts';

/**
 * The text rule of the room (Phase 6.3, docs/contracts/phase-6-room.md section 4), in a file of its own with
 * no zod in it, as text-guard.ts is: the composer's script imports it by its path
 * (`@prix/contracts/room-text`) and judges a text with the very function the server uses. The server's
 * answer is the one that counts.
 *
 * Revision 2 is the security reviewer's rule (2026-10-10): of 216 hostile lines the first rule let 202
 * through. Revision 3 is that reviewer's second look: an address in pieces with words between them is
 * refused, and honest lines the second rule refused pass again ("$PRIX new high today", "MSFT closed at
 * 455", "who really knows", "Nice trade. GG", "What's Apple doing"). It still refuses more honest lines
 * than the first rule did, and that is the price: a refused line costs a writer one more try, and the page
 * says which words the room does not take.
 */

/** The longest message, after `roomFoldText`. */
export const ROOM_TEXT_MAX = 280;

/** White space folded: runs of space, tab and line ends become one space, and the ends are trimmed. What is judged is what is stored. */
export function roomFoldText(text: string): string {
  return text.replace(/[ \t\r\n]+/g, ' ').trim();
}

export const ROOM_TEXT_PROBLEMS = [
  'empty',
  'length',
  'characters',
  'address',
  'cashtag',
  'link',
  'number',
  'bait',
  'spelled',
  'words',
] as const;
export type RoomTextProblem = (typeof ROOM_TEXT_PROBLEMS)[number];

/** The one address and the one host a message may hold: $PRIX's contract, and the site's own host. */
export interface RoomAllowed {
  /** Lower-case, as the token's config holds it; null while there is none. */
  prixAddress: string | null;
  /** The host of the site's origin, for example "prixagent.com". */
  siteHost: string;
}

const any = (...parts: RegExp[]): RegExp => new RegExp(parts.map((part) => part.source).join('|'), 'i');

/** Printable ASCII and nothing else: a look-alike letter is how a false host or a false "Prix" is written. */
const ROOM_CHARS = /^[ -~]*$/;
/** The opening of a tag, and one mark eight times in a row: no message is ever markup, and none is a wall of marks. */
const ROOM_MARKUP = /<[a-z/!?]|([^a-z0-9 ])\1{7,}/i;
/**
 * A scheme, "www.", any host, an at sign, a percent escape, a numeric host, and every way to spell a dot.
 * A full stop before "GG" or "ETH" ends a sentence ("Nice trade. GG"), so those two are not in the list of
 * endings that follow a stop and a space.
 */
const ROOM_LINK = any(
  /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.[a-z]{2,}\b|@|%[0-9a-f]{2}|\b\d{1,3}(?:\.\d{1,3}){3}\b/,
  /\s\.\s*[a-z]{2,}|[a-z0-9]\.\s+(?:com|io|xyz|org|vip|fi|ly|cc)\b|(?<![a-z0-9])(?:com|c0m|xyz)(?![a-z0-9])/,
  /[([{<]\s*(?:d[o0]t|\.)\s*[)\]}>]|(?<![a-z0-9])(?:d[o0]t|point|period)[^a-z0-9]*(?:com|io|xyz|net|org|app|gg|me|co|ai|fi|eth|link|site|club|top|vip|ly|cc)(?![a-z0-9])/,
  /\b(?:javascript|vbscript|mailto|https?|hxxps?)\s*:|\bhxxps?\b|\bdata:\s*[a-z]+\/[a-z]/,
);
/** A telephone number or another long number to write to: a plus before eight digits, or eleven digits in a row with marks between. */
const ROOM_NUMBER = /\+\s?\d[\d ().\-/]{6,}\d|(?:\d[ ().\-/]{0,2}){11,}/;
/** What a scam asks for, where it sends people, and who it says it is. */
const ROOM_BAIT = any(
  /\b(?:dm|pm|inbox|message|msg|text|write|contact|add|email|call|ping)[\s_-]+(?:me|us|him|her|them)\b|\bdms?\b|\bhmu\b|\bhit\s+me\s+up\b|\breach\s+(?:out|me)\b|\b(?:my|in)\s+(?:bio|profile)\b|\bsend\s+(?:me|us)\b|\bpm\s+(?:the|an?|admin|mod)\b|\binbox\b/,
  /\b(?:seed|recovery|secret|mnemonic|backup|pass|wallet)[\s_-]*(?:phrase|words?|keys?)\b|\bmnemonic|\bpriv(?:ate)?[\s_-]*keys?\b|\bkeystore|\b(?:12|24|twelve)[\s-]*words?\b/,
  /\b(?:connect|validate|verify|sync\w*|restore|rectify|migrate|link|authenticate|revoke)\s+(?:your\s+|ur\s+|the\s+)?(?:wallets?|metamask|approvals?|holdings?)\b|\bwallet\s*connect\b|\bclaim\w*/,
  /\bair[\s_-]*drop|\bgive[\s_-]*away|\bpre[\s_-]*sale|\b(?:white|allow)[\s_-]*list|\bfree\s+(?:tokens?|mint|coins?|eth|prix)\b|\b(?:bonus|refund|snapshot|compensation)\b|\bdouble\s+(?:your|ur)\b|\bget\s+\d+\s+back\b/,
  /\bhelp\s*(?:desk|center|centre)\b|\b(?:customer|live|tech|technical)\s+support\b|\bsupport\s+(?:team|desk|agent|ticket|staff|line|chat)\b|\bticket\b|\b(?:contact|talk\s+to|ask|message)\s+support\b/,
  /\b(?:telegram|whatsapp|discord|wechat|weixin|tg|snapchat|instagram|insta|tiktok|twitter|skype|viber|messenger|facebook|reddit|gmail|e-?mail|kik)\b|\bwa\s+me\b/,
  /\bpr[il1|!]x\w*.{0,24}\b(?:support|admin|team|official|mod|moderator|staff|dev|developer|founder|ceo|employee|rep|helper|assistant|owner)s?\b/,
  /\b(?:support|admin|team|official|mod|moderator|staff|dev|developer|founder|ceo|employee|rep|helper|assistant|owner)s?\b.{0,24}\bpr[il1|!]x/,
  /^\W*pr[il1|!]x\W*[:\]>|-]|\bpr[l1|!]x|\b(?:work|working)\s+(?:for|at|with)\s+prix/,
  // "I am the owner" is what an agent's owner says of an agent, so `owner` is refused beside "Prix" only, above.
  /\b(?:i\s*am|i'?m|as)\s+(?:an?\s+|the\s+|your\s+)?(?:official\s+)?(?:admin|mod|moderator|staff|dev|developer|support|founder)\b|\b(?:admin|mod|moderator|staff|support)\s+here\b|\bstaff\s+member\b|\bofficial\s+(?:mod|admin|staff|support|account|chat|group|channel|page|site|link)\b/,
);
/**
 * A second token under Prix's name: "$PRIX_V2", "$PRIX-new", "$PRIX II", "prix-2", "the new prix token",
 * "prix 2 coin". A word or a number after the cashtag is an ordinary sentence and passes: "$PRIX new high
 * today", "bought $PRIX 3 days ago", "Prix 2 days ago", "is Prix new?".
 */
const ROOM_VERSION =
  /\$?prix[\s._-]*v\s?\d|\$prix[._-]*(?:[2-9]|ii)\b|\$prix[._-]+(?:new|classic)\b|\$prix\s+(?:ii|classic)\b|\$?\bprix\s+(?:new|[2-9])\s+(?:token|coin|ca|contract|address)\b|\bprix[._-]?(?:[2-9]|ii)\b|\b(?:new|classic|real|true|original|second)\s+\$?prix\s+(?:token|coin|ca|contract|address)\b|\bprix\s+(?:new|classic)\s+(?:token|coin|ca|contract|address)\b/i;
/** Read on the text with everything but letters and digits taken out and look-alike digits and marks made letters. */
const ROOM_SQUEEZED =
  /telegram|telegrarn|whatsapp|vvhatsapp|dlscord|lnstagram|tlktok|twltter|alrdrop|glveaway|seedphrase|prlvatekey|prlx.{0,12}(?:support|admln|staff|offlclal|helpdesk)/;
/**
 * "What's Apple doing" and "what's approved" would read as the name of a platform once the space is taken
 * out. Before that reading, "what's" before a longer word that starts "app" is written out as "what is".
 * Only before the words English has there (apple, applied, apply, approved, appreciate, appealing,
 * apparent, appoint, appetite): "what's app" on its own and "whats appgroup" stay as they are, and are
 * refused.
 */
const ROOM_WHATS_APP_WORD = /\bwhat'?s\s+(?=app(?:l[eiy]|r[oe]|ea|ar|oi|et)[a-z]*)/gi;
/** Hype a list can name, and harm said in pieces: beside the abuse and claim lists of text-guard.ts. */
const ROOM_WORDS =
  /\b(?:100%|zero|no)\s+(?:safe|risk)\b|\b(?:easy|free|quick|fast)\s+(?:money|profits?|gains?)\b|\bsure\s+(?:profits?|win|gains?)\b|\bmust\s+buy\b|\bwill\s+\d+x\b|\b\d+x\s+(?:soon|guaranteed|easy|incoming)\b|\bto\s+the\s+moon\b|\bk\W?y\W?s\b|\bkill\s*(?:ur|your|you're)\s*self\b/i;
/** Four letters spelled apart, a digit that stands for a letter inside a word, or a mark inside a word: ways round the lists. */
const ROOM_SPELLED =
  /(?<![a-z0-9])[a-z](?:[^a-z0-9]{1,3}[a-z](?![a-z0-9])){3,}|[a-z][0134578]+[a-z]|[a-z][|*^~#=\\]+[a-z]/i;
/** The entries of ABUSE_ANYWHERE that are phrases: looked for across the spaces of a text. Every other entry is looked for inside one word. */
const ROOM_ABUSE_PHRASES: ReadonlySet<string> = new Set([
  'killyourself',
  'gasthejews',
  'whitepower',
  'siegheil',
  'chingchong',
]);

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * An address in pieces. Words of hex only, one after another: 16 characters or more of them with two that
 * mix digits and letters, or 8 or more with three that do. And, anywhere in the line with any words
 * between ("ca ends 6f2e9c2d and starts 2c9d6f2a"): hex words of four or more that mix digits and letters,
 * 16 characters of them together. Two short commit hashes in one line are 14 and pass. And an address
 * typed in very short pieces, with no "0x" before it: six pieces of three characters or fewer that mix
 * digits and letters, anywhere in the line ("2c9 then d6f then 2a9 ..."); or, one after another, 16
 * characters of hex in which four short pieces are digits only and four are letters only ("2 c 9 d 6 f").
 */
function hexInPieces(rest: string): boolean {
  let total = 0;
  let mixed = 0;
  let apart = 0;
  let digits = 0;
  let letters = 0;
  let short = 0;
  for (const token of rest.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!/^[0-9a-f]+$/.test(token)) {
      total = 0;
      mixed = 0;
      digits = 0;
      letters = 0;
      continue;
    }
    total += token.length;
    if (token.length <= 3 && /^[0-9]+$/.test(token)) digits += 1;
    if (token.length <= 3 && /^[a-f]+$/.test(token)) letters += 1;
    if (/\d/.test(token) && /[a-f]/.test(token)) {
      mixed += 1;
      if (token.length >= 4) apart += token.length;
      else short += 1;
    }
    if ((total >= 16 && mixed >= 2) || (total >= 8 && mixed >= 3) || apart >= 16 || short >= 6) return true;
    if (total >= 16 && digits >= 4 && letters >= 4) return true;
  }
  return false;
}

/**
 * The abuse and claim lists of text-guard.ts, read word by word. `modelTextProblem` joins a text across
 * its spaces before it looks, which suits a model's two sentences and not a room: "who really knows",
 * "push it" and "public until Monday" each spell an entry of the list across two words. The price is an
 * insult typed with a space inside it, which an admin removes.
 */
function roomListed(text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  const spaced = ` ${words.join(' ')} `;
  const joined = words.join('');
  return (
    CLAIM_PATTERNS.some((pattern) => pattern.test(spaced)) ||
    ABUSE_WORDS.some((word) => words.includes(word)) ||
    ABUSE_ANYWHERE.some((bad) =>
      ROOM_ABUSE_PHRASES.has(bad) ? joined.includes(bad) : words.some((word) => word.includes(bad)),
    )
  );
}

/**
 * Why a message may not be shown, or null. `input` is judged after `roomFoldText`. The route refuses the
 * whole message; nothing is ever edited or cut.
 *
 * In order: `empty`; `length` beyond ROOM_TEXT_MAX, judged before any pattern is run; `characters`
 * (anything that is not printable ASCII, the opening of a tag, one mark eight times in a row); `address`
 * (0x and six hex or more that is not `prixAddress`, whole; the same split by spaces or marks, written with
 * the letter O, or in pieces, with words between them too; a bare hex word of ten or more that mixes digits
 * and letters; any word of 26 letters and digits or more; a word of twelve or more that mixes digits and
 * both cases); `cashtag` (a dollar sign before a letter other than `$PRIX`, and a second token under Prix's
 * name); `link` (a scheme, "www.", any host but `siteHost`, an at sign, a percent escape, a numeric host, a
 * dot spelled out or set apart, the bare word "com"); `number`; `bait`; `spelled`; and `words`, the abuse
 * and claim lists of text-guard.ts read word by word, and the room's own short list of hype and harm.
 *
 * A list cannot judge meaning: the page says that messages are users' own words, and an admin removes what
 * a list lets through.
 */
export function roomTextProblem(input: string, allowed: RoomAllowed): RoomTextProblem | null {
  const text = roomFoldText(input);
  if (text.length === 0) return 'empty';
  if (text.length > ROOM_TEXT_MAX) return 'length';
  if (!ROOM_CHARS.test(text) || ROOM_MARKUP.test(text)) return 'characters';

  const lower = text.toLowerCase();
  const prix = allowed.prixAddress === null ? null : allowed.prixAddress.toLowerCase();
  for (const match of lower.matchAll(/0x[0-9a-f]+/g)) {
    if (match[0].length >= 8 && match[0] !== prix) return 'address';
  }
  // An address written with spaces or marks between its characters still reads as one. A run with no digit
  // in it is words ("10x a decade ago"), not an address.
  for (const match of lower.replace(/[^a-z0-9]/g, '').matchAll(/0x[0-9a-f]{6,}/g)) {
    if (/[0-9]/.test(match[0].slice(2)) && (prix === null || !match[0].startsWith(prix))) return 'address';
  }
  // What is left once the one allowed address is taken out.
  let rest = text;
  if (prix !== null) rest = rest.replace(new RegExp(escapeForPattern(prix), 'gi'), ' ');
  if (/\b[0-9a-f]{32,}\b/i.test(rest) || /\b[A-Za-z0-9]{26,}\b/.test(rest)) return 'address';
  if (/(?<![a-z0-9])o\s?x\s?[0-9a-f]{6,}/i.test(rest)) return 'address';
  if (/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{10,}\b/i.test(rest)) return 'address';
  if (/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{12,}\b/.test(rest)) return 'address';
  if (hexInPieces(rest)) return 'address';
  for (const match of rest.matchAll(/\$\s?[A-Za-z][A-Za-z0-9]*/g)) {
    if (match[0].replace(/\s/g, '').toLowerCase() !== '$prix') return 'cashtag';
  }
  if (ROOM_VERSION.test(rest)) return 'cashtag';
  // And once $PRIX and the site's own host are taken out. The host may carry a path of plain segments and
  // end a sentence; anything else after it (another dot and a name, a percent, a second slash, an
  // underscore) leaves it in.
  rest = rest.replace(/\$\s?prix\b/gi, ' ');
  if (allowed.siteHost.length > 0) {
    const host = escapeForPattern(allowed.siteHost.toLowerCase());
    const tail = /(?:\/[A-Za-z0-9_-]+)*\/?(?![A-Za-z0-9/\\%:@?#_-])(?!\.[A-Za-z0-9])/.source;
    rest = rest.replace(new RegExp(`(?<![A-Za-z0-9.-])${host}${tail}`, 'gi'), ' ');
  }
  if (ROOM_LINK.test(rest)) return 'link';
  if (ROOM_NUMBER.test(rest)) return 'number';
  if (ROOM_BAIT.test(rest)) return 'bait';
  const squeezed = rest
    .replace(ROOM_WHATS_APP_WORD, 'what is ')
    .toLowerCase()
    .replace(/[^a-z0-9|!]/g, '')
    .replace(/[i1|!]/g, 'l')
    .replace(/[96]/g, 'g')
    .replace(/0/g, 'o')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a');
  if (ROOM_SQUEEZED.test(squeezed)) return 'bait';
  if (ROOM_SPELLED.test(rest)) return 'spelled';
  // The lists once more on the text with look-alike digits and marks read as the letters they stand for
  // ("n0 risk", an insult with an exclamation mark in it). Only beside a letter: a number that stands alone
  // is a number ("MSFT closed at 455").
  const plain = rest
    .toLowerCase()
    .replace(/(?<=[a-z])[013457!|]+|[013457!|]+(?=[a-z])/g, (run) =>
      run
        .replace(/[!1|]/g, 'i')
        .replace(/0/g, 'o')
        .replace(/3/g, 'e')
        .replace(/4/g, 'a')
        .replace(/5/g, 's')
        .replace(/7/g, 't'),
    )
    .replace(/v/g, 'u');
  if (roomListed(rest) || roomListed(plain) || ROOM_WORDS.test(rest)) return 'words';
  return null;
}
