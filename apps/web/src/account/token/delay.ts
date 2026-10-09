import { text } from '../../content/index.ts';

/**
 * How long the follow feed runs late, in the words a person uses: "15 minutes", "1 hour",
 * "24 hours". Under an hour it counts minutes, from an hour up it counts whole hours.
 */
export function formatDelay(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) {
    return minutes === 1
      ? text('token.delayMinuteOne', '1 minute')
      : text('token.delayMinuteOther', '{count} minutes', { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  return hours === 1
    ? text('token.delayHourOne', '1 hour')
    : text('token.delayHourOther', '{count} hours', { count: hours });
}
