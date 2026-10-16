import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HSTS_VALUE, httpsRedirect, SITE_ORIGIN } from './https.ts';

const ON = { production: true };

describe('httpsRedirect', () => {
  it('sends a plain http GET on the production host to the same path and query on https', () => {
    const answer = httpsRedirect(new URL('http://prixagent.com/agents/abc?tab=trades&x=1'), 'GET', ON);
    expect(answer).not.toBeNull();
    expect(answer?.status).toBe(301);
    expect(answer?.headers.get('Location')).toBe('https://prixagent.com/agents/abc?tab=trades&x=1');
  });

  it('answers 301 for HEAD and for the bare root', () => {
    const answer = httpsRedirect(new URL('http://prixagent.com/'), 'HEAD', ON);
    expect(answer?.status).toBe(301);
    expect(answer?.headers.get('Location')).toBe('https://prixagent.com/');
  });

  it('answers 308 for every other method, so the method and body are kept', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const answer = httpsRedirect(new URL('http://prixagent.com/account?a=b'), method, ON);
      expect(answer?.status, method).toBe(308);
      expect(answer?.headers.get('Location'), method).toBe('https://prixagent.com/account?a=b');
    }
  });

  it('treats a lower-case method as the method it names', () => {
    expect(httpsRedirect(new URL('http://prixagent.com/'), 'get', ON)?.status).toBe(301);
  });

  it('lets https through', () => {
    expect(httpsRedirect(new URL('https://prixagent.com/agents?x=1'), 'GET', ON)).toBeNull();
    expect(httpsRedirect(new URL('https://prixagent.com/'), 'POST', ON)).toBeNull();
  });

  it('lets this machine through, on any port', () => {
    for (const url of [
      'http://localhost/',
      'http://localhost:4321/agents',
      'http://127.0.0.1:8787/',
      'http://127.0.0.1/',
      'http://[::1]:4321/',
    ]) {
      expect(httpsRedirect(new URL(url), 'GET', ON), url).toBeNull();
    }
  });

  it('does nothing outside production or in a fixtures build', () => {
    expect(httpsRedirect(new URL('http://prixagent.com/'), 'GET', { production: false })).toBeNull();
  });

  it('never builds Location from a host the request names', () => {
    for (const url of [
      'http://evil.example/steal?x=1',
      'http://prixagent.com.evil.example/',
      'http://www.prixagent.com/',
      'http://evilprixagent.com/',
    ]) {
      // Not the production host: no answer at all, so no Location that could carry it.
      expect(httpsRedirect(new URL(url), 'GET', ON), url).toBeNull();
    }
    // On the production host the Location starts with the fixed origin, whatever the path says.
    for (const path of ['//evil.example/x', '/\\evil.example', '/%2F%2Fevil.example', '/@evil.example']) {
      const answer = httpsRedirect(new URL(`http://prixagent.com${path}`), 'GET', ON);
      const location = answer?.headers.get('Location') ?? '';
      expect(location.startsWith(`${SITE_ORIGIN}/`), path).toBe(true);
      expect(new URL(location).host, path).toBe('prixagent.com');
    }
  });

  it('builds Location from the fixed origin and not from a port the request names', () => {
    const answer = httpsRedirect(new URL('http://prixagent.com:8080/x'), 'GET', ON);
    expect(answer?.headers.get('Location')).toBe('https://prixagent.com/x');
  });

  it('carries no body', async () => {
    const answer = httpsRedirect(new URL('http://prixagent.com/'), 'GET', ON);
    expect(answer?.body).toBeNull();
  });
});

describe('HSTS', () => {
  it('binds every subdomain and lasts a year', () => {
    expect(HSTS_VALUE).toBe('max-age=31536000; includeSubDomains');
  });

  it('is the same value in public/_headers as in the middleware', () => {
    const headers = readFileSync(fileURLToPath(new URL('../../public/_headers', import.meta.url)), 'utf8');
    const lines = headers
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^Strict-Transport-Security\s*:/i.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.replace(/^Strict-Transport-Security\s*:\s*/i, '')).toBe(HSTS_VALUE);
  });

  it('is the value the middleware sends', () => {
    const middleware = readFileSync(fileURLToPath(new URL('../middleware.ts', import.meta.url)), 'utf8');
    expect(middleware).toMatch(/headers\.set\('Strict-Transport-Security', HSTS_VALUE\)/);
    // No second, literal value anywhere in the file.
    expect(middleware.match(/Strict-Transport-Security/g)).toHaveLength(1);
  });
});
