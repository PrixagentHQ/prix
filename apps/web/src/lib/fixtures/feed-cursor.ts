import type { FeedCursorText } from '@prix/contracts';
import { formatFeedCursor } from '@prix/contracts';

/**
 * Feed cursors as the fixtures hand them out. The API signs every cursor (docs/CONTRACTS.md
 * section 20): `<tickId>~<agentId>~<16 base32>`. The fixtures have no secret, so they sign with one
 * fixed fake signature of the right shape. The web never reads a cursor; it passes it back unchanged.
 */
export const FIXTURE_CURSOR_SIGNATURE = 'fixturesignature';

/** The cursor after this item, in the signed shape of the API. */
export function fixtureCursor(item: { tickId: string; agentId: string }): FeedCursorText {
  return formatFeedCursor({ tickId: item.tickId, agentId: item.agentId }, FIXTURE_CURSOR_SIGNATURE);
}
