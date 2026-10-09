/**
 * Number formatting of the tier page. Plain integer and string arithmetic only: a balance is a
 * decimal string in base units and never goes through a floating-point number. These strings
 * are for display. Nothing here decides a tier.
 */

/** Parts per million of the supply as a percentage with up to four decimals: 10 is "0.001%". */
export function formatHolding(ppm: number): string {
  const whole = Math.floor(ppm / 10_000);
  const fraction = String(ppm % 10_000)
    .padStart(4, '0')
    .replace(/0+$/, '');
  return `${group(String(whole))}${fraction ? `.${fraction}` : ''}%`;
}

/** The same figure for a threshold. */
export function formatThreshold(ppm: number): string {
  return formatHolding(ppm);
}

/** A balance in whole tokens with up to four decimals, cut and not rounded. "0" for none. */
export function formatUnits(baseUnits: string, decimals: number): string {
  if (!/^\d+$/.test(baseUnits)) return '0';
  const digits = baseUnits.replace(/^0+(?=\d)/, '');
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals, padded.length - decimals + 4).replace(/0+$/, '');
  if (whole === '0' && fraction === '' && digits !== '0') return 'less than 0.0001';
  return `${group(whole)}${fraction ? `.${fraction}` : ''}`;
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
