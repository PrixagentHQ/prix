import {
  ADVICE_WORDS,
  ROOM_PICTURE_ADMIN_NOTE,
  ROOM_PICTURE_ALT,
  ROOM_PICTURE_COMPOSER_NOTE,
  ROOM_PICTURE_COPY_KEYS,
  ROOM_PICTURE_DISCLAIMER,
  ROOM_PICTURE_LIMITS,
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_PROBLEMS,
  ROOM_PICTURE_REFUSALS,
  ROOM_PICTURE_ROW_NOTE,
  type RoomPictureSentenceField,
  roomPictureRefusalKey,
  SOCIAL_FORBIDDEN_WORDS,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from './deck.ts';
import { socialFacts } from './deck-social.ts';
import type { Block, Doc } from './doc.ts';
import { grouped, inWords, links } from './facts.ts';
import privacy from './pages/privacy.ts';
import terms from './pages/terms.ts';
import { roomPictureRefusalText } from './states.ts';

/**
 * What docs/contracts/phase-6-pictures.md asks of the words of pictures in the Community chat (sections
 * 11, 13 and 17). Every sentence is read from the deck, and every key from the contract's own list
 * (`ROOM_PICTURE_COPY_KEYS`): a test here pins a rule of the contract, not a wording.
 */

const read = (key: string): string => deck[key] ?? '';
const picture = (name: string): string => read(`social.roomPicture${name}`);
const pictureStrings = ROOM_PICTURE_COPY_KEYS.map((key) => [key, read(key)] as const);

const sentenceFields = (Object.keys(ROOM_PICTURE_REFUSALS) as (keyof typeof ROOM_PICTURE_REFUSALS)[]).filter(
  (field): field is RoomPictureSentenceField => field !== 'picture_views_day',
);

/** How many sentences a string holds: a full stop, a question mark or an exclamation mark before a space or the end. */
const sentencesIn = (value: string): number => (value.match(/[.!?](?:\s|$)/g) ?? []).length;
const slotsOf = (value: string): string[] =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();

/** Text that stands in for a sentence nobody has written yet. */
const UNWRITTEN = /\b(?:lorem|ipsum|todo|tbd|placeholder|fixme|xxx+|draft|pending|coming soon)\b/i;
/** Section 17: "No sentence near a picture says safe, verified or checked". Every form of the three. */
const VOUCHING = /\b(?:safe\w*|verif\w*|check\w*|approv\w*|trusted|genuine|official\w*)\b/i;
/** The names the code uses, which no visitor reads. */
const CODE_WORD = /\b(?:rooms?|bytes?|KV|D1|sweep|KiB)\b/;
const TIER_WORD = /\btiers?\b/i;
const ACQUIRE_WORD =
  /\b(?:buy|buys|buying|bought|get|gets|getting|got|acquire|acquires|acquiring|purchase|purchases|purchasing|obtain|obtains|obtaining|top up|grab|pick up)\b/i;

/** The slots the contract names for a key (the comment at `ROOM_PICTURE_COPY_KEYS`). Every other key has none. */
const SLOTS: Record<string, string[]> = {
  'social.roomPictureFacts': ['height', 'size', 'type', 'width'],
  'social.roomPictureFactsAnimated': ['frames', 'height', 'size', 'width'],
  'social.roomPictureNewWriter': ['minutes'],
  'social.roomPictureAdminOffState': ['at'],
  // The room's own word for a count that changes a sentence (`social.roomLeftOther`).
  'social.roomPictureLeftOther': ['count'],
  'social.roomPictureSizeKb': ['count'],
  'social.roomPictureAdminReportsOther': ['count'],
  'social.roomPictureAdminHash': ['hash'],
};
/** A size is a count and its unit: the one string of pictures with no word in small letters. */
const UNIT_ONLY = new Set(['social.roomPictureSizeKb']);

const CONTROLS = ['AdminRemove', 'AdminKeep', 'AdminOff', 'AdminOn'] as const;
const PARTS = ['', 'Busy', 'Question', 'Consequence', 'Done', 'Failed'] as const;

function blockStrings(block: Block): string[] {
  if (block.kind === 'list') return block.items;
  if (block.kind === 'table') return [...block.head, ...block.rows.flat()];
  return [block.text];
}

const tableRows = (doc: Doc): string[][] =>
  doc.sections.flatMap((section) => section.blocks).flatMap((block) => (block.kind === 'table' ? block.rows : []));

describe('the keys of pictures in the Community chat', () => {
  it('are the contract’s list, each once', () => {
    expect(ROOM_PICTURE_COPY_KEYS.length).toBeGreaterThan(70);
    expect(new Set(ROOM_PICTURE_COPY_KEYS).size).toBe(ROOM_PICTURE_COPY_KEYS.length);
    for (const key of ROOM_PICTURE_COPY_KEYS) expect(key).toMatch(/^social\.roomPicture[A-Z][A-Za-z]*$/);
  });

  it('each have a sentence in the deck that is no draft', () => {
    for (const key of ROOM_PICTURE_COPY_KEYS) {
      expect(Object.hasOwn(deck, key), `${key} has no entry in the deck`).toBe(true);
      const value = read(key);
      expect(value.trim().length, key).toBeGreaterThan(0);
      expect(value, key).toBe(value.trim());
      expect(UNWRITTEN.test(value), `${key}: ${value}`).toBe(false);
      expect(/[\n\r<>]|&(?:[a-z]+|#\d+);/i.test(value), `${key}: ${value}`).toBe(false);
      // No arrow appended, no meta line joined with a middle dot, no label in capitals only.
      expect(/[→·»›]|->/.test(value), `${key}: ${value}`).toBe(false);
      if (!UNIT_ONLY.has(key)) expect(/[a-z]/.test(value.replace(/\{\w+\}/g, '')), `${key}: ${value}`).toBe(true);
    }
  });

  it('are the only keys of pictures the deck holds', () => {
    // Revision 5: "There is no `SizeBytes` and no `Size`: one key and one rounding rule, and the deck drops the two."
    const held = Object.keys(deck).filter((key) => key.startsWith('social.roomPicture'));
    expect(held.filter((key) => !ROOM_PICTURE_COPY_KEYS.includes(key))).toEqual([]);
    expect(held.length).toBe(ROOM_PICTURE_COPY_KEYS.length);
  });

  it('carry the slots the contract names, and no other', () => {
    for (const [key, value] of pictureStrings) expect(slotsOf(value), key).toEqual(SLOTS[key] ?? []);
  });

  it('carry the words the contract gives a control on the two pages', () => {
    expect(picture('Show')).toBe('Show picture');
    expect(picture('Hide')).toBe('Hide picture');
    expect(picture('Add')).toBe('Add a picture');
    expect(picture('AdminReportedTitle')).toBe('Reported pictures');
    expect(picture('AdminShow')).toBe('Show picture');
    expect(picture('AdminRemove')).toBe('Remove picture');
    expect(picture('AdminKeep')).toBe('Keep picture');
    expect(picture('Send')).toBe('Send picture');
    expect(picture('AdminPicturesTitle')).toBe('Pictures');
    expect(picture('AdminMessagesTitle')).toBe('All messages');
  });

  it('name the switch by its act, as its question does, and never by a state', () => {
    // Revision 6, D6: "Pictures off" under "Pictures are on." read as a state and not as an act.
    expect(picture('AdminOff')).toBe('Switch pictures off');
    expect(picture('AdminOn')).toBe('Switch pictures on');
    expect(picture('AdminOffQuestion')).toBe(`${picture('AdminOff')}?`);
    expect(picture('AdminOnQuestion')).toBe(`${picture('AdminOn')}?`);
    for (const state of [picture('AdminOnState'), picture('AdminOffDone'), picture('AdminOnDone')]) {
      expect(state).not.toBe(picture('AdminOff'));
      expect(state).not.toBe(picture('AdminOn'));
    }
  });

  it('ask once before a report, in one question and one sentence, with no figure', () => {
    // Revision 6, P2: the first press opens the question; only the yes reports; the no restores the row.
    const ask = picture('ReportAsk');
    expect(ask).toMatch(/^Report this picture\? /);
    expect(sentencesIn(ask)).toBe(2);
    expect(ask).not.toMatch(/\d/);
    expect(ask).toMatch(/\bhidden\b/);
    expect(ask).toMatch(/\ban admin of Prix\b/);
    expect(picture('ReportYes')).toBe('Report');
    expect(picture('ReportNo')).toBe('Cancel');
    // The answer after the report uses the question's own words for who decides.
    expect(picture('ReportDone')).toMatch(/\ban admin of Prix\b/);
  });

  it('call whoever decides on a picture an admin of Prix, in every sentence', () => {
    for (const [key, value] of pictureStrings) expect(value, key).not.toMatch(/\bmoderat\w*/i);
  });

  it('say the send of a picture by one name, and of one that failed that it is still chosen', () => {
    expect(picture('Sending')).toBe('Sending picture');
    expect(picture('SendFailedTitle')).toBe('Picture not sent');
    for (const label of ['Send', 'Sending', 'SendFailedTitle', 'ReportYes', 'ReportNo', 'AdminReportedBy']) {
      expect(picture(label), label).not.toMatch(/[.!?:]$/);
    }
    const failed = picture('SendFailed');
    expect(failed).toMatch(/\bdid not reach Prix\b/);
    expect(failed).toMatch(/\bstill chosen\b/);
    expect(failed.split(/(?<=[.!?])\s+/).at(-1)).toMatch(/\bagain\b/);
  });

  it('say a size in whole KB, the unit of the largest size', () => {
    // Revision 5: one key and one rounding rule. The page rounds up; the deck gives the unit.
    expect(picture('SizeKb')).toBe('{count} KB');
    expect(picture('Limits')).toContain(picture('SizeKb').replace('{count}', grouped(ROOM_PICTURE_LIMITS.maxKib)));
  });

  it('hold the largest size the contract holds', () => {
    expect(socialFacts.pictureMaxBytes).toBe(ROOM_PICTURE_MAX_BYTES);
    expect(socialFacts.pictureMaxBytes).toBe(ROOM_PICTURE_LIMITS.maxKib * 1_024);
  });

  it('count the reports of a picture for one and for more, and name a closed report no reason', () => {
    expect(picture('AdminReportsOne')).toBe('1 report');
    expect(picture('AdminReportsOther')).toBe('{count} reports');
    const closed = picture('ReportClosed');
    expect(sentencesIn(closed)).toBe(1);
    expect(closed).not.toMatch(/\b(?:removed?|deleted?|kept|hidden|admins?|because|since)\b/i);
    // The hash is a slot: a figure typed beside it would pass for a limit of the contract.
    expect(picture('AdminHash')).not.toMatch(/\d/);
  });

  it('give each control of the admins a question, what it does, its result and its failure', () => {
    for (const control of CONTROLS) {
      const said = PARTS.map((part) => picture(`${control}${part}`));
      for (const value of said) expect(value.length, control).toBeGreaterThan(0);
      expect(new Set(said).size, control).toBe(PARTS.length);
      expect(picture(`${control}Question`), control).toMatch(/\?$/);
      // A label and a result are no sentences: nothing is appended to them.
      for (const part of ['', 'Busy', 'Done', 'Failed']) expect(picture(`${control}${part}`)).not.toMatch(/[.!?]$/);
    }
  });

  it('say before a removal that the file cannot be brought back', () => {
    // Section 11: "The confirmation of a removal says that the bytes cannot be brought back."
    expect(picture('AdminRemoveConsequence')).toMatch(/\bcannot be brought back\b/i);
  });

  it('never vouch for a picture, and hold no word of advice or of a promise', () => {
    for (const [key, value] of pictureStrings) {
      expect(VOUCHING.test(value), `${key}: ${value}`).toBe(false);
      expect(ADVICE_WORDS.test(value), `${key}: ${value}`).toBe(false);
      expect(SOCIAL_FORBIDDEN_WORDS.test(value), `${key}: ${value}`).toBe(false);
    }
  });

  it('name no tier, ask nobody to acquire the token, and use no word of the code', () => {
    for (const [key, value] of pictureStrings) {
      expect(TIER_WORD.test(value), `${key}: ${value}`).toBe(false);
      expect(ACQUIRE_WORD.test(value), `${key}: ${value}`).toBe(false);
      expect(CODE_WORD.test(value), `${key}: ${value}`).toBe(false);
      expect(value.includes('_'), `${key}: ${value}`).toBe(false);
    }
  });

  it('leave the five sentences of the contract to the contract', () => {
    const own = [
      ROOM_PICTURE_DISCLAIMER,
      ROOM_PICTURE_ROW_NOTE,
      ROOM_PICTURE_COMPOSER_NOTE,
      ROOM_PICTURE_ADMIN_NOTE,
      ROOM_PICTURE_ALT,
    ].flatMap((sentences) => sentences.split(/(?<=\.)\s+/));
    for (const [key, value] of pictureStrings) {
      for (const sentence of own) expect(value.includes(sentence), `${key} repeats "${sentence}"`).toBe(false);
    }
  });

  it('give a picture that is gone no reason, and every failed load one string', () => {
    // Section 11: the seven days, a key that is gone and a writer who is an admin wallet now all read so.
    const gone = picture('Gone');
    expect(sentencesIn(gone)).toBe(1);
    expect(gone).not.toMatch(/\b(?:days?|expir\w*|removed?|deleted?|admins?|reports?|because|since)\b/i);
    // An image's error carries no status: the sentence names none of the reasons either.
    expect(picture('LoadFailed')).not.toMatch(/\b(?:limit|views?|removed?|deleted?|admins?|reports?|because)\b/i);
    expect(picture('LoadFailed')).not.toBe(gone);
  });

  it('say of pictures that rest when they come back, in UTC', () => {
    expect(picture('Resting')).toContain('00:00 UTC');
    expect(picture('Off')).not.toBe(picture('Resting'));
    // Revision 6, D9: the long sentence once under the heading, and a short form in each picture row.
    const row = picture('RestingRow');
    expect(row).toContain('00:00 UTC');
    expect(sentencesIn(row)).toBe(1);
    expect(row.length).toBeLessThan(picture('Resting').length / 2);
  });

  it('take every number of a sentence from the limits of the contract', () => {
    const limits = ROOM_PICTURE_LIMITS;
    const said = picture('Limits');
    for (const figure of [limits.maxKib, limits.minSide, limits.maxSide, limits.maxFrames, limits.animatedMaxSide]) {
      expect(said, String(figure)).toContain(grouped(figure));
    }
    expect(said).toMatch(/\bJPEG\b.*\bPNG\b.*\bGIF\b/);
    // No other figure stands in any sentence of pictures: a count of the page's own is a slot.
    const known = new Set([...Object.values(limits).map((figure) => grouped(figure)), '1', '00:00']);
    for (const [key, value] of pictureStrings) {
      for (const figure of value.match(/\d[\d,:]*\d|\d/g) ?? []) {
        expect(known.has(figure), `${key} states ${figure}: ${value}`).toBe(true);
      }
    }
  });

  it('say what is left of a wallet’s pictures for the day, for one and for more', () => {
    expect(picture('LeftOne')).toMatch(/\b1 more picture\b/);
    expect(picture('LeftOther')).toMatch(/\{count\} more pictures\b/);
  });

  it('tell an admin who or what switched pictures off, in three different sentences', () => {
    const reasons = ['AdminOffByAdmin', 'AdminOffByReportsHour', 'AdminOffByReportsDay'].map(picture);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons[1]).toMatch(/\bhour\b/i);
    expect(reasons[2]).toMatch(/\bday\b/i);
  });

  it('give the admins a word for each state of a picture and of its file', () => {
    const states = ['Ok', 'Reported', 'Kept', 'Removed'].map((name) => picture(`AdminState${name}`));
    expect(new Set(states).size).toBe(states.length);
    expect(picture('AdminBytesGone')).not.toBe(picture('AdminBytesOwed'));
  });
});

describe('a sentence for every refusal of a picture', () => {
  it('exists for each field a page can show, shows no code, has no slot, and is shared by no two fields', () => {
    const seen = new Set<string>();
    for (const field of sentenceFields) {
      const sentence = roomPictureRefusalText(field);
      expect(sentence, field).toBe(read(roomPictureRefusalKey(field)));
      expect(sentence.trim().length, field).toBeGreaterThan(0);
      expect(sentence.includes('_'), `${field}: ${sentence}`).toBe(false);
      expect(sentence, field).not.toMatch(/\{\w+\}/);
      expect(seen.has(sentence), `${field} repeats the sentence of another field`).toBe(false);
      seen.add(sentence);
    }
    expect(seen.size).toBe(sentenceFields.length);
    expect(sentenceFields).not.toContain('picture_views_day');
  });

  it('says which rule a file broke, with the rule’s own figures, and what its sender does next', () => {
    const limits = ROOM_PICTURE_LIMITS;
    const rule: Record<(typeof ROOM_PICTURE_PROBLEMS)[number], RegExp[]> = {
      size: [new RegExp(`\\b${grouped(limits.maxKib)} KB\\b`)],
      type: [/\bJPEG\b/, /\bPNG\b/, /\bGIF\b/],
      malformed: [/\bdid not arrive whole\b/i, /\bcannot be read\b/i],
      dimensions: [
        new RegExp(`\\b${grouped(limits.minSide)}\\b`),
        new RegExp(`\\b${grouped(limits.maxSide)}\\b`),
        new RegExp(`\\b${grouped(limits.animatedMaxSide)}\\b`),
        /\bpixels\b/,
      ],
      frames: [new RegExp(`\\b${grouped(limits.maxFrames)} frames\\b`)],
    };
    expect(Object.keys(rule).sort()).toEqual([...ROOM_PICTURE_PROBLEMS].sort());
    for (const problem of ROOM_PICTURE_PROBLEMS) {
      const sentence = roomPictureRefusalText(`picture_${problem}`);
      for (const named of rule[problem]) expect(sentence, problem).toMatch(named);
      // The rule first, then the next step: two sentences, the second with "add".
      expect(sentencesIn(sentence), `${problem}: ${sentence}`).toBeGreaterThanOrEqual(2);
      expect(sentence.split(/(?<=[.!?])\s+/).at(-1), problem).toMatch(/\badd\b/i);
    }
  });

  it('says of a file that cannot be read nothing that is false of a picture that arrived late', () => {
    // Revision 6, S1: a body that did not arrive whole in time is `picture_malformed` too, and so is a
    // file the browser cannot draw (D14). The sentence never says that the file is broken.
    const sentence = roomPictureRefusalText('picture_malformed');
    expect(sentence).not.toMatch(/\b(?:broken|damaged|corrupt\w*|cut short|editor)\b/i);
    expect(sentence).toMatch(/\btry again\b/i);
    expect(sentence).toMatch(/\banother picture\b/i);
    expect(sentence).not.toMatch(/\bcounts as one of this wallet’s pictures\b/);
  });

  it('says of a picture that is too large that it could not be made small enough', () => {
    // Revision 6, D13: the sentence stands above "A larger photo ... is made smaller in your browser".
    const sentence = roomPictureRefusalText('picture_size');
    expect(sentence).toMatch(/\bcould not be made small enough\b/);
    expect(sentence).toMatch(/\bGIF\b/);
  });

  it('says two different waits in two sentences: an hour to add, a day to report', () => {
    // Section 8: a reporter waits a day and an uploader an hour, and one sentence cannot say both.
    const add = roomPictureRefusalText('picture_new_writer');
    const report = roomPictureRefusalText('report_new_writer');
    expect(add).toContain(`${ROOM_PICTURE_LIMITS.writerAgeMinutes} minutes`);
    expect(report).toContain(`${ROOM_PICTURE_LIMITS.reporterAgeHours} hours`);
    expect(add).not.toContain(`${ROOM_PICTURE_LIMITS.reporterAgeHours} hours`);
    expect(report).not.toContain(`${ROOM_PICTURE_LIMITS.writerAgeMinutes} minutes`);
  });

  it('says a wallet’s pictures of the day by the contract’s figure, and when the day turns', () => {
    const sentence = read('social.roomPictureRefusalWalletDay');
    expect(sentence).toContain(`${ROOM_PICTURE_LIMITS.perWalletPerDay} pictures`);
    expect(sentence).toContain('00:00 UTC');
    expect(read('social.roomPictureRefusalRoomDay')).toContain('00:00 UTC');
    expect(read('social.roomPictureRefusalReportWalletDay')).toContain('00:00 UTC');
  });

  it('tells a sender what a refusal after the turn has already cost', () => {
    // Section 5: a blocked file and a put that throws leave the wallet's picture of the day spent.
    for (const field of ['picture_blocked', 'picture_storage'] as const) {
      expect(roomPictureRefusalText(field), field).toMatch(/\bcounts as one of this wallet’s pictures for today\b/);
    }
  });

  it('tells a wallet that was muted once that it can still write', () => {
    // Section 3: "a lift gives back writing, not pictures".
    expect(roomPictureRefusalText('picture_not_allowed')).toMatch(/\bmuted\b.*\bcan still write\b/i);
  });

  it('apologises in none, and blames no sender', () => {
    for (const field of sentenceFields) {
      expect(roomPictureRefusalText(field), field).not.toMatch(/\b(?:sorry|apolog\w*|unfortunately|oops|please)\b/i);
    }
  });
});

describe('the privacy page and the terms, for pictures', () => {
  const row = tableRows(privacy).find((cells) => /\bpicture\b/i.test(cells[0] ?? ''));
  const [what = '', kept = '', seen = ''] = row ?? [];

  it('has a row of the privacy page for a picture, after the row of a message', () => {
    expect(row, 'a row whose first cell names a picture').toBeDefined();
    expect(what).toMatch(/Community chat/);
    const names = tableRows(privacy).map((cells) => cells[0] ?? '');
    expect(names.findIndex((name) => /\bpicture\b/i.test(name))).toBeGreaterThan(
      names.findIndex((name) => /\bmessage\b/i.test(name)),
    );
  });

  it('says in that row what section 13 asks', () => {
    const days = `${inWords(ROOM_PICTURE_LIMITS.shownDays)} days`;
    // Public beside the writer's short address until an admin removes it or its seven days end.
    expect(seen).toMatch(/\banyone\b/i);
    expect(seen).toMatch(/\bshortened\b/i);
    expect(seen).toMatch(/\buntil an admin removes\b/i);
    expect(seen).toContain(days);
    // Stored without the location, text and device tags a camera adds, for seven days.
    expect(kept).toMatch(/\bwithout the location, text and device tags a camera adds\b/);
    expect(kept).toContain(days);
    expect(`${kept} ${seen}`).not.toMatch(/\bhidden data\b/i);
    // A report is stored with the reporter's address until the message ages out, and nowhere after that.
    expect(kept).toMatch(/\breport\b.*\baddress\b.*\buntil\b/i);
    expect(kept).toMatch(/\bnowhere after\b/i);
    // The record of a removal is kept: the writer's address, the file's hash and facts, the count of reports.
    expect(kept).toMatch(/\brecord\b.*\bis kept\b/i);
    for (const word of [/\bwallet address\b/i, /\bfingerprint\b/i, /\bhow many\b.*\breported\b/i]) {
      expect(kept).toMatch(word);
    }
    expect(CODE_WORD.test(`${what} ${kept} ${seen}`), `${kept} ${seen}`).toBe(false);
  });

  it('has a paragraph of the terms for pictures, in the section of the Community chat', () => {
    const section = terms.sections.find((entry) => entry.id === 'community-chat');
    expect(section?.blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph']);
    const said = blockStrings(section?.blocks[1] as Block).join(' ');
    // A writer answers for a picture and holds the right to post it.
    expect(said).toMatch(/\banswer for\b/i);
    expect(said).toMatch(/\bright to post\b/i);
    // No addresses, links, codes, offers or advice in one; nothing unlawful.
    for (const word of [/\baddress(?:es)?\b/i, /\blinks?\b/i, /\bcodes?\b/i, /\boffers?\b/i, /\badvice\b/i]) {
      expect(said).toMatch(word);
    }
    expect(said).toMatch(/\bbreaks the law\b|\bunlawful\b/i);
    // Prix may remove any picture and end any wallet's pictures; where to write to have one removed.
    expect(said).toMatch(/\bremove any picture\b/i);
    expect(said).toMatch(/\bend any wallet’s pictures\b/i);
    expect(said).toContain(links.supportEmail);
    expect(VOUCHING.test(said.replace(/does not check/gi, '')), said).toBe(false);
    expect(CODE_WORD.test(said), said).toBe(false);
  });

  it('names one address for a removal request, the one the founder reads, in the terms and in a refusal', () => {
    // Section 12, point 2, and the founder’s word of 2026-10-11: the removal contact is this address and stays it.
    const contact = 'support@prixagent.com';
    const addresses = (value: string): string[] => value.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [];
    const section = terms.sections.find((entry) => entry.id === 'community-chat');
    expect(addresses(blockStrings(section?.blocks[1] as Block).join(' '))).toEqual([contact]);
    // A writer cannot take a picture back: the refusal of a report of its own picture says where to ask.
    expect(addresses(roomPictureRefusalText('report_own'))).toEqual([contact]);
  });

  it('says in both, of a page that is live before pictures are, that it speaks of when they are on', () => {
    expect(kept).toMatch(/^While pictures are switched on\b/);
    const section = terms.sections.find((entry) => entry.id === 'community-chat');
    expect(blockStrings(section?.blocks[1] as Block).join(' ')).toMatch(/^While pictures are switched on\b/);
  });
});
