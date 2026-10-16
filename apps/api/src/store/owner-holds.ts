import type { D1Database } from '@cloudflare/workers-types';
import type { Address, IsoTime, OwnerHoldsStore } from '@prix/contracts';

/**
 * The owner's choice to show "Owner holds $PRIX" on its agents' pages (docs/contracts/phase-6-holders.md
 * sections 3 and 4.2): one column of the wallet's `users` row, `users.show_holds` (migration 0018), off by
 * default. It sits beside the users rows of reputation.ts and sql.ts. One statement a call.
 */
const GET_SHOW_HOLDS_SQL = 'SELECT show_holds FROM users WHERE address = ?';
const SET_SHOW_HOLDS_SQL =
  'INSERT INTO users (address, created_at, show_holds) VALUES (?1, ?3, ?2) ON CONFLICT (address) DO UPDATE SET show_holds = excluded.show_holds';

export function createOwnerHoldsStore(db: D1Database): OwnerHoldsStore {
  return {
    async getShowHolds(wallet: Address) {
      const row = await db.prepare(GET_SHOW_HOLDS_SQL).bind(wallet).first<{ show_holds: number }>();
      return row?.show_holds === 1;
    },
    async setShowHolds(wallet: Address, show: boolean, at: IsoTime) {
      await db
        .prepare(SET_SHOW_HOLDS_SQL)
        .bind(wallet, show ? 1 : 0, at)
        .run();
    },
  };
}
