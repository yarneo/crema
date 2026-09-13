/**
 * Rediscovering the Mac after it changes address. Ported in spirit from the
 * Tcl skin's bounded /24 sweep — a browser cannot open raw sockets, so this
 * probes /health instead, and only ever after a real failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { candidateOrigins, discoverServer, hostOf } from '../advice/discover.ts';

test('the saved address is tried first, before any sweeping', () => {
  const candidates = candidateOrigins('http://10.0.0.11:8877');
  assert.equal(candidates[0], 'http://10.0.0.11:8877', 'a failure can be transient');
});

test('a numeric address sweeps its own /24, and never itself twice', () => {
  const candidates = candidateOrigins('http://10.0.0.11:8877');
  assert.equal(candidates.length, 254, 'the saved one plus the other 253 hosts');
  assert.equal(new Set(candidates).size, candidates.length, 'no duplicates');
  assert.ok(candidates.includes('http://10.0.0.42:8877'));
  assert.ok(candidates.includes('http://10.0.0.254:8877'));
  assert.ok(!candidates.includes('http://10.0.0.0:8877'), 'not the network address');
  assert.ok(!candidates.includes('http://10.0.0.255:8877'), 'not the broadcast address');
});

test('the port and scheme are carried across the sweep', () => {
  const candidates = candidateOrigins('http://192.168.1.50:9999');
  assert.ok(candidates.includes('http://192.168.1.7:9999'));
});

test('a Bonjour name is not swept — mDNS already re-resolves it', () => {
  // If `mac.local` failed, the name is wrong and scanning cannot fix it.
  const candidates = candidateOrigins('http://Yardens-MacBook-Pro.local:8877');
  assert.deepEqual(candidates, ['http://Yardens-MacBook-Pro.local:8877']);
});

test('nonsense in the settings field does not produce a sweep', () => {
  assert.deepEqual(candidateOrigins(''), []);
  assert.deepEqual(candidateOrigins('   '), []);
  assert.deepEqual(candidateOrigins('not a url'), ['not a url']);
  assert.deepEqual(candidateOrigins('http://999.1.1.1:8877'), ['http://999.1.1.1:8877']);
});

test('a trailing slash does not become a double slash on the health probe', () => {
  assert.equal(candidateOrigins('http://10.0.0.11:8877/')[0], 'http://10.0.0.11:8877');
});

test('hostOf reads the host, or admits it cannot', () => {
  assert.equal(hostOf('http://10.0.0.11:8877'), '10.0.0.11');
  assert.equal(hostOf('rubbish'), null);
});

/** A fake network where exactly one address answers as the advisor. */
function networkWhere(advisorOrigin: string | null, onCall?: (url: string) => void) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    onCall?.(url);
    if (advisorOrigin && url === `${advisorOrigin}/health`) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error('connection refused');
  };
}

test('the server is found again after it changes address', async () => {
  const found = await discoverServer('http://10.0.0.11:8877', {
    fetch: networkWhere('http://10.0.0.37:8877') as never,
    timeoutMs: 50
  });
  assert.equal(found, 'http://10.0.0.37:8877');
});

test('the saved address wins when it is still alive', async () => {
  const tried: string[] = [];
  const found = await discoverServer('http://10.0.0.11:8877', {
    fetch: networkWhere('http://10.0.0.11:8877', (u) => tried.push(u)) as never,
    timeoutMs: 50,
    concurrency: 4
  });
  assert.equal(found, 'http://10.0.0.11:8877');
  assert.ok(tried.length < 30, `stopped early, tried ${tried.length}`);
});

test('something else listening on the port is not mistaken for the advisor', async () => {
  const impostor = async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input) === 'http://10.0.0.9:8877/health') {
      // A different service: answers, but not ours.
      return new Response(JSON.stringify({ status: 'fine' }), { status: 200 });
    }
    throw new Error('refused');
  };
  assert.equal(
    await discoverServer('http://10.0.0.11:8877', { fetch: impostor as never, timeoutMs: 50 }),
    null
  );
});

test('a network where nothing answers gives up rather than hanging', async () => {
  const found = await discoverServer('http://10.0.0.11:8877', {
    fetch: networkWhere(null) as never,
    timeoutMs: 20,
    concurrency: 32
  });
  assert.equal(found, null);
});

test('probes are bounded, not 254 at once', async () => {
  let live = 0;
  let peak = 0;
  const slow = async (input: RequestInfo | URL): Promise<Response> => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live -= 1;
    if (String(input) === 'http://10.0.0.200:8877/health') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error('refused');
  };
  await discoverServer('http://10.0.0.11:8877', { fetch: slow as never, timeoutMs: 50, concurrency: 8 });
  assert.ok(peak <= 8, `kept ${peak} in flight, expected at most 8`);
});
