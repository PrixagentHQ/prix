import {
  ADVICE_WORDS,
  ROOM_DISCLAIMER,
  ROOM_KEEP,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PAGE,
  ROOM_REFUSALS,
  ROOM_SECONDS_BETWEEN,
  ROOM_TEXT_MAX,
  ROOM_TEXT_PROBLEMS,
  ROOM_TOKEN_NOTE,
  ROOM_WRITE_MIN_TOKENS,
  type RoomRefusalField,
  type RoomTextProblem,
  roomTextProblem,
  SOCIAL_FORBIDDEN_WORDS,
  TOKEN_CACHE_SECONDS,
  TOKEN_RISE_HOLD_SECONDS,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from './deck.ts';
import type { Block, Doc } from './doc.ts';
import { grouped, hoursOf, minutesOf } from './facts.ts';
import privacy from './pages/privacy.ts';
import terms from './pages/terms.ts';
import { roomRefusalMoreFor, roomRefusalText, roomRefusalTextFor, roomWriterRefusalText } from './states.ts';

/**
 * What docs/contracts/phase-6-room.md asks of the words of the Community chat (sections 3, 9 and 10).
 * Every sentence is read from the deck: a test here pins a rule of the contract, not a wording.
 */

const ROOM_KEY = /^social\.room[A-Z]/;
const roomStrings = Object.entries(deck).filter(([key]) => ROOM_KEY.test(key));
const fields = Object.keys(ROOM_REFUSALS) as RoomRefusalField[];
const textFields = ROOM_TEXT_PROBLEMS.map((problem) => `text_${problem}` as const);

/** How many sentences a string holds: a full stop, a question mark or an exclamation mark before a space or the end. */
const sentencesIn = (value: string): number => (value.match(/[.!?](?:\s|$)/g) ?? []).length;

/** The deck key of a field's sentence: `text_bait` is `social.roomRefusalTextBait`. */
const refusalKey = (field: string): string =>
  `social.roomRefusal${field.replace(/(?:^|_)([a-z])/g, (_, letter: string) => letter.toUpperCase())}`;

/** The name the code uses, which no visitor reads. */
const CODE_WORD = /\brooms?\b/i;

/** What a wallet must hold to write, as a sentence says it: ROOM_WRITE_MIN_TOKENS whole tokens, by the ticker. */
const HOLDING = `at least ${grouped(ROOM_WRITE_MIN_TOKENS)} $PRIX`;

/** Revision 7: writing asks for a holding and for no tier, so no sentence of the chat names one. */
const TIER_WORD = /\btiers?\b/i;

/** A word that asks a reader to acquire the token, in any form a sentence could carry it. */
const ACQUIRE_WORD =
  /\b(?:buy|buys|buying|bought|get|gets|getting|got|acquire|acquires|acquiring|purchase|purchases|purchasing|obtain|obtains|obtaining|top up|grab|pick up)\b/i;

function blockStrings(block: Block): string[] {
  if (block.kind === 'list') return block.items;
  if (block.kind === 'table') return [...block.head, ...block.rows.flat()];
  return [block.text];
}

function sectionStrings(doc: Doc, id: string): string[] {
  const section = doc.sections.find((entry) => entry.id === id);
  return section ? [section.heading, ...section.blocks.flatMap(blockStrings)] : [];
}

describe('the keys of the Community chat', () => {
  const read = (key: string): string => deck[key] ?? '';

  it('carry the words the contract gives the two pages', () => {
    expect(read('social.roomTitle')).toBe('Community chat');
    expect(read('social.roomNav')).toBe('Chat');
    expect(read('social.roomLoadNew')).toBe('Load new messages');
    expect(read('social.roomAdminHide')).toBe('Hide message');
    expect(read('social.roomAdminMute')).toBe('Mute writer');
    expect(read('social.roomAdminUnmute')).toBe('Lift the mute');
  });

  it('give each control of the admins a question, what it does, its result and its failure', () => {
    for (const control of ['Hide', 'Mute', 'Unmute']) {
      for (const part of ['', 'Busy', 'Question', 'Consequence', 'Done', 'Failed']) {
        const key = `social.roomAdmin${control}${part}`;
        expect(read(key).length, key).toBeGreaterThan(0);
      }
    }
  });

  it('say who may write in one sentence, with the holding of the contract', () => {
    // Revision 7, section 3: a wallet that holds ROOM_WRITE_MIN_TOKENS whole $PRIX writes.
    const sentence = read('social.roomWhoWrites');
    expect(sentence).toContain(HOLDING);
    expect(sentence).toMatch(/\banyone can read\b/i);
    expect(sentence.match(/[.!?](?:\s|$)/g) ?? []).toHaveLength(1);
  });

  it('name no tier in any sentence', () => {
    // Section 9: "No sentence of the room names a tier".
    for (const [key, value] of roomStrings) expect(TIER_WORD.test(value), `${key}: ${value}`).toBe(false);
  });

  it('ask nobody to acquire the token', () => {
    // Section 9: "none asks anyone to acquire the token". A sentence says what a wallet holds, never how to come by it.
    for (const [key, value] of roomStrings) expect(ACQUIRE_WORD.test(value), `${key}: ${value}`).toBe(false);
  });

  it('tell a visitor of an empty chat the holding that writes', () => {
    const body = read('social.roomEmptyBody');
    expect(body).toContain(HOLDING);
    expect(sentencesIn(body)).toBe(2);
  });

  it('word the link under the sign-in sentence for the Account page, where a wallet’s holding is read', () => {
    // Revision 7: the link goes to the Account page's token part, and its words name the token by its ticker.
    const link = read('social.roomTiersLink');
    expect(link).toMatch(/\bAccount page\b/);
    expect(link).toContain('$PRIX');
    // A label, not a sentence: no full stop, and nothing appended to it.
    expect(link).toMatch(/^[A-Z][A-Za-z$’ ]+$/);
  });

  it('state the figures of the contract', () => {
    expect(read('social.roomComposerHint')).toContain(String(ROOM_TEXT_MAX));
    expect(read('social.roomComposerCount')).toContain(String(ROOM_TEXT_MAX));
    expect(read('social.roomNewestNote')).toContain(String(ROOM_PAGE));
    expect(roomRefusalText('text_length')).toContain(String(ROOM_TEXT_MAX));
    expect(roomRefusalText('too_soon')).toContain(String(ROOM_SECONDS_BETWEEN));
    // The sentence of the wallet's day, by its deck key: its field, written as a string in a file of the
    // site, reads as a wallet request to tests/unit/wallet-requests.test.ts.
    // Phase 6.8 (docs/contracts/phase-6-holders-2.md sections 2.2 and 7): the cap of a wallet's day rises
    // with its tier, so the sentence names no figure and says when the wallet writes again.
    const walletDay = read('social.roomRefusalWalletDay');
    expect(walletDay.replace('00:00 UTC', '')).not.toMatch(/\d/);
    expect(walletDay).not.toContain(String(ROOM_MESSAGES_PER_WALLET_PER_DAY));
    expect(walletDay).toContain('00:00 UTC');
  });

  it('never call it a room, and hold no word of advice or of a promise', () => {
    expect(roomStrings.length).toBeGreaterThan(40);
    for (const [key, value] of roomStrings) {
      expect(CODE_WORD.test(value), `${key}: ${value}`).toBe(false);
      expect(ADVICE_WORDS.test(value), `${key}: ${value}`).toBe(false);
      expect(SOCIAL_FORBIDDEN_WORDS.test(value), `${key}: ${value}`).toBe(false);
    }
  });

  it('give the admins a word for each reason the public does not see a message', () => {
    // Section 7: hidden, its writer muted now, or written at or before its writer's last mute.
    const reasons = ['Hidden', 'Muted', 'Cut'].map((name) => read(`social.roomAdminState${name}`));
    for (const reason of reasons) expect(reason.length).toBeGreaterThan(0);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it('ask no signed-in visitor of an empty chat to sign in', () => {
    // The design round, S3: the empty state has a body for each of the two visitors.
    expect(read('social.roomEmptyBody')).toMatch(/\bsign in\b/i);
    const signedIn = read('social.roomEmptyBodySignedIn');
    expect(signedIn.length).toBeGreaterThan(0);
    expect(signedIn).not.toMatch(/\bsign(?:ed)? in\b/i);
    expect(signedIn).not.toBe(read('social.roomEmptyBody'));
  });

  it('say the order of the list and that it stands still, in a note of two short sentences', () => {
    // The design round, C1: the note is short, so that the first message stands higher on a phone.
    const note = read('social.roomNewestNote');
    expect(note).toMatch(/\bnewest first\b/i);
    expect(note).toMatch(/\bdoes not update by itself\b/i);
    expect(sentencesIn(note)).toBe(2);
    expect(note.length).toBeLessThan(80);
  });

  it('have one body for a failed read of the admins’ page, which says to reload once', () => {
    // The design round, C6: the page shows this sentence and no second one beside it.
    const body = read('social.roomAdminLoadFailedBody');
    expect(body).toMatch(/\bcould not load\b/i);
    expect(body.match(/\breload\b/gi) ?? []).toHaveLength(1);
    expect(body.match(/\bagain\b/gi) ?? []).toHaveLength(0);
    expect(body).toMatch(/\bkeeps failing\b/i);
  });

  it('say of a lifted mute what revision 5 makes true: the cut is at the lift, not at the mute', () => {
    // Section 7: lifting a mute moves the cut to the writer's newest message.
    const consequence = read('social.roomAdminUnmuteConsequence');
    expect(consequence).not.toMatch(/\bbefore the mute\b/i);
    expect(consequence).toMatch(/\bup to now\b/i);
    expect(consequence).toMatch(/\bstay off the public page\b/i);
    // The chip and the intro are true of a message written while the mute was on, too.
    expect(read('social.roomAdminStateCut')).toMatch(/\bduring\b|\blifted\b/i);
    expect(read('social.roomAdminIntro')).toMatch(/\bduring\b|\blifted\b/i);
  });

  it('leave the two sentences of the contract to the contract', () => {
    const own = [ROOM_DISCLAIMER, ROOM_TOKEN_NOTE].flatMap((text) => text.split(/(?<=\.)\s+/));
    for (const [key, value] of roomStrings) {
      for (const sentence of own) expect(value.includes(sentence), `${key} repeats "${sentence}"`).toBe(false);
    }
  });
});

describe('a sentence for every refusal of the Community chat', () => {
  it('exists for each field of ROOM_REFUSALS, shows no code, and is shared by no two fields', () => {
    const seen = new Set<string>();
    for (const field of fields) {
      const sentence = roomRefusalText(field);
      expect(sentence.trim().length, field).toBeGreaterThan(0);
      expect(sentence.includes('_'), `${field}: ${sentence}`).toBe(false);
      expect(seen.has(sentence), `${field} repeats the sentence of another field`).toBe(false);
      seen.add(sentence);
    }
    expect(seen.size).toBe(fields.length);
  });

  it('is one sentence for the two codes of requireWriter, and no field shares it', () => {
    const sentence = roomWriterRefusalText('rate_limited');
    expect(sentence.trim().length).toBeGreaterThan(0);
    expect(roomWriterRefusalText('daily_limit')).toBe(sentence);
    expect(fields.map(roomRefusalText)).not.toContain(sentence);
  });

  it('never repeats the text it refuses: a sentence of a text rule has no slot', () => {
    expect(textFields.length).toBe(ROOM_TEXT_PROBLEMS.length);
    for (const field of textFields) {
      expect(roomRefusalText(field), field).not.toMatch(/\{\w+\}/);
      expect(roomRefusalMoreFor(field), field).not.toMatch(/\{\w+\}/);
    }
  });

  it('keeps the first sentence of a text rule alone, and the rest under the key that ends in More', () => {
    // The design round, S2: the first sentence stands beside the field in weight 600, the rest under it.
    for (const field of textFields) {
      const first = roomRefusalTextFor(field);
      const rest = roomRefusalMoreFor(field);
      expect(sentencesIn(first), `${field}: ${first}`).toBe(1);
      expect(rest.trim().length, field).toBeGreaterThan(0);
      expect(rest.includes('_'), `${field}: ${rest}`).toBe(false);
      expect(deck[refusalKey(field)], field).toBe(first);
      expect(deck[`${refusalKey(field)}More`], field).toBe(rest);
    }
    // The longest one: its first sentence says why and names no word yet.
    expect(roomRefusalTextFor('text_bait')).toMatch(/\bin any sense\b.*\bscams\b/i);
    expect(roomRefusalTextFor('text_bait')).not.toMatch(/Telegram|“/);
  });

  it('has no rest for a refusal that stands whole, and none for a field no page knows', () => {
    // A refusal that is not a text rule is shown as a notice or as a sentence of the page, whole.
    for (const field of fields.filter((name) => !name.startsWith('text_'))) {
      expect(roomRefusalMoreFor(field), field).toBe('');
      expect(deck[`${refusalKey(field)}More`], field).toBeUndefined();
    }
    for (const name of ['', 'constructor', 'toString', '__proto__', 'a_field_no_page_knows']) {
      expect(roomRefusalMoreFor(name), name).toBe('');
    }
    expect(roomRefusalMoreFor(undefined)).toBe('');
  });

  it('says when writing opens again in words a visitor knows', () => {
    // The design round, C9: "while tiers are switched on" is an inside word. Revision 7: writing asks
    // for no tier, so the sentence speaks of the holding Prix reads, by the token's ticker.
    const sentence = roomRefusalText('gate_off');
    expect(sentence).toMatch(/\bclosed for now\b/i);
    expect(sentence).toMatch(/\bopens\b/i);
    expect(sentence).toMatch(/\$PRIX holdings\b/);
    expect(TIER_WORD.test(sentence), sentence).toBe(false);
    expect(sentencesIn(sentence)).toBe(2);
  });

  it('names the words an honest writer meets, in the sentence of the rule that refuses them', () => {
    const allowed = { prixAddress: '0xa74ac6e9f2f8493344923c23972d496364241044', siteHost: 'prixagent.com' };
    // The honest lines the rule refuses (section 4), each with what its sentence names.
    const met: [string, RoomTextProblem, RegExp][] = [
      ['Is there a Telegram group?', 'bait', /other platform/i],
      ['The Prix team did well', 'bait', /\bstaff\b/i],
      ['Does Prix support SOL?', 'bait', /\bsupport\b/i],
      ['As the owner of two Prix agents', 'bait', /\bowner\b/i],
      ['Is there an airdrop?', 'bait', /\bairdrop\b/i],
      ['text me later', 'bait', /\btext me\b/i],
      // "claim" and "ticket" in any sense.
      ['I want to claim my seat at the table', 'bait', /\bclaim\b/i],
      ['got a ticket to the game', 'bait', /\bticket\b/i],
      ['not financial advice', 'words', /\bfinancial advice\b/i],
      // A digit inside a word, with the contract's own example in the sentence.
      ['my agent decided in 5m30s', 'spelled', /\bdigit\b.*5m30s/i],
      ['L1s are slow today', 'spelled', /\bdigit\b/i],
      // A full stop that reads as the dot of a host.
      ['new here. io errors', 'link', /\bfull stop\b.*\bio\b/i],
      ['Nice trade.Thanks', 'link', /\bfull stop\b/i],
    ];
    for (const [line, rule, named] of met) {
      expect(roomTextProblem(line, allowed), line).toBe(rule);
      // The first sentence and the rest, as the composer shows them: one under the other.
      const field = `text_${rule}` as const;
      expect(`${roomRefusalText(field)} ${roomRefusalMoreFor(field)}`, line).toMatch(named);
    }
  });

  it('has one general sentence for a refusal the page has no sentence for', () => {
    const general = roomRefusalTextFor('a_field_no_page_knows');
    // It says that the message was not sent and to try again, shows no code and has no slot.
    expect(general).toMatch(/\bnot sent\b/i);
    expect(general).toMatch(/\bagain\b/i);
    expect(general.includes('_'), general).toBe(false);
    expect(general).not.toMatch(/\{\w+\}/);
    // No field shares it, and a name every object has is no field.
    expect(fields.map(roomRefusalText)).not.toContain(general);
    for (const name of ['', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(roomRefusalTextFor(name), name).toBe(general);
    }
    expect(roomRefusalTextFor(undefined)).toBe(general);
  });

  it('gives a field its own sentence when the server names one', () => {
    for (const field of fields) expect(roomRefusalTextFor(field), field).toBe(roomRefusalText(field));
  });

  it('tells a wallet below the holding what writing takes', () => {
    // Section 9: writing takes a wallet that holds at least ROOM_WRITE_MIN_TOKENS $PRIX.
    expect(roomRefusalText('not_holder')).toContain(HOLDING);
  });

  it('tells a new holder how soon Prix reads a holding, and of a reload', () => {
    // Section 5, step 3: `me` reads a holding again once the stored read is TOKEN_CACHE_SECONDS old.
    const sentence = roomRefusalText('not_holder');
    expect(sentence).toContain(`within ${minutesOf(TOKEN_CACHE_SECONDS)}`);
    expect(sentence).toMatch(/\breload\b/i);
  });

  it('tells a new holder that the Account page reads the holding again at once', () => {
    const sentence = roomRefusalText('not_holder');
    expect(sentence).toMatch(/\bAccount page\b.*\bat once\b/);
  });

  it('no longer speaks of the hour the token gate waits before a tier rises', () => {
    // Section 5, step 3: "The hour the token gate waits before a tier rises does not apply here".
    const sentence = roomRefusalText('not_holder');
    expect(sentence).not.toContain(hoursOf(TOKEN_RISE_HOLD_SECONDS));
    expect(sentence).not.toMatch(/\bhours?\b/i);
  });
});

describe('the agent chat, which is live', () => {
  it('has a deck string for each key its component reads', () => {
    for (const name of ['Eyebrow', 'Title', 'AnswerBy', 'NoteHouse', 'NoteHow', 'NoteOwner']) {
      expect((deck[`social.chat${name}`] ?? '').length, name).toBeGreaterThan(0);
    }
  });
});

describe('the privacy page and the terms', () => {
  it('has a row for a message: public beside the short address, and for how long it is kept', () => {
    const tables = privacy.sections.flatMap((section) => section.blocks).filter((block) => block.kind === 'table');
    const row = tables
      .flatMap((table) => table.rows)
      .find((cells) => cells.some((cell) => /Community chat/.test(cell)));
    expect(row, 'a row that names the Community chat').toBeDefined();
    const said = (row ?? []).join(' ');
    expect(said).toMatch(/\banyone\b/i);
    expect(said).toMatch(/\bshortened\b/i);
    expect(said).toMatch(/\badmin\b/i);
    expect(said).toContain(grouped(ROOM_KEEP));
    expect(CODE_WORD.test(said), said).toBe(false);
  });

  it('says in that row what section 10 asks: until when it is public, until when stored, what is kept', () => {
    const tables = privacy.sections.flatMap((section) => section.blocks).filter((block) => block.kind === 'table');
    const row = tables
      .flatMap((table) => table.rows)
      .find((cells) => cells.some((cell) => /Community chat/.test(cell)));
    const [, kept = '', seen = ''] = row ?? [];
    // Public until an admin hides it or mutes its writer.
    expect(seen).toMatch(/\buntil an admin hides\b.*\bmutes\b/i);
    // Stored until it ages out of the newest ROOM_KEEP.
    expect(kept).toContain(`newest ${grouped(ROOM_KEEP)}`);
    // The three things kept for each writer: the time of its last message, the count of its day, a mute.
    expect(kept).toMatch(/\blast message\b/i);
    expect(kept).toMatch(/\bcount\b.*\bday\b/i);
    // `cut_at` is the time of the last mute and is never cleared: the row says that this time is kept.
    expect(kept).toMatch(/\blast muted\b/i);
  });

  it('has a paragraph of the terms under a heading of its own', () => {
    const section = terms.sections.find((entry) => /Community chat/.test(entry.heading));
    expect(section, 'a section whose heading names the Community chat').toBeDefined();
    // Its first block; Phase 6.4 sets the paragraph of pictures under it (room-pictures.test.ts).
    expect(section?.blocks[0]?.kind).toBe('paragraph');
    const said = sectionStrings(terms, section?.id ?? '').join(' ');
    // A writer answers for what they write; no links, addresses, offers or advice; Prix may remove and mute.
    for (const word of [/\banswer for\b/i, /\blinks?\b/i, /\baddress(?:es)?\b/i, /\boffers?\b/i, /\badvice\b/i]) {
      expect(said).toMatch(word);
    }
    expect(said).toMatch(/\bremove any message\b/i);
    expect(said).toMatch(/\bmute any wallet\b/i);
    expect(CODE_WORD.test(said), said).toBe(false);
  });
});
