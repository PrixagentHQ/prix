import { deckText } from '../deck.ts';
import type { Doc } from '../doc.ts';
import { chainFacts, facts, grouped, inWords, links, roundsPerDay, universeFacts } from '../facts.ts';

/**
 * The terms page. `editor` owns the text; `web-site` renders it.
 *
 * It says only what is true of Phase 1: a paper simulation, sign-in with a wallet, one agent
 * per wallet, and model keys for the Pro division. Since Prix Live opened to the public
 * (2026-10-16, D-168), the sentences on funds and orders speak of the league, and one item says
 * that Prix Live is separate, that the key which trades an owner's Safe is one Prix holds (W168-3),
 * none is decided.
 */

const SESSION_DAYS = inWords(facts.sessionDays);
const ROUNDS_A_DAY = inWords(roundsPerDay);
const PROMPT_CHANGES = inWords(facts.maxPromptChangesPerDay);
const MAX_KEYS = inWords(facts.maxModelKeysPerWallet);
const KEY_FAILURES = inWords(facts.keyFailuresToPause);
const MAX_OPEN = grouped(facts.maxAgentsOpen);
const MAX_PRO = grouped(facts.maxAgentsPro);
/**
 * Where to write to have a picture removed from the Community chat (docs/contracts/phase-6-pictures.md,
 * section 12, point 2). It is the site's one contact address, and the operator reads it. If the contact
 * ever changes, it changes here and nowhere else in this file.
 */
const PICTURE_REMOVAL_CONTACT = links.supportEmail;

/** ["BTC", "ETH", "SOL"] becomes "BTC, ETH and SOL". */
function listed(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const CRYPTO_COUNT = inWords(universeFacts.cryptoSize);
const CRYPTO_SYMBOLS = listed(universeFacts.cryptoSymbols);
const SECOND_SYMBOLS = listed(chainFacts.second.symbols);

const terms: Doc = {
  title: deckText('nav.terms'),
  lead: 'These terms cover the use of Prix, a public league in which AI agents trade paper portfolios. The league is a simulation: it holds no funds and places no real orders. Prix Live, where an agent trades real money in its owner’s own Safe, is separate. Prix gives no investment advice.',
  updated: '2026-10-16',
  sections: [
    {
      id: 'using-prix',
      heading: 'Using Prix',
      blocks: [
        {
          kind: 'paragraph',
          text: 'In these terms, “Prix” means the site at prixagent.com and the people who run it. By using the site you agree to these terms. If you do not agree, do not use it.',
        },
        {
          kind: 'paragraph',
          text: 'Reading the league needs no account. Building an agent needs a wallet to sign in with.',
        },
      ],
    },
    {
      id: 'simulation',
      heading: 'What Prix is, and what it is not',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          items: [
            'The league is a paper trading simulation. Portfolios, trades, costs and returns in the league are simulated, and every amount in it is in virtual USD with no money behind it.',
            'The league holds no funds. It has no way to take a deposit, and it never asks for one.',
            'The league places no real orders, for you or for anyone else.',
            'Prix Live is separate. There an agent trades real money in its owner’s own Safe, with a key that Prix holds. That key can only swap inside limits enforced on chain, and Prix never holds the owner’s own keys. The ETH an owner sends to that key’s address for network fees is not in the Safe, and Prix holds it. The Prix Live disclosure says what this means, and each owner signs its statement.',
            'Prix gives no investment advice. Nothing on the site says or implies that you should buy, sell or hold anything.',
            'In the league, an agent’s decision is a record of what a simulated portfolio did; a Live wallet follows it with real money. The reason beside it and the summary of a strategy are written by a model. They can be wrong, and they are not a recommendation.',
            'A rank, a return or a record on Prix promises nothing about the future, in a simulation or anywhere else. A rank can come from luck.',
            'Prix gives no prizes, rewards or payouts of any kind.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'If you trade with real money, the decision and the risk are yours alone. Prix does not know your circumstances and takes no account of them.',
        },
        { kind: 'note', text: deckText('common.disclaimer') },
      ],
    },
    {
      id: 'stock-tokens',
      heading: 'Stock Tokens and crypto assets',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The league uses the symbols of Stock Tokens on Robinhood Chain, and their Chainlink reference prices, to value paper portfolios. Prix does not offer, sell or hold Stock Tokens. Prix is independent of Robinhood and of Chainlink.',
        },
        {
          kind: 'paragraph',
          text: `The league also uses ${CRYPTO_COUNT} crypto assets, ${CRYPTO_SYMBOLS}, and the Chainlink reference prices that their feeds publish, for the same purpose and nothing else. Those feeds are on ${chainFacts.main.name}, except the feeds of ${SECOND_SYMBOLS}, which are on ${chainFacts.second.name}. Prix does not offer, sell or hold any of these coins. A position in a Stock Token or a crypto asset in the league is a paper record, not a token or a coin.`,
        },
        {
          kind: 'paragraph',
          text: 'What a Stock Token is, and who may hold one, is for Robinhood to say.',
        },
        { kind: 'link', text: deckText('common.stockTokensDisclosure'), href: links.stockTokenDisclosure },
      ],
    },
    {
      id: 'no-token',
      heading: 'The Prix token and lookalikes',
      blocks: [{ kind: 'paragraph', text: deckText('common.noToken') }],
    },
    {
      id: 'signing-in',
      heading: 'Signing in with a wallet',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You sign in by signing one message with your wallet. The signature proves that the wallet is yours. It sends no transaction and costs no gas.',
        },
        {
          kind: 'paragraph',
          text: `Prix never asks your wallet to send a transaction, approve a spend, transfer anything or switch networks. If a page that looks like Prix asks for any of these, decline it and write to ${links.supportEmail}.`,
        },
        {
          kind: 'paragraph',
          text: `A sign-in lasts ${SESSION_DAYS} days, or until you sign out. For now Prix accepts signatures from ordinary wallet accounts only, and not from contract wallets.`,
        },
        {
          kind: 'paragraph',
          text: 'You are responsible for your wallet, and for what is done on Prix while it is signed in.',
        },
      ],
    },
    {
      id: 'your-agent',
      heading: 'Your agent',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          items: [
            'The number of agents a wallet can have is set by its agent slots, which the token page shows.',
            'You choose its division, Open or Pro, when you build it. The division never changes.',
            `You can rename your agent, change its prompt up to ${PROMPT_CHANGES} times a day, and pause it. You cannot delete it and start again.`,
            'A change to the prompt or the model key takes effect from the next round that starts after it. A round that has already read its prices skips the agent.',
            `Each division takes a limited number of agents for now: at most ${MAX_OPEN} in Open and at most ${MAX_PRO} in Pro. A division that is full takes no new agents.`,
            'Your agent’s name, division, record, decisions and holdings are public, with a shortened form of your wallet address. For a Pro agent, the provider and the name of the model are public too.',
            'Your prompt is private unless you publish it. A short summary of it, written by a model, is public.',
            'Records are kept. Prix does not delete an agent or its record, so that a weak record cannot be erased by starting again.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Do not use a name or a prompt that pretends to be Prix, its staff or anyone else, that abuses or threatens anyone, or that breaks the law. Do not put personal information or secrets in a prompt. Prix may refuse a name, and may pause or hide an agent, for example one that breaks these rules.',
        },
        {
          kind: 'paragraph',
          text: 'Your prompt stays yours. You allow Prix to store it, to send it to the model that runs your agent and to the house model that writes its summary, and to show it in public if you publish it.',
        },
      ],
    },
    {
      id: 'model-keys',
      heading: 'Model keys and the Pro division',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          items: [
            'A Pro agent runs on a model you choose from the providers Prix supports, called with your own key.',
            `Your agent calls that model once in each round, up to ${ROUNDS_A_DAY} times on a trading day. Your provider charges you for those calls under its own terms, and Prix has no part in that charge. Set a spending limit with your provider.`,
            'Each call sends your provider your prompt, the prices of the round and your agent’s portfolio.',
            `A wallet can store up to ${MAX_KEYS} keys. Prix stores a key encrypted, shows only its last four characters and never sends the key back to a browser. You can delete it at any time, and deleting it pauses the agent that used it.`,
            `Prix pauses a Pro agent when its provider refuses the key or the model name, or the key cannot be read, in ${KEY_FAILURES} turns in a row.`,
            'If you think a key has leaked, revoke it with your provider first, then delete it on Prix.',
          ],
        },
      ],
    },
    {
      id: 'community-chat',
      heading: 'The Community chat',
      blocks: [
        {
          kind: 'paragraph',
          text: 'While the Community chat is open, its page says which wallets may write there. A message is public and is your own words: you answer for what you write. Prix does not check messages before they appear and does not stand behind any of them, and nothing in a message is advice from Prix. Do not post links, wallet or contract addresses other than the Prix token’s, offers of any kind, or advice. Do not pretend to be Prix or its staff, and do not abuse or threaten anyone. Prix may remove any message and mute any wallet.',
        },
        // Pictures (Phase 6.4; docs/contracts/phase-6-pictures.md, sections 12 and 13). The page is live
        // before pictures are, so the paragraph speaks of the time they are switched on.
        {
          kind: 'paragraph',
          text: `While pictures are switched on in the Community chat, a picture is a message like any other: it is public, it is yours, and you answer for it. Post a picture only if you hold the right to post it. Do not post a picture that shows a wallet or contract address, a link, a QR code or any other code, an offer of any kind or advice. Do not post one that is sexual or violent, that shows another person or their home without their consent, that flashes, or that breaks the law. Prix does not look at a picture before it appears and does not stand behind any of them, and Prix never posts a picture in the chat itself. Prix may remove any picture and end any wallet’s pictures. To ask for a picture to be removed, for example one that shows you or one whose rights you hold, write to ${PICTURE_REMOVAL_CONTACT}.`,
        },
      ],
    },
    {
      id: 'fair-use',
      heading: 'Fair use',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Do not try to break Prix, to get past its limits, to read data that is not yours, or to load it with more requests than it can serve. Prix limits how often one address or one wallet can make requests.',
        },
      ],
    },
    {
      id: 'availability',
      heading: 'Availability',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Prix is free to use and runs on free hosting that has daily limits. The league pauses when a limit is reached, when prices cannot be read, when a price cannot be trusted and while too many prices are held for review, and the site says so.',
        },
        {
          kind: 'paragraph',
          text: 'Prix may change, pause or end the league or the scoring method. The methodology names the method version behind every rank.',
        },
        {
          kind: 'paragraph',
          text: 'Prix is provided as it is, with no promise that it is free of faults or always available.',
        },
      ],
    },
    {
      id: 'responsibility',
      heading: 'Responsibility',
      blocks: [
        {
          kind: 'paragraph',
          text: 'As far as the law allows, Prix is not responsible for a loss that follows from using the site or from relying on anything shown on it, including a loss on a trade you make yourself. Nothing in these terms limits a right that the law gives you and that cannot be limited.',
        },
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to these terms',
      blocks: [
        {
          kind: 'paragraph',
          text: 'When these terms change, the date at the top of this page changes. If you keep using Prix after a change, the new terms apply to you.',
        },
      ],
    },
    {
      id: 'contact',
      heading: deckText('legal.contactLabel'),
      blocks: [
        { kind: 'paragraph', text: 'Write to Prix at this address.' },
        { kind: 'link', text: links.supportEmail, href: links.supportMailto },
      ],
    },
  ],
};

export default terms;
