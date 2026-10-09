import { deckText } from '../deck.ts';
import type { Doc } from '../doc.ts';
import { facts, inWords, links } from '../facts.ts';

/**
 * The privacy page. `editor` owns the text; `web-site` renders it.
 *
 * It says only what is true of Phase 1, as docs/CONTRACTS.md sections 3, 4, 10, 11, 12 and 15
 * define it: a wallet address and what the user creates, one session cookie, no cross-site
 */

const SESSION_DAYS = inWords(facts.sessionDays);
const MAX_KEYS = inWords(facts.maxModelKeysPerWallet);

const privacy: Doc = {
  title: deckText('nav.privacy'),
  lead: 'Prix keeps a wallet address and what you create with it. This page says what is kept, what is public, who else receives it and what you can delete.',
  updated: '2026-10-08',
  sections: [
    {
      id: 'what-prix-keeps',
      heading: 'What Prix keeps',
      blocks: [
        {
          kind: 'table',
          head: ['What', 'Why', 'Who can see it'],
          rows: [
            [
              'Your wallet address',
              'It is your account. You sign in with it.',
              'Anyone, in a shortened form, on your agent’s page.',
            ],
            ['Your agent’s name and division', 'They identify the agent in the league.', 'Anyone.'],
            [
              'Your strategy prompt',
              'The model that runs your agent decides from it.',
              'Only you, unless you publish it.',
            ],
            [
              'A summary of your strategy',
              'It says what the agent does without showing the prompt. A model writes it.',
              'Anyone.',
            ],
            [
              'Your agent’s record',
              'Its decisions, the reasons its model gave, its trades, its holdings and its portfolio value make up the league.',
              'Anyone.',
            ],
            [
              'The link from a fork to its source agent',
              'When forking is open, it records which public agent a fork started from and when the link was made.',
              'Anyone. Lineage is public: anyone can see which agent a fork came from and when it was linked.',
            ],
            [
              'A model key, for a Pro agent',
              'Your agent’s model is called with it.',
              'Nobody sees the key. You see its last four characters. Its provider and the name of the model are shown on your agent’s page.',
            ],
            [
              'Sign-in records',
              'A record of each sign-in code that was used, so that it cannot be used twice, and a record of each session, which keeps you signed in.',
              'Nobody.',
            ],
          ],
        },
        {
          kind: 'paragraph',
          text: 'Prix does not ask for your name, your email address or your phone number. If you write to Prix, it has your email address and what you wrote.',
        },
      ],
    },
    {
      id: 'wallet',
      heading: 'Your wallet',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Prix asks your wallet for its address and for one signature that signs you in, and for nothing else.',
        },
        {
          kind: 'paragraph',
          text: 'When token features are on, Prix reads the balance of one token, the Prix token, for your address from the public chain. It reads no other balance and no other holdings, and it stores the balance it read and the time of the read.',
        },
        {
          kind: 'paragraph',
          text: 'A wallet address is public on its chain, and so is what that wallet has done there. Prix shows a shortened form of your address, not the whole of it.',
        },
        {
          kind: 'paragraph',
          text: 'If you link a Telegram chat to receive notes about agents you follow, Prix stores the chat id with your wallet address until you unlink the chat. Unlinking removes the chat id.',
        },
      ],
    },
    {
      id: 'cookie',
      heading: 'One cookie, and no tracking',
      blocks: [
        {
          kind: 'paragraph',
          text: `Prix sets one cookie, when you sign in. It holds your session, lasts ${SESSION_DAYS} days and cannot be read by scripts on the page. Signing out clears it.`,
        },
        {
          kind: 'paragraph',
          text: 'Prix uses no analytics that follow people across sites, shows no advertising and loads nothing from other companies’ sites.',
        },
      ],
    },
    {
      id: 'who-else',
      heading: 'Who else receives data',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          items: [
            'Cloudflare hosts Prix: the site, the database and the house model. Every request you make reaches Cloudflare with your IP address, as on any website. Prix uses the IP address to limit how often one address can make requests, and does not store it in its database.',
            'The house model, on Cloudflare Workers AI, receives the prompt of an Open agent at each of its turns. It also receives the prompt of every agent, Open or Pro, when it writes the strategy summary.',
            'For a Pro agent, the provider you chose is called with your key at every turn. It receives your prompt, the prices of the round and your agent’s portfolio, under your own account with that provider.',
            'Prix reads prices from Robinhood Chain. Those requests carry nothing about you.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Prix sends your prompt, your key and your sign-in records to nobody else. What is public on the site is public to everyone, people and programs alike.',
        },
      ],
    },
    {
      id: 'model-keys',
      heading: 'Model keys',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          items: [
            `A wallet can store up to ${MAX_KEYS} keys. Each is encrypted before it is stored, with a secret that is kept outside the database.`,
            'A key is decrypted only at the moment your agent calls your model, and it is not kept in readable form after the call.',
            'A key is never written to a log and never sent back to a browser. The site shows its last four characters and nothing more of it.',
            'You can delete a key on your account page at any time. Prix then deletes the stored key from its database, and the agent that used it is paused until you choose another key.',
          ],
        },
      ],
    },
    {
      id: 'keeping-and-deleting',
      heading: 'What is kept, and for how long',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          items: [
            'A model key is kept until you delete it.',
            'Used sign-in codes and sessions are deleted after they expire.',
            'Your agent, its prompt and its record are kept. Prix does not delete agents or records, so that a weak record cannot be erased by starting again. Changing your prompt replaces the stored prompt.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'To ask what Prix holds about your wallet address, or to ask for something to be corrected or removed, write to the address at the end of this page.',
        },
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to this page',
      blocks: [
        {
          kind: 'paragraph',
          text: 'When this page changes, the date at the top changes. A change in what Prix keeps or who receives it is described here before it takes effect.',
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

export default privacy;
