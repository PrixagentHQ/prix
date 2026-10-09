import type { DataEndpointId } from '@prix/contracts';

export interface DataCache {
  get(key: string): Promise<unknown | null>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = stable(v);
    }
    return out;
  }
  return value;
}

/** Endpoint, feed delay and normalised input. Never a key, a header, an owner or a cookie. */
export function dataCacheKey(id: DataEndpointId, input: unknown, delaySeconds: number): string {
  return `${id}|d${delaySeconds}|${JSON.stringify(stable(input ?? {}))}`;
}

const urlOf = (key: string): string => `https://data-cache.prix.invalid/${encodeURIComponent(key)}`;

export function createDataCache(cache?: Cache): DataCache {
  const resolve = (): Cache | null => {
    try {
      return cache ?? (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
    } catch {
      return null;
    }
  };
  return {
    async get(key) {
      try {
        const c = resolve();
        if (c === null) return null;
        const hit = await c.match(urlOf(key));
        return hit === undefined ? null : await hit.json();
      } catch {
        return null;
      }
    },
    async put(key, value, ttlSeconds) {
      try {
        const c = resolve();
        if (c === null || ttlSeconds <= 0) return;
        await c.put(
          urlOf(key),
          new Response(JSON.stringify(value), {
            headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttlSeconds}` },
          }),
        );
      } catch {
        // A cache that fails never fails a call.
      }
    },
  };
}
