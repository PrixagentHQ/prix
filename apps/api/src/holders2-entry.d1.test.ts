import { env as baseEnv } from 'cloudflare:workers';
import type {
  FollowApiDepsWithLounge,
  LoungeSweepJobDeps,
  RoomHoldersApiDeps,
  SocialJob,
  SocialJobOutcome,
  TapeApiDeps,
  TelegramLoungePort,
} from '@prix/contracts';
import {
  HOLDERS_LOUNGE_CHAT_ID_VAR,
  HOLDERS_LOUNGE_INVITE_URL_VAR,
  HOLDERS_LOUNGE_VAR,
  LOUNGE_CHAT_ID_PATTERN,
  LOUNGE_INVITE_URL_PATTERN,
  loungeConfig,
  ROOM_ENABLED_VAR,
  ROOM_HOLDERS_VAR,
  SOCIAL_CRON,
  socialJobNameSchema,
  TAPE_ENABLED_VAR,
  TAPE_PATH,
} from '@prix/contracts';
import { resetTokenMemory } from '@prix/runtime/token/service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { runCron } from './index.ts';

/**
 * Phase 6.8, the holders' second wave, in the Worker entry (docs/contracts/phase-6-holders-2.md sections
 * 2, 3.1, 4.1, 4.6 and 5): the three switches and their config in every state of the runbook, the room's
 * two new deps, the lounge's deps on the follow routes, the tape's deps, the sweep's place in the social
 * step, and the entry's own cache that never holds the tape.
 * Run: pnpm exec vitest run --config apps/api/vitest.workers.config.ts
 */
const ORIGIN = 'https://prix.test';
const ADMIN = '0x00000000000000000000000000000000000009a1';
const TOKEN = '0xa74ac6e9f2f8493344923c23972d496364241044';
const CHAT_ID = '-1001234567890';
const INVITE = 'https://t.me/+AbCdEfGh12345678';
const MARKER = 'from-the-cache';

const db = (baseEnv as unknown as { DB: D1Database }).DB;

/** The extras the entry built its app from, the last time. */
const app = vi.hoisted(() => ({ extras: null as Record<string, unknown> | null }));
vi.mock('./http/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http/index.ts')>();
  return {
    ...actual,
    createApp: (...args: Parameters<typeof actual.createApp>) => {
      app.extras = args[1] as unknown as Record<string, unknown>;
      return actual.createApp(...args);
    },
  };
});

/**
 * The runtime's social module, with three seams: the step records the names of the jobs it was handed and
 * runs none; and the two factories of engine-runtime this wave reads by name are present or absent as a
 * test says, each recording what it was built from.
 */
const runtime = vi.hoisted(() => ({
  factories: false,
  names: [] as string[],
  sweepDeps: null as LoungeSweepJobDeps | null,
  portTokens: [] as string[],
}));
vi.mock('@prix/runtime/social/index', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const port: TelegramLoungePort = {
    approveJoin: async () => ({ ok: true }) as never,
    declineJoin: async () => ({ ok: true }) as never,
    ban: async () => ({ ok: true }) as never,
    unban: async () => ({ ok: true }) as never,
    sendDirect: async () => ({ ok: true }) as never,
  };
  const module: Record<string, unknown> = {
    ...actual,
    runSocialStep: async (jobs: readonly SocialJob[]) => {
      runtime.names = jobs.map((job) => job.name);
      return { ran: null, outcome: 'idle' as SocialJobOutcome };
    },
  };
  // Present only while a test asks for them: a getter, so that the entry reads them at the moment it builds.
  Object.defineProperty(module, 'createLoungeSweepJob', {
    enumerable: true,
    get: () =>
      runtime.factories
        ? (deps: LoungeSweepJobDeps): SocialJob => {
            runtime.sweepDeps = deps;
            return { name: 'holders_lounge_sweep', run: async () => 'idle' } as SocialJob;
          }
        : undefined,
  });
  Object.defineProperty(module, 'createTelegramLoungePort', {
    enumerable: true,
    get: () =>
      runtime.factories
        ? (token: string): TelegramLoungePort => {
            runtime.portTokens.push(token);
            return port;
          }
        : undefined,
  });
  return module;
});

/** A fresh env each time, so the entry builds its wiring again. */
function envWith(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const counted = { limit: async () => ({ success: true }) };
  return {
    ...(baseEnv as unknown as Record<string, unknown>),
    SITE_ORIGIN: ORIGIN,
    ADMIN_ADDRESSES: ADMIN,
    HOUSE_MODEL: '@cf/test/model',
    HOUSE_MODEL_INPUT_NEURONS: '1',
    HOUSE_MODEL_OUTPUT_NEURONS: '1',
    KEY_ENCRYPTION_KEY: btoa('k'.repeat(32)),
    NONCE_SECRET: btoa('n'.repeat(32)),
    RATE_SIGN_IN: counted,
    RATE_WRITE: counted,
    RATE_READ: counted,
    SOCIAL_ENABLED: 'true',
    [ROOM_ENABLED_VAR]: 'true',
    ...extra,
  };
}

/** The bot's three settings, as a deploy with the bot configured has them. */
const BOT = {
  TELEGRAM_BOT_TOKEN: '123456:test-token-of-the-bot',
  TELEGRAM_WEBHOOK_SECRET: 's'.repeat(40),
  TELEGRAM_BOT_USERNAME: 'PrixagentBot',
};
const LOUNGE_ON = {
  [HOLDERS_LOUNGE_VAR]: 'on',
  [HOLDERS_LOUNGE_CHAT_ID_VAR]: CHAT_ID,
  [HOLDERS_LOUNGE_INVITE_URL_VAR]: INVITE,
};

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined };

async function call(env: Record<string, unknown>, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init) as never, env as never, ctx as never);
  await Promise.all(pending.splice(0));
  return response;
}

/** Builds the entry's app for `env` (one request to a path nobody answers) and answers its extras. */
async function extrasFor(env: Record<string, unknown>): Promise<Record<string, unknown>> {
  app.extras = null;
  await call(env, '/api/no-such-path');
  if (app.extras === null) throw new Error('the entry built no app');
  return app.extras;
}

let logs: string[] = [];
beforeEach(() => {
  runtime.factories = false;
  runtime.names = [];
  runtime.sweepDeps = null;
  runtime.portTokens = [];
  logs = [];
  const record = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  vi.spyOn(console, 'warn').mockImplementation(record);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db
    .prepare("UPDATE token_config SET enabled = 0, token_address = NULL, updated_by = 'migration' WHERE id = 1")
    .run();
  resetTokenMemory();
});

describe('the room: ROOM_HOLDERS and the gate', () => {
  for (const [value, on] of [
    ['true', true],
    [' TRUE ', true],
    ['false', false],
    ['', false],
    [undefined, false],
  ] as const) {
    it(`hands the room roomHoldersOn ${on} while ROOM_HOLDERS is ${JSON.stringify(value)}`, async () => {
      const extras = await extrasFor(envWith(value === undefined ? {} : { [ROOM_HOLDERS_VAR]: value }));
      expect((extras.room as RoomHoldersApiDeps).roomHoldersOn).toBe(on);
      expect((extras.roomAdmin as RoomHoldersApiDeps).roomHoldersOn).toBe(on);
    });
  }

  it("answers the gate from the token service's config: off with no token", async () => {
    const room = (await extrasFor(envWith({ [ROOM_HOLDERS_VAR]: 'true' }))).room as RoomHoldersApiDeps;
    expect(await room.holdersGate?.()).toEqual({ gatingOn: false, token: null });
  });

  it("answers the gate from the token service's config: on, with the token in lower case", async () => {
    await db.prepare('UPDATE token_config SET enabled = 1, token_address = ?1 WHERE id = 1').bind(TOKEN).run();
    resetTokenMemory();
    const room = (await extrasFor(envWith({ [ROOM_HOLDERS_VAR]: 'true' }))).room as RoomHoldersApiDeps;
    expect(await room.holdersGate?.()).toEqual({ gatingOn: true, token: TOKEN });
  });

  it('keeps a token with the gate off as off', async () => {
    await db.prepare('UPDATE token_config SET enabled = 0, token_address = ?1 WHERE id = 1').bind(TOKEN).run();
    resetTokenMemory();
    const room = (await extrasFor(envWith())).room as RoomHoldersApiDeps;
    expect(await room.holdersGate?.()).toEqual({ gatingOn: false, token: TOKEN });
  });
});

describe('the tape: TAPE_ENABLED and SOCIAL_ENABLED, both', () => {
  for (const [social, tape, mounted] of [
    ['true', 'true', true],
    ['true', 'false', false],
    ['false', 'true', false],
    ['false', 'false', false],
    ['true', undefined, false],
  ] as const) {
    it(`${mounted ? 'hands' : 'does not hand'} the app the tape while they are ${JSON.stringify([social, tape])}`, async () => {
      const extras = await extrasFor(
        envWith({ SOCIAL_ENABLED: social, ...(tape === undefined ? {} : { [TAPE_ENABLED_VAR]: tape }) }),
      );
      if (!mounted) {
        expect(extras.tape).toBeUndefined();
        return;
      }
      const deps = extras.tape as TapeApiDeps;
      expect(typeof deps.follow.listLeagueFeed).toBe('function');
      expect(typeof deps.entitlements.entitlementsFor).toBe('function');
      expect(deps.config.siteOrigin).toBe(ORIGIN);
    });
  }

  it('never serves the tape from the entry, and never stores it there: its cache key is null', async () => {
    await caches.default.put(
      `${ORIGIN}${TAPE_PATH}`,
      new Response(MARKER, { headers: { 'Cache-Control': 'public, max-age=30' } }),
    );
    for (const tape of ['true', 'false']) {
      const response = await call(envWith({ [TAPE_ENABLED_VAR]: tape }), TAPE_PATH);
      expect(await response.text()).not.toBe(MARKER);
    }
    await caches.default.delete(`${ORIGIN}${TAPE_PATH}`);
    await call(envWith({ [TAPE_ENABLED_VAR]: 'true' }), TAPE_PATH);
    expect(await caches.default.match(`${ORIGIN}${TAPE_PATH}`)).toBeUndefined();
  });

  it('answers the tape as an unknown path while it is off', async () => {
    const env = envWith({ [TAPE_ENABLED_VAR]: 'false' });
    const tape = await call(env, TAPE_PATH);
    const unknown = await call(env, '/api/no-such-path');
    expect(tape.status).toBe(404);
    expect(await tape.text()).toBe(await unknown.text());
  });
});

describe('the lounge: HOLDERS_LOUNGE, its two variables, the bot and the two factories', () => {
  async function loungeOf(env: Record<string, unknown>): Promise<FollowApiDepsWithLounge['lounge']> {
    return ((await extrasFor(env)).follow as FollowApiDepsWithLounge).lounge;
  }

  it('hands the follow routes the lounge when all of them are there', async () => {
    runtime.factories = true;
    const lounge = await loungeOf(envWith({ ...BOT, ...LOUNGE_ON }));
    expect(lounge?.config).toEqual({ chatId: Number(CHAT_ID), inviteUrl: INVITE });
    expect(typeof lounge?.store.listDue).toBe('function');
    expect(typeof lounge?.port.approveJoin).toBe('function');
    // The port is built with the bot's own token, and the token is in no log line.
    expect(runtime.portTokens).toEqual([BOT.TELEGRAM_BOT_TOKEN]);
    expect(logs.join('\n')).not.toContain(BOT.TELEGRAM_BOT_TOKEN);
  });

  it('is null while HOLDERS_LOUNGE is off, and says nothing of it', async () => {
    runtime.factories = true;
    for (const off of ['off', '', 'true', 'ON-ish']) {
      expect(await loungeOf(envWith({ ...BOT, ...LOUNGE_ON, [HOLDERS_LOUNGE_VAR]: off })), off).toBeNull();
    }
    expect(logs.join('\n')).not.toContain('lounge_config_invalid');
  });

  it('is null while the bot is not configured', async () => {
    runtime.factories = true;
    expect(await loungeOf(envWith({ ...LOUNGE_ON }))).toBeNull();
    expect(await loungeOf(envWith({ ...BOT, ...LOUNGE_ON, TELEGRAM_WEBHOOK_SECRET: 'short' }))).toBeNull();
  });

  it("is null while either of engine-runtime's factories is missing", async () => {
    runtime.factories = false;
    expect(await loungeOf(envWith({ ...BOT, ...LOUNGE_ON }))).toBeNull();
  });

  for (const [what, vars] of [
    ['no chat id', { [HOLDERS_LOUNGE_CHAT_ID_VAR]: '' }],
    ["a basic group's id", { [HOLDERS_LOUNGE_CHAT_ID_VAR]: '-123456789' }],
    ['a user id', { [HOLDERS_LOUNGE_CHAT_ID_VAR]: '123456789' }],
    ['no link', { [HOLDERS_LOUNGE_INVITE_URL_VAR]: '' }],
    ['a public link', { [HOLDERS_LOUNGE_INVITE_URL_VAR]: 'https://t.me/prixcommunity' }],
    ['a link of another site', { [HOLDERS_LOUNGE_INVITE_URL_VAR]: 'https://t.me.example/+AbCdEfGh12345678' }],
  ] as const) {
    it(`is null with ${what} while HOLDERS_LOUNGE is "on", and logs lounge_config_invalid once, with no value`, async () => {
      runtime.factories = true;
      const env = envWith({ ...BOT, ...LOUNGE_ON, ...vars });
      expect(await loungeOf(env)).toBeNull();
      await call(env, '/api/no-such-path');
      const invalid = logs.filter((line) => line.includes('lounge_config_invalid'));
      expect(invalid).toEqual([JSON.stringify({ event: 'lounge_config_invalid' })]);
    });
  }
});

describe('the sweep in the social step', () => {
  it('stands after manager_value and poll_tally and before room_picture_sweep, with room_prune last', async () => {
    runtime.factories = true;
    await runCron(SOCIAL_CRON, envWith({ ...BOT, ...LOUNGE_ON }) as never);
    expect(runtime.names).toEqual([
      'model_war',
      'rank_tape',
      'rivalry_match',
      'strategy_dna',
      'manager_value',
      // The first holders wave's tally, before the lounge's sweep once both waves are merged.
      'poll_tally',
      'holders_lounge_sweep',
      'room_picture_sweep',
      'room_prune',
    ]);
    // Every name is one of the job schema's.
    for (const name of runtime.names) expect(socialJobNameSchema.safeParse(name).success, name).toBe(true);
  });

  it('is built with the lounge, the gate, the site and the token service', async () => {
    runtime.factories = true;
    await runCron(SOCIAL_CRON, envWith({ ...BOT, ...LOUNGE_ON }) as never);
    const deps = runtime.sweepDeps;
    expect(deps?.config).toEqual({ chatId: Number(CHAT_ID), inviteUrl: INVITE });
    expect(deps?.port).not.toBeNull();
    expect(deps?.siteOrigin).toBe(ORIGIN);
    expect(typeof deps?.lounge.listDue).toBe('function');
    expect(await deps?.holdersGate()).toEqual({ gatingOn: false, token: null });
  });

  it('is built idle while the lounge is off: no config and no port', async () => {
    runtime.factories = true;
    await runCron(SOCIAL_CRON, envWith({ ...BOT }) as never);
    expect(runtime.names).toContain('holders_lounge_sweep');
    expect(runtime.sweepDeps?.config).toBeNull();
    expect(runtime.sweepDeps?.port).toBeNull();
  });

  it("is left out of the list, and says so, while engine-runtime's factories are missing", async () => {
    runtime.factories = false;
    await runCron(SOCIAL_CRON, envWith({ ...BOT, ...LOUNGE_ON }) as never);
    expect(runtime.names).not.toContain('holders_lounge_sweep');
    expect(runtime.names.slice(-2)).toEqual(['room_picture_sweep', 'room_prune']);
    expect(logs.some((line) => line.includes('step_not_configured') && line.includes('holders_lounge_sweep'))).toBe(
      true,
    );
  });
});

describe('wrangler.jsonc', () => {
  /** apps/api/wrangler.jsonc of the checkout under test, handed in as text by this suite's config. */
  const REAL = (baseEnv as unknown as { WRANGLER_JSONC: string }).WRANGLER_JSONC;
  const liveOf = (text: string): string =>
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

  const PROBLEMS = {
    unreadable: 'it is not JSON once its comment lines are taken out',
    roomHolders: `${ROOM_HOLDERS_VAR} is neither "true" nor "false"`,
    tape: `${TAPE_ENABLED_VAR} is neither "true" nor "false"`,
    lounge: `${HOLDERS_LOUNGE_VAR} is neither "on" nor "off"`,
    chatId: `${HOLDERS_LOUNGE_CHAT_ID_VAR} is neither empty nor a supergroup's id`,
    invite: `${HOLDERS_LOUNGE_INVITE_URL_VAR} is neither empty nor an approval link`,
    early: `${HOLDERS_LOUNGE_VAR} is "on" and the lounge's config would be null: the chat id and the link first`,
  } as const;

  /**
   * What is wrong with a text of apps/api/wrangler.jsonc for this wave, or null. The runbook (infra/README.md
   * section 20) changes the file in steps, each a commit with a deploy of its own, so no single state is
   * pinned: the three switches each read one of their two words, the chat id and the link are empty or
   * valid, and the lounge is never "on" with a config `loungeConfig` refuses.
   */
  function holders2ConfigProblem(text: string): string | null {
    let read: { vars?: Record<string, unknown> };
    try {
      read = JSON.parse(liveOf(text));
    } catch {
      return PROBLEMS.unreadable;
    }
    const vars = read.vars ?? {};
    const roomHolders = vars[ROOM_HOLDERS_VAR];
    const tape = vars[TAPE_ENABLED_VAR];
    const lounge = vars[HOLDERS_LOUNGE_VAR];
    const chatId = vars[HOLDERS_LOUNGE_CHAT_ID_VAR];
    const invite = vars[HOLDERS_LOUNGE_INVITE_URL_VAR];
    if (roomHolders !== 'true' && roomHolders !== 'false') return PROBLEMS.roomHolders;
    if (tape !== 'true' && tape !== 'false') return PROBLEMS.tape;
    if (lounge !== 'on' && lounge !== 'off') return PROBLEMS.lounge;
    if (typeof chatId !== 'string' || (chatId !== '' && !LOUNGE_CHAT_ID_PATTERN.test(chatId))) return PROBLEMS.chatId;
    if (typeof invite !== 'string' || (invite !== '' && !LOUNGE_INVITE_URL_PATTERN.test(invite)))
      return PROBLEMS.invite;
    if (lounge === 'on' && loungeConfig({ on: lounge, chatId, inviteUrl: invite }) === null) return PROBLEMS.early;
    return null;
  }

  /** `text` with the value of one variable written as `json`. The variable stands once. */
  function withVar(text: string, name: string, json: string): string {
    const value = new RegExp(`("${name}": )[^,\\r\\n]*`, 'g');
    if ([...text.matchAll(value)].length !== 1) throw new Error(`not once in the text: the variable ${name}`);
    return text.replace(value, (_, key: string) => `${key}${json}`);
  }

  /** This wave's five variables as the build left them: every switch off, the lounge with no chat id and no link. */
  const BUILT: [name: string, json: string][] = [
    [ROOM_HOLDERS_VAR, '"false"'],
    [TAPE_ENABLED_VAR, '"false"'],
    [HOLDERS_LOUNGE_VAR, '"off"'],
    [HOLDERS_LOUNGE_CHAT_ID_VAR, '""'],
    [HOLDERS_LOUNGE_INVITE_URL_VAR, '""'],
  ];
  /**
   * The real file with those five as the build left them. The refused states below are made from it, never
   * from the real file itself, so that each is the state its name says at whichever step of the runbook the
   * real file stands.
   */
  const asBuilt = (): string => BUILT.reduce((text, [name, json]) => withVar(text, name, json), REAL);

  it('allows the real file at whichever step of the runbook it stands, with no lounge while it is not "on"', () => {
    expect(
      holders2ConfigProblem(REAL),
      'apps/api/wrangler.jsonc is in none of the states that infra/README.md section 20 allows',
    ).toBeNull();
    const { vars } = JSON.parse(liveOf(REAL)) as { vars: Record<string, string> };
    const on = vars[HOLDERS_LOUNGE_VAR];
    const chatId = vars[HOLDERS_LOUNGE_CHAT_ID_VAR];
    const inviteUrl = vars[HOLDERS_LOUNGE_INVITE_URL_VAR];
    // "off": no lounge, whatever the chat id and the link hold. "on": the file's own two values, valid by the rule.
    expect(loungeConfig({ on, chatId, inviteUrl })).toEqual(on === 'on' ? { chatId: Number(chatId), inviteUrl } : null);
  });

  it('allows the state after the build, wherever the real file stands: every switch off, and no lounge', () => {
    const built = asBuilt();
    expect(holders2ConfigProblem(built)).toBeNull();
    expect(holders2ConfigProblem(built.replaceAll('\n', '\r\n')), 'with Windows line ends').toBeNull();
    const { vars } = JSON.parse(liveOf(built)) as { vars: Record<string, string> };
    expect(vars[HOLDERS_LOUNGE_VAR]).toBe('off');
    expect(
      loungeConfig({
        on: vars[HOLDERS_LOUNGE_VAR],
        chatId: vars[HOLDERS_LOUNGE_CHAT_ID_VAR],
        inviteUrl: vars[HOLDERS_LOUNGE_INVITE_URL_VAR],
      }),
    ).toBeNull();
  });

  it('allows every state of the runbook ahead of the real file: the tape, the room, then the lounge', () => {
    const tape = withVar(REAL, TAPE_ENABLED_VAR, '"true"');
    const room = withVar(tape, ROOM_HOLDERS_VAR, '"true"');
    const ids = withVar(
      withVar(room, HOLDERS_LOUNGE_CHAT_ID_VAR, `"${CHAT_ID}"`),
      HOLDERS_LOUNGE_INVITE_URL_VAR,
      `"${INVITE}"`,
    );
    const lounge = withVar(ids, HOLDERS_LOUNGE_VAR, '"on"');
    const back = withVar(lounge, HOLDERS_LOUNGE_VAR, '"off"');
    for (const [name, text] of Object.entries({ tape, room, ids, lounge, back })) {
      expect(holders2ConfigProblem(text), name).toBeNull();
      expect(holders2ConfigProblem(text.replaceAll('\n', '\r\n')), `${name} with Windows line ends`).toBeNull();
    }
    const { vars } = JSON.parse(liveOf(lounge)) as { vars: Record<string, string> };
    expect(
      loungeConfig({
        on: vars[HOLDERS_LOUNGE_VAR],
        chatId: vars[HOLDERS_LOUNGE_CHAT_ID_VAR],
        inviteUrl: vars[HOLDERS_LOUNGE_INVITE_URL_VAR],
      }),
    ).toEqual({ chatId: Number(CHAT_ID), inviteUrl: INVITE });
  });

  /** Every state the file must never be in: the state after the build with the one change its name says. */
  const REFUSED: [state: string, text: () => string, problem: string][] = [
    [
      'the lounge "on" before its chat id and link',
      () => withVar(asBuilt(), HOLDERS_LOUNGE_VAR, '"on"'),
      PROBLEMS.early,
    ],
    [
      'the lounge "on" with a link and no chat id',
      () => withVar(withVar(asBuilt(), HOLDERS_LOUNGE_INVITE_URL_VAR, `"${INVITE}"`), HOLDERS_LOUNGE_VAR, '"on"'),
      PROBLEMS.early,
    ],
    ["a basic group's id", () => withVar(asBuilt(), HOLDERS_LOUNGE_CHAT_ID_VAR, '"-123456789"'), PROBLEMS.chatId],
    ['a public link', () => withVar(asBuilt(), HOLDERS_LOUNGE_INVITE_URL_VAR, '"https://t.me/prix"'), PROBLEMS.invite],
    ['ROOM_HOLDERS "yes"', () => withVar(asBuilt(), ROOM_HOLDERS_VAR, '"yes"'), PROBLEMS.roomHolders],
    ['TAPE_ENABLED "on"', () => withVar(asBuilt(), TAPE_ENABLED_VAR, '"on"'), PROBLEMS.tape],
    ['HOLDERS_LOUNGE "true"', () => withVar(asBuilt(), HOLDERS_LOUNGE_VAR, '"true"'), PROBLEMS.lounge],
    ['HOLDERS_LOUNGE a number', () => withVar(asBuilt(), HOLDERS_LOUNGE_VAR, '1'), PROBLEMS.lounge],
  ];
  for (const [state, text, problem] of REFUSED) {
    it(`refuses ${state}`, () => {
      expect(holders2ConfigProblem(text())).toBe(problem);
    });
  }
});
