/**
 * The only functions that format a number, an amount, a percentage, a date or a time.
 * `editor` owns this file. Times are UTC and say so.
 *
 * Every function is pure and uses no locale data, so the server and the browser always
 * print the same text. A negative value carries a true minus sign, a value that rounds to
 * zero carries no sign, and thousands are grouped with commas.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUS = '−';
const ELLIPSIS = '…';

/** 2800 becomes "2,800". Takes a whole number that is zero or positive. */
function group(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The whole number of `step`s nearest to `value`, with a half rounding away from zero. */
function nearest(value: number, step: number): number {
  const steps = Math.round(Math.abs(value) / step);
  return value < 0 ? -steps : steps;
}

/** "1,234.50" from 123450 hundredths: a grouped whole part and a fraction of fixed width. */
function fixed(scaled: number, digits: number): string {
  const unit = 10 ** digits;
  return `${group(Math.floor(scaled / unit))}.${String(scaled % unit).padStart(digits, '0')}`;
}

/**
 * A return in basis points as a signed percentage with two decimals.
 * 684 becomes "+6.84%", -192 becomes "−1.92%", 0 becomes "0.00%" and 1234567 becomes "+12,345.67%".
 * With `sign: false` a gain has no plus sign: 684 becomes "6.84%". A loss always keeps its minus sign.
 */
export function formatPercentBps(bps: number, options: { sign?: boolean } = {}): string {
  const hundredths = nearest(bps, 1);
  const body = `${fixed(Math.abs(hundredths), 2)}%`;
  if (hundredths < 0) return `${MINUS}${body}`;
  return hundredths > 0 && options.sign !== false ? `+${body}` : body;
}

/**
 * A maximum drawdown as the fall it is. The record stores it as a positive number of basis
 * points; a page shows it with a minus sign. 192 becomes "−1.92%" and 0 becomes "0.00%".
 */
export function formatDrawdownBps(bps: number): string {
  return formatPercentBps(-Math.abs(bps));
}

/**
 * A weight in basis points as a percentage with one decimal and no plus sign.
 * 2100 becomes "21.0%", 10000 becomes "100.0%" and 0 becomes "0.0%".
 */
export function formatWeightBps(bps: number): string {
  const tenths = nearest(bps, 10);
  const body = `${fixed(Math.abs(tenths), 1)}%`;
  return tenths < 0 ? `${MINUS}${body}` : body;
}

/**
 * An amount in micro-USD as dollars and cents, with no currency sign: the page says once that
 * amounts are in virtual USD. 10684000000 becomes "10,684.00", -1500000 becomes "−1.50" and 0 becomes "0.00".
 */
export function formatUsdMicro(micro: number): string {
  const cents = nearest(micro, 10_000);
  const body = fixed(Math.abs(cents), 2);
  return cents < 0 ? `${MINUS}${body}` : body;
}

/**
 * A holding as a number of Stock Tokens with at most four decimals. The record keeps it in
 * micro-shares, and one micro-share is a millionth of one token, not of one share of stock.
 * 12345678 becomes "12.3457", 2000000 becomes "2" and 1234500000 becomes "1,234.5".
 * A holding too small to show is "<0.0001", never "0": zero means no holding.
 */
export function formatUnitsMicro(micro: number): string {
  const tenThousandths = nearest(micro, 100);
  if (tenThousandths === 0) return micro > 0 ? '<0.0001' : '0';
  const abs = Math.abs(tenThousandths);
  const fraction = String(abs % 10_000)
    .padStart(4, '0')
    .replace(/0+$/, '');
  const body = fraction ? `${group(Math.floor(abs / 10_000))}.${fraction}` : group(Math.floor(abs / 10_000));
  return tenThousandths < 0 ? `${MINUS}${body}` : body;
}

/** A whole number with grouped thousands. 2800 becomes "2,800" and 0 becomes "0". */
export function formatCount(value: number): string {
  const whole = nearest(value, 1);
  return whole < 0 ? `${MINUS}${group(-whole)}` : group(whole);
}

/** The parts of a UTC day or timestamp that starts with YYYY-MM-DD, or null if it does not. */
function dayParts(value: string): { year: string; month: string; date: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  const date = Number(match[3]);
  if (!month || date < 1 || date > 31) return null;
  return { year: match[1] ?? '', month, date };
}

/** The HH:MM of a timestamp or a tick id, or null if it has none. */
function clock(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d/.test(value) ? value.slice(11, 16) : null;
}

/** "2026-10-06" becomes "6 Oct 2026". A timestamp gives its UTC day. Other text is returned as it is. */
export function formatDay(day: string): string {
  const parts = dayParts(day);
  return parts ? `${parts.date} ${parts.month} ${parts.year}` : day;
}

/** "2026-10-06" becomes "6 Oct". For a list where the year is clear from the page. */
export function formatDayShort(day: string): string {
  const parts = dayParts(day);
  return parts ? `${parts.date} ${parts.month}` : day;
}

/** "2026-10-06T15:00:00.000Z" becomes "15:00 UTC". */
export function formatTimeUtc(iso: string): string {
  const time = clock(iso);
  return time ? `${time} UTC` : iso;
}

/** A tick id, "2026-10-06T15:00Z", or a timestamp becomes "6 Oct, 15:00 UTC". */
export function formatTick(tickId: string): string {
  const time = clock(tickId);
  return time ? `${formatDayShort(tickId)}, ${time} UTC` : tickId;
}

/** "2026-10-06T15:04:05.000Z" becomes "6 Oct 2026, 15:04 UTC". For a time that needs its year. */
export function formatDateTimeUtc(iso: string): string {
  const time = clock(iso);
  return time ? `${formatDay(iso)}, ${time} UTC` : iso;
}

/**
 * A wallet address the one way the site writes it: "0x7a3f…c91e", the same form the API
 * uses for an agent's owner. Text that is not an address is returned as it is.
 */
export function formatAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}${ELLIPSIS}${address.slice(-4)}` : address;
}

/**
 * A delay in seconds as words, for the feed delay on every page that names it.
 * Under an hour it is minutes, from an hour it is whole hours, and a one is singular:
 * 900 becomes "15 minutes", 3600 becomes "1 hour" and 86400 becomes "24 hours".
 */
export function formatDelay(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 3600) {
    const minutes = Math.max(1, Math.round(whole / 60));
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  const hours = Math.round(whole / 3600);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}
