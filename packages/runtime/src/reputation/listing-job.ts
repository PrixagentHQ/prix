import type {
  ChainEvent,
  ListingRecord,
  ListingSyncUpdate,
  RawTransfer,
  ReputationJob,
  ReputationJobDeps,
  UtcDay,
} from '@prix/contracts';
import {
  BLOCKS_PER_TIMESTAMP_BATCH,
  CONFIRMATION_BLOCKS,
  LISTING_SYNC_INTERVAL_SECONDS,
  MAX_CHAIN_EVENTS_PER_LISTING,
  MIN_LOG_WINDOW_BLOCKS,
} from '@prix/contracts';
import { guardJob } from './season-jobs.ts';

const DAY_MS = 86_400_000;
/** Failed reads in a row before a listing is marked `error`. */
const MAX_SYNC_ERRORS = 3;

/** The update that changes nothing but what the caller overrides. */
function unchanged(listing: ListingRecord, iso: string, over: Partial<ListingSyncUpdate>): ListingSyncUpdate {
  return {
    listingId: listing.id,
    events: [],
    days: [],
    syncedBlock: listing.syncedBlock,
    syncedAt: listing.syncedAt ?? iso,
    syncState: listing.syncState,
    windowBlocks: listing.windowBlocks,
    syncErrors: listing.syncErrors,
    verified: listing.verified,
    balancesWei: listing.balancesWei,
    recordDay: listing.recordDay,
    recordBlock: listing.recordBlock,
    indexMicro: listing.indexMicro,
    eventCount: listing.eventCount,
    ...over,
  };
}

export function createListingSyncJob(deps: ReputationJobDeps): ReputationJob {
  const { reputation, wallet, chainRecord, entitlements } = deps;
  const name = 'listing_sync';

  return {
    name,
    run: (now) =>
      guardJob(name, async () => {
        const iso = now.toISOString();
        const listing = await reputation.nextListingToSync(iso, LISTING_SYNC_INTERVAL_SECONDS);
        if (listing === null) return 'idle';

        const fail = async (): Promise<'more'> => {
          const errors = listing.syncErrors + 1;
          await reputation.applySync(
            unchanged(listing, iso, {
              syncErrors: errors,
              syncState: errors >= MAX_SYNC_ERRORS ? 'error' : listing.syncState,
            }),
          );
          return 'more';
        };

        const verifiedNow = (await entitlements.entitlementsFor(listing.claimant, { cachedOnly: true })).verifiedBadge;

        if (listing.syncState === 'too_active') {
          await reputation.applySync(unchanged(listing, iso, { syncedAt: iso, verified: verifiedNow }));
          return 'done';
        }

        const head = await wallet.headBlock();
        if (head === null) return fail();
        const target = head.number - CONFIRMATION_BLOCKS;
        if (listing.syncedBlock >= target) {
          await reputation.applySync(unchanged(listing, iso, { syncedAt: iso, verified: verifiedNow }));
          return 'done';
        }

        let to = Math.min(target, listing.syncedBlock + listing.windowBlocks);
        const read = await wallet.readTransfers(listing.wallet, listing.syncedBlock + 1, to);
        if (!read.ok) {
          if (read.reason === 'window_too_large' && listing.windowBlocks > MIN_LOG_WINDOW_BLOCKS) {
            const half = Math.max(MIN_LOG_WINDOW_BLOCKS, Math.floor(listing.windowBlocks / 2));
            await reputation.applySync(unchanged(listing, iso, { windowBlocks: half }));
            return 'more';
          }
          return fail();
        }

        // Block times: the distinct blocks of the transfers plus `to`, at most one batch.
        let transfers: RawTransfer[] = read.transfers.filter((t) => t.block <= to);
        const blocks = [...new Set(transfers.map((t) => t.block))].sort((a, b) => a - b);
        if (new Set([...blocks, to]).size > BLOCKS_PER_TIMESTAMP_BATCH) {
          const kept = blocks.slice(0, BLOCKS_PER_TIMESTAMP_BATCH);
          to = kept[kept.length - 1] ?? to;
          transfers = transfers.filter((t) => t.block <= to);
          blocks.length = kept.length;
        }
        const wanted = [...new Set([...blocks, to])];
        const times = await wallet.blockTimes(wanted);
        if (times === null || wanted.some((b) => typeof times[b] !== 'number')) return fail();
        const dayOfBlock = (block: number): UtcDay => new Date((times[block] ?? 0) * 1000).toISOString().slice(0, 10);

        let events: ChainEvent[] = chainRecord.classify(transfers, dayOfBlock);
        let tooActive = false;
        const room = MAX_CHAIN_EVENTS_PER_LISTING - listing.eventCount;
        if (events.length > room) {
          events = events.slice(0, Math.max(0, room));
          tooActive = true;
        }

        const settledDay = new Date(Date.parse(`${dayOfBlock(to)}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
        const stored = await reputation.listEventsAfterBlock(
          listing.id,
          listing.recordBlock,
          MAX_CHAIN_EVENTS_PER_LISTING,
        );
        const all = [...stored, ...events].filter((e) => listing.recordDay === null || e.day > listing.recordDay);
        const days = await reputation.listDayPrices(listing.recordDay, settledDay);
        const base = listing.recordDay === null ? null : await reputation.getDayPrices(listing.recordDay);
        const built = chainRecord.build({
          balancesWei: listing.balancesWei,
          recordDay: listing.recordDay,
          indexMicro: listing.indexMicro,
          events: all,
          days,
          baseDayPrices: base,
        });

        let recordBlock = listing.recordBlock;
        if (built.recordDay !== null) {
          for (const e of [...stored, ...events]) {
            if (e.day <= built.recordDay && e.block > recordBlock) recordBlock = e.block;
          }
        }
        const verified = verifiedNow;

        await reputation.applySync({
          listingId: listing.id,
          events,
          days: built.newDays,
          syncedBlock: to,
          syncedAt: iso,
          syncState: tooActive ? 'too_active' : to < target ? 'backfill' : 'live',
          windowBlocks: listing.windowBlocks,
          syncErrors: 0,
          verified,
          balancesWei: built.balancesWei,
          recordDay: built.recordDay,
          recordBlock,
          indexMicro: built.indexMicro,
          eventCount: listing.eventCount + events.length,
        });
        return 'done';
      }),
  };
}
