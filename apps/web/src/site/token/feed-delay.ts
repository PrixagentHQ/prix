/**
 * How long the follow feed is held back, in words. One formatter for every page that shows it.
 * Under an hour it counts minutes; a whole number of hours counts hours; anything between
 * counts minutes. Singular forms are kept: "1 minute", "1 hour". Formatting only: the length
 * is the API's own number of seconds.
 */
export function formatFeedDelay(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.round(safe / 60);
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${hours.toLocaleString('en-US')} hours`;
  }
  return minutes === 1 ? '1 minute' : `${minutes.toLocaleString('en-US')} minutes`;
}
