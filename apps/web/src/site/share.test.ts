import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { text } from '../content/index.ts';
import { shareDisclaimerLines, shareStatement, siteShareImage } from './share.ts';

// D-168, W168-4: the alt text of the site's share image says what the PNG prints, and the PNG
// prints the two disclaimer lines of ShareImage.astro, never the footer's `common.disclaimer`.
describe('siteShareImage', () => {
  const [first, second] = shareDisclaimerLines();

  it('composes the two lines the PNG prints from the share keys', () => {
    expect(first).toBe(
      `${text('common.simulationLabel', 'Paper trading simulation')}. ${text('common.notAdviceLabel', 'Not investment advice')}.`,
    );
    expect(second).toBe(`${text('common.noOrdersLabel', 'No real orders are placed')}.`);
  });

  it('gives an alt text that ends with exactly those two lines', () => {
    const { alt } = siteShareImage();
    expect(alt).toBe(`${text('common.productName', 'Prix')}. ${shareStatement()} ${first} ${second}`);
    expect(alt.endsWith(`${first} ${second}`)).toBe(true);
  });

  it('never puts the footer disclaimer in the alt text', () => {
    const { alt } = siteShareImage();
    const footer = text('common.disclaimer', '');
    expect(footer.length).toBeGreaterThan(0);
    expect(alt).not.toContain(footer);
    expect(alt).not.toMatch(/Prix Live/);
  });

  it('draws the PNG template from the same two lines', () => {
    const template = readFileSync(new URL('./ShareImage.astro', import.meta.url), 'utf8');
    expect(template).toMatch(/const \[disclaimerFirst, disclaimerSecond\] = shareDisclaimerLines\(\);/);
    expect(template).toContain('>{disclaimerFirst}</text>');
    expect(template).toContain('>{disclaimerSecond}</text>');
    expect(template).not.toMatch(/common\.disclaimer/);
  });
});
