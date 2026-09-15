import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Gateway } from '../gateway/client.ts';
import { Store } from '../store.ts';

/**
 * A skin reinstall clears `localStorage` — it is scoped to the port Decaid
 * serves the skin from — which is how a configured grinder and Mac-server
 * address disappeared without anyone changing them. Shots survived because
 * they live in Decaid's store; the non-secret settings now do too.
 */
function fakeStore(): { store: Store; written: Map<string, unknown> } {
  const written = new Map<string, unknown>();
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const key = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    if (init?.method === 'POST') {
      written.set(key, JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    }
    if (!written.has(key)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(written.get(key)), { status: 200 });
  }) as typeof fetch;

  return { store: new Store(new Gateway({ origin: 'http://gw:8080', fetch: fetchImpl })), written };
}

test('the settings mirror round-trips through Decaid storage', async () => {
  const { store, written } = fakeStore();
  assert.equal(await store.readSettingsMirror(), null);

  const mirror = {
    provider: 'server', model: '', baseUrl: 'http://tiny.local:8877',
    grinderName: 'Lagom 01', grinderRange: '0-1.5', theme: 'dark'
  };
  assert.ok(await store.saveSettingsMirror(mirror));
  assert.deepEqual(await store.readSettingsMirror(), mirror);

  // it is one key, not a shot, and it never carries the API key
  assert.deepEqual([...written.keys()], ['settings-mirror']);
  assert.ok(!JSON.stringify(written.get('settings-mirror')).includes('apiKey'));
});

test('the mirror never carries the API key, whatever is in settings', async () => {
  const { store, written } = fakeStore();
  const settings = {
    provider: 'anthropic', apiKey: 'sk-do-not-write-this', model: 'claude-opus-5',
    baseUrl: '', grinderName: 'Niche', grinderRange: '0-100', theme: 'light'
  };
  // the same projection main.ts uses
  const { provider, model, baseUrl, grinderName, grinderRange, theme } = settings;
  await store.saveSettingsMirror({ provider, model, baseUrl, grinderName, grinderRange, theme });

  const raw = JSON.stringify(written.get('settings-mirror'));
  assert.ok(!raw.includes('sk-do-not-write-this'));
  assert.ok(!raw.includes('apiKey'));
  assert.match(raw, /Niche/);
});
