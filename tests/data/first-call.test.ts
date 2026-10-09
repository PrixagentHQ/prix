import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createApiKeyResponseSchema, dataEnvelope, dataUsageSchema, leagueResponseSchema } from '@prix/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../support/repo.ts';
import { createDataHarness, testWallet } from './support/harness.ts';

/**
 * docs/contracts/phase-5-data.md section 8 item 4: the five-minute claim. A developer who is
 * signed in makes a key and reads the league in at most four requests, and the page that tells
 * them how holds the curl line.
 */

describe('the quickstart as requests', () => {
  it('sign in (a test session), create a key, read the league with it, read the quota: at most four requests', async () => {
    const h = await createDataHarness();
    const wallet = testWallet(801);
    // The session is the result of the sign-in signature; the test stores it without the nonce round trip.
    const cookie = await h.seedSession(wallet);
    const before = h.transcript.length;
    let requests = 1; // the sign-in itself

    const created = await h.send('POST', '/api/data/keys', { cookie, body: { label: 'first call' } });
    requests += 1;
    expect(created.status, created.text).toBe(201);
    const secret = created.json.secret as string;
    expect(secret).toMatch(/^prix_[a-z2-7]{52}$/);

    const league = await h.send('GET', '/api/v1/league', { key: secret });
    requests += 1;
    expect(league.status, league.text).toBe(200);
    const parsed = dataEnvelope(leagueResponseSchema).safeParse(league.json);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    expect(league.headers.get('X-Prix-Quota-Remaining')).toBe('49');

    const me = await h.send('GET', '/api/v1/me', { key: secret });
    requests += 1;
    expect(me.status).toBe(200);
    const usage = dataEnvelope(dataUsageSchema).parse(me.json).data;
    expect(usage.usedFree).toBe(1);
    expect(usage.remainingFree).toBe(49);

    expect(requests).toBeLessThanOrEqual(4);
    expect(h.transcript.length - before).toBe(3);
  });
});

describe('the answer that creates a key', () => {
  it('matches createApiKeyResponseSchema: the id is a contract id, the secret has the key shape', async () => {
    const h = await createDataHarness();
    const cookie = await h.seedSession(testWallet(802));
    const created = await h.send('POST', '/api/data/keys', { cookie, body: { label: 'shape' } });
    expect(created.status).toBe(201);
    const parsed = createApiKeyResponseSchema.safeParse(created.json);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

describe('the built /developers page', () => {
  let built = '';

  beforeAll(() => {
    const root = repoRoot();
    execSync('pnpm --filter @prix/web exec astro build', { cwd: root, stdio: 'pipe', timeout: 240_000 });
    const dist = path.join(root, 'apps', 'web', 'dist', 'server');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.mjs')) files.push(full);
      }
    };
    walk(dist);
    // The page is server-rendered, so its source is in the built server chunks. The one that
    // holds the first-call line of the developers page is the one that also builds the MCP config.
    built = files
      .map((file) => readFileSync(file, 'utf8'))
      .filter((text) => text.includes('/api/v1/league') && text.includes('Authorization: Bearer'))
      .join('\n');
  }, 300_000);

  it('contains the curl line for /api/v1/league with the Authorization: Bearer header', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the page source holds a literal ${origin} placeholder
    expect(built).toContain('curl -H "Authorization: Bearer prix_YOUR_KEY" ${origin}/api/v1/league');
    expect(built).toContain('Authorization: Bearer');
  });

  it('shows a placeholder key and never a real-looking one', () => {
    expect(built).not.toMatch(/prix_[a-z2-7]{52}/);
  });
});
