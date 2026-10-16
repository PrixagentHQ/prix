import type { AgentPublic } from './api.ts';
import { MIN_TRADING_DAYS_TO_RANK } from './constants.ts';
import { ADVICE_WORDS } from './phase3-follow.ts';
import type { SocialApiDeps, SocialJob, SocialJobDeps } from './phase6-social.ts';
import { isSocialSafeText } from './phase6-social.ts';
import type { Address, AgentId, IsoTime, UtcDay } from './primitives.ts';
import { idSchema, isoTimeSchema } from './primitives.ts';
import { modelTextProblem } from './text-guard.ts';
import { z } from './zod.ts';

/**
 * Phase 6.2: an agent's voice, a linked X account, and the questions an agent answers (D-136, 2026-10-10).
 * docs/contracts/phase-6-voices.md says what these mean and what the rules are. Where the two disagree,
 * this file is the shape and that file is the rule.
 *
 * Everything here is paper and words. A voice never reaches a decision call, a reason, a summary or a
 * strategy time: it only chooses which sentence, written by the editor and filled with the agent's own
 * stored facts, a page shows. No model is asked, so no visitor and no owner can make an agent say
 * anything the editor did not write, except the stored reason and summary: those are model text, which an
 * answer shows as a quotation, in quotation marks, and only when `voiceQuoteProblem` finds nothing in
 * them. A linked X account says that the agent's owner controlled that account when it was last
 * checked, and nothing about who they are.
 */

// --- the switches ------------------------------------------------------------------------------------

/**
 * Worker variables of prix-api, each off unless exactly "true" after trimming and lower-casing. Voices
 * are on only while SOCIAL_ENABLED and VOICES_ENABLED are both on; linking an X account only while
 * X_LINK_ENABLED is on as well. Off: the public and owner routes of that part are not mounted and
 * answer the generic 404.
 */
export const VOICES_ENABLED_VAR = 'VOICES_ENABLED';
export const X_LINK_ENABLED_VAR = 'X_LINK_ENABLED';
export function voicesSwitchOn(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}
/**
 * The Worker variable that names one public post of @PrixagentHQ which the recheck reads first in every
 * run: a `gone` of a link counts only in a run in which this post read as `post`, so a moved endpoint or a
 * wall in front of X unlinks nobody. Empty or not a post id: no `gone` is ever counted.
 */
export const X_CANARY_POST_VAR = 'X_CANARY_POST_ID';

/**
 * GET /api/social/voices/status. 404 while voices are off, because the route is not mounted. The site
 * asks it once and keeps the answer for a minute, as it does for /api/social/status, so that a page costs
 * no request for a phase that is off.
 */
export const voicesStatusResponseSchema = z.strictObject({ on: z.literal(true), xLink: z.boolean() });
export type VoicesStatusResponse = z.infer<typeof voicesStatusResponseSchema>;

// --- voices ------------------------------------------------------------------------------------------

/** The voices an owner may choose. `plain` is every agent's voice until its owner picks another. */
export const AGENT_VOICES = ['plain', 'dry', 'sarcastic', 'shy', 'cheerful', 'formal', 'blunt'] as const;
export const agentVoiceSchema = z.enum(AGENT_VOICES);
export type AgentVoice = z.infer<typeof agentVoiceSchema>;
export const DEFAULT_VOICE: AgentVoice = 'plain';
/** Changes of voice an agent may have in one UTC day. A change never touches `strategyChangedAt`. */
export const VOICE_CHANGES_PER_DAY = 3;

/**
 * Stage 0 (the contract's section 14): the site alone, before this phase's API exists. The personalities
 * Prix gave its own house agents, by agent id. Deleted when the voice's read is deployed and these become
 * rows of `agent_voices`.
 */
export const HOUSE_VOICES: Readonly<Record<string, AgentVoice>> = {
  '5oq63nmwh5kz': 'sarcastic', // Crowd Favourites
  tgxiopdti5m2: 'blunt', // Crypto Proxies
  vvdzsaur4iyn: 'dry', // Oil And Idle
  qfoocl4nen6j: 'formal', // Big Tech Equal
  adiz4yeo5ams: 'shy', // Dip Buyer
  '3w6inochcjno': 'cheerful', // Momentum Five
  rqfkmxkfz72j: 'plain', // Treasury First
  '4nxdlbu3idgu': 'formal', // Index Core
  '2ynmb7yiulmp': 'dry', // Semis Rotation
};
/**
 * The voice of an agent in stage 0: the one Prix gave a house agent; for a house agent the list does not
 * name (a fixture, a new one) one chosen by its id, always the same; `plain` for everybody else, whose
 * owner cannot choose yet.
 */
export function stageZeroVoice(agent: { id: string; house?: boolean | undefined }): AgentVoice {
  const given = HOUSE_VOICES[agent.id];
  if (given !== undefined) return given;
  if (agent.house !== true) return DEFAULT_VOICE;
  let sum = 0;
  for (let i = 0; i < agent.id.length; i += 1) sum = (sum * 31 + agent.id.charCodeAt(i)) % 1_000_003;
  return AGENT_VOICES[sum % AGENT_VOICES.length] ?? DEFAULT_VOICE;
}

/**
 * What the newest row of an agent was, as a voiced line names it: `waiting` for no row; `skipped` for a
 * row that is `no_decision` or `skipped`; for a `decided` row `held` with no fill, `bought` with buys
 * only, `sold` with sells only, `rebalanced` with both.
 */
export const VOICE_EVENTS = ['bought', 'sold', 'rebalanced', 'held', 'skipped', 'waiting'] as const;
export type VoiceEvent = (typeof VOICE_EVENTS)[number];

/** The questions a page offers. `today` is answered with the event's own line. */
export const VOICE_QUESTIONS = ['today', 'why', 'holds', 'standing', 'strategy'] as const;
export type VoiceQuestion = (typeof VOICE_QUESTIONS)[number];

/**
 * The kinds of answer the editor writes. `why` and `strategy` quote stored model text; `why_none` and
 * `strategy_none` are for when there is none; `why_record` and `strategy_record` are for when there is
 * some and `voiceQuoteProblem` keeps it out of the agent's mouth: they point to the record, where it
 * stands as written.
 */
export const VOICE_ANSWERS = [
  'why',
  'why_none',
  'why_record',
  'holds',
  'holds_cash',
  'standing',
  'standing_unranked',
  'strategy',
  'strategy_none',
  'strategy_record',
] as const;
export type VoiceAnswer = (typeof VOICE_ANSWERS)[number];

/** Every slot a sentence may hold, written `{slot}`. */
export const VOICE_SLOTS = [
  'name',
  'bought',
  'sold',
  'count',
  'top',
  'cash',
  'held',
  'reason',
  'summary',
  'rank',
  'ranked',
  'days',
  'needed',
] as const;
export type VoiceSlot = (typeof VOICE_SLOTS)[number];

/** The slots a line for an event may use. */
export const VOICE_EVENT_SLOTS: Readonly<Record<VoiceEvent, readonly VoiceSlot[]>> = {
  bought: ['name', 'bought', 'count', 'top', 'cash'],
  sold: ['name', 'sold', 'count', 'top', 'cash'],
  rebalanced: ['name', 'bought', 'sold', 'count', 'top', 'cash'],
  held: ['name', 'top', 'cash', 'held'],
  skipped: ['name'],
  waiting: ['name'],
};
/** The slots an answer may use. */
export const VOICE_ANSWER_SLOTS: Readonly<Record<VoiceAnswer, readonly VoiceSlot[]>> = {
  why: ['name', 'reason'],
  why_none: ['name'],
  why_record: ['name'],
  holds: ['name', 'top', 'cash', 'held'],
  holds_cash: ['name'],
  standing: ['name', 'rank', 'ranked', 'days'],
  standing_unranked: ['name', 'days', 'needed'],
  strategy: ['name', 'summary'],
  strategy_none: ['name'],
  strategy_record: ['name'],
};
/**
 * An answer that quotes ends with its quotation and with nothing after it: `why` ends in `{reason}` and
 * `strategy` in `{summary}`, each used once. The filled slot carries its own quotation marks.
 */
export const VOICE_QUOTE_SLOT: Readonly<Partial<Record<VoiceAnswer, VoiceSlot>>> = {
  why: 'reason',
  strategy: 'summary',
};

/** Sentences the editor writes for each voice and event, and for each voice and kind of answer. */
export const VOICE_LINE_VARIANTS = 3;
export const VOICE_ANSWER_VARIANTS = 2;
/** The longest sentence the editor may write, slots unfilled. */
export const VOICE_TEMPLATE_MAX = 140;
/** Symbols a filled `{bought}` or `{sold}` names before it says "and N more". */
export const VOICE_SYMBOLS_SHOWN = 3;

/** Everything the editor writes for voices: `apps/web/src/content/voices.ts` exports one value of this shape. */
export interface VoiceDeck {
  /** The voice's name as a page shows it, for example "Dry". */
  names: Readonly<Record<AgentVoice, string>>;
  /** One sentence for the owner who chooses: what this voice sounds like. */
  about: Readonly<Record<AgentVoice, string>>;
  /** The question as the page words it, in the visitor's mouth. */
  questions: Readonly<Record<VoiceQuestion, string>>;
  lines: Readonly<Record<AgentVoice, Readonly<Record<VoiceEvent, readonly string[]>>>>;
  answers: Readonly<Record<AgentVoice, Readonly<Record<VoiceAnswer, readonly string[]>>>>;
}

/**
 * The agent's own facts a sentence is filled with, as `voiceFactsOf` reads them from one answer of
 * GET /api/agents/:id. That answer is cut by the viewer's delay, so an owner may be shown a newer row,
 * and so a newer line, than a visitor: as with every delayed fact of the agent page.
 */
export interface VoiceFacts {
  name: string;
  event: VoiceEvent;
  /** The tick of the newest row the read returned; null before a first row. It seeds the choice of a sentence. */
  tickId: string | null;
  /** The symbols bought and sold in the newest row when it is `decided`, in the order of its fills, each once. */
  bought: readonly string[];
  sold: readonly string[];
  /** Fills in that row; 0 when it is not `decided`. */
  count: number;
  /** The holding with the largest value; null when no holding is worth anything. */
  top: string | null;
  /** Cash as a whole percent of the portfolio's value, 0 to 100. */
  cash: number;
  /** Holdings other than cash that are worth something. */
  held: number;
  /** The stored reason of the newest row when it is `decided` and has one; null otherwise. */
  reason: string | null;
  /** The public summary of the strategy; null until one is written. */
  summary: string | null;
  /**
   * Whether this agent's stored text may be quoted at all. Stage 0: only a house agent's, whose prompt Prix
   * wrote. An owner's prompt shapes what the model stores, and no list of words stops a text written to
   * read as advice in the agent's mouth (the security read of 2026-10-10): an owner's agent answers that
   * its record holds the text as written.
   */
  quotes: boolean;
  /** The agent's rank and how many agents of its division are ranked; both null while it is unranked. */
  rank: number | null;
  ranked: number | null;
  /** Trading days on its record, and how many a rank needs. */
  days: number;
  needed: number;
}

/** The one way `VoiceFacts` is built. The agent page, the owner's page and qa's tests all call it. */
export function voiceFactsOf(agent: AgentPublic): VoiceFacts {
  const newest = agent.decisions[0] ?? null;
  const fills = newest !== null && newest.status === 'decided' ? newest.fills : [];
  const once = (side: 'buy' | 'sell'): string[] => {
    const symbols: string[] = [];
    for (const fill of fills) if (fill.side === side && !symbols.includes(fill.symbol)) symbols.push(fill.symbol);
    return symbols;
  };
  const bought = once('buy');
  const sold = once('sell');
  let event: VoiceEvent;
  if (newest === null) event = 'waiting';
  else if (newest.status !== 'decided') event = 'skipped';
  else if (fills.length === 0) event = 'held';
  else if (sold.length === 0) event = 'bought';
  else if (bought.length === 0) event = 'sold';
  else event = 'rebalanced';
  // A holding worth nothing is no holding a sentence may name or count.
  let top: string | null = null;
  let topValue = 0;
  let held = 0;
  for (const holding of agent.holdings) {
    if (holding.valueMicro <= 0) continue;
    held += 1;
    if (holding.valueMicro > topValue) {
      topValue = holding.valueMicro;
      top = holding.symbol;
    }
  }
  return {
    name: agent.name,
    event,
    tickId: newest?.tickId ?? null,
    bought,
    sold,
    count: fills.length,
    top,
    cash: agent.cashWeightBps / 100,
    held,
    reason: newest !== null && newest.status === 'decided' ? newest.reason : null,
    summary: agent.summary,
    quotes: agent.house === true,
    rank: agent.rank,
    ranked: agent.rank === null ? null : agent.rankedCount,
    days: agent.stats.tradingDays,
    needed: MIN_TRADING_DAYS_TO_RANK,
  };
}

const SLOT_PATTERN = /\{([a-z_]*)\}/g;
/** Words of the second person and of "we": a voiced sentence speaks of the agent's own portfolio, never to or about the reader. */
const READER_WORDS = /\b(you|your|yours|yourself|yourselves|we|us|our|ours|everyone|anyone|people)\b/i;
/** A scheme, a host, a handle, a cashtag or hex: no sentence carries one. */
const LINK_PATTERN =
  /(https?:|www\.|\b[a-z0-9-]+\.(?:com|io|xyz|org|net|app|fi)\b|0x[0-9a-fA-F]{4,}|@[A-Za-z0-9_]|\$[A-Za-z])/i;
/** Words of what is to come: no sentence and no quotation speaks of the future. */
const FUTURE_WORDS =
  /\b(will|won't|wont|shall|going to|gonna|soon|tomorrow|tonight|next (?:week|month|quarter|year)|by (?:mon|tues|wednes|thurs|fri|satur|sun)day|before it|double\w*|triple\w*|moon\w*|pump\w*|expect\w*|forecast\w*|predict\w*)\b/i;
/** The editor's own sentences never say "target" at all. */
const TARGET_ANY = /\btarget\w*\b/i;
/**
 * A quotation may: a strategy's own weights are its targets ("within five points of target", "target
 * weights"). What it may not hold is a target for a price: the word beside "price", or before a number.
 */
const TARGET_PRICE = /\bprice targets?\b|\btargets? price\b|\btarget\w*(?: of| at| is| to|:)? ?\$?\d/i;

/**
 * The marks of a quotation. It holds plain ASCII without the double quotation mark, opens with a capital
 * or a digit, and has an apostrophe only inside a word: so no text closes its own quotation (two
 * apostrophes read as a mark) and goes on as the page. Letters spelled apart or mixed with digits
 * ("B U Y", "Pr1x") are a way round the lists, and are refused with them.
 */
const QUOTE_CHARS = /^[A-Za-z0-9 .,;:!?'()%&/+\-$]*$/;
const QUOTE_OPENING = /^[A-Z0-9]/;
const QUOTE_APOSTROPHE = /(^|[^A-Za-z0-9])'|'(?![A-Za-z])/;
const QUOTE_SPELLED = /\b[a-z]\b(?:[ .\-/+][a-z]\b){2,}|[a-z]\d+[a-z]/i;
/** The first person and an audience, beside READER_WORDS: a stored reason is written in the third person, to nobody. */
const QUOTE_FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|me|my|mine|myself)\b/i;
const QUOTE_AUDIENCE =
  /\b(everybody|anybody|somebody|nobody|folks|guys|ur|ya|yall|friends|fam|shareholders?|buyers?|newcomers?|beginners?|members?|u(?!\.))\b/i;
/** A place to follow somebody, beside LINK_PATTERN: any host, a spelled-out dot, a telephone number, a platform's short name. */
const QUOTE_PLACE = /\b[a-z0-9-]+\.[a-z]{2,}\b|\bdot\b|\+?\d[\d ]{6,}\d|\b(?:on|via) x\b|\btg\b/i;
/** The future, beside FUTURE_WORDS. */
const QUOTE_FUTURE =
  /\b(\w+'ll|about to|poised|bound to|sure to|likely|headed|heading|goes to \$?\d+|on (?:its|the) way|can only|up only|only (?:go|goes) up|rall(?:y|ies|ied|ying)|break(?:s|ing)? out|breakout|soar\w*|rocket\w*|skyrocket\w*|explod\w*|surg\w*|\d+x|by (?:year|month|week)[ -]end)\b/i;
/**
 * Words of advice, of a claim, of an audience, of money asked for and of a place to follow somebody,
 * beside ADVICE_WORDS. Strict on purpose: a text these refuse loses only its quotation, never its place
 * on the record.
 */
const QUOTE_ADVICE =
  /\b(should\w*|must\w*|ought|advi[sc]\w*|tips|investors?|traders?|readers?|holders?|followers?|subscribers?|follow|join|dm|subscribe|best|smartest|safer|safest|winner\w*|wins?|won|beat\w*|champion\w*|outperform\w*|suitable|risk tolerance|bets?|betting|odds|wager\w*|jackpot|prize\w*|twitter|telegram|discord|instagram|tiktok|youtube|whatsapp|never (?:loses?|lost|fails?|failed))\b/i;
const QUOTE_CLAIMS =
  /\b(safe|sure|proven|easy|great|cheap\w*|undervalued|overvalued|bargain\w*|opportunit\w*|(?:the|a|top|great|premium|real|free) picks?|better than|ahead of|number one|top (?:agent|pick|choice|strategy)|verified|endorsed|approved|certified|audited|official\w*|staff|editor|moderator|admin\w*|system|league|conviction|worth (?:owning|having|holding|it)|to own|time to|profitable|rich|richer|wealth\w*|passive income|(?:real|easy|free|smart|more|make|makes|making|made|grow) money|real (?:trades?|picks?)|(?:zero|no|low|little|less|without) risk|riskless|go wrong|not lost|no los\w+|zero los\w+|\d+(?:\.\d+)?% (?:a|per|each|every) (?:day|week|month|year)|apy|roi|regret\w*|miss|paid|premium|vip|private|exclusive|presale|airdrop\w*|giveaway\w*|whitelist\w*|wallets?|send|pay|pays|payment\w*|deposit\w*|donat\w*|contact|owner|pr[i1l]x)\b/i;
/**
 * A sentence, or a clause after a comma or after a word such as "just" or "always", that opens with a bare
 * verb reads as an order. The record's own sentences open with "Holds", "Moves", "The", "It".
 */
const QUOTE_ORDER =
  /(?:^|[.!?;:,()-]\s*|\b(?:just|always|please|now|then|so|and|simply|better|never|kindly|ok|okay|yes)\s+)(?:buy|sell|load|get|grab|own|ape|hold|add|accumulate|stack|short|long|dump|pick|take|keep|go|put|move|invest|trade|watch|check|look|see|try|consider|act|hurry|do|don't|dont|copy|mirror|stay|be|rotate|allocate|ask|purchase|acquire|send|pay|search|call|visit|miss|read|click|contact|message|deposit|transfer|claim|mint|stake|swap|bridge|enter|exit|switch|trust)\b/i;

/** The slots a sentence names, in order, each once. An unknown name is returned as it stands. */
export function voiceSlotsOf(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(SLOT_PATTERN)) {
    const name = match[1] ?? '';
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

export type VoiceTemplateProblem = 'empty' | 'length' | 'braces' | 'slot' | 'reader' | 'link' | 'forecast' | 'words';

/**
 * Why a sentence of the editor's may not be used, or null. `allowed` is the list of slots of its place.
 * The editor and qa's test call this one function; the deck is checked before it ships, and a page does
 * not check it again. A list of words cannot judge meaning: a person reads the whole deck before the
 * switch goes on (the contract's gate 1).
 */
export function voiceTemplateProblem(text: string, allowed: readonly VoiceSlot[]): VoiceTemplateProblem | null {
  if (text.trim().length === 0) return 'empty';
  if (text.length > VOICE_TEMPLATE_MAX) return 'length';
  const bare = text.replace(SLOT_PATTERN, '');
  if (bare.includes('{') || bare.includes('}')) return 'braces';
  for (const slot of voiceSlotsOf(text)) {
    if (!(allowed as readonly string[]).includes(slot)) return 'slot';
  }
  if (READER_WORDS.test(bare)) return 'reader';
  if (LINK_PATTERN.test(bare)) return 'link';
  if (FUTURE_WORDS.test(bare) || TARGET_ANY.test(bare)) return 'forecast';
  if (!isSocialSafeText(bare) || modelTextProblem(bare) !== null) return 'words';
  return null;
}

export type VoiceQuoteProblem = 'braces' | 'marks' | 'reader' | 'link' | 'forecast' | 'advice' | 'words';

/**
 * Why a stored reason or summary may not stand in an agent's mouth, or null. It is model text shaped by
 * the owner's prompt, and the scheduler's guard passed it as a line of the record, in the third person.
 * As the answer to a visitor's question the same words can read as the agent advising the reader. So a
 * text is quoted only when it is plain ASCII with no double quotation mark (it cannot close its own
 * quotation and speak as the page), speaks to nobody and of no "I", holds no link and no place to follow
 * anybody, says nothing of the future, and holds no word of advice, of a claim or of an audience, and no
 * sentence that opens as an order. The lists are strict on purpose: what they refuse loses only its
 * quotation (the answer then points to the record, where the text stands as written). They cannot judge
 * meaning, and the contract says so.
 */
export function voiceQuoteProblem(stored: string): VoiceQuoteProblem | null {
  const text = stored.trim();
  if (text.includes('{') || text.includes('}')) return 'braces';
  if (!QUOTE_CHARS.test(text) || !QUOTE_OPENING.test(text) || QUOTE_APOSTROPHE.test(text) || QUOTE_SPELLED.test(text))
    return 'marks';
  // "US" in capitals is the country, not the reader.
  if (READER_WORDS.test(text.replace(/\bUS\b/g, ' ')) || QUOTE_FIRST_PERSON.test(text) || QUOTE_AUDIENCE.test(text))
    return 'reader';
  if (LINK_PATTERN.test(text) || QUOTE_PLACE.test(text)) return 'link';
  if (FUTURE_WORDS.test(text) || TARGET_PRICE.test(text) || QUOTE_FUTURE.test(text)) return 'forecast';
  // Once as written, and once with the marks that split a word taken out ("Bu-y").
  for (const read of [text, text.replace(/[-.'/+]/g, '')]) {
    if (ADVICE_WORDS.test(read) || QUOTE_ADVICE.test(read) || QUOTE_CLAIMS.test(read) || QUOTE_ORDER.test(read))
      return 'advice';
  }
  if (modelTextProblem(text) !== null) return 'words';
  return null;
}

/** Every reason a deck may not ship, each as "place: problem". Empty for a deck that may. */
export function voiceDeckProblems(deck: VoiceDeck): string[] {
  const problems: string[] = [];
  const check = (
    place: string,
    texts: readonly string[] | undefined,
    count: number,
    allowed: readonly VoiceSlot[],
    quote?: VoiceSlot,
  ) => {
    if (!texts || texts.length !== count) {
      problems.push(`${place}: ${texts?.length ?? 0} sentences, ${count} wanted`);
      return;
    }
    texts.forEach((text, i) => {
      const problem = voiceTemplateProblem(text, allowed);
      if (problem) problems.push(`${place}[${i}]: ${problem}`);
      else if (quote && (!text.endsWith(`{${quote}}`) || text.split(`{${quote}}`).length !== 2))
        problems.push(`${place}[${i}]: does not end in one {${quote}}`);
      if (texts.indexOf(text) !== i) problems.push(`${place}[${i}]: said twice`);
    });
  };
  for (const voice of AGENT_VOICES) {
    for (const [what, text] of [
      ['names', deck.names[voice]],
      ['about', deck.about[voice]],
    ] as const) {
      const problem = voiceTemplateProblem(text ?? '', []);
      if (problem) problems.push(`${what}.${voice}: ${problem}`);
    }
    for (const event of VOICE_EVENTS)
      check(`lines.${voice}.${event}`, deck.lines[voice]?.[event], VOICE_LINE_VARIANTS, VOICE_EVENT_SLOTS[event]);
    for (const answer of VOICE_ANSWERS) {
      check(
        `answers.${voice}.${answer}`,
        deck.answers[voice]?.[answer],
        VOICE_ANSWER_VARIANTS,
        VOICE_ANSWER_SLOTS[answer],
        VOICE_QUOTE_SLOT[answer],
      );
    }
  }
  for (const question of VOICE_QUESTIONS) {
    const text = deck.questions[question] ?? '';
    if (text.trim().length === 0 || text.length > VOICE_TEMPLATE_MAX || text.includes('{'))
      problems.push(`questions.${question}: empty, too long or with a slot`);
  }
  return problems;
}

function symbolList(symbols: readonly string[]): string | null {
  if (symbols.length === 0) return null;
  const shown = symbols.slice(0, VOICE_SYMBOLS_SHOWN);
  const more = symbols.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length === 1) return shown[0] ?? null;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** A stored text as an answer quotes it: in straight quotation marks, or null when it may not be quoted. */
function quoted(text: string | null): string | null {
  if (text === null || text.trim().length === 0 || voiceQuoteProblem(text) !== null) return null;
  return `"${text.trim()}"`;
}

/** What a slot says for these facts, or null when the fact is not there. */
export function voiceSlotValue(slot: VoiceSlot, facts: VoiceFacts): string | null {
  switch (slot) {
    case 'name':
      // A name is its owner's text, as a reason is: it stands in a sentence only for a house agent.
      return facts.quotes ? facts.name : null;
    case 'bought':
      return symbolList(facts.bought);
    case 'sold':
      return symbolList(facts.sold);
    case 'count':
      return facts.count > 0 ? String(facts.count) : null;
    case 'top':
      return facts.top;
    case 'cash':
      return `${Math.max(0, Math.min(100, Math.round(facts.cash)))}%`;
    case 'held':
      return String(facts.held);
    case 'reason':
      return facts.quotes ? quoted(facts.reason) : null;
    case 'summary':
      return facts.quotes ? quoted(facts.summary) : null;
    case 'rank':
      return facts.rank === null ? null : String(facts.rank);
    case 'ranked':
      // Fewer ranked agents than the rank is no fact a sentence may state.
      return facts.ranked === null || facts.rank === null || facts.ranked < facts.rank ? null : String(facts.ranked);
    case 'days':
      return String(facts.days);
    case 'needed':
      // An agent with enough trading days can still be unranked: the days are then not what a rank waits for.
      return facts.days >= facts.needed ? null : String(facts.needed);
  }
}

/**
 * The sentence with its slots filled, or null when one of its facts is not there. One pass: a filled
 * value is never read again for slots. Text only: the page escapes it.
 */
export function fillVoiceTemplate(text: string, facts: VoiceFacts): string | null {
  let missing = false;
  const filled = text.replace(SLOT_PATTERN, (whole, name: string) => {
    if (!(VOICE_SLOTS as readonly string[]).includes(name)) {
      missing = true;
      return whole;
    }
    const value = voiceSlotValue(name as VoiceSlot, facts);
    if (value === null) missing = true;
    return value ?? whole;
  });
  return missing ? null : filled;
}

/** The seed of a choice: the agent, the place (`line`, or a question's name) and the newest row's tick. */
export function voiceSeed(agentId: string, place: 'line' | VoiceQuestion, tickId: string | null): string {
  return `${agentId}|${place}|${tickId ?? 'none'}`;
}

/**
 * Which of several sentences an agent says: the same one for the same seed, so that a reload shows the
 * same words. Only sentences whose facts are all there take part; null when none does.
 */
export function pickVoiceText(texts: readonly string[], facts: VoiceFacts, seed: string): string | null {
  const filled = texts.map((text) => fillVoiceTemplate(text, facts)).filter((text): text is string => text !== null);
  if (filled.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < seed.length; i += 1) sum = (sum * 31 + seed.charCodeAt(i)) % 1_000_003;
  return filled[sum % filled.length] ?? null;
}

/** The kind of answer a question gets for these facts. `today` has none: it is the event's line. */
export function voiceAnswerFor(question: Exclude<VoiceQuestion, 'today'>, facts: VoiceFacts): VoiceAnswer {
  switch (question) {
    case 'why':
      if (facts.reason === null || facts.reason.trim().length === 0) return 'why_none';
      return facts.quotes && voiceQuoteProblem(facts.reason) === null ? 'why' : 'why_record';
    case 'holds':
      return facts.top === null ? 'holds_cash' : 'holds';
    case 'standing':
      return facts.rank === null || facts.ranked === null ? 'standing_unranked' : 'standing';
    case 'strategy':
      if (facts.summary === null || facts.summary.trim().length === 0) return 'strategy_none';
      return facts.quotes && voiceQuoteProblem(facts.summary) === null ? 'strategy' : 'strategy_record';
  }
}

/**
 * What a page shows for one place: the line of the day (`line`) or the answer to a question, in the
 * agent's voice, in `plain` when the voice has no sentence whose facts are there, and null when `plain`
 * has none either. The agent page and the owner's page both call it.
 */
export function voiceTextFor(
  deck: VoiceDeck,
  voice: AgentVoice,
  place: 'line' | VoiceQuestion,
  agentId: string,
  facts: VoiceFacts,
): string | null {
  const seed = voiceSeed(agentId, place, facts.tickId);
  const from = (v: AgentVoice): readonly string[] =>
    place === 'line' || place === 'today'
      ? (deck.lines[v]?.[facts.event] ?? [])
      : (deck.answers[v]?.[voiceAnswerFor(place, facts)] ?? []);
  return (
    pickVoiceText(from(voice), facts, seed) ??
    (voice === DEFAULT_VOICE ? null : pickVoiceText(from(DEFAULT_VOICE), facts, seed))
  );
}

// --- a linked X account ------------------------------------------------------------------------------

/** The numeric id of a post, the only thing the server takes from what an owner pastes. */
export const xPostIdSchema = z.string().regex(/^[1-9]\d{0,19}$/);
/** A handle as X writes it, without the at sign. */
export const xHandleSchema = z.string().regex(/^[A-Za-z0-9_]{1,15}$/);

/**
 * The id of the post a pasted address names, or null. Only x.com and twitter.com, with or without www or
 * mobile; the handle in the address is not read, since X answers by the id alone (read on 2026-10-10).
 */
export function xPostIdFromUrl(input: string): string | null {
  const match =
    /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status(?:es)?\/([1-9]\d{0,19})(?:[/?#].*)?$/.exec(
      input.trim(),
    );
  return match?.[1] ?? null;
}

/** The one address the server fetches for a post: X's public embed endpoint, no key (docs.x.com/x-for-websites/oembed-api). */
export const X_OEMBED_ORIGIN = 'https://publish.x.com';
export function xOembedUrl(postId: string): string {
  return `${X_OEMBED_ORIGIN}/oembed?url=${encodeURIComponent(`https://x.com/i/status/${postId}`)}&omit_script=true&dnt=true`;
}
/** How the endpoint is read. The byte cap is enforced while the body is read, not from a header. */
export const X_OEMBED_FETCH = { timeoutMs: 5_000, maxBytes: 16_384 } as const;

/** A proof code lives this long. It is not stored: it is an HMAC over the agent, the session's wallet and its expiry. */
export const X_LINK_CODE_TTL_SECONDS = 1_800;
export const X_LINK_CODE_PATTERN = /^prix-[0-9a-f]{8}[0-9a-f]{32}$/;
/** The label of the HMAC, under the secret that signs sign-in nonces. */
export const X_LINK_CODE_LABEL = 'x-link:v1';
/** The two routes of a link answer only a session created this recently; an older one is 401 and the page asks for a new sign-in. */
export const X_LINK_FRESH_SESSION_SECONDS = 900;

/**
 * The one sentence the owner posts: plain ASCII with nothing X turns into a link (X rewrites every address
 * in a post, and a name that looks like a host, to a t.co anchor in the embed). It names the agent by its
 * id, so a later change of the agent's name changes nothing. The post's text must equal it.
 */
export function xLinkSentence(agentId: string, code: string): string {
  return `I am linking this X account to my Prix agent, id ${agentId}. Code: ${code}`;
}

/** Handles that read as Prix or as a party Prix names, look-alike letters included. Refused at linking and at every recheck. */
export const X_HANDLE_REFUSED =
  /pr[i1l]x|r[o0]b[i1l]nh[o0]{2}d|cha[i1l]n[l1i][i1l]nk|[o0]ff[i1l]c[i1l]a[l1i]|supp[o0]rt|adm[i1l]n|staff|helpdesk/i;

/** Tries to link an X account, a wallet a UTC day and all wallets a UTC day: each is one fetch of X at most. */
export const X_LINK_TRIES_PER_WALLET_PER_DAY = 3;
export const X_LINK_TRIES_PER_DAY = 200;
/** The keys of the two counts, for `takeCounter` of Phase 2 (which deletes day counters by their `d:<day>:` start). */
export function xLinkTryKeys(day: UtcDay, wallet: Address): { wallet: string; all: string } {
  return { wallet: `d:${day}:xlink:${wallet}`, all: `d:${day}:xlink:*` };
}

/**
 * The recheck. A link is due when it was last tried more than `everyHours` ago; a run tries at most
 * `perRun` due links, the one tried longest ago first, after the canary post. A link is tried once a day
 * at most, so a miss is counted once a day at most.
 */
/**
 * `hideAfterDays`: a link with no good check for this long is in no response and no longer holds its handle
 * against another wallet; one failed try a day apart does not reach it, two in a row do. `deleteAfterDays`: a
 * link with no good check for this long is deleted by a run whose canary read `post`, that tried it and did
 * not read `post`. Without a good canary nothing is deleted, however old: a wall in front of X unlinks nobody.
 */
export const X_RECHECK = {
  perRun: 8,
  everyHours: 24,
  missesToUnlink: 2,
  hideAfterDays: 3,
  deleteAfterDays: 30,
} as const;

function decodeEntitiesOnce(text: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: String.fromCharCode(160),
  };
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return named[body] ?? whole;
  });
}

/** White space folded: runs of space, tab and line ends become one space, and the ends are trimmed. No other character is touched. */
export function xFoldSpace(text: string): string {
  return text.replace(/[ \t\r\n]+/g, ' ').trim();
}

/**
 * The text of a post as its embed gives it: the content of the blockquote's first paragraph only, a line
 * break as a space, tags removed, entities decoded once, white space folded. The trailer after that
 * paragraph (the display name, the handle, the date) is never part of it. No character is dropped, so a
 * zero-width or a direction character makes the text differ from the sentence. Null when the shape is
 * not that of an embedded post.
 */
export function xEmbedText(html: string): string | null {
  // Every step is one pass: 16 KB of "<" with no ">" took a pattern 400 ms (the second look's L2).
  const quote = /<blockquote\b/i.exec(html);
  if (!quote) return null;
  const quoteEnd = html.indexOf('>', quote.index);
  if (quoteEnd < 0) return null;
  let at = quoteEnd + 1;
  while (at < html.length && ' \t\r\n'.includes(html[at] ?? '')) at += 1;
  if (!/^<p[\s>]/i.test(html.slice(at, at + 3))) return null;
  const openEnd = html.indexOf('>', at);
  if (openEnd < 0) return null;
  const close = /<\/p>/gi;
  close.lastIndex = openEnd + 1;
  const closed = close.exec(html);
  if (!closed) return null;
  const inner = stripTags(html.slice(openEnd + 1, closed.index));
  return inner === null ? null : xFoldSpace(decodeEntitiesOnce(inner));
}

/** The text with its tags taken out, a line break as a space; null when a tag never closes. */
function stripTags(inner: string): string | null {
  let out = '';
  let at = 0;
  for (;;) {
    const lt = inner.indexOf('<', at);
    if (lt < 0) return out + inner.slice(at);
    const gt = inner.indexOf('>', lt);
    if (gt < 0) return null;
    // A tag that holds another open angle is no tag X writes.
    if (inner.slice(lt + 1, gt).includes('<')) return null;
    out += inner.slice(at, lt) + (/^<br[\s/]*>$/i.test(inner.slice(lt, gt + 1)) ? ' ' : '');
    at = gt + 1;
  }
}

/** What reading a post gave. `gone` is the endpoint's 404 and nothing else; everything that is not an answer is `unreadable`. */
export type XEmbedRead =
  | { kind: 'post'; postId: string; handle: string; text: string }
  | { kind: 'gone' }
  | { kind: 'unreadable' };

/**
 * A 200 answer of the embed endpoint, judged: `post` only when its `url` is `https://x.com/<handle>/status/<id>`
 * or the same on twitter.com, the id equal to the one asked; its `author_url` is `https://x.com/<handle>` or
 * the same on twitter.com, whole, with no query and no trailing slash; the two handles are equal, case
 * aside; and its `html` has the shape of an embedded post. `author_name` is never read. Anything else is
 * `unreadable`.
 */
export function readXOembed(body: unknown, askedId: string): XEmbedRead {
  if (typeof body !== 'object' || body === null) return { kind: 'unreadable' };
  const { url, author_url: authorUrl, html } = body as { url?: unknown; author_url?: unknown; html?: unknown };
  if (typeof url !== 'string' || typeof authorUrl !== 'string' || typeof html !== 'string')
    return { kind: 'unreadable' };
  const post = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d{0,19})$/.exec(url);
  const author = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})$/.exec(authorUrl);
  if (!post || !author || post[2] !== askedId) return { kind: 'unreadable' };
  const handle = author[1] ?? '';
  if ((post[1] ?? '').toLowerCase() !== handle.toLowerCase()) return { kind: 'unreadable' };
  const text = xEmbedText(html);
  if (text === null) return { kind: 'unreadable' };
  return { kind: 'post', postId: askedId, handle, text };
}

/**
 * The port to X's embed endpoint. `packages/runtime/src/social/x-embed.ts` implements it
 * (`createXEmbed(fetch)`); the entry gives the same value to the route and to the recheck job. It fetches
 * `xOembedUrl(postId)` and nothing else, whatever it is handed: an id that fails `xPostIdSchema` is
 * `unreadable` with no fetch. `redirect: 'manual'`, and any 3xx is `unreadable`; no cookie is sent or kept;
 * the body is cut at X_OEMBED_FETCH.maxBytes while it is read; a content type that is not JSON is
 * `unreadable`; 404 is `gone`; every other status but 200 is `unreadable` (a 403 too: what the endpoint
 * answers for a protected or suspended account is not measured); a 200 is `readXOembed`. No answer is
 * cached. It never throws.
 */
export interface XEmbedPort {
  read(postId: string): Promise<XEmbedRead>;
}

/** A link as it is stored. No token, no display name, no picture, no text of a post. */
export interface XLinkRecord {
  agentId: AgentId;
  /** The wallet that linked it. A public read answers no link whose `owner` is not the agent's owner now. */
  owner: Address;
  postId: string;
  /** The handle as X last returned it, and its lower-case form for the one-wallet rule. */
  handle: string;
  handleKey: string;
  linkedAt: IsoTime;
  /** The last read that answered `post`. */
  checkedAt: IsoTime;
  /** The last read of any outcome. */
  triedAt: IsoTime;
  /** Reads in a row that answered `gone`. */
  misses: number;
}

export interface AgentVoiceRecord {
  agentId: AgentId;
  /** A stored value that is not one of AGENT_VOICES is read as `plain` by the store's row mapper. */
  voice: AgentVoice;
  /** The UTC day of the latest change, and how many there were on that day. */
  changeDay: UtcDay | null;
  changeCount: number;
  updatedAt: IsoTime;
}

/**
 * `apps/api/src/store/voices.ts` exports `createVoicesStore(db)`. Every method is one D1 call or one D1
 * batch. Migration `infra/migrations/0011_voices.sql`: tables `agent_voices`, `x_links` (unique on the
 * post id; indexes on the handle key and on the time of the last try) and `x_link_blocks`.
 */
export interface VoicesStore {
  getVoice(agentId: AgentId): Promise<AgentVoiceRecord | null>;
  /**
   * Sets the voice in one statement that also counts the change of the day, and answers the changes left
   * today. Null, with nothing written, when the agent has had VOICE_CHANGES_PER_DAY changes on `day`.
   * Setting the voice the agent has, `plain` for an agent with no row included, is no change: nothing is
   * written and nothing is counted.
   */
  setVoice(agentId: AgentId, voice: AgentVoice, day: UtcDay, now: IsoTime): Promise<number | null>;
  getXLink(agentId: AgentId): Promise<XLinkRecord | null>;
  /** The agent that holds a post, or null: asked before a try is counted. */
  getXLinkByPost(postId: string): Promise<XLinkRecord | null>;
  /**
   * Stores a link, replacing the agent's own earlier one. Nothing is written for: `post_taken` (another
   * agent holds the post); `handle_taken` (a link of another wallet holds the handle key, and that link's
   * last good check is not older than X_RECHECK.hideAfterDays before this one's: a hidden link holds no
   * handle); `blocked` (a block names this agent, this owner or this handle key).
   */
  putXLink(link: XLinkRecord): Promise<'ok' | 'post_taken' | 'handle_taken' | 'blocked'>;
  deleteXLink(agentId: AgentId): Promise<void>;
  /**
   * The admin's removal, in one batch: writes a block that names the agent and, when the agent has a link,
   * that link's owner and handle key; then deletes the link. Other links of that owner or of that handle are
   * not touched here: each falls at its own next recheck, where `markXLinkChecked` answers `refused`. An agent
   * that already has a block keeps its row untouched (`ON CONFLICT(agent_id) DO NOTHING`): a second removal
   * finds no link and must not write nulls over the wallet and the handle. The link, if any, is still deleted.
   */
  blockXLink(agentId: AgentId, now: IsoTime): Promise<void>;
  /** The links last tried before `before`, the one tried longest ago first, at most `limit`. */
  listXLinksToCheck(before: IsoTime, limit: number): Promise<XLinkRecord[]>;
  /**
   * A read that answered `post`, in one statement: both times, the handle as X returned it now, and no
   * misses. `refused`, with nothing written, when `putXLink` would not store this link with that handle now
   * (`handle_taken` or `blocked`): the job then deletes the link.
   */
  markXLinkChecked(agentId: AgentId, handle: string, now: IsoTime): Promise<'ok' | 'refused'>;
  /** A read that answered `gone` in a run whose canary read `post`: the time of the try, and the misses after it. */
  markXLinkMissed(agentId: AgentId, now: IsoTime): Promise<number>;
  /** Any other read: the time of the try only. */
  markXLinkTried(agentId: AgentId, now: IsoTime): Promise<void>;
}

// --- the API ---------------------------------------------------------------------------------------

/** An X account as a page shows it: the handle, the proof post and the time of the last good check. */
export const xLinkPublicSchema = z.strictObject({
  handle: xHandleSchema,
  postId: xPostIdSchema,
  linkedAt: isoTimeSchema,
  checkedAt: isoTimeSchema,
});
export type XLinkPublic = z.infer<typeof xLinkPublicSchema>;

/**
 * GET /api/social/agents/:id/voice. Public, cached like every Phase 6 read, no session; 404 for an
 * unknown or hidden agent. `xLink` is null when there is none, when X_LINK_ENABLED is off, when the
 * link's owner is not the agent's owner now, and when the last good check is older than
 * X_RECHECK.hideAfterDays.
 */
export const agentVoiceResponseSchema = z.strictObject({
  agentId: idSchema,
  voice: agentVoiceSchema,
  xLink: xLinkPublicSchema.nullable(),
});
export type AgentVoiceResponse = z.infer<typeof agentVoiceResponseSchema>;

/** PUT /api/social/agents/:id/voice, the owner's session. */
export const setVoiceRequestSchema = z.strictObject({ voice: agentVoiceSchema });
export type SetVoiceRequest = z.infer<typeof setVoiceRequestSchema>;
/** Its answer, read from the store and never from a cache: the voice now, and the changes left today. */
export const setVoiceResponseSchema = z.strictObject({
  agentId: idSchema,
  voice: agentVoiceSchema,
  changesLeft: z.number().int().min(0).max(VOICE_CHANGES_PER_DAY),
});
export type SetVoiceResponse = z.infer<typeof setVoiceResponseSchema>;

/** POST /api/social/agents/:id/x-link/code, the owner's fresh session. Nothing is stored for it. */
export const xLinkCodeResponseSchema = z.strictObject({
  code: z.string().regex(X_LINK_CODE_PATTERN),
  /** The whole sentence to post, as `xLinkSentence` builds it. */
  sentence: z.string(),
  expiresAt: isoTimeSchema,
});
export type XLinkCodeResponse = z.infer<typeof xLinkCodeResponseSchema>;

/** POST /api/social/agents/:id/x-link, the owner's fresh session: the address of the post that carries the sentence. */
export const xLinkRequestSchema = z.strictObject({ postUrl: z.string().min(1).max(200) });
export type XLinkRequest = z.infer<typeof xLinkRequestSchema>;

/**
 * The fields a refusal of a link names, each with `invalid_input` (no new error code) and the status
 * beside it. The page has one sentence for each.
 */
export const X_LINK_REFUSALS = {
  /** Not the address of a post. */
  postUrl: 400,
  /** The post or the handle is linked elsewhere, or an admin removed this agent's link. */
  taken: 409,
  /** X says there is no such public post. */
  missing: 409,
  /** The post could not be read now; nothing is concluded. Try again later. */
  post: 409,
  /** The post's text is not the sentence for this agent and this wallet, or its code has expired: ask for a new code and post the sentence exactly. */
  sentence: 409,
  /** A handle Prix does not link. */
  handle: 409,
} as const;
export type XLinkRefusalField = keyof typeof X_LINK_REFUSALS;

/**
 * D1 rows a call may write, for `requireWriter`: an index written counts as a row. A voice is one row.
 * The code writes none. A link is the two counts of a try and the row with its three indexes. An unlink
 * is that row with its indexes; the admin's adds the block and its two indexes.
 */
export const VOICE_WRITE_ROWS = 1;
export const X_LINK_CODE_WRITE_ROWS = 0;
export const X_LINK_WRITE_ROWS = 6;
export const X_UNLINK_WRITE_ROWS = 4;
export const X_BLOCK_WRITE_ROWS = 7;

/**
 * `apps/api/src/http/social/voices/` exports `createVoicesRoutes(deps)`: the status, the voice's read and
 * write and the owner's unlink, mounted under SOCIAL_API_PREFIX only while `voicesEnabled` holds (an owner
 * can always take a stored handle away while voices are on), and the code and the link only while
 * `xLinkEnabled` holds as well; and `createVoicesAdminRoutes(deps)`: the admin's removal, mounted always,
 * the generic 404 to anyone who is not an admin session, whatever the switches say. The entry hands them to
 * `createApp` as `AppExtras.voices` and `AppExtras.voicesAdmin`, both of this type, and spells the two
 * names itself as it does for Phase 6. The proof code is an HMAC under `nonceSecret` with X_LINK_CODE_LABEL, compared in constant time,
 * so no secret is added. A write drops the cached read of that agent's voice.
 */
export interface VoicesApiDeps extends SocialApiDeps {
  voices: VoicesStore;
  xEmbed: XEmbedPort;
  /** SOCIAL_ENABLED and VOICES_ENABLED. */
  voicesEnabled: boolean;
  /** `voicesEnabled` and X_LINK_ENABLED. */
  xLinkEnabled: boolean;
}

/**
 * What `createXRecheckJob(deps): SocialJob` of `packages/runtime/src/social/x-recheck.ts` takes. Its name
 * is `x_recheck`; it is the sixth job of the social step. It runs under `guardSocialJob` like every social
 * job, is idle while `xLinkEnabled` is off or no link is due, and answers `more` while due links are left.
 * A run whose canary did not read `post` logs `x_recheck_canary` with the kind it read, and counts no miss.
 */
export interface XRecheckJobDeps extends Pick<SocialJobDeps, 'log' | 'social' | 'reputation' | 'now'> {
  voices: VoicesStore;
  xEmbed: XEmbedPort;
  xLinkEnabled: boolean;
  /** The value of X_CANARY_POST_ID when it passes `xPostIdSchema`; null otherwise. */
  canaryPostId: string | null;
}
export type CreateXRecheckJob = (deps: XRecheckJobDeps) => SocialJob;

/** The sentence every surface that shows a voiced line or an answer carries, server-rendered, as it stands. */
export const VOICE_DISCLAIMER =
  'Paper portfolio. Nothing on this page holds money, places an order or can accept any. Nothing this agent says is advice.';
/** And beside a linked X account. */
export const X_LINK_DISCLAIMER = 'Prix has not checked who this is and does not control what that account posts.';
