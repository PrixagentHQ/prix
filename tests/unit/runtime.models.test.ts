import type { ModelRequest, ModelResponse, ProviderId } from '@prix/contracts';
import { PROVIDERS } from '@prix/contracts';
import { createHouseModel, createOwnModel } from '@prix/runtime';
import { describe, expect, it } from 'vitest';

/**
 * The two model adapters behind `ModelPort` (docs/CONTRACTS.md sections 6 and 12).
 *
 * Acceptance, docs/SPEC.md section 8: "A base URL outside the allowlist is rejected." The
 * contract goes further: no input accepts a URL at all, and each provider id maps to one
 * fixed endpoint. These tests give the adapter a fake `fetch` and look at where it calls.
 */

const API_KEY = 'fixture-key-Zq7Lm2Xv9Rt4Kp8Wn3Bc6Hy1Jd5Fg0As';

/** The one host each allowlisted provider is served from. */
const PROVIDER_HOSTS: Record<ProviderId, string> = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  google: 'generativelanguage.googleapis.com',
  openrouter: 'openrouter.ai',
  groq: 'api.groq.com',
  xai: 'api.x.ai',
};

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  messages: [
    { role: 'system', content: 'Return the decision as JSON.' },
    { role: 'user', content: '{"time":"2026-10-06T15:00:00.000Z"}' },
  ],
  maxOutputTokens: 300,
  timeoutMs: 20_000,
  jsonDecision: true,
  ...overrides,
});

interface Recorded {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}

/** A fake `fetch` that records every call and answers with an OpenAI-compatible body. */
function fakeFetch(
  answer: (call: Recorded) => Response | Promise<Response> = () =>
    chatResponse('{"targets":{},"reason":"Stays in cash."}'),
) {
  const calls: Recorded[] = [];
  const impl: typeof fetch = async (input, init) => {
    const built = new Request(input, init);
    const call = {
      url: new URL(built.url),
      method: built.method,
      headers: built.headers,
      body: await built.clone().text(),
    };
    calls.push(call);
    if (built.signal.aborted) throw new DOMException('aborted', 'AbortError');
    return answer(call);
  };
  return { calls, impl };
}

function chatResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: 'model-test',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1_600, completion_tokens: 120, total_tokens: 1_720 },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function expectFailureShape(result: ModelResponse): void {
  expect(result.ok).toBe(false);
  // A code and a status, never the provider's message: it can echo part of a key.
  expect(Object.keys(result).sort()).toEqual(['code', 'httpStatus', 'ok']);
  expect(JSON.stringify(result)).not.toContain(API_KEY.slice(-12));
}

describe('createOwnModel: the provider allowlist', () => {
  it('knows the providers this test knows', () => {
    expect(PROVIDERS.map((provider) => provider.id).sort()).toEqual(Object.keys(PROVIDER_HOSTS).sort());
  });

  it.each(PROVIDERS.map((provider) => provider.id))(
    '%s: calls its one fixed HTTPS endpoint, and only that',
    async (provider) => {
      const { calls, impl } = fakeFetch();
      const model = createOwnModel({ provider, model: 'model-test-1' }, API_KEY, impl);
      const result = await model.complete(request());
      expect(result).toMatchObject({ ok: true, text: '{"targets":{},"reason":"Stays in cash."}' });
      expect(calls).toHaveLength(1);
      const call = calls[0] as Recorded;
      expect(call.url.protocol).toBe('https:');
      expect(call.url.hostname).toBe(PROVIDER_HOSTS[provider]);
      expect(call.url.username + call.url.password).toBe('');
      expect(call.method).toBe('POST');
    },
  );

  it.each(PROVIDERS.map((provider) => provider.id))(
    '%s: the model name travels in the body, never in the URL',
    async (provider) => {
      const urls: string[] = [];
      for (const name of ['model-test-1', 'another/model:v2', 'evil.test/v1']) {
        const { calls, impl } = fakeFetch();
        await createOwnModel({ provider, model: name }, API_KEY, impl).complete(request());
        const call = calls[0] as Recorded;
        urls.push(call.url.href);
        expect(call.url.href).not.toContain(name);
        expect(call.url.hostname).toBe(PROVIDER_HOSTS[provider]);
        expect(JSON.parse(call.body).model).toBe(name);
      }
      expect(new Set(urls).size).toBe(1);
    },
  );

  it.each(PROVIDERS.map((provider) => provider.id))(
    '%s: the key travels in a header, never in the URL or the body',
    async (provider) => {
      const { calls, impl } = fakeFetch();
      await createOwnModel({ provider, model: 'model-test-1' }, API_KEY, impl).complete(request());
      const call = calls[0] as Recorded;
      expect(call.url.href).not.toContain(API_KEY);
      expect(call.body).not.toContain(API_KEY);
      const carrying = [...call.headers.entries()].filter(([, value]) => value.includes(API_KEY));
      expect(carrying.length).toBeGreaterThan(0);
    },
  );

  it.each(PROVIDERS.map((provider) => provider.id))(
    '%s: sends the two messages and the output limit, and asks for no tools',
    async (provider) => {
      const { calls, impl } = fakeFetch();
      await createOwnModel({ provider, model: 'model-test-1' }, API_KEY, impl).complete(
        request({ maxOutputTokens: 123 }),
      );
      const body = JSON.parse((calls[0] as Recorded).body);
      expect(body.messages).toEqual(request().messages);
      expect(JSON.stringify(body)).toContain('123');
      expect(body.tools).toBeUndefined();
      expect(body.functions).toBeUndefined();
      expect(body.stream ?? false).toBe(false);
    },
  );

  it.each(['https://models.evil.test/v1', 'evil', 'custom', 'azure', 'OpenAI', '', '__proto__', 'constructor'])(
    'never calls anywhere for the provider "%s"',
    async (provider) => {
      const { calls, impl } = fakeFetch();
      let result: ModelResponse | null = null;
      try {
        const model = createOwnModel({ provider: provider as ProviderId, model: 'model-test-1' }, API_KEY, impl);
        result = await model.complete(request());
      } catch {
        // Refusing to build the adapter is as good as a failed call.
      }
      expect(calls).toEqual([]);
      if (result !== null) expect(result.ok).toBe(false);
    },
  );

  it('takes no base URL from its input, whatever extra fields a record carries', async () => {
    const { calls, impl } = fakeFetch();
    const record = {
      provider: 'openai',
      model: 'model-test-1',
      baseUrl: 'https://models.evil.test/v1',
      url: 'https://models.evil.test',
    };
    await createOwnModel(record as unknown as { provider: ProviderId; model: string }, API_KEY, impl).complete(
      request(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.hostname).toBe('api.openai.com');
  });

  it('labels itself with provider and model, and never with the key', () => {
    const model = createOwnModel({ provider: 'openai', model: 'gpt-x' }, API_KEY, fakeFetch().impl);
    expect(model.label).toContain('openai');
    expect(model.label).toContain('gpt-x');
    expect(model.label).not.toContain(API_KEY.slice(-4));
    expect(JSON.stringify(model)).not.toContain(API_KEY);
  });
});

describe('createOwnModel: failures carry a code and a status, never a message', () => {
  const failing = (status: number) =>
    fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { message: `Incorrect API key provided: ${API_KEY}. You can find your key at the dashboard.` },
          }),
          {
            status,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

  it.each([401, 403, 404])('HTTP %i is provider_rejected: the key or the model name is wrong', async (status) => {
    const result = await createOwnModel(
      { provider: 'openai', model: 'model-test-1' },
      API_KEY,
      failing(status).impl,
    ).complete(request());
    expect(result).toEqual({ ok: false, code: 'provider_rejected', httpStatus: status });
    expectFailureShape(result);
  });

  it.each([400, 408, 409, 422, 429, 500, 502, 503, 529])('HTTP %i is provider_error', async (status) => {
    const result = await createOwnModel(
      { provider: 'openai', model: 'model-test-1' },
      API_KEY,
      failing(status).impl,
    ).complete(request());
    expect(result).toEqual({ ok: false, code: 'provider_error', httpStatus: status });
    expectFailureShape(result);
  });

  it('a network failure is provider_error, and complete does not throw', async () => {
    const impl: typeof fetch = async () => {
      throw new TypeError(`fetch failed for key ${API_KEY}`);
    };
    const result = await createOwnModel({ provider: 'openai', model: 'model-test-1' }, API_KEY, impl).complete(
      request(),
    );
    expect(result).toEqual({ ok: false, code: 'provider_error', httpStatus: null });
    expectFailureShape(result);
  });

  it.each([
    ['a body that is not JSON', new Response('<html>Bad gateway</html>', { status: 200 })],
    ['a body with no choices', new Response('{"choices":[]}', { status: 200 })],
    ['a body of another shape', new Response('{"result":"ok"}', { status: 200 })],
    ['an empty body', new Response('', { status: 200 })],
  ])('a 200 answer with %s is provider_error', async (_name, response) => {
    const { impl } = fakeFetch(() => response.clone());
    const result = await createOwnModel({ provider: 'openai', model: 'model-test-1' }, API_KEY, impl).complete(
      request(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('provider_error');
  });

  it('a call that outlasts its timeout is provider_timeout', async () => {
    const impl: typeof fetch = (input, init) =>
      new Promise((_resolve, reject) => {
        const signal = new Request(input, init).signal;
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    const started = Date.now();
    const result = await createOwnModel({ provider: 'openai', model: 'model-test-1' }, API_KEY, impl).complete(
      request({ timeoutMs: 40 }),
    );
    expect(result).toEqual({ ok: false, code: 'provider_timeout', httpStatus: null });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('returns the text and the token counts of a good answer, and null when the provider gives no counts', async () => {
    const withUsage = await createOwnModel(
      { provider: 'openai', model: 'model-test-1' },
      API_KEY,
      fakeFetch().impl,
    ).complete(request());
    expect(withUsage).toEqual({
      ok: true,
      text: '{"targets":{},"reason":"Stays in cash."}',
      inputTokens: 1_600,
      outputTokens: 120,
    });
    const { impl } = fakeFetch(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }] }), {
          status: 200,
        }),
    );
    const withoutUsage = await createOwnModel({ provider: 'openai', model: 'model-test-1' }, API_KEY, impl).complete(
      request(),
    );
    expect(withoutUsage).toEqual({ ok: true, text: 'hello', inputTokens: null, outputTokens: null });
  });

  it('returns the text exactly as the model wrote it: validation is not the job of the adapter', async () => {
    const raw = '```json\n{"targets":{"NVDA":41}}\n```';
    const { impl } = fakeFetch(() => chatResponse(raw));
    const result = await createOwnModel({ provider: 'openai', model: 'model-test-1' }, API_KEY, impl).complete(
      request(),
    );
    expect(result).toMatchObject({ ok: true, text: raw });
  });
});

describe('createHouseModel', () => {
  const MODEL_ID = '@cf/test/house-model';

  function fakeAi(run: (model: string, input: Record<string, unknown>) => unknown) {
    const calls: { model: string; input: Record<string, unknown> }[] = [];
    return {
      calls,
      ai: {
        async run(model: string, input: Record<string, unknown>): Promise<unknown> {
          calls.push({ model, input });
          return run(model, input);
        },
      },
    };
  }

  it('runs the model id it was given, with the two messages and the output limit', async () => {
    const { calls, ai } = fakeAi(() => ({
      response: '{"targets":{},"reason":"Stays in cash."}',
      usage: { prompt_tokens: 1_600, completion_tokens: 120, neurons: 4.25 },
    }));
    const model = createHouseModel(ai, MODEL_ID);
    expect(model.label.length).toBeGreaterThan(0);
    const result = await model.complete(request({ maxOutputTokens: 123 }));
    expect(result).toEqual({
      ok: true,
      text: '{"targets":{},"reason":"Stays in cash."}',
      inputTokens: 1_600,
      outputTokens: 120,
      neurons: 4.25,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(MODEL_ID);
    expect(calls[0]?.input.messages).toEqual(request().messages);
    expect(JSON.stringify(calls[0]?.input)).toContain('123');
    expect(calls[0]?.input.tools).toBeUndefined();
  });

  it('reports the used-up daily allocation as allocation_exhausted', async () => {
    // Workers AI error 3036, HTTP 429, as documented on 2026-10-06:
    // developers.cloudflare.com/workers-ai/platform/errors/
    const { ai } = fakeAi(() => {
      throw Object.assign(
        new Error(
          "3036: You have used up your daily free allocation of 10,000 neurons. Please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.",
        ),
        { code: 3036, status: 429 },
      );
    });
    const result = await createHouseModel(ai, MODEL_ID).complete(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('allocation_exhausted');
    expect(Object.keys(result).sort()).toEqual(['code', 'httpStatus', 'ok']);
  });

  it('reports any other failure as provider_error, and never throws', async () => {
    for (const error of [
      Object.assign(new Error('3040: Capacity temporarily exceeded, please try again.'), { code: 3040, status: 429 }),
      Object.assign(new Error('5007: No such model'), { code: 5007, status: 400 }),
      new Error('internal error'),
      'a string instead of an error',
    ]) {
      const { ai } = fakeAi(() => {
        throw error;
      });
      const result = await createHouseModel(ai, MODEL_ID).complete(request());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('provider_error');
      expect(Object.keys(result).sort()).toEqual(['code', 'httpStatus', 'ok']);
    }
  });

  it.each([
    ['null', null],
    ['a number', 7],
    ['an object without a response', { result: 'ok' }],
    ['a stream', new ReadableStream()],
  ])('reports an answer that is %s as provider_error', async (_name, answer) => {
    const { ai } = fakeAi(() => answer);
    const result = await createHouseModel(ai, MODEL_ID).complete(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('provider_error');
  });

  it('reports a call that outlasts its timeout as provider_timeout', async () => {
    const { ai } = fakeAi(() => new Promise(() => {}));
    const result = await createHouseModel(ai, MODEL_ID).complete(request({ timeoutMs: 40 }));
    expect(result).toEqual({ ok: false, code: 'provider_timeout', httpStatus: null });
  });

  it('returns null token counts when the model reports none', async () => {
    const { ai } = fakeAi(() => ({ response: 'hello' }));
    expect(await createHouseModel(ai, MODEL_ID).complete(request())).toEqual({
      ok: true,
      text: 'hello',
      inputTokens: null,
      outputTokens: null,
      neurons: null,
    });
  });
});
