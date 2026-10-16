import { text } from '../../content/index.ts';

/**
 * Every sentence of the lounge's block on /following (docs/contracts/phase-6-holders-2.md sections 4.7 and
 * 7), each under its key in the copy deck (the editor's apps/web/src/content/deck-holders2.ts), which holds
 * the final wording. Server only.
 */
export function loungeWords() {
  return {
    title: text('lounge.title', 'Prix Community on Telegram'),
    description: text(
      'lounge.description',
      'Prix’s Community group on Telegram. A new member joins by a request that @PrixagentBot approves when the wallet linked to their Telegram account holds at least 10,000 $PRIX. It is a place to talk about Prix, never a source of trade calls or advice.',
    ),
    join: text('lounge.join', 'Ask to join'),
    joinNote: text(
      'lounge.joinNote',
      'Telegram sends your request to @PrixagentBot, which lets you in when the wallet linked to your Telegram account holds at least 10,000 $PRIX.',
    ),
    linkFirst: text(
      'lounge.linkFirst',
      'Link Telegram on this page first. The bot lets in the Telegram account linked to this wallet.',
    ),
    notHolder: text(
      'lounge.notHolder',
      'A new member joins Prix Community on Telegram with a wallet that holds at least 10,000 $PRIX. A new holding counts about an hour after Prix first sees it.',
    ),
    leaving: text(
      'lounge.leaving',
      'Once a day Prix reads every member’s wallet again. A member whose wallet holds less than 10,000 $PRIX, or whose Telegram account is no longer linked to it, is removed and may ask to join again later.',
    ),
  };
}
