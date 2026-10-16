import type {
  ApiError,
  ChainEventPublic,
  ClaimMessageResponse,
  ListingDetail,
  ListingOwnerResponse,
  ListingOwnerView,
  ListingPublic,
  ListingRecord,
  ListingResponse,
  ListingsResponse,
  MyListingsResponse,
  ReputationApiDeps,
  SessionRecord,
} from '@prix/contracts';
import {
  agentNameKey,
  buildClaimMessage,
  CHAIN_EXCLUSIONS,
  CHAIN_METHOD,
  CLAIM_TTL_SECONDS,
  CLAIMS_PER_CLAIMANT_PER_DAY,
  CLAIMS_PER_NETWORK_PER_DAY,
  claimMessageInputSchema,
  createListingInputSchema,
  explorerAddressUrl,
  explorerTxUrl,
  idSchema,
  isStockToken,
  LISTING_EVENTS_PAGE,
  LISTINGS_PER_MAX_AGENT,
  LOG_WINDOW_BLOCKS,
  MAX_LISTINGS_TOTAL,
  newId,
  pageQuerySchema,
  RESULTS_PAGE_SIZE,
  setListingHiddenInputSchema,
  setListingStatusInputSchema,
} from '@prix/contracts';
import { UNIVERSE } from '@prix/market';
import type { Hono } from 'hono';
import { isBlockedName } from '../blocked-names.ts';
import { ApiFailure, failures, json, noContent, secondsToUtcMidnight } from '../errors.ts';
import { clientNetwork, requireSession, requireWriter } from '../guard.ts';
import { matches, readInput, readQuery } from '../input.ts';
import { currentSeason } from '../views.ts';
import { checkClaimNonce, createClaimNonce, networkKey } from './claim.ts';

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
/** A claim may be dated this far ahead of the server clock. */
const CLOCK_SKEW_MS = 60_000;

/**
 * The Stock Tokens of the universe. On-chain records stay Stock Tokens only (docs/CONTRACTS.md section
 * 21, rule 6): a crypto asset has no token on the chain, so it is never read here.
 */
const STOCK_TOKENS = UNIVERSE.filter(isStockToken);

/**
 * The addresses of the product itself, lower-cased: the zero address, every feed of the universe
 * (Stock Tokens and crypto assets alike, the Arbitrum feeds of SOL, BNB and HYPE included, section 23
 * rule 12) and every Stock Token. None of them is ever listed.
 */
const PRODUCT_ADDRESSES: ReadonlySet<string> = new Set([
  ZERO_ADDRESS,
  ...UNIVERSE.map((entry) => entry.feedAddress.toLowerCase()),
  ...STOCK_TOKENS.map((token) => token.tokenAddress.toLowerCase()),
]);

const DECIMALS_BY_SYMBOL: ReadonlyMap<string, number> = new Map(
  STOCK_TOKENS.map((token) => [token.symbol, token.tokenDecimals]),
);

/** Wei as tokens with at most six decimals, as text. BigInt: no amount passes through a Number. */
function formatAmount(wei: string, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const value = BigInt(wei);
  const whole = value / unit;
  const fraction = (value % unit).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

/** Every listing carries its method and everything its record leaves out, whatever the store returned. */
function asPublic(listing: ListingPublic): ListingPublic {
  return { ...listing, estimated: true, recordMethod: CHAIN_METHOD, exclusions: [...CHAIN_EXCLUSIONS] };
}

function publicFromRecord(record: ListingRecord): ListingPublic {
  return {
    id: record.id,
    name: record.name,
    wallet: record.wallet,
    explorerUrl: explorerAddressUrl(record.wallet),
    verified: record.verified,
    claimedAt: record.claimedAt,
    syncState: record.syncState,
    syncedAt: record.syncedAt,
    eventCount: record.eventCount,
    estimated: true,
    recordMethod: CHAIN_METHOD,
    scoringMethod: null,
    exclusions: [...CHAIN_EXCLUSIONS],
    recordFrom: null,
    standing: null,
  };
}

function wrongSignature(): ApiFailure {
  return new ApiFailure(
    'unauthorized',
    'This signature does not match the wallet and the claim. Request a new claim message, sign it with the agent wallet, and try again.',
  );
}

function badClaim(message: string, field: string): ApiFailure {
  return failures.invalidInput(message, field);
}

function claimsRefused(now: Date): ApiFailure {
  return new ApiFailure('rate_limited', 'Too many claims were made today. Try again after 00:00 UTC.', null, {
    'Retry-After': String(secondsToUtcMidnight(now)),
  });
}

/** The wallet routes of Phase 2: claiming, listing, and reading listed on-chain agents. */
export function registerListingRoutes(app: Hono, deps: ReputationApiDeps): void {
  const { reputation, store } = deps;
  const admins: ReadonlySet<string> = new Set(deps.config.adminAddresses.map((address) => address.toLowerCase()));
  const secret = deps.config.nonceSecret;

  async function ownerView(record: ListingRecord): Promise<ListingOwnerView> {
    const visible = record.status === 'active' && !record.hidden;
    const found = visible ? await reputation.getListedAgent(record.id) : null;
    return { ...asPublic(found ?? publicFromRecord(record)), status: record.status, hidden: record.hidden };
  }

  async function maxListings(claimant: string): Promise<number> {
    const entitlements = await deps.entitlements.entitlementsFor(claimant);
    return LISTINGS_PER_MAX_AGENT * entitlements.maxAgents;
  }

  function assertListable(wallet: string, name: string): void {
    if (PRODUCT_ADDRESSES.has(wallet.toLowerCase())) {
      throw badClaim('This address belongs to Prix itself and cannot be listed. Use your agent wallet.', 'wallet');
    }
    if (isBlockedName(name)) throw failures.nameNotAllowed();
  }

  async function takeClaimCounters(keys: readonly string[], caps: readonly number[], now: Date): Promise<void> {
    const iso = now.toISOString();
    const day = iso.slice(0, 10);
    for (let i = 0; i < keys.length; i += 1) {
      if (!(await reputation.takeCounter(keys[i] as string, caps[i] as number, day, iso))) throw claimsRefused(now);
    }
  }

  // --- public reads -------------------------------------------------------------------------------

  app.get('/listings', async (c) => {
    const query = readQuery(pageQuerySchema, c.req.url);
    const rows = await reputation.listListedAgents(RESULTS_PAGE_SIZE + 1, (query.page - 1) * RESULTS_PAGE_SIZE);
    const body: ListingsResponse = {
      listings: rows.slice(0, RESULTS_PAGE_SIZE).map(asPublic),
      page: query.page,
      hasMore: rows.length > RESULTS_PAGE_SIZE,
    };
    return json(body, 200, 'public');
  });

  app.get('/me/listings', async (c) => {
    const session = await requireSession(deps, c.req.raw);
    const records = await reputation.listListingsByClaimant(session.address);
    const listings = await Promise.all(records.map(ownerView));
    const body: MyListingsResponse = {
      listings,
      remaining: Math.max(0, (await maxListings(session.address)) - records.length),
    };
    return json(body, 200, 'private');
  });

  app.get('/listings/:id', async (c) => {
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw notFound();
    const [pub, record] = await Promise.all([reputation.getListedAgent(id), reputation.getListing(id)]);
    if (pub === null || record === null || record.hidden || record.status !== 'active') throw notFound();

    const season = await currentSeason(store, deps.now().toISOString());
    const days = season
      ? await reputation.listListingDays(id, season.startsAt.slice(0, 10), season.endsAt.slice(0, 10))
      : [];
    const events = await reputation.listEventsNewest(id, LISTING_EVENTS_PAGE);
    const eventDays = events.map((event) => event.day).sort();
    const pricedDays = new Set(
      eventDays.length === 0
        ? []
        : (await reputation.listListingDays(id, eventDays[0] as string, eventDays[eventDays.length - 1] as string)).map(
            (day) => day.day,
          ),
    );
    const publicEvents: ChainEventPublic[] = events.map((event) => ({
      day: event.day,
      block: event.block,
      txHash: event.txHash,
      explorerUrl: explorerTxUrl(event.txHash),
      symbol: event.symbol,
      direction: event.direction,
      amount: formatAmount(event.amountWei, DECIMALS_BY_SYMBOL.get(event.symbol) ?? 18),
      kind: event.kind,
      priced: pricedDays.has(event.day),
    }));
    const detail: ListingDetail = {
      ...asPublic(pub),
      claimMessage: record.message,
      claimSignature: record.signature,
      signatureKind: record.signatureKind,
      days,
      events: publicEvents,
      track: await reputation.getTrackRecord(id),
    };
    return json<ListingResponse>({ listing: detail }, 200, 'public');
  });

  // --- claiming -----------------------------------------------------------------------------------

  app.post('/listings/claim-message', async (c) => {
    const session = await requireWriter(deps, c.req.raw, 1);
    const input = await readInput(claimMessageInputSchema, c.req.raw);
    assertListable(input.wallet, input.name);
    const nameKey = agentNameKey(input.name);
    // A wallet listed for another account may still be claimed back: the wallet's own signature decides.
    const existing = await reputation.getListingByWallet(input.wallet);
    if (existing !== null && existing.claimant === session.address) return walletListed();
    if (existing === null && (await reputation.nameKeyTaken(nameKey))) throw failures.nameTaken();

    const now = deps.now();
    const net = await networkKey(clientNetwork(c.req.raw), secret);
    await takeClaimCounters([`d:${now.toISOString().slice(0, 10)}:claimnet:${net}`], [CLAIMS_PER_NETWORK_PER_DAY], now);

    const issuedAt = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + CLAIM_TTL_SECONDS * 1000).toISOString();
    const nonce = await createClaimNonce(secret, {
      claimant: session.address,
      wallet: input.wallet,
      nameKey,
      issuedAt,
      expiresAt,
    });
    const message = buildClaimMessage({
      wallet: input.wallet,
      name: input.name,
      claimant: session.address,
      nonce,
      issuedAt,
      expiresAt,
      chainId: deps.chainId,
    });
    return json<ClaimMessageResponse>({ message, nonce, issuedAt, expiresAt }, 200, 'private');
  });

  app.post('/listings', async (c) => {
    const session = await requireWriter(deps, c.req.raw, 8);
    const input = await readInput(createListingInputSchema, c.req.raw);
    const now = deps.now();

    // The time rules. The server's own clock decides; a body only names the window it was given.
    const issued = Date.parse(input.issuedAt);
    const expires = Date.parse(input.expiresAt);
    if (expires - issued !== CLAIM_TTL_SECONDS * 1000) {
      throw badClaim('This claim has the wrong length of validity. Request a new claim message.', 'expiresAt');
    }
    if (issued > now.getTime() + CLOCK_SKEW_MS) {
      throw badClaim('This claim is dated in the future. Request a new claim message.', 'issuedAt');
    }
    if (!(now.getTime() < expires)) {
      throw badClaim(
        'This claim has expired. Request a new claim message and sign it within ten minutes.',
        'expiresAt',
      );
    }

    const nameKey = agentNameKey(input.name);
    const nonceOk = await checkClaimNonce(secret, input.nonce, {
      claimant: session.address,
      wallet: input.wallet,
      nameKey,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    });
    if (!nonceOk)
      throw badClaim('This claim was not issued for this wallet and name. Request a new claim message.', 'nonce');

    assertListable(input.wallet, input.name);

    // Counted on every attempt that passes the nonce, before the expensive signature check.
    const day = now.toISOString().slice(0, 10);
    const net = await networkKey(clientNetwork(c.req.raw), secret);
    await takeClaimCounters(
      [`d:${day}:claimant:${session.address}`, `d:${day}:claimnet:${net}`],
      [CLAIMS_PER_CLAIMANT_PER_DAY, CLAIMS_PER_NETWORK_PER_DAY],
      now,
    );

    // The text is built here, from the server's own fields. The body has no message to take.
    const message = buildClaimMessage({
      wallet: input.wallet,
      name: input.name,
      claimant: session.address,
      nonce: input.nonce,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      chainId: deps.chainId,
    });
    const kind = await deps.verifier.verify({ wallet: input.wallet, message, signature: input.signature });
    if (kind === null) throw wrongSignature();

    const record: ListingRecord = {
      id: newId(),
      wallet: input.wallet,
      claimant: session.address,
      name: input.name,
      nameKey,
      message,
      signature: input.signature,
      signatureKind: kind,
      status: 'active',
      hidden: false,
      verified: false,
      claimedAt: now.toISOString(),
      syncState: 'backfill',
      syncedBlock: 0,
      syncedAt: null,
      windowBlocks: LOG_WINDOW_BLOCKS,
      syncErrors: 0,
      eventCount: 0,
      balancesWei: {},
      recordDay: null,
      recordBlock: 0,
      indexMicro: 0,
    };
    const maxPerClaimant = await maxListings(session.address);
    const held = await reputation.getListingByWallet(input.wallet);
    if (held !== null) {
      // The signature above was made by the wallet itself, so it takes its listing back from any claimant.
      if (held.claimant === session.address) return walletListed();
      const taken = await reputation.replaceListingClaimant(record, { maxPerClaimant });
      if (taken === 'name_taken') throw failures.nameTaken();
      if (taken === 'claimant_limit') {
        throw new ApiFailure(
          'forbidden',
          'This account has listed as many wallets as it may. Remove a listing, or raise your tier, then try again.',
        );
      }
      if (taken === 'not_replaceable') return walletListed();
      const replaced = (await reputation.getListingByWallet(input.wallet)) ?? { ...held, ...record, id: held.id };
      return json<ListingOwnerResponse>({ listing: await ownerView(replaced) }, 201, 'private');
    }
    const outcome = await reputation.createListing(record, {
      maxPerClaimant,
      maxTotal: MAX_LISTINGS_TOTAL,
    });
    if (outcome === 'wallet_listed') return walletListed();
    if (outcome === 'name_taken') throw failures.nameTaken();
    if (outcome === 'claimant_limit') {
      throw new ApiFailure(
        'forbidden',
        'This account has listed as many wallets as it may. Remove a listing, or raise your tier, then try again.',
      );
    }
    if (outcome === 'listings_full') {
      throw new ApiFailure('league_full', 'The table of listed agents is full for now. Try again later.');
    }
    return json<ListingOwnerResponse>({ listing: await ownerView(record) }, 201, 'private');
  });

  app.post('/listings/:id/status', async (c) => {
    const session = await requireWriter(deps, c.req.raw, 2);
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw notFound();
    const input = await readInput(setListingStatusInputSchema, c.req.raw);
    const record = await reputation.getListing(id);
    if (record === null) throw notFound();
    if (record.claimant !== session.address) throw notYours(session);
    if (!(await reputation.setListingStatus(id, session.address, input.status, deps.now().toISOString()))) {
      throw notFound();
    }
    const updated = (await reputation.getListing(id)) ?? { ...record, status: input.status };
    return json<ListingOwnerResponse>({ listing: await ownerView(updated) }, 200, 'private');
  });

  app.post('/admin/listings/:id/hidden', async (c) => {
    const session = await requireWriter(deps, c.req.raw, 4);
    if (!admins.has(session.address)) throw failures.notAdmin();
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw notFound();
    const input = await readInput(setListingHiddenInputSchema, c.req.raw);
    if (!(await reputation.setListingHidden(id, input.hidden))) throw notFound();
    console.log(
      JSON.stringify({
        event: 'admin_action',
        admin: session.address,
        action: input.hidden ? 'hide_listing' : 'unhide_listing',
        target: id,
      }),
    );
    const season = await currentSeason(store, deps.now().toISOString());
    if (season !== null) await reputation.rankScores(season.id, 'chain');
    return noContent();
  });
}

/**
 * 409 with code `invalid_input` and field `wallet`, as section 3 of the contract says. The shared
 * `errorResponse` maps `invalid_input` to 400 only, so this answer is built here, in the same shape.
 */
function walletListed(): Response {
  const body: ApiError = {
    error: { code: 'invalid_input', message: 'This wallet is already listed. Open its page instead.', field: 'wallet' },
  };
  return json(body, 409, 'private');
}

function notFound(): ApiFailure {
  return new ApiFailure('not_found', 'No listed agent has this id. Check the link, or open the list of listed agents.');
}

function notYours(_session: SessionRecord): ApiFailure {
  return new ApiFailure(
    'forbidden',
    'This listing belongs to another account. Sign in with the account that claimed it.',
  );
}
