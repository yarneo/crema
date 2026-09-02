import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  askProvider,
  buildRequest,
  describeHttpError,
  endpointFor,
  extractErrorDetail,
  extractReplyText,
  isConfigured,
  isReasoningModel,
  ProviderError,
  resolveModel,
  type ProviderConfig
} from '../advice/provider.ts';

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  return ((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

// ---- endpoints ------------------------------------------------------------

test('each provider resolves to its documented endpoint', () => {
  assert.equal(endpointFor({ provider: 'anthropic' }), 'https://api.anthropic.com/v1/messages');
  assert.equal(endpointFor({ provider: 'openai' }), 'https://api.openai.com/v1/chat/completions');
  assert.equal(
    endpointFor({ provider: 'google' }),
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    'the Google base already carries its version segment'
  );
  assert.equal(endpointFor({ provider: 'compatible' }), 'http://localhost:11434/v1/chat/completions');
  assert.equal(endpointFor({ provider: 'server' }), 'http://localhost:8877/v1/chat/completions');
});

test('a custom base URL wins and its trailing slash is trimmed', () => {
  assert.equal(
    endpointFor({ provider: 'compatible', baseUrl: 'http://10.0.0.18:1234/' }),
    'http://10.0.0.18:1234/v1/chat/completions'
  );
});

test('a blank model falls back to the per-provider default', () => {
  assert.equal(resolveModel({ provider: 'anthropic' }), 'claude-haiku-4-5');
  assert.equal(resolveModel({ provider: 'anthropic', model: '  ' }), 'claude-haiku-4-5');
  assert.equal(resolveModel({ provider: 'anthropic', model: 'claude-opus-4-8' }), 'claude-opus-4-8');
});

test('self-hosted providers are usable without a key', () => {
  assert.equal(isConfigured({ provider: 'compatible' }), true);
  assert.equal(isConfigured({ provider: 'server' }), true);
  assert.equal(isConfigured({ provider: 'anthropic' }), false);
  assert.equal(isConfigured({ provider: 'anthropic', apiKey: 'sk-x' }), true);
  assert.equal(isConfigured({ provider: 'openai', apiKey: '   ' }), false);
});

// ---- request shape --------------------------------------------------------

test('Anthropic gets its key, version, and the browser opt-in header', () => {
  const request = buildRequest({ provider: 'anthropic', apiKey: 'sk-ant-x' }, 'hello');

  assert.equal(request.headers['x-api-key'], 'sk-ant-x');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(
    request.headers['anthropic-dangerous-direct-browser-access'],
    'true',
    'without this the browser call is refused before it is sent'
  );
  assert.equal(request.headers['authorization'], undefined, 'Anthropic uses x-api-key, not bearer auth');

  assert.deepEqual(JSON.parse(request.body), {
    model: 'claude-haiku-4-5',
    max_tokens: 8000,
    messages: [{ role: 'user', content: 'hello' }]
  });
});

test('chat/completions providers use bearer auth', () => {
  const request = buildRequest({ provider: 'openai', apiKey: 'sk-x' }, 'hello');
  assert.equal(request.headers['authorization'], 'Bearer sk-x');
  assert.equal(request.headers['x-api-key'], undefined);
});

test('no key means no auth header at all, rather than an empty bearer', () => {
  const request = buildRequest({ provider: 'compatible' }, 'hello');
  assert.equal(request.headers['authorization'], undefined);
});

test('reasoning models are detected and sent the parameters they accept', () => {
  for (const model of ['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5.1-turbo']) {
    assert.equal(isReasoningModel(model), true, model);
  }
  for (const model of ['gpt-4o-mini', 'claude-haiku-4-5', 'llama3.1', 'gpt-4.1']) {
    assert.equal(isReasoningModel(model), false, model);
  }
});

test('a reasoning model gets max_completion_tokens, never max_tokens', () => {
  const body = JSON.parse(buildRequest({ provider: 'openai', apiKey: 'k', model: 'o4-mini' }, 'x').body);
  assert.equal(body.max_completion_tokens, 25000);
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_tokens, undefined, 'o-series rejects max_tokens outright');
});

test('an ordinary chat model gets max_tokens', () => {
  const body = JSON.parse(buildRequest({ provider: 'openai', apiKey: 'k', model: 'gpt-4o-mini' }, 'x').body);
  assert.equal(body.max_tokens, 8000);
  assert.equal(body.max_completion_tokens, undefined);
});

test('the prompt is JSON-encoded, so quotes and newlines survive', () => {
  const prompt = 'He said "sour"\nand it ran 19s\\fast';
  const body = JSON.parse(buildRequest({ provider: 'openai', apiKey: 'k' }, prompt).body);
  assert.equal(body.messages[0].content, prompt);
});

// ---- reply extraction -----------------------------------------------------

test('Anthropic text blocks are concatenated, non-text blocks ignored', () => {
  const payload = {
    content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: '{"a":' },
      { type: 'text', text: '1}' }
    ]
  };
  assert.equal(extractReplyText('anthropic', payload), '{"a":1}');
});

test('chat/completions replies come from the first choice', () => {
  const payload = { choices: [{ message: { content: 'hello' } }, { message: { content: 'ignored' } }] };
  assert.equal(extractReplyText('openai', payload), 'hello');
});

test('an unexpected response shape is an empty reply, not a crash', () => {
  for (const payload of [null, undefined, {}, { choices: [] }, { choices: [{}] }, { content: 'not an array' }, 42]) {
    assert.equal(extractReplyText('openai', payload), '');
    assert.equal(extractReplyText('anthropic', payload), '');
  }
});

// ---- errors ---------------------------------------------------------------

test('HTTP failures become sentences a person can act on', () => {
  assert.match(describeHttpError('anthropic', 401, ''), /did not accept your API key/);
  assert.match(describeHttpError('server', 401, ''), /Mac server.*needs an API key/s);
  assert.match(describeHttpError('openai', 429, ''), /rate limiting/);
  assert.match(describeHttpError('openai', 503, ''), /trouble at its end/);
  assert.match(describeHttpError('compatible', 404, ''), /model name and base URL/);
});

test('the Mac server is named as itself, not capitalised as a vendor', () => {
  assert.match(describeHttpError('server', 500, ''), /^The Mac server/);
});

// ---- end to end -----------------------------------------------------------

test('a successful call returns the reply text', async () => {
  let seenUrl = '';
  const reply = await askProvider({ provider: 'anthropic', apiKey: 'k' }, 'prompt', {
    fetch: stubFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'advice' }] }), { status: 200 });
    })
  });

  assert.equal(reply, 'advice');
  assert.equal(seenUrl, 'https://api.anthropic.com/v1/messages');
});

test('an HTTP error carries the readable message and the status', async () => {
  await assert.rejects(
    () =>
      askProvider({ provider: 'openai', apiKey: 'k' }, 'p', {
        fetch: stubFetch(() => new Response('nope', { status: 401 }))
      }),
    (error: unknown) =>
      error instanceof ProviderError && error.status === 401 && /did not accept your API key/.test(error.message)
  );
});

test('an empty reply is an error rather than silently no advice', async () => {
  await assert.rejects(
    () =>
      askProvider({ provider: 'openai', apiKey: 'k' }, 'p', {
        fetch: stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }))
      }),
    (error: unknown) => error instanceof ProviderError && /empty reply/.test(error.message)
  );
});

test('an unreachable endpoint mentions CORS, the likely cause in a browser', async () => {
  await assert.rejects(
    () =>
      askProvider({ provider: 'compatible' }, 'p', {
        fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch
      }),
    (error: unknown) => error instanceof ProviderError && /allows requests from this page/.test(error.message)
  );
});

test('an abort propagates rather than being reported as unreachable', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      askProvider({ provider: 'openai', apiKey: 'k' }, 'p', {
        signal: controller.signal,
        fetch: (() => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          return Promise.reject(error);
        }) as unknown as typeof fetch
      }),
    (error: unknown) => (error as Error).name === 'AbortError'
  );
});

test('the API key goes on the provider request and nowhere else', () => {
  const config: ProviderConfig = { provider: 'anthropic', apiKey: 'sk-secret' };
  const request = buildRequest(config, 'prompt about my shot');

  assert.ok(!request.body.includes('sk-secret'), 'the key is never in the request body');
  assert.ok(request.url.startsWith('https://api.anthropic.com'), 'and never in a query string');
  assert.equal(Object.values(request.headers).filter((v) => v.includes('sk-secret')).length, 1);
});

// ---- self-hosted failures surface their own detail ------------------------

test('a self-hosted 500 shows the servers own reason, not a generic line', () => {
  // Verbatim from the Mac server when the claude CLI is not authenticated.
  const body = '{"detail":"claude exited 1 with no output. It is probably not authenticated for headless use"}';
  const message = describeHttpError('server', 500, body);

  assert.match(message, /not authenticated for headless use/);
  assert.ok(!/having trouble at its end/.test(message), 'the generic line would hide the only useful clue');
});

test('a hosted providers 500 stays generic, because its body is noise', () => {
  assert.match(describeHttpError('openai', 500, '{"error":{"message":"internal"}}'), /trouble at its end/);
});

test('error details are pulled from either envelope shape', () => {
  assert.equal(extractErrorDetail('{"detail":"a"}'), 'a');
  assert.equal(extractErrorDetail('{"error":"b"}'), 'b');
  assert.equal(extractErrorDetail('{"error":{"message":"c"}}'), 'c');
  assert.equal(extractErrorDetail('plain text'), 'plain text');
  assert.equal(extractErrorDetail(''), '');
  assert.equal(extractErrorDetail('   '), '');
});

test('a detail-less self-hosted 500 still says what happened', () => {
  assert.match(describeHttpError('server', 503, ''), /HTTP 503 with no detail/);
});
