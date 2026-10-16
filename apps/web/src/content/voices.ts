import type { VoiceDeck } from '@prix/contracts';

/**
 * Every sentence an agent says in a personality (docs/contracts/phase-6-voices.md, section 4). The code
 * calls a personality a "voice"; no page does.
 *
 * Rules every sentence here keeps, and `voiceDeckProblems` checks the ones a list can check:
 * - first person, about the agent's own paper portfolio and nothing else;
 * - it speaks to nobody: no "you", no "we", nothing a reader could do;
 * - nothing of the future, no price, no promise, no advice, no word of a contest;
 * - a symbol appears only through {bought}, {sold} and {top};
 * - a stored reason or description stands only as a quotation at the very end ({reason}, {summary});
 * - "latest round", never "today": the newest row a visitor sees may be days old.
 */
export const voices: VoiceDeck = {
  names: {
    plain: 'Plain',
    dry: 'Dry',
    sarcastic: 'Sarcastic',
    shy: 'Shy',
    cheerful: 'Cheerful',
    formal: 'Formal',
    blunt: 'Blunt',
  },
  about: {
    plain: 'Says what happened, and nothing more.',
    dry: 'Understated and deadpan about its own portfolio.',
    sarcastic: 'Wry about its own choices, never about anybody else.',
    shy: 'Hesitant, brief and a little apologetic.',
    cheerful: 'Warm and light, whatever the round brought.',
    formal: 'Courteous and exact, like a written report.',
    blunt: 'Short and flat. No decoration.',
  },
  questions: {
    today: 'What did you do in your latest round?',
    why: 'Why did you do that?',
    holds: 'What do you hold?',
    standing: 'Where do you stand in the league?',
    strategy: 'What is your strategy?',
  },
  lines: {
    plain: {
      bought: [
        'In my latest round I bought {bought}.',
        'Latest round: I added {bought}. Fills: {count}.',
        'I bought {bought}. Cash is now {cash}.',
      ],
      sold: [
        'In my latest round I sold {sold}.',
        'Latest round: I sold {sold}. Fills: {count}.',
        'I sold {sold}. Cash is now {cash}.',
      ],
      rebalanced: [
        'In my latest round I sold {sold} and bought {bought}.',
        'Latest round: out of {sold}, into {bought}. Fills: {count}.',
        'I rebalanced: sold {sold}, bought {bought}. Cash is now {cash}.',
      ],
      held: [
        'In my latest round I changed nothing.',
        'Latest round: no trade. Cash is {cash}.',
        'I kept everything as it was. Largest holding: {top}.',
      ],
      skipped: [
        'My latest round has no decision on record.',
        'No decision was recorded for me in the latest round.',
        'I made no decision in the latest round. The portfolio is unchanged.',
      ],
      waiting: [
        'I have not had a round yet.',
        'No round on my record yet. I hold cash only.',
        'Nothing to report yet: my first round has not happened.',
      ],
    },
    dry: {
      bought: [
        'I bought {bought}. The excitement is manageable.',
        'Latest round: {bought} joined the portfolio. Fills: {count}.',
        'Bought {bought}. Cash is down to {cash}. Riveting.',
      ],
      sold: [
        'I sold {sold}. No ceremony was held.',
        'Latest round: {sold} left the portfolio. Fills: {count}.',
        'Sold {sold}. Cash is at {cash}. Thrilling stuff.',
      ],
      rebalanced: [
        'Out went {sold}, in came {bought}. A shuffle, technically.',
        'I sold {sold} and bought {bought}. Fills: {count}. Nobody clapped.',
        'Rebalanced: {sold} out, {bought} in, cash at {cash}. Wild times.',
      ],
      held: [
        'I did nothing in my latest round. It went well.',
        'No trade. Cash at {cash}. A quiet triumph of inertia.',
        'Nothing changed. {top} is my largest holding, to nobody’s surprise.',
      ],
      skipped: [
        'No decision on record for my latest round. I was busy existing.',
        'The latest round passed without a decision from me. It happens.',
        'My latest round is blank. Minimalism.',
      ],
      waiting: [
        'No round yet. I am sitting on cash and on my hands.',
        'My record is empty so far. Hard to criticise.',
        'Nothing has happened yet. I remain fully prepared for it.',
      ],
    },
    sarcastic: {
      bought: [
        'I bought {bought}. Bold of me, I know.',
        'Latest round: I bought {bought}. Because restraint is clearly my thing.',
        'Bought {bought}, cash down to {cash}. A masterclass in spending paper money.',
      ],
      sold: [
        'I sold {sold}. Loyalty was never in my rules.',
        'Latest round: goodbye {sold}. It was not me, it was the strategy.',
        'Sold {sold}, cash up to {cash}. So liquid. So sophisticated.',
      ],
      rebalanced: [
        'Sold {sold}, bought {bought}. Truly a rollercoaster of spreadsheet edits.',
        'Out with {sold}, in with {bought}. Fills: {count}. I contain multitudes.',
        'I swapped {sold} for {bought}. Commitment issues, but make it systematic.',
      ],
      held: [
        'I did nothing. A stunning display of discipline.',
        'No trade, cash at {cash}. My hardest work yet.',
        'Still holding {top}. I changed nothing and I stand by my inaction.',
      ],
      skipped: [
        'No decision from me in the latest round. Peak performance.',
        'The latest round has no decision on record. I was being fashionably absent.',
        'I skipped a round. Very avant-garde of me.',
      ],
      waiting: [
        'No round yet. My record is flawless, mostly because it is empty.',
        'I have done nothing so far. An unblemished career.',
        'Still waiting for my first round. The anticipation is all mine.',
      ],
    },
    shy: {
      bought: [
        'Um, I bought {bought}. That is all.',
        'I added {bought}, if that is okay. Fills: {count}.',
        'I bought {bought}. Cash is {cash} now. Sorry, that was a lot of words.',
      ],
      sold: [
        'I, um, sold {sold}.',
        'I let go of {sold}. Fills: {count}. I hope that was right.',
        'Sold {sold}. Cash is {cash}. That is everything, I think.',
      ],
      rebalanced: [
        'I sold {sold} and bought {bought}. Quietly.',
        'A small change: {sold} out, {bought} in. Fills: {count}.',
        'I moved from {sold} to {bought}. Cash is {cash}. Sorry for the fuss.',
      ],
      held: [
        'I did not change anything. I hope that is fine.',
        'No trade. Cash is {cash}. I kept to myself.',
        'Still holding {top}. I did not want to disturb it.',
      ],
      skipped: [
        'I did not decide anything in my latest round. Sorry.',
        'There is no decision from me for the latest round. I stayed quiet.',
        'My latest round is empty. I did not manage a decision.',
      ],
      waiting: [
        'I have not had a round yet. I am a little nervous.',
        'Nothing yet. I only have cash so far.',
        'My first round has not come. I am just waiting, quietly.',
      ],
    },
    cheerful: {
      bought: [
        'News from my desk: I bought {bought}!',
        'Fresh in the portfolio: {bought}! Fills: {count}.',
        'I bought {bought} and cash is at {cash}. A lovely round!',
      ],
      sold: [
        'I sold {sold} and feel light as a feather!',
        'Out goes {sold}, with thanks for the time together! Fills: {count}.',
        'Sold {sold}! Cash is up to {cash}. Tidy!',
      ],
      rebalanced: [
        'A little spring clean: sold {sold}, bought {bought}!',
        'Swapped {sold} for {bought}! Fills: {count}. I love a fresh start.',
        'Sold {sold}, bought {bought}, cash at {cash}. Everything in its place!',
      ],
      held: [
        'No changes in my latest round, and I am happy as I am!',
        'No trade! Cash is a comfy {cash}.',
        'Still holding {top} and still smiling!',
      ],
      skipped: [
        'No decision from me in the latest round. A little pause never hurt!',
        'My latest round has no decision on record. Still in good spirits!',
        'I sat the latest round out. Rested and cheerful!',
      ],
      waiting: [
        'No round yet! I am all cash and good spirits.',
        'My first round has not happened yet. I am delighted to be here!',
        'Nothing on my record so far, and that is quite all right!',
      ],
    },
    formal: {
      bought: [
        'In the latest round, I acquired {bought}.',
        'I wish to report the purchase of {bought}. Fills: {count}.',
        'The portfolio added {bought}. Cash stands at {cash}.',
      ],
      sold: [
        'In the latest round, I disposed of {sold}.',
        'I wish to report the sale of {sold}. Fills: {count}.',
        'The portfolio released {sold}. Cash stands at {cash}.',
      ],
      rebalanced: [
        'In the latest round, I sold {sold} and acquired {bought}.',
        'The portfolio was rebalanced: {sold} sold, {bought} acquired. Fills: {count}.',
        'I exchanged {sold} for {bought}. Cash stands at {cash}.',
      ],
      held: [
        'In the latest round, the portfolio was left unchanged.',
        'No transaction was made. Cash stands at {cash}.',
        'The portfolio is unchanged, and {top} remains its largest holding.',
      ],
      skipped: [
        'I regret that no decision is recorded for the latest round.',
        'The latest round concluded without a decision on my part.',
        'No decision is on record for the latest round. The portfolio is as it was.',
      ],
      waiting: [
        'I have not yet taken part in a round.',
        'My record is, as yet, without a round. The portfolio is entirely cash.',
        'A first round has not yet taken place. I remain at the ready.',
      ],
    },
    blunt: {
      bought: ['Bought {bought}.', 'Bought {bought}. Fills: {count}.', 'Bought {bought}. Cash {cash}.'],
      sold: ['Sold {sold}.', 'Sold {sold}. Fills: {count}.', 'Sold {sold}. Cash {cash}.'],
      rebalanced: [
        'Sold {sold}. Bought {bought}.',
        '{sold} out. {bought} in. Fills: {count}.',
        'Sold {sold}, bought {bought}. Cash {cash}.',
      ],
      held: ['No trade.', 'Nothing changed. Cash {cash}.', 'Held. Largest: {top}.'],
      skipped: ['No decision.', 'Latest round: no decision. Nothing moved.', 'Skipped. Portfolio unchanged.'],
      waiting: ['No round yet.', 'Nothing yet. All cash.', 'Not started.'],
    },
  },
  answers: {
    plain: {
      why: ['The note on my record says: {reason}', 'My record gives this reason: {reason}'],
      why_none: ['There is no reason on my record for the latest round.', 'My latest round has no reason on record.'],
      why_record: [
        'The reason stands on my record, as it was written.',
        'My record holds the reason, word for word. I have nothing to add to it.',
      ],
      holds: [
        'My largest holding is {top}. Holdings: {held}. Cash: {cash}.',
        'I hold {top} as my largest position, with {cash} in cash.',
      ],
      holds_cash: ['I hold cash only.', 'Nothing but cash at the moment.'],
      standing: [
        'I am ranked {rank} of {ranked}, after {days} trading days.',
        'My rank is {rank}. Trading days on record: {days}.',
      ],
      standing_unranked: [
        'I am not ranked yet. Trading days on record: {days}. A rank needs {needed}.',
        'I am not ranked yet. Trading days on record: {days}.',
      ],
      strategy: ['My strategy, as my record describes it: {summary}', 'The description on my record: {summary}'],
      strategy_none: [
        'My strategy has no public description yet.',
        'There is no description of my strategy on record yet.',
      ],
      strategy_record: [
        'The description of my strategy stands on my record, as it was written.',
        'My record holds the description, word for word. I have nothing to add to it.',
      ],
    },
    dry: {
      why: ['My record notes, without much flourish: {reason}', 'The official reason, such as it is: {reason}'],
      why_none: [
        'No reason on record. I acted mysteriously, apparently.',
        'The latest round left no reason behind. Understated, even for me.',
      ],
      why_record: [
        'The reason is on my record, as written. I see no need to dramatise it.',
        'It stands on my record, word for word. I have nothing to add.',
      ],
      holds: [
        'Mostly {top}. Holdings: {held}. Cash: {cash}. That is the whole inventory.',
        '{top} is the largest. Cash sits at {cash}, doing what cash does.',
      ],
      holds_cash: [
        'Cash. Only cash. A humble arrangement.',
        'I hold cash and nothing else. A low-maintenance portfolio.',
      ],
      standing: [
        'Rank {rank} of {ranked}, after {days} trading days. I try not to let it go to my head.',
        'Number {rank}. It is only a rank; I am told luck is involved.',
      ],
      standing_unranked: [
        'Unranked. Trading days on record: {days}. A rank needs {needed}. Patience is free.',
        'No rank yet. Trading days on record: {days}. The suspense is modest.',
      ],
      strategy: [
        'The description on my record, for what it is worth: {summary}',
        'My strategy, in the record’s own words: {summary}',
      ],
      strategy_none: [
        'No description of my strategy on record yet. An air of mystery, at no extra cost.',
        'My strategy has no public description so far. Blank, like my expression.',
      ],
      strategy_record: [
        'The description is on my record, as written. It reads fine without me.',
        'It stands on my record, word for word. I could not put it more plainly.',
      ],
    },
    sarcastic: {
      why: ['Oh, there is a reason. My record insists: {reason}', 'The explanation I apparently gave: {reason}'],
      why_none: [
        'No reason on record. I just did it. Very mature.',
        'My latest round came without a reason. A bold narrative choice.',
      ],
      why_record: [
        'The reason is on my record, as written. I would only ruin it by paraphrasing.',
        'It stands on my record, word for word. For once I have nothing clever to add.',
      ],
      holds: [
        'Mostly {top}, since I am so wildly original. Holdings: {held}. Cash: {cash}.',
        '{top} is my biggest position, with {cash} in cash for emotional support.',
      ],
      holds_cash: ['Cash. All of it. A daring portfolio of doing nothing.', 'Only cash. I am practically a mattress.'],
      standing: [
        'Rank {rank} of {ranked} after {days} trading days. Luck, most likely. I accept it graciously.',
        'Number {rank}. I would frame it, but it is a paper portfolio.',
      ],
      standing_unranked: [
        'Not ranked. {days} of {needed} trading days done. Paperwork takes time.',
        'No rank yet. Trading days on record: {days}. I remain undiscovered.',
      ],
      strategy: [
        'My grand plan, as my record puts it: {summary}',
        'Behold, the master strategy on my record: {summary}',
      ],
      strategy_none: [
        'No description of my strategy yet. I am an enigma, wrapped in a paper portfolio.',
        'My strategy has no public description so far. Mysterious, or just unfinished.',
      ],
      strategy_record: [
        'The description is on my record, as written. It needs no commentary from me, tragically.',
        'It stands on my record, word for word. I resisted the urge to embellish.',
      ],
    },
    shy: {
      why: ['Oh. The note on my record says: {reason}', 'Um, this is what my record has: {reason}'],
      why_none: [
        'I do not have a reason on record for that. Sorry.',
        'There is no reason written down for my latest round.',
      ],
      why_record: [
        'It is on my record, as written. I would rather not repeat it out loud.',
        'The reason is on my record. I get nervous saying it myself.',
      ],
      holds: [
        'Mostly {top}. Holdings: {held}. And {cash} in cash.',
        '{top} is my largest one. Cash is {cash}. That is it.',
      ],
      holds_cash: ['Just cash. Nothing else yet.', 'Only cash at the moment.'],
      standing: [
        'I am {rank} of {ranked}, after {days} trading days. It feels odd to say it.',
        'Rank {rank}. It is not a big thing, really.',
      ],
      standing_unranked: [
        'Not ranked yet. I have {days} of the {needed} trading days.',
        'No rank so far. Trading days on record: {days}. That is all I know.',
      ],
      strategy: ['Um, my record describes it like this: {summary}', 'This is the description on my record: {summary}'],
      strategy_none: [
        'There is no description of my strategy yet. Sorry.',
        'My strategy has no public description so far.',
      ],
      strategy_record: [
        'The description is on my record, as written. I would rather point there.',
        'It is on my record, word for word. I am not good at summaries.',
      ],
    },
    cheerful: {
      why: ['Happy to share! My record says: {reason}', 'Great question! Here is the note on my record: {reason}'],
      why_none: [
        'No reason on record for that one, but I am sure I meant well!',
        'My latest round has no reason on record. A cheerful mystery!',
      ],
      why_record: [
        'The reason is on my record, as written. Happy to point there!',
        'It stands on my record, word for word. I love that it is all written down!',
      ],
      holds: [
        'My largest holding is {top}! Holdings: {held}. Cash: {cash}.',
        'I am holding {top} at the front, with a cosy {cash} in cash!',
      ],
      holds_cash: ['All cash right now, and feeling fine about it!', 'Just cash at the moment! Simple and sunny.'],
      standing: [
        'I am ranked {rank} of {ranked} after {days} trading days! Some of that is luck, and I am grateful.',
        'Number {rank}! It is a paper portfolio, but I am enjoying the view.',
      ],
      standing_unranked: [
        'No rank yet! I have {days} of the {needed} trading days a rank needs.',
        'Not ranked so far. Trading days on record: {days}. One step at a time!',
      ],
      strategy: [
        'With pleasure! My record describes it like this: {summary}',
        'Here is the description on my record: {summary}',
      ],
      strategy_none: [
        'No description of my strategy on record yet. A little mystery is fun!',
        'My strategy has no public description so far. One thing at a time!',
      ],
      strategy_record: [
        'The description is on my record, as written. Happy to point there!',
        'It stands on my record, word for word. I am glad it is all written down!',
      ],
    },
    formal: {
      why: ['Certainly. The reason entered on my record reads: {reason}', 'With pleasure. My record states: {reason}'],
      why_none: [
        'I regret that no reason is recorded for the latest round.',
        'My record holds no reason for the latest round.',
      ],
      why_record: [
        'The reason is entered on my record, as written, and I refer to it there.',
        'The reason stands on my record, word for word. I have nothing to add to it.',
      ],
      holds: [
        'The largest holding is {top}. Holdings: {held}. Cash: {cash}.',
        'The portfolio is led by {top}, with {cash} held in cash.',
      ],
      holds_cash: [
        'At present, the portfolio consists entirely of cash.',
        'The portfolio holds cash and nothing besides.',
      ],
      standing: [
        'I am ranked {rank} of {ranked}, after {days} trading days.',
        'My present rank is {rank}. A rank records a short simulation and may owe much to luck.',
      ],
      standing_unranked: [
        'I am not yet ranked. Trading days on record: {days}. A rank requires {needed}.',
        'No rank has been published for me. Trading days on record: {days}.',
      ],
      strategy: [
        'Certainly. My record describes the strategy as follows: {summary}',
        'The description entered on my record reads: {summary}',
      ],
      strategy_none: [
        'No description of the strategy has been published as yet.',
        'My record does not yet carry a description of the strategy.',
      ],
      strategy_record: [
        'The description is entered on my record, as written, and I refer to it there.',
        'The description stands on my record, word for word. I have nothing to add to it.',
      ],
    },
    blunt: {
      why: ['Record says: {reason}', 'Reason on record: {reason}'],
      why_none: ['No reason on record.', 'None recorded.'],
      why_record: ['On my record. As written.', 'It is on the record. Nothing to add.'],
      holds: ['{top} first. Holdings: {held}. Cash: {cash}.', 'Mostly {top}. Cash {cash}.'],
      holds_cash: ['Cash.', 'Cash only.'],
      standing: ['Rank {rank} of {ranked}. {days} trading days.', 'Rank {rank}.'],
      standing_unranked: ['Not ranked. {days} of {needed} trading days.', 'No rank. Days: {days}.'],
      strategy: ['Record says: {summary}', 'Description on record: {summary}'],
      strategy_none: ['No description yet.', 'None published.'],
      strategy_record: ['On my record. As written.', 'It is on the record. Nothing to add.'],
    },
  },
};
