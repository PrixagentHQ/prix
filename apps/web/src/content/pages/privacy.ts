import { deckText } from '../deck.ts';
import { socialFacts } from '../deck-social.ts';
import type { Doc } from '../doc.ts';
import { chainFacts, facts, grouped, inWords, links } from '../facts.ts';

/**
 * The privacy page. `editor` owns the text; `web-site` renders it.
 *
 * It says only what is true of Phase 1, as docs/CONTRACTS.md sections 3, 4, 10, 11, 12 and 15
 * define it: a wallet address and what the user creates, one session cookie, no cross-site
 */

const SESSION_DAYS = inWords(facts.sessionDays);
const MAX_KEYS = inWords(facts.maxModelKeysPerWallet);
/** The messages of the Community chat that are kept: ROOM_KEEP of the contract, which deck-social.ts pins. */
const CHAT_KEPT = grouped(socialFacts.roomKeep);
/** How long Prix stores the file of a picture: ROOM_PICTURE_TTL_SECONDS of the contract, as "seven days". */
const PICTURE_DAYS = `${inWords(socialFacts.pictureTtlSeconds / 86_400)} days`;

const privacy: Doc = {
  title: deckText('nav.privacy'),
  lead: 'Prix keeps a wallet address and what you create with it. This page says what is kept, what is public, who else receives it and what you can delete.',
  updated: '2026-10-16',
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
            [
              'A message in the Community chat',
              `While the Community chat is open, a message is what you publish there. Prix stores it with your wallet address and the time, and deletes it once it is no longer among the newest ${CHAT_KEPT} messages. For each wallet that has written, Prix also keeps the time of its last message, its count of messages for the day and a mute: whether the wallet is muted, and when it was last muted. That record stays when the messages are deleted.`,
              `Anyone, beside a shortened form of your wallet address, until an admin hides the message or mutes your wallet, or until it is no longer among the newest ${CHAT_KEPT} messages. Admins of Prix see it with your whole address until it is deleted.`,
            ],
            // docs/contracts/phase-6-pictures.md, section 13. The page is live before pictures are, so the
            // row speaks of the time they are switched on. "Without the location, text and device tags a
            // camera adds" and never "without the hidden data": the settings a file was compressed with
            // stay in it, and they can point to a device or a program.
            [
              'A picture in the Community chat',
              `While pictures are switched on in the Community chat, a picture is what you publish there. Prix stores the file without the location, text and device tags a camera adds, with your wallet address and the time, for at most ${PICTURE_DAYS}. The settings the file was compressed with stay in it, and they can point to the device or the program that made it. For each wallet, Prix also keeps the time of its first message, its counts of pictures and of reports for the day, and how many pictures it reported that an admin then kept. A report of a picture is stored with the wallet address of the user who sent it until the message is no longer among the newest ${CHAT_KEPT} messages, and nowhere after that. When an admin removes a picture, its file is deleted and a record of the removal is kept: your wallet address, a fingerprint of the file, its type and size, when it was posted and removed, the wallet address of the admin, and how many wallets had reported it.`,
              `Anyone, beside a shortened form of your wallet address, until an admin removes the picture or mutes your wallet, or until its ${PICTURE_DAYS} end. It is hidden from the public while reports from other users wait for an admin’s decision. Anyone who sees a picture can save it. Admins of Prix see it with your whole address, and they see the whole addresses of the wallets that reported it.`,
            ],
            // docs/contracts/phase-6-holders.md sections 4.2 and 10 (D-158 C). The last sentence of the middle
            // cell is HOLDERS_PRIVACY_SENTENCE word for word; holders.test.ts pins it. The page is live before
            // the poll is, so the row speaks of the time a poll is open.
            [
              "A vote in the holders' poll",
              "While a holders' poll is open, Prix stores your wallet address with the option you chose and the time you chose it, and reads your wallet's $PRIX balance from the chain to check that it may vote and, after the close, that its vote counts. A vote keeps the wallet's address and its choice until the poll's result is counted; then only the counts stay, apart from database backups, which are deleted within 30 days.",
              "You see your own choice on the poll's page. Anyone sees the count of votes for each option, and nobody else sees which option a wallet chose.",
            ],
            // docs/contracts/phase-6-holders.md section 3 (D-158 B): `users.show_holds`, off by default.
            [
              'Your choice to show "Owner holds $PRIX"',
              'When the token page offers it, Prix stores whether you turned this mark on, with your wallet address, until you change it. It is off unless you turn it on.',
              "Anyone, while it is on. The mark stands on your agents' own pages and tells anyone who sees it that the wallet that owns them held at least the amount the token page names, at Prix's last check.",
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
        // docs/contracts/phase-6-holders-2.md sections 4.2 and 4.6: holders_lounge_members keeps the Telegram
        // user id, the wallet, joined_at and checked_day; the daily sweep reads the wallet again and deletes the
        // row when it removes the member. A member who leaves the group alone keeps the row until then.
        {
          kind: 'paragraph',
          text: 'While joining Prix Community on Telegram by request is switched on, and @PrixagentBot lets your Telegram account into that group, Prix stores your Telegram user id with the linked wallet address, the time the bot let you in and the last day it checked that wallet. Once a day Prix reads that wallet’s $PRIX again while the record stands. Prix deletes the record when the bot removes your account from the group: after you unlink Telegram, or when the wallet holds less than 10,000 $PRIX. Leaving the group yourself does not delete it.',
        },
      ],
    },
    {
      id: 'cookie',
      heading: 'Two cookies, and no tracking',
      blocks: [
        // apps/api/src/http/session.ts: HttpOnly, Secure, Max-Age SESSION_TTL_SECONDS; routes-session.ts sets
        // and clears it.
        {
          kind: 'paragraph',
          text: `Prix sets a cookie when you sign in. It holds your session, lasts ${SESSION_DAYS} days and cannot be read by scripts on the page. Signing out clears it.`,
        },
        // apps/web/src/design/theme.ts: `prix_theme`, set only on a press of the theme control, one word,
        // Max-Age of a year; Layout.astro reads it on the server to render the page in that theme.
        {
          kind: 'paragraph',
          text: 'If you switch between the dark and the light theme, Prix keeps your choice in a second cookie, prix_theme, for a year. It holds the name of the theme and nothing else. The site reads it to show your next page in that theme.',
        },
        // apps/web/src/account/build.ts (DRAFT, DRAFT_FIELDS, writeDraft, the removeItem after a build) and
        // build/picker.ts (keepPrompt): sessionStorage of the tab, never put in a request.
        {
          kind: 'paragraph',
          text: 'While you build an agent, what you type in the form, or a template you choose before you sign in, is kept in this tab’s storage in your browser, so that you can sign in or visit your account page without losing it. That draft is never sent: Prix receives only what you submit when you build the agent. It is deleted once the agent is built, and your browser deletes it when the tab’s session ends, usually when you close the tab.',
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
            `Prix reads prices from ${chainFacts.main.name} and ${chainFacts.second.name}. Those requests carry nothing about you.`,
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
