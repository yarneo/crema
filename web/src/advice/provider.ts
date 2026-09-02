/**
 * Talking to whichever model the user chose.
 *
 * Ported from the Tcl `llm.tcl`, with one change forced by the move to a
 * browser: Anthropic blocks direct browser calls unless the request opts in
 * explicitly, so we send `anthropic-dangerous-direct-browser-access`. That is
 * the documented way to call the API from a page, and it is what keeps
 * bring-your-own-key working now that the skin *is* a web page.
 *
 * The key never leaves the device. It is read from local storage, put on one
 * request, and never sent anywhere else — in particular never to the Decaid
 * gateway, which has no reason to see it.
 *
 * Request building and reply extraction are pure functions so every provider's
 * wire format is testable without a network.
 */

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'compatible' | 'server';

export const PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'google', 'compatible', 'server'];

export interface ProviderConfig {
  provider: ProviderId;
  /** Blank for `compatible` and `server`, which may need no auth at all. */
  apiKey?: string;
  /** Blank means the per-provider default below. */
  model?: string;
  /** Blank means the per-provider default below. */
  baseUrl?: string;
}

/**
 * Cheap-but-capable defaults. The README is emphatic that model choice is the
 * single biggest lever on advice quality, so these are a floor to get someone
 * running, not a recommendation.
 */
export function defaultModel(provider: ProviderId): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'google':
      return 'gemini-flash-lite-latest';
    case 'compatible':
      return 'llama3.1';
    case 'server':
      return 'opus';
    case 'anthropic':
      return 'claude-haiku-4-5';
  }
}

export function defaultBaseUrl(provider: ProviderId): string {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com';
    case 'google':
      // Gemini's OpenAI-compatible surface; the base already carries /v1beta.
      return 'https://generativelanguage.googleapis.com/v1beta/openai';
    case 'compatible':
      return 'http://localhost:11434';
    case 'server':
      return 'http://localhost:8877';
    case 'anthropic':
      return 'https://api.anthropic.com';
  }
}

export function resolveModel(config: ProviderConfig): string {
  return config.model?.trim() || defaultModel(config.provider);
}

export function resolveBaseUrl(config: ProviderConfig): string {
  return (config.baseUrl?.trim() || defaultBaseUrl(config.provider)).replace(/\/+$/, '');
}

/** The full chat endpoint. The base already carries any version segment. */
export function endpointFor(config: ProviderConfig): string {
  const base = resolveBaseUrl(config);
  switch (config.provider) {
    case 'anthropic':
      return `${base}/v1/messages`;
    case 'google':
      return `${base}/chat/completions`;
    default:
      return `${base}/v1/chat/completions`;
  }
}

/**
 * Whether we have enough to try a request. `compatible` and `server` point at
 * something the user runs themselves and often need no key at all.
 */
export function isConfigured(config: ProviderConfig): boolean {
  if (config.provider === 'compatible' || config.provider === 'server') return true;
  return (config.apiKey ?? '').trim() !== '';
}

/**
 * OpenAI's reasoning models reject `max_tokens`: they need
 * `max_completion_tokens` plus enough headroom for hidden reasoning tokens.
 * Low effort is deliberate — dial-in does not need deep deliberation, and it
 * roughly halves latency while keeping the holistic reasoning that makes the
 * advice good.
 */
export function isReasoningModel(model: string): boolean {
  return /^(o[0-9]|gpt-5)/.test(model);
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Build the HTTP request for a prompt. Pure. */
export function buildRequest(config: ProviderConfig, prompt: string): ProviderRequest {
  const model = resolveModel(config);
  const url = endpointFor(config);
  const key = (config.apiKey ?? '').trim();
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (config.provider === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    // Without this, the browser request is rejected before it is even sent.
    headers['anthropic-dangerous-direct-browser-access'] = 'true';

    return {
      url,
      headers,
      body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
    };
  }

  // openai / google / compatible / server all speak chat/completions.
  if (key !== '') headers['authorization'] = `Bearer ${key}`;

  const body = isReasoningModel(model)
    ? { model, max_completion_tokens: 25000, reasoning_effort: 'low', messages: [{ role: 'user', content: prompt }] }
    : { model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] };

  return { url, headers, body: JSON.stringify(body) };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Pull the assistant's text out of a provider response.
 *
 * Anthropic returns content blocks, of which we concatenate the text ones;
 * everyone else returns choices[0].message.content. Returns an empty string
 * rather than throwing, so a shape we did not expect surfaces as "no reply"
 * instead of a crash.
 */
export function extractReplyText(provider: ProviderId, payload: unknown): string {
  if (!isRecord(payload)) return '';

  if (provider === 'anthropic') {
    const content = payload['content'];
    if (!Array.isArray(content)) return '';
    return content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block['type'] === 'text')
      .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
      .join('');
  }

  const choices = payload['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!isRecord(first)) return '';
  const message = first['message'];
  if (!isRecord(message)) return '';
  return typeof message['content'] === 'string' ? message['content'] : '';
}

export class ProviderError extends Error {
  readonly status: number;
  readonly provider: ProviderId;

  constructor(provider: ProviderId, status: number, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
  }
}

/**
 * Turn an HTTP failure into something a person can act on.
 *
 * The status codes mean much the same thing across Anthropic, OpenAI and the
 * compatible endpoints, and a bare "HTTP 401" on a tablet at 6am helps nobody.
 */
export function describeHttpError(provider: ProviderId, status: number, body: string): string {
  const name = provider === 'server' ? 'The Mac server' : provider[0]!.toUpperCase() + provider.slice(1);

  switch (status) {
    case 400:
      return `${name} rejected the request. If you changed the model name, check it is one your account can use.`;
    case 401:
    case 403:
      return provider === 'compatible' || provider === 'server'
        ? `${name} refused the request. Check whether it needs an API key.`
        : `${name} did not accept your API key. Check it in AI setup.`;
    case 404:
      return `${name} has no such endpoint or model. Check the model name and base URL.`;
    case 429:
      return `${name} is rate limiting. Wait a moment and try again.`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `${name} is having trouble at its end. Try again shortly.`;
    default:
      return `${name} returned HTTP ${status}. ${body.slice(0, 200)}`.trim();
  }
}

export interface AskOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/** Send a prompt, get the model's reply text back. */
export async function askProvider(
  config: ProviderConfig,
  prompt: string,
  options: AskOptions = {}
): Promise<string> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const request = buildRequest(config, prompt);

  let response: Response;
  try {
    response = await doFetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      ...(options.signal ? { signal: options.signal } : {})
    });
  } catch (cause) {
    if ((cause as Error)?.name === 'AbortError') throw cause;
    // In a browser this is also what a CORS rejection looks like, which is the
    // likeliest cause for a self-hosted endpoint that has not allowed us.
    throw new ProviderError(
      config.provider,
      0,
      `Could not reach ${request.url}. Check the address, and that it allows requests from this page.`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderError(config.provider, response.status, describeHttpError(config.provider, response.status, body));
  }

  const payload = await response.json().catch(() => null);
  const text = extractReplyText(config.provider, payload);

  if (text.trim() === '') {
    throw new ProviderError(config.provider, response.status, 'The model returned an empty reply.');
  }

  return text;
}
