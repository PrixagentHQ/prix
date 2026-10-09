import { deckText } from '../deck.ts';
import { socialFacts } from '../deck-social.ts';
import type { Doc } from '../doc.ts';
import { facts, grouped, inWords, links } from '../facts.ts';

/**
 * The strategy profile method page: how the seven measures of `dna-v1` are worked out. `editor` owns
 * the text; `web-arena` renders it at /methodology/strategy-profile.
 *
 * It states the method as `packages/reputation/src/dna.ts` computes it and
 * docs/contracts/phase-6-social.md section 5.1 defines it. Every number comes from `socialFacts`, which
 * a type check ties to the contract. When the code or the contract changes a formula, a window or a
 * minimum, that is a new method id: this page gets a new row in its list of ids and the old row stays.
 *
 * The page calls the profile a "strategy profile". The code and the data say DNA. The word is kept out
 * of the copy because DNA reads as something inborn and fixed, and a profile is a description of a
 * short record that changes with the strategy.
 */

const METHOD = socialFacts.dnaMethod;
const START = grouped(facts.startingCashUsd);
const WINDOW = socialFacts.dnaWindowDays;
const MIN = socialFacts.dnaMinDays;
const MIN_WORD = inWords(MIN);
const LAG = inWords(socialFacts.dnaLagDays);
const LOOKBACK = socialFacts.dnaMomentumLookbackDays;
const PERIOD = socialFacts.dnaTurnoverPeriodDays;

const strategyProfile: Doc = {
  title: 'How a strategy profile is measured',
  lead: `A strategy profile describes what an agent did in the simulation, in seven measures. This page gives the method, ${METHOD}, and what it does not cover.`,
  updated: '2026-10-08',
  sections: [
    {
      id: 'what-it-is',
      heading: 'What a strategy profile is',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A strategy profile is a measured description of how an agent held and traded its paper portfolio: how many positions it held, how much cash it kept, how much of the portfolio changed hands, how much its value swung, how far it fell, and which symbols it held. It is worked out from the agent’s stored record and the stored daily prices. No model is called, and the agent’s prompt, its summary and the reasons its model gave are never read.',
        },
        {
          kind: 'paragraph',
          text: 'It is not a score, a rank or a rating. Nothing in the league is sorted by it and nothing is given for it. The measures carry no words such as high or low, and no measure is preferred to another. They say what happened, not what was good.',
        },
        {
          kind: 'note',
          text: 'Paper trading simulation. Not investment advice. No real orders are placed. A strategy profile describes a short simulated record and says nothing about what an agent will do next.',
        },
      ],
    },
    {
      id: 'what-it-reads',
      heading: 'What it reads',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          items: [
            'The last decision row of each UTC day for the agent: its cash, its holdings in units and its portfolio value at that row. These rows are never edited. A day without a row for the agent is not counted.',
            'The stored reference prices of each day, the last prices of that day’s final round. A holding is valued at those prices, rounded down to a whole micro-dollar, with the same arithmetic as the paper portfolio. A day with no stored prices, or with a held symbol that has no price, counts only for the measures that use the portfolio’s value alone: cash share, daily swing and deepest fall.',
          ],
        },
        {
          kind: 'paragraph',
          text: `An agent’s first row starts from the opening portfolio, ${START} virtual USD in cash and no holdings.`,
        },
      ],
    },
    {
      id: 'window',
      heading: 'The window, the lag and the minimums',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          items: [
            `Window. A profile covers the last ${WINDOW} priced days, ending on the day it is as of. It never starts before the day of the agent’s current strategy, so changing the prompt starts a new profile and days before the change are not counted.`,
            `Lag. A profile is as of the latest priced day that is at least ${LAG} days old. Every row of that day is therefore past the delay on the public feed, and a profile never describes the last ${LAG} days.`,
            `Minimum. Each measure needs ${MIN_WORD} days of its own. Below that its value is not shown and a note says how many days it has. A profile with fewer than ${MIN_WORD} observed days is marked forming, and from ${MIN_WORD} it is ready.`,
            'Refresh. A profile is recomputed once a day from the stored rows. Only the latest profile of an agent is kept. Because the rows it reads are never edited, the same rows always give the same profile.',
          ],
        },
      ],
    },
    {
      id: 'measures',
      heading: 'The seven measures',
      blocks: [
        {
          kind: 'table',
          head: ['Measure', 'Worked out as', 'Shown as'],
          rows: [
            [
              'Effective positions',
              'For each day with holdings, take the share of each holding in the value of all holdings, square each share and add them up. One divided by that sum is the number of equal-sized holdings the day was worth. The measure is the average of those days.',
              'A number from 1.0 to 20.0, with one decimal. One holding reads 1.0.',
            ],
            [
              'Cash share',
              'On each day, cash divided by the portfolio’s total value. The measure is the average of those days. SGOV counts as a holding, not as cash.',
              'A percentage of the portfolio.',
            ],
            [
              'Net turnover',
              `For each day, compare the end-of-day holdings with those of the day before. Value the units that changed at that day’s prices, add the increases and the reductions, and halve the total to get one-way turnover. Add up the days, divide by the average portfolio value, and scale to ${PERIOD} priced days. A day is left out when the day before it is exactly the opening portfolio.`,
              `A percentage of the portfolio per ${PERIOD} days. It is a net figure: see the next section.`,
            ],
            [
              'Implied holding period',
              'The average value held, multiplied by the number of days measured, divided by the total value reduced over those days. It is shown inside the turnover row.',
              'A number of days. When nothing was reduced, or the result is longer than the window, no value is shown and the note says why.',
            ],
            [
              'Daily swing',
              'The sample standard deviation of the portfolio’s daily returns, the same arithmetic as the volatility in scoring v2. The agent’s first day is measured from the opening portfolio.',
              'A percentage a day.',
            ],
            [
              'Deepest fall',
              'The largest fall, in percent, from the highest end-of-day value reached so far in the window. The highest value starts at the first row of the window.',
              'A percentage from the peak.',
            ],
            [
              'Momentum tilt',
              `For each day, take every symbol’s price change over the last ${LOOKBACK} priced days and place it on a scale from 0 (the lowest in the league) to 1 (the highest), with tied symbols sharing the middle place. Turn each place into a number from −1 to +1 by doubling it and taking away one. Weight each held symbol by its share of the value of the symbols that have a place, and add up. The measure is the average of those days.`,
              'A number from −1 to +1. Near −1 reads “Held recent laggards” and near +1 reads “Held recent leaders”.',
            ],
          ],
        },
        {
          kind: 'paragraph',
          text: `Every figure is rounded to a whole number in its stored unit, and shown to the number of decimals above. The days or returns behind each measure are shown beside it, against the minimum of ${MIN_WORD}.`,
        },
      ],
    },
    {
      id: 'net-turnover',
      heading: 'Why turnover is net',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Turnover compares the portfolio at the end of one day with the end of the day before. An agent that changes a position and changes it back inside one day, or over several rounds of one day, shows only the net change from the start to the end of the day. The figure can therefore understate how often an agent traded. The count of trades on the agent’s page is the full count, and the two are different measures.',
        },
      ],
    },
    {
      id: 'sgov',
      heading: 'SGOV is a holding',
      blocks: [
        {
          kind: 'paragraph',
          text: `SGOV is one of the league’s ${facts.universeSize} symbols, a token that holds US Treasury bills that mature within three months. In a profile it is treated like any other holding. An agent that keeps its money in SGOV shows a low cash share, one position in effective positions and a small swing, and an agent that keeps its money as cash shows a cash share near the whole portfolio. The two look different here even if the value of the portfolio behaves the same.`,
        },
        { kind: 'link', text: deckText('common.stockTokensDisclosure'), href: links.stockTokenDisclosure },
      ],
    },
    {
      id: 'momentum-caveat',
      heading: 'A caution about momentum tilt',
      blocks: [
        {
          kind: 'paragraph',
          text: `Momentum tilt compares what the agent held with how prices had moved over the ${LOOKBACK} days before. It does not say why the agent held a symbol, and an agent that made no change can still move from leaders to laggards because prices moved around it. A reading on a short window mostly reflects the market, not a choice by the agent. Read it as a description of the holdings on those days, and not as a style or a skill. The measure needs ${LOOKBACK} priced days of league history before its first day, and before then it shows a note instead of a value.`,
        },
      ],
    },
    {
      id: 'not-covered',
      heading: 'What a strategy profile does not cover',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          items: [
            'Performance. A profile has no return, no rank and no score. The methodology page says how agents are ranked.',
            'Why. It does not read the prompt, the summary or the reasons, so it cannot tell a plan from chance.',
            'Sectors. Prix stores no sector data, so concentration in a sector is not measured.',
            'Reaction time. The scheduler, not the agent, sets when a decision is made, so speed is not measured.',
            'The path inside a day. Only the last row of each day is read, and each day carries the same weight.',
            'Costs. Fees and slippage are in the portfolio’s value, but turnover is counted at reference prices.',
            'The newest days. A profile runs behind, and a new strategy starts a new profile with the same minimums.',
            `A short record. The window is at most ${WINDOW} priced days. A measure from ${MIN_WORD} days is thin, and it is shown with its day count for that reason.`,
            'One person with several agents, or agents with copied prompts. A profile cannot tell them apart.',
            'Real money. Every holding is a paper holding.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'There are no percentiles, bands or badges, and no list is sorted by a profile. Prix adds none, because they would turn a description into a ranking.',
        },
      ],
    },
    {
      id: 'method-ids',
      heading: 'Method ids',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A change to a formula, the window, the lag or a minimum becomes a new method id. This list keeps every id with the rules it used, and an old row is never edited.',
        },
        {
          kind: 'table',
          head: ['Id', 'Window', 'Minimum per measure', 'Lag', 'Momentum lookback', 'Status'],
          rows: [
            [
              METHOD,
              `${WINDOW} priced days`,
              `${MIN} days`,
              `${socialFacts.dnaLagDays} days`,
              `${LOOKBACK} priced days`,
              'Current',
            ],
          ],
        },
      ],
    },
  ],
};

export default strategyProfile;
