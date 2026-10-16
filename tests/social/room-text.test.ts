import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoomAllowed, RoomTextProblem } from '@prix/contracts';
import {
  ROOM_MESSAGES_PER_DAY_DEFAULT,
  ROOM_MESSAGES_PER_DAY_MAX,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_REFUSALS,
  ROOM_SECONDS_BETWEEN,
  ROOM_TEXT_MAX,
  ROOM_TEXT_PROBLEMS,
  roomDailyCap,
  roomDayKey,
  roomFoldText,
  roomHourKey,
  roomPostRequestSchema,
  roomRetryAfterSeconds,
  roomTextProblem,
  roomTurnRefusal,
} from '@prix/contracts';
import { roomTextProblem as composerRule } from '@prix/contracts/room-text';
import { describe, expect, it } from 'vitest';

/**
 * The text rule of the room (docs/contracts/phase-6-room.md section 4, `roomTextProblem` of
 * packages/contracts/src/room-text.ts), at revision 4 of the contract.
 *
 * Three sets. The operator's first check (.artifacts/room-check.mts, 112 cases) and its second
 * (room-check-3.mts, 80 cases at revision 4) are carried over line by line. The third is qa's own: hostile
 * and honest lines, each with the problem the contract's section 4 gives it. A line the contract names as
 * "refused though honest" or "passing by nature" is pinned as the contract words it.
 */

const PRIX = '0xa74ac6e9f2f8493344923c23972d496364241044';
const OTHER = '0x1234567890abcdef1234567890abcdef12345678';
const allowed: RoomAllowed = { prixAddress: PRIX, siteHost: 'prixagent.com' };
const noToken: RoomAllowed = { prixAddress: null, siteHost: 'prixagent.com' };

type Want = RoomTextProblem | null;
type Case = readonly [text: string, want: Want];

const verdict = (text: string, with_: RoomAllowed = allowed): Want => roomTextProblem(text, with_);

/** Every case of a set at once, so that one run names every line that is wrong. */
function wrong(cases: readonly Case[], with_: RoomAllowed = allowed): string[] {
  return cases
    .filter(([text, want]) => verdict(text, with_) !== want)
    .map(([text, want]) => `${JSON.stringify(text)}: got ${verdict(text, with_)}, wanted ${want}`);
}

const passing = (texts: readonly string[]): Case[] => texts.map((text) => [text, null] as const);
const refusedAs = (want: RoomTextProblem, texts: readonly string[]): Case[] =>
  texts.map((text) => [text, want] as const);

// --- the operator's first check: room-check.mts, 112 cases ---------------------------------------------------

const LEAD_1: Case[] = [
  // what a holder would honestly write (15)
  ...passing([
    'gm, who else is watching Momentum Five today?',
    'Dip Buyer has held cash for three rounds. Patient or stuck?',
    `The only address is ${PRIX}`,
    `CA: ${PRIX.toUpperCase().replace('0X', '0x')} thanks`,
    'Holding $PRIX since launch.',
    'Full league table is on prixagent.com/league',
    'See prixagent.com for the rules.',
    'Round is at 15:00 UTC on 2026-10-12, right?',
    'I hold 1,250,000 PRIX and I am not selling.',
    'NVDA up 3.5% today, Big Tech Equal did not move.',
    'e.g. Big Tech Equal bought AAPL and NVDA on day one.',
    'p2p, b2b and a16z are fine to say.',
    'Is 10x leverage allowed? No, there is none.',
    "What's the difference between Open and Pro?",
    'The U.S. market is closed on Monday? ok. Thanks!',
  ]),
  // a contract address that is not $PRIX's (9 here; the tenth needs no token, below)
  ['Real CA 0x1234567890abcdef1234567890abcdef12345678', 'address'],
  [`CA ${PRIX.slice(0, -1)}5`, 'address'],
  [`CA ${PRIX.slice(0, 30)}`, 'address'],
  ['CA 0x12 34 56 78 90 ab cd ef 12 34', 'address'],
  ['CA 0x.12.34.56.78.90.ab', 'address'],
  ['CA 1234567890abcdef1234567890abcdef12345678', 'address'],
  ['send to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'address'],
  ['Forget it, $PRIXX is the real one', 'cashtag'],
  ['Buy $DOGE instead', 'cashtag'],
  // a link, a host, a handle (12)
  ...refusedAs('link', [
    'go to https://prixagent.com.claim-now.io',
    'the site moved to prixagent.co',
    'prixagent.com.evil.io has the list',
    'xprixagent.com has the list',
    'prixagent.com-claim.io',
    'www.prix-agent.net',
    'bit.ly/prix-drop',
    'send to realprix.eth',
    'ask @prix_support',
    'prix-claim dot com',
    'prix-claim(dot)io',
    't.me/prixsupport',
  ]),
  // a number to write to (2)
  ['call +62 812 3456 7890', 'number'],
  ['my id is 5512 3456 7890 12', 'number'],
  // bait (10)
  ...refusedAs('bait', [
    'dm me for the list',
    'enter your seed phrase to claim',
    'validate your wallet first',
    'airdrop for holders is open',
    'Giveaway at midnight',
    'customer support will help',
    'join the whatsapp group',
    'I am from the Prix support staff',
    'official admin of prix here',
    'presale of the next token',
  ]),
  // ways round the lists (7)
  ['h t t p s then the name', 'spelled'],
  ['ask the pr1x mods', 'bait'],
  ['this is a sc4m', 'spelled'],
  [`pri${String.fromCharCode(0x445)}agent has it`, 'characters'],
  [`dm${String.fromCharCode(0x200b)} me`, 'characters'],
  [`gm ${String.fromCodePoint(0x1f680)}`, 'characters'],
  ['dm\nme now', 'bait'],
  // what the security reviewer brought on 2026-10-10 (36)
  ['CA first half 2c9d6f2a9b6e9c2d6f2a second half 9d2c6f9e2a6b2d9c6f2e', 'address'],
  [`${PRIX} is old. new: 2c9d 6f2a 9b6e 9c2d 6f2a 9d2c 6f9e 2a6b 2d9c 6f2e`, 'address'],
  [`real one ${PRIX} 2c 9d 6f 2a 9b 6e`, 'address'],
  ['Ox2c9d6f2a9b6e9c2d6f2a9d2c6f9e2a6b2d9c6f2e', 'address'],
  ['bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'address'],
  ['$ DOGE better', 'cashtag'],
  ['$PRIX_V2 is the new one', 'cashtag'],
  ['PRIX2 token is real, old $PRIX is dead', 'cashtag'],
  ['prixclaim .com', 'link'],
  ['prixclaim[.]com', 'link'],
  ['prixclaim-dot-com', 'link'],
  ['prixclaim com', 'link'],
  ['185.12.34.56/claim', 'link'],
  ['prixagent.com//evil.com', 'link'],
  ['prixagent.com%2eevil%2eio/claim', 'link'],
  ['+1 (415) 555 0123', 'number'],
  ['dm-me', 'bait'],
  ['dms open', 'bait'],
  ['seedphrase', 'bait'],
  ['your 12 words', 'bait'],
  ['claim your tokens', 'bait'],
  ['air drop', 'bait'],
  ['tele gram', 'bait'],
  ['t,e,l,e,g,r,a,m', 'bait'],
  ['twitter', 'bait'],
  ['prixagent support', 'bait'],
  ['PRlX staff', 'bait'],
  ['admin here', 'bait'],
  ['Prix: the chat moves tomorrow', 'bait'],
  ['</script><script>alert(1)</script>', 'characters'],
  ['!!!!!!!!!!', 'characters'],
  ['100% safe', 'words'],
  ['easy money', 'words'],
  ['must buy', 'words'],
  ['n0 risk here', 'words'],
  ['k y s', 'words'],
  // and what must still pass (11)
  ...passing([
    'I am the owner of Momentum Five, ask me anything about it.',
    'I found Prix 2 days ago and I like it.',
    'Is Prix new? Looks like it started this month.',
    'wow!ok that was fast',
    'I added 10x a decade ago and never looked back, lol.',
    'See prixagent.com.',
    'The league page is prixagent.com/league, check it.',
    'Can a mod tell me when Model War 1 ends?',
    'P/E of 30x is too rich for me.',
    '<3 this league',
    'NVDA > AAPL',
  ]),
  // shape (6)
  ['   ', 'empty'],
  ['a'.repeat(281), 'length'],
  [`${'hello '.repeat(46)}gmgm`, null],
  [`${'hello '.repeat(46)}gmgmg`, 'length'],
  ['you are a retard', 'words'],
  ['this is a guaranteed win', 'words'],
];

describe("the operator's first check of the text rule, carried over (room-check.mts, 112 cases)", () => {
  it('has the verdict the operator wrote for each of its 108 lines judged with the token', () => {
    expect(LEAD_1).toHaveLength(108);
    expect(wrong(LEAD_1)).toEqual([]);
  });

  it('allows no address at all while the token has none', () => {
    expect(verdict(`CA ${PRIX}`, noToken)).toBe('address');
  });

  it('refuses a claim of no risk, whichever problem names it', () => {
    expect(verdict('risk free returns in this league')).not.toBeNull();
  });

  it('folds white space, and the folded text is what is judged', () => {
    expect(roomFoldText('  gm \n\t all  ')).toBe('gm all');
  });

  it("reads the day's cap from the variable: the default, a number, the ceiling, no number, zero", () => {
    expect([
      roomDailyCap(undefined),
      roomDailyCap('100'),
      roomDailyCap('999999'),
      roomDailyCap('x'),
      roomDailyCap('0'),
    ]).toEqual([ROOM_MESSAGES_PER_DAY_DEFAULT, 100, ROOM_MESSAGES_PER_DAY_MAX, ROOM_MESSAGES_PER_DAY_DEFAULT, 0]);
  });
});

// --- the operator's second check: room-check-3.mts, 80 cases at revision 4 -----------------------------------

const HEX = '2c9d6f2a9b6e9c2d6f2a9d2c6f9e2a6b2d9c6f2e';
const pieces = (size: number, between: string): string =>
  (HEX.match(new RegExp(`.{1,${size}}`, 'g')) ?? []).join(between);

const LEAD_3: Case[] = [
  // honest lines revision 2 refused and revision 3 lets through (22)
  ...passing([
    '$PRIX new high today',
    'bought $PRIX 3 days ago',
    '$PRIX 5% up',
    'is $PRIX new here?',
    'MSFT closed at 455',
    'price at 7175',
    'NVDA 455 then 470, AAPL 231',
    "What's Apple doing",
    "what's approved for Open agents?",
    "What's apparent is that NVDA leads",
    "what's applied first, the cap or the stop?",
    'Nice trade. GG',
    'Sold too early. ETH looks stronger',
    'who really knows',
    'going up or not',
    'stocks hit a wall',
    'push it',
    'public until Monday',
    'commits 4c33203 and 5620343 are live',
    'my F150 and an A380, lol',
    'prixagent.com/league_table',
    'see prixagent.com/agents/3w6inochcjno.',
  ]),
  // an address in pieces with words between, and a host that only starts as the site's (6)
  ['2c9d6f2a9 then b6e9c2d6f then 2a9d2c6f9 then e2a6b2d9c then 6f2e', 'address'],
  ['ca ends 6f2e9c2d and starts 2c9d6f2a', 'address'],
  ['first 2c9d6f2a then, after a word or two, 9b6e9c2d', 'address'],
  ['prixagent.com_evil', 'link'],
  ['prixagent.com_evil/claim', 'link'],
  ['prixagent.com/abc_?next=evil', 'link'],
  // revision 4: an address with no "0x" before it, typed in very short pieces (7)
  ...refusedAs('address', [
    pieces(1, ' '),
    pieces(1, '-'),
    `ca ${pieces(1, ' ')}`,
    `zero x ${pieces(1, ' ')}`,
    pieces(3, ' x '),
    pieces(2, ' x '),
    pieces(3, ' then '),
  ]),
  // and what must still pass beside it (5)
  ...passing([
    'bought 3 then 5 then 2 more, 10 in all',
    'a 5 and a 10 and a 20, then b',
    'rounds 1 2 3 and 4 are done, 5 and 6 are next',
    'my 3d printer and a b2b deal',
    'add 5 to 10 and be done',
  ]),
  // revision 4: "what's" is written out only before the words English has there (3 and 4)
  ...passing(['whats applicable here', "what's appealing about SOL", "what's appreciated most?"]),
  ...refusedAs('bait', ['whats appp', 'whats apps group is better', 'whats appme later', 'whats appgroup has signals']),
  // a second token under Prix's name is still refused (12)
  ...refusedAs('cashtag', [
    '$PRIX_V2 is out',
    '$PRIX-2',
    '$PRIX2',
    '$PRIX II',
    '$PRIX classic',
    '$PRIX-new',
    '$PRIX.new',
    'prix 2 coin',
    'prix-2',
    'PRIX new token is out',
    'the new prix token',
    'the real $PRIX contract',
  ]),
  // the lists, word by word and with look-alikes beside a letter (8)
  ...refusedAs('words', [
    'n0 risk at all',
    'a55',
    'risk free',
    'not financial advice',
    'guaranteed',
    'easy money',
    '100% safe',
    'you should buy',
  ]),
  // length before any pattern (2)
  ['a.'.repeat(141), 'length'],
  [`${'a '.repeat(139)}ab`, 'spelled'],
];

/** The name of a platform, however it is spaced: refused as `bait` or as `spelled` (11). */
const LEAD_3_PLATFORMS = [
  'whats app',
  "what's app?",
  'whats app link',
  'whats app is where we talk',
  'join whatsapp',
  'whatsapp later',
  'whatsa pp',
  'wh4tsapp works too',
  'what s a p p',
  'tele gram',
  't e l e g r a m',
];

describe("the operator's second check of the text rule, carried over (room-check-3.mts, 80 cases)", () => {
  it('has the verdict the operator wrote for each of its 69 lines with one problem', () => {
    expect(LEAD_3).toHaveLength(69);
    expect(wrong(LEAD_3)).toEqual([]);
  });

  it('refuses the name of a platform however it is spaced, as bait or as spelled', () => {
    expect(LEAD_3_PLATFORMS).toHaveLength(11);
    const through = LEAD_3_PLATFORMS.filter((text) => !['bait', 'spelled'].includes(String(verdict(text))));
    expect(through).toEqual([]);
  });
});

// --- qa's own ---------------------------------------------------------------------------------------------

/** The order of section 4: a line with two problems is refused for the one that comes first. */
const ORDER: Case[] = [
  ['', 'empty'],
  [' \n\t\r ', 'empty'],
  // Longer than the longest and not ASCII: the length is judged before any pattern.
  [String.fromCodePoint(0x1f680).repeat(ROOM_TEXT_MAX + 1), 'length'],
  [`${OTHER} ${'a'.repeat(ROOM_TEXT_MAX)}`, 'length'],
  [`gm ${String.fromCodePoint(0x1f680)} ${OTHER}`, 'characters'],
  [`<b>${OTHER}</b>`, 'characters'],
  [`${OTHER} beats $DOGE`, 'address'],
  ['$DOGE is on evil.io', 'cashtag'],
  ['evil.io or call +62 812 3456 7890', 'link'],
  ['+62 812 3456 7890 and dm me', 'number'],
  ['dm me, this is a sc4m', 'bait'],
  ['a sc4m with easy money', 'spelled'],
];

/** Hostile lines, each by the problem section 4 gives it. */
const HOSTILE: Case[] = [
  // characters: nothing but printable ASCII, no tag, no wall of marks
  [`gm${String.fromCharCode(0xa0)}all`, 'characters'],
  [`${String.fromCharCode(0x202e)}moc.live`, 'characters'],
  [`${String.fromCharCode(0xff50, 0xff52, 0xff49, 0xff58)} is here`, 'characters'],
  ['café talk', 'characters'],
  [`gm${String.fromCharCode(0x7f)}`, 'characters'],
  [`gm${String.fromCharCode(0)}all`, 'characters'],
  ['<img src=x onerror=alert(1)>', 'characters'],
  ['<!-- hidden', 'characters'],
  ['</b>', 'characters'],
  ['<?php echo 1', 'characters'],
  ['wow ========', 'characters'],
  // address: any address but the one, whole
  [`${PRIX}0`, 'address'],
  [`${PRIX} and ${OTHER}`, 'address'],
  ['0x1234ab', 'address'],
  ['cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu', 'address'],
  ['aB3dE6gH9jKlmN', 'address'],
  // cashtag: no cashtag but $PRIX, and no second token under its name
  ['$PRIXAGENT is the one', 'cashtag'],
  ['$ETH and $BTC', 'cashtag'],
  // link: any host but the site's own, whole
  ['http://prixagent.com', 'link'],
  ['sub.prixagent.com has it', 'link'],
  ['prixagent.com.co', 'link'],
  ['prixagent.com:8080', 'link'],
  ['prixagent.com/league?ref=x', 'link'],
  ['prixagent.com@evil.io', 'link'],
  ['write to help@prixagent.com', 'link'],
  ['evil%2Ecom', 'link'],
  ['192.168.1.1', 'link'],
  ['example dot org', 'link'],
  ['evil [.] io', 'link'],
  // number: a plus before eight digits, or eleven digits with marks between
  ['+12345678', 'number'],
  ['12345678901', 'number'],
  ['62-812-3456-7890', 'number'],
  // bait
  ['inbox me for signals', 'bait'],
  ['never share a private key', 'bait'],
  ['type your recovery phrase', 'bait'],
  ['connect your wallet to continue', 'bait'],
  ['whitelist spots are open', 'bait'],
  ['a refund is waiting', 'bait'],
  ['open a ticket', 'bait'],
  ['join the Discord', 'bait'],
  ['I am an admin', 'bait'],
  ['Prix official here', 'bait'],
  ['PRIX: send funds now', 'bait'],
  // spelled: ways round the lists
  ['s c a m', 'spelled'],
  ['fr*e tokens', 'spelled'],
];

/** Honest lines that pass. */
const HONEST: Case[] = passing([
  PRIX,
  PRIX.toUpperCase(),
  `${PRIX} and again ${PRIX}`,
  '$PRIX',
  '$prix holders, gm',
  'paid $5 a share',
  'PRIXAGENT.COM has the table',
  'prixagent.com/league.',
  'a < b and b > c',
  'wow!!!!!!!',
  'gm\tall',
  `gm${' '.repeat(400)}all`,
  'the round of 2026-10-12',
  'volume was 1234567890 today',
]);

/** Honest lines the rule refuses, as section 4 says it does ("still refused though honest"). */
const HONEST_BUT_REFUSED: Case[] = [
  ['Is there a Telegram group?', 'bait'],
  ['Does Prix support SOL?', 'bait'],
  ['Is the Prix team adding options?', 'bait'],
  ['As the owner of two Prix agents', 'bait'],
  ['I claim nothing', 'bait'],
  ["what's app with the leaderboard", 'bait'],
  ['not financial advice', 'words'],
  ['5m30s', 'spelled'],
  ['L1s', 'spelled'],
  ['new here. io errors', 'link'],
  // Other cashtags are left out of this version (section 1), an honest one too.
  ['$NVDA is up today', 'cashtag'],
  // Any host is a link, also a name with a dot in it.
  ['I use Node.js', 'link'],
  // Any word of 26 letters and digits is refused as an address.
  ['Supercalifragilisticexpialidocious', 'address'],
];

/** What section 4 says passes by nature, and what revision 3 gave up: an admin removes these. */
const PASSING_BY_NATURE: Case[] = passing([
  'prixrewards io',
  'prixrewards. net',
  'd m me',
  'check bio',
  'Prix here, the chat moves',
  'follow prix_help on X',
  'telegrm',
  '$PRIX new',
  'realprix. eth',
]);

describe("qa's own cases of the text rule", () => {
  it('holds at least thirty of them', () => {
    const own = ORDER.length + HOSTILE.length + HONEST.length + HONEST_BUT_REFUSED.length + PASSING_BY_NATURE.length;
    expect(own).toBeGreaterThanOrEqual(30);
  });

  it('refuses a line with two problems for the one that comes first in section 4', () => {
    expect(wrong(ORDER)).toEqual([]);
  });

  it('refuses each hostile line for the problem section 4 gives it', () => {
    expect(wrong(HOSTILE)).toEqual([]);
  });

  it('lets honest lines through: the one address in any case, $PRIX, an amount, a date, the site itself', () => {
    expect(wrong(HONEST)).toEqual([]);
  });

  it('refuses the honest lines section 4 says it refuses, each for the problem its sentence names', () => {
    expect(wrong(HONEST_BUT_REFUSED)).toEqual([]);
  });

  it('lets through what section 4 says passes by nature and what revision 3 gave up', () => {
    expect(wrong(PASSING_BY_NATURE)).toEqual([]);
  });

  it('refuses every address while the token has none, and still lets an honest line through', () => {
    expect(
      wrong([[PRIX, 'address'], [`CA ${PRIX.toUpperCase()}`, 'address'], ...passing(['gm all'])], noToken),
    ).toEqual([]);
  });

  it('takes the one host from what it is given: another site host does not free prixagent.com', () => {
    const elsewhere = { prixAddress: PRIX, siteHost: 'prix.test' };
    expect(verdict('see prixagent.com/league', elsewhere)).toBe('link');
    expect(verdict('see prix.test/league', elsewhere)).toBeNull();
    // With no host at all, no host passes.
    expect(verdict('see prixagent.com', { prixAddress: PRIX, siteHost: '' })).toBe('link');
  });

  it('takes the one address from what it is given, whole: a longer or a shorter one is another address', () => {
    expect(verdict(PRIX, { prixAddress: OTHER, siteHost: 'prixagent.com' })).toBe('address');
    expect(verdict(OTHER, { prixAddress: OTHER, siteHost: 'prixagent.com' })).toBeNull();
    expect(verdict(OTHER.slice(0, 20), { prixAddress: OTHER, siteHost: 'prixagent.com' })).toBe('address');
  });

  it('judges the length after the fold, at exactly ROOM_TEXT_MAX and one over', () => {
    const longest = `${'gm all '.repeat(ROOM_TEXT_MAX)}`.slice(0, ROOM_TEXT_MAX - 2).concat('ok');
    expect(roomFoldText(longest)).toHaveLength(ROOM_TEXT_MAX);
    expect(verdict(`  ${longest.replaceAll(' ', '   ')}\n`)).toBeNull();
    expect(verdict(`${longest}s`)).toBe('length');
  });

  it('answers a problem of the list and nothing else, and never throws, whatever it is given', () => {
    const odd = [
      '\\',
      '(((((((',
      '$',
      '0x',
      '.',
      '%',
      '+',
      '@',
      `${'a.'.repeat(140)}`,
      `${'$a '.repeat(90)}`,
      `${'0x1 '.repeat(70)}`,
      `${'. '.repeat(140)}`,
      `${'a1'.repeat(140)}`,
      `${'what s '.repeat(40)}`,
      '\u0000\u0001\u0002',
      String.fromCharCode(0xd800),
    ];
    for (const text of odd) {
      const got = verdict(text);
      expect(got === null || ROOM_TEXT_PROBLEMS.includes(got), JSON.stringify(text)).toBe(true);
    }
  });
});

describe('where the rule lives', () => {
  const source = (name: string): string =>
    readFileSync(join(process.cwd(), 'packages/contracts/src', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('is one function for the composer and the server', () => {
    expect(composerRule).toBe(roomTextProblem);
  });

  it('sits in a file that imports text-guard.ts and nothing else, and neither imports zod', () => {
    const imports = [...source('room-text.ts').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports).toEqual(['./text-guard.ts']);
    expect(source('text-guard.ts')).not.toMatch(/from\s+['"]zod['"]/);
  });

  it('names one refusal for each problem, each a 400', () => {
    for (const problem of ROOM_TEXT_PROBLEMS) expect(ROOM_REFUSALS[`text_${problem}`], problem).toBe(400);
  });
});

describe("the contract's own helpers", () => {
  const NOW = '2026-10-20T12:10:30.000Z';
  const DAY = '2026-10-20';
  const writer = (over: Record<string, unknown> = {}) => ({
    address: OTHER,
    lastAt: null,
    day: null,
    count: 0,
    mutedAt: null,
    mutedBy: null,
    cutAt: null,
    ...over,
  });
  const ago = (seconds: number): string => new Date(Date.parse(NOW) - seconds * 1_000).toISOString();

  it('refuses a turn for a mute first, then the cap of the day, then the seconds between two messages', () => {
    const full = { day: DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY };
    expect(roomTurnRefusal(null, NOW, DAY)).toBeNull();
    expect(roomTurnRefusal(writer(), NOW, DAY)).toBeNull();
    expect(roomTurnRefusal(writer({ mutedAt: ago(5), ...full, lastAt: ago(1) }), NOW, DAY)).toBe('muted');
    expect(roomTurnRefusal(writer({ ...full, lastAt: ago(1) }), NOW, DAY)).toBe('day');
    expect(roomTurnRefusal(writer({ day: DAY, count: 1, lastAt: ago(1) }), NOW, DAY)).toBe('too_soon');
    // The edge of the seconds, and a count of another day.
    expect(roomTurnRefusal(writer({ lastAt: ago(ROOM_SECONDS_BETWEEN - 1) }), NOW, DAY)).toBe('too_soon');
    expect(roomTurnRefusal(writer({ lastAt: ago(ROOM_SECONDS_BETWEEN) }), NOW, DAY)).toBeNull();
    expect(roomTurnRefusal(writer({ ...full, day: '2026-10-19', lastAt: ago(3_600) }), NOW, DAY)).toBeNull();
    expect(roomTurnRefusal(writer({ day: DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY - 1 }), NOW, DAY)).toBeNull();
  });

  it('tells a 429 how long to wait, in whole seconds, at least one', () => {
    expect(roomRetryAfterSeconds('too_soon', NOW, ago(5))).toBe(ROOM_SECONDS_BETWEEN - 5);
    expect(roomRetryAfterSeconds('too_soon', NOW, ago(ROOM_SECONDS_BETWEEN - 0.4))).toBe(1);
    expect(roomRetryAfterSeconds('too_soon', NOW, ago(ROOM_SECONDS_BETWEEN + 50))).toBe(1);
    // A turn that another request of the wallet took a moment ago: the whole wait.
    expect(roomRetryAfterSeconds('too_soon', NOW, NOW)).toBe(ROOM_SECONDS_BETWEEN);
    expect(roomRetryAfterSeconds('too_soon', NOW, 'no time')).toBe(ROOM_SECONDS_BETWEEN);
    // 12:10:30 UTC: 49 minutes and 30 seconds to the hour, 11 hours more to midnight.
    expect(roomRetryAfterSeconds('room_hour', NOW, null)).toBe(49 * 60 + 30);
    expect(roomRetryAfterSeconds('room_day', NOW, null)).toBe(11 * 3_600 + 49 * 60 + 30);
    expect(roomRetryAfterSeconds('wallet_day', NOW, null)).toBe(11 * 3_600 + 49 * 60 + 30);
    expect(roomRetryAfterSeconds('room_hour', '2026-10-20T12:59:59.999Z', null)).toBe(1);
    expect(roomRetryAfterSeconds('room_day', '2026-10-20T00:00:00.000Z', null)).toBe(86_400);
  });

  it("reads the day's cap as a whole number of at most six digits, never above the ceiling of 600", () => {
    expect(ROOM_MESSAGES_PER_DAY_MAX).toBe(600);
    for (const value of ['600', '601', '100000', '999999']) expect(roomDailyCap(value), value).toBe(600);
    expect(roomDailyCap(' 250 ')).toBe(250);
    expect(roomDailyCap('599')).toBe(599);
    for (const value of ['', ' ', '-1', '1.5', '1e3', '0x10', '1000000', 'NaN', 'Infinity', '4 0 0']) {
      expect(roomDailyCap(value), JSON.stringify(value)).toBe(ROOM_MESSAGES_PER_DAY_DEFAULT);
    }
  });

  it("keys the room's counts by the UTC day, so that Phase 2 deletes them with the day's counters", () => {
    expect(roomDayKey(DAY)).toBe(`d:${DAY}:room:*`);
    expect(roomHourKey(DAY, 0)).toBe(`d:${DAY}:room:h00`);
    expect(roomHourKey(DAY, 23)).toBe(`d:${DAY}:room:h23`);
    const keys = new Set([roomDayKey(DAY), ...Array.from({ length: 24 }, (_, hour) => roomHourKey(DAY, hour))]);
    expect(keys.size).toBe(25);
    for (const key of keys) expect(key.startsWith(`d:${DAY}:`), key).toBe(true);
  });

  it('takes a body of one text and nothing else: an empty text passes the schema, a typed mark does not', () => {
    expect(roomPostRequestSchema.safeParse({ text: '' }).success).toBe(true);
    expect(roomPostRequestSchema.safeParse({ text: 'a'.repeat(2_000) }).success).toBe(true);
    expect(roomPostRequestSchema.safeParse({ text: 'a'.repeat(2_001) }).success).toBe(false);
    for (const body of [
      {},
      { text: 1 },
      { text: null },
      { text: ['gm'] },
      { text: 'gm', admin: true },
      { text: 'gm', author: OTHER },
      { text: 'gm', at: NOW },
      { text: 'gm', id: 1 },
      { text: 'gm', prixAddress: OTHER },
      { text: 'gm', siteHost: 'evil.io' },
    ]) {
      expect(roomPostRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});
