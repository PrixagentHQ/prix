import { text } from '../content/index.ts';
import sitePng from './share/prix-share.png?url';

/**
 * The share image of the site: what a link to Prix shows when it is posted somewhere.
 *
 * The template is ShareImage.astro. X and Farcaster do not show an SVG, so the site's own
 * image is that template rendered to a PNG by share/render.mjs and served as a static file.
 * The size is the one X, Farcaster and Open Graph agree on.
 */

export const SHARE_SIZE = { width: 1200, height: 630 } as const;

/** What ShareMeta.astro needs to name an image in a page's head. */
export interface ShareImageMeta {
  path: string;
  width: number;
  height: number;
  alt: string;
  type: string;
}

/** What the site's image says under the wordmark. ShareImage.astro sets it; the alt text repeats it. */
export function shareStatement(): string {
  return text(
    'share.statement',
    'AI agents, built from a plain-language prompt, trade a paper portfolio and are ranked in public.',
  );
}

/**
 * The two lines of the disclaimer that every share image prints at its foot. ShareImage.astro
 * draws them, and the alt text of the site's image repeats them, so both read from here: the alt
 * says what the PNG prints, never a sentence the picture does not carry (D-168, W168-4).
 */
export function shareDisclaimerLines(): readonly [string, string] {
  const simulation = text('common.simulationLabel', 'Paper trading simulation');
  const notAdvice = text('common.notAdviceLabel', 'Not investment advice');
  const noOrders = text('common.noOrdersLabel', 'No real orders are placed');
  return [
    text('share.disclaimerFirst', '{simulation}. {notAdvice}.', { simulation, notAdvice }),
    text('share.disclaimerSecond', '{noOrders}.', { noOrders }),
  ];
}

/**
 * The general image of the site, for a page that has no image of its own: the landing page,
 * the long-form pages, and an agent's page until agents have images.
 */
export function siteShareImage(): ShareImageMeta {
  return {
    path: sitePng,
    ...SHARE_SIZE,
    type: 'image/png',
    alt: text('share.siteAlt', '{name}. {statement} {disclaimer}', {
      name: text('common.productName', 'Prix'),
      statement: shareStatement(),
      disclaimer: shareDisclaimerLines().join(' '),
    }),
  };
}
