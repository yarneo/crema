import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeFailedConnect } from '../gateway/devices.ts';
import { Gateway, GatewayError, GatewayTimeoutError, resolveGatewayOrigin, toWebSocketOrigin } from '../gateway/client.ts';
import {
  diffToWorkflowPatch,
  profileTemperature,
  shiftProfileTemperature,
  undoPatch,
  workflowToRecipe
} from '../gateway/workflow.ts';
import type { WorkflowWire } from '../gateway/types.ts';
import { diffRecipe } from '../domain/recipe.ts';

const workflow: WorkflowWire = {
  id: 'wf-1',
  profile: {
    version: '2',
    title: 'Gentle Decline',
    // Shaped like a real Decaid step, verified against a live gateway 0.8.4.
    steps: [
      { name: 'fill', pump: 'flow', transition: 'fast', exit: { type: 'pressure', condition: 'over', value: 3 }, volume: 100, seconds: 8, weight: 0, temperature: 89, sensor: 'coffee', flow: 4, limiter: null },
      { name: 'bloom', pump: 'flow', transition: 'fast', exit: null, volume: 100, seconds: 20, weight: 0, temperature: 89, sensor: 'coffee', flow: 0.8, limiter: null },
      { name: 'extract', pump: 'pressure', transition: 'smooth', exit: null, volume: 0, seconds: 40, weight: 0, temperature: 92, sensor: 'coffee', pressure: 6, limiter: { value: 0, range: 0.6 } }
    ]
  },
  context: {
    targetDoseWeight: 18,
    targetYield: 40,
    grinderModel: 'Lagom 01',
    grinderSetting: '12.4'
  }
};

// ---- origin ---------------------------------------------------------------

test('the gateway is the page host on the API port', () => {
  assert.equal(resolveGatewayOrigin({ protocol: 'http:', hostname: 'localhost' }), 'http://localhost:8080');
  assert.equal(resolveGatewayOrigin({ protocol: 'http:', hostname: '10.0.0.18' }), 'http://10.0.0.18:8080');
});

test('an override wins, so a laptop can point at a tablet', () => {
  const origin = resolveGatewayOrigin({ protocol: 'http:', hostname: 'localhost' }, 'http://10.0.0.42:8080/');
  assert.equal(origin, 'http://10.0.0.42:8080', 'trailing slash trimmed');
});

test('the websocket origin follows the http scheme', () => {
  assert.equal(toWebSocketOrigin('http://localhost:8080'), 'ws://localhost:8080');
  assert.equal(toWebSocketOrigin('https://box:8080'), 'wss://box:8080');
});

// ---- reading --------------------------------------------------------------

test('a workflow reads as a recipe, with grind parsed out of its string', () => {
  assert.deepEqual(workflowToRecipe(workflow), {
    profileTitle: 'Gentle Decline',
    grind: 12.4,
    doseG: 18,
    targetYieldG: 40,
    temperatureC: 92
  });
});

test('a blank or unparseable grinder setting reads as no grind, not NaN', () => {
  for (const grinderSetting of ['', '   ', 'medium', null, undefined]) {
    const recipe = workflowToRecipe({ ...workflow, context: { ...workflow.context, grinderSetting } });
    assert.equal(recipe.grind, null, `"${String(grinderSetting)}"`);
  }
});

test('brew temperature is the hottest step', () => {
  assert.equal(profileTemperature(workflow.profile), 92);
  assert.equal(profileTemperature({ steps: [] }), null);
  assert.equal(profileTemperature(undefined), null);
});

test('an empty workflow reads as an empty recipe rather than throwing', () => {
  assert.deepEqual(workflowToRecipe({}), {
    profileTitle: null,
    grind: null,
    doseG: null,
    targetYieldG: null,
    temperatureC: null
  });
});

// ---- temperature ----------------------------------------------------------

test('a temperature change shifts every step, preserving the profile shape', () => {
  const shifted = shiftProfileTemperature(workflow.profile!, 1);
  assert.deepEqual(shifted.steps?.map((s) => s.temperature), [90, 90, 93]);

  const before = workflow.profile!.steps!.map((s) => s.temperature!);
  const after = shifted.steps!.map((s) => s.temperature!);
  assert.deepEqual(
    before.map((t) => t - before[0]!),
    after.map((t) => t - after[0]!),
    'the gaps between stages are unchanged'
  );
});

test('shifting does not mutate the original profile', () => {
  shiftProfileTemperature(workflow.profile!, 5);
  assert.equal(workflow.profile?.steps?.[0]?.temperature, 89);
});

test('a zero shift is a no-op', () => {
  assert.equal(shiftProfileTemperature(workflow.profile!, 0), workflow.profile);
});

// ---- writing --------------------------------------------------------------

test('only accepted changes reach the patch', () => {
  const current = workflowToRecipe(workflow);
  const diff = diffRecipe(current, { grind: 12.0, targetYieldG: 36 });
  const patch = diffToWorkflowPatch(diff, workflow);

  // "12.0", not "12": the Tcl skin rendered a whole dial with one decimal and
  // the grinder's own labelling follows suit, so keep the reading recognisable.
  assert.equal(patch.context?.grinderSetting, '12.0');
  assert.equal(patch.context?.targetYield, 36);
  assert.equal(patch.context?.targetDoseWeight, undefined, 'dose was not accepted, so it is not sent');
  assert.equal(patch.profile, undefined, 'no temperature change means no profile rewrite');
  assert.deepEqual(Object.keys(patch.context ?? {}).sort(), ['grinderSetting', 'targetYield']);
});

test('grind is written back as a string on the dial scale', () => {
  const diff = diffRecipe(workflowToRecipe(workflow), { grind: 0.15 });
  assert.equal(diffToWorkflowPatch(diff, workflow).context?.grinderSetting, '0.15');
});

test('a temperature change is written as a shifted profile', () => {
  const diff = diffRecipe(workflowToRecipe(workflow), { temperatureC: 93 });
  const patch = diffToWorkflowPatch(diff, workflow);
  assert.deepEqual(patch.profile?.steps?.map((s) => s.temperature), [90, 90, 93]);
});

test('an empty diff produces an empty patch, so apply is a no-op', () => {
  const current = workflowToRecipe(workflow);
  assert.deepEqual(diffToWorkflowPatch(diffRecipe(current, {}), workflow), {});
});

// ---- undo -----------------------------------------------------------------

test('undo restores exactly the fields the apply touched', () => {
  const diff = diffRecipe(workflowToRecipe(workflow), { grind: 12.0, targetYieldG: 36 });
  const applied = diffToWorkflowPatch(diff, workflow);

  assert.deepEqual(undoPatch(workflow, applied), {
    context: { grinderSetting: '12.4', targetYield: 40 }
  });
});

test('a field that had no value is sent back as null, not omitted', () => {
  const sparse: WorkflowWire = { ...workflow, context: { grinderSetting: '12.4' } };
  const diff = diffRecipe(workflowToRecipe(sparse), { doseG: 18 });
  const applied = diffToWorkflowPatch(diff, sparse);

  const undo = undoPatch(sparse, applied);
  assert.ok('targetDoseWeight' in (undo.context ?? {}), 'the key must be present');
  assert.equal(undo.context?.targetDoseWeight, null, 'or the applied dose would survive the undo');
});

test('undo restores the whole original profile when temperature moved', () => {
  const diff = diffRecipe(workflowToRecipe(workflow), { temperatureC: 95 });
  const applied = diffToWorkflowPatch(diff, workflow);
  assert.deepEqual(undoPatch(workflow, applied).profile?.steps?.map((s) => s.temperature), [89, 89, 92]);
});

// ---- transport ------------------------------------------------------------

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return ((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

test('a workflow read hits the documented path', async () => {
  let seen = '';
  const gateway = new Gateway({
    origin: 'http://localhost:8080',
    fetch: stubFetch((url) => {
      seen = url;
      return new Response(JSON.stringify(workflow), { status: 200 });
    })
  });

  assert.equal((await gateway.readWorkflow()).id, 'wf-1');
  assert.equal(seen, 'http://localhost:8080/api/v1/workflow');
});

test('machine info exposes whether physical GHC controls are fitted', async () => {
  let seen = '';
  const gateway = new Gateway({
    origin: 'http://localhost:8080',
    fetch: stubFetch((url) => {
      seen = url;
      return new Response(JSON.stringify({ model: 'DE1XL', GHC: true }), { status: 200 });
    })
  });

  assert.equal((await gateway.readMachineInfo()).GHC, true);
  assert.equal(seen, 'http://localhost:8080/api/v1/machine/info');
});

test('device controls use Decaids documented scan, connect, and tare routes', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const gateway = new Gateway({
    origin: 'http://localhost:8080',
    fetch: stubFetch((url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      return new Response(url.includes('/tare') ? null : '[]', { status: url.includes('/tare') ? 204 : 200 });
    })
  });

  await gateway.connectDevice('MockScale');
  await gateway.tareScale();

  assert.deepEqual(calls, [
    { url: 'http://localhost:8080/api/v1/devices/connect', method: 'PUT', body: '{"deviceId":"MockScale"}' },
    { url: 'http://localhost:8080/api/v1/scale/tare', method: 'PUT' }
  ]);
});

// ---- connecting one device without disturbing the others ------------------

/** Record every URL a connectKind call touches, given a fixed scan result. */
async function connectCalls(
  kind: 'machine' | 'scale',
  scanResult: (url: string) => unknown[]
): Promise<Array<{ url: string; body?: string }>> {
  const calls: Array<{ url: string; body?: string }> = [];
  const gateway = new Gateway({
    origin: 'http://localhost:8080',
    fetch: stubFetch((url, init) => {
      calls.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      const body = url.includes('/devices/connect') ? '{}' : JSON.stringify(scanResult(url));
      return new Response(body, { status: 200 });
    })
  });
  await gateway.connectKind(kind);
  return calls;
}

const de1 = { name: 'DE1', id: 'm-1', state: 'disconnected', type: 'machine', available: true };
const scale = { name: 'Decent Scale', id: 's-1', state: 'connected', type: 'scale', available: true };

test('connecting never asks the gateway to connect everything it can see', async () => {
  // `scan?connect=true` connects whatever it finds. Asking for the scale then
  // churned Bluetooth for the machine too, and a DE1 mid-handshake drops.
  const calls = await connectCalls('machine', () => [de1, scale]);
  assert.ok(!calls.some((c) => c.url.includes('connect=true')), 'no shotgun scan');
  assert.ok(calls.some((c) => c.url.includes('/devices/scan')), 'it still discovers');
});

test('only the device that was asked for is connected', async () => {
  const calls = await connectCalls('machine', () => [de1, scale]);
  const connects = calls.filter((c) => c.url.includes('/devices/connect'));
  assert.equal(connects.length, 1);
  assert.equal(connects[0]!.body, '{"deviceId":"m-1"}', 'the machine, by id');
});

test('a device already connected is left alone', async () => {
  // The scale here is connected; nothing should be done to it.
  const calls = await connectCalls('scale', () => [de1, scale]);
  assert.equal(calls.filter((c) => c.url.includes('/devices/connect')).length, 0);
});

test('an unavailable device is not connected to', async () => {
  const asleep = { ...de1, available: false };
  const calls = await connectCalls('machine', () => [asleep]);
  assert.equal(calls.filter((c) => c.url.includes('/devices/connect')).length, 0,
    'connecting to hardware that is not advertising just errors');
});

test('an empty quick scan falls through to the full one', async () => {
  const calls = await connectCalls('machine', (url) => (url.includes('quick=true') ? [] : [de1]));
  assert.match(calls[0]!.url, /quick=true/);
  assert.equal(calls[1]!.url, 'http://localhost:8080/api/v1/devices/scan');
  assert.equal(calls[2]!.body, '{"deviceId":"m-1"}');
});

test('a quick scan that finds the device is the end of the scanning', async () => {
  const calls = await connectCalls('machine', () => [de1]);
  assert.equal(calls.filter((c) => c.url.includes('/devices/scan')).length, 1);
});

test('AI-authored profiles are created through the profile record endpoint', async () => {
  let body = '';
  const gateway = new Gateway({
    origin: 'http://localhost:8080',
    fetch: stubFetch((_url, init) => {
      body = String(init?.body ?? '');
      return new Response('{"id":"p1","profile":{"title":"AI · Kenya","steps":[]}}', { status: 201 });
    })
  });
  const created = await gateway.createProfile({ title: 'AI · Kenya', steps: [] });
  assert.equal(created.id, 'p1');
  // The four defaults are Decaid's requirement, not ours — see createProfile.
  assert.deepEqual(JSON.parse(body), {
    profile: {
      title: 'AI · Kenya',
      steps: [],
      version: '2',
      target_volume: 0,
      target_volume_count_start: 0,
      tank_temperature: 0
    }
  });
});

test('bean corrections and deletion use the bean resource', async () => {
  const calls: string[] = [];
  const gateway = new Gateway({
    origin: 'http://localhost:8080',
    fetch: stubFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(init?.method === 'DELETE' ? '{}' : '{"id":"b1","roaster":"Moonwake","name":"Kenya"}');
    })
  });
  await gateway.updateBean('b1', { name: 'Kenya' });
  await gateway.deleteBean('b1');
  assert.deepEqual(calls, [
    'PUT http://localhost:8080/api/v1/beans/b1',
    'DELETE http://localhost:8080/api/v1/beans/b1'
  ]);
});

test('an update PUTs JSON and returns the machines answer', async () => {
  let body = '';
  let method = '';
  const gateway = new Gateway({
    origin: 'http://localhost:8080',
    fetch: stubFetch((_url, init) => {
      method = String(init?.method);
      body = String(init?.body);
      return new Response(JSON.stringify({ ...workflow, id: 'wf-2' }), { status: 200 });
    })
  });

  const result = await gateway.updateWorkflow({ context: { targetYield: 36 } });
  assert.equal(method, 'PUT');
  assert.deepEqual(JSON.parse(body), { context: { targetYield: 36 } });
  assert.equal(result.id, 'wf-2', 'we render the gateway response, not our optimistic guess');
});

test('an error body is surfaced instead of a bare status code', async () => {
  const gateway = new Gateway({
    origin: 'http://localhost:8080',
    fetch: stubFetch(() => new Response('machine is asleep', { status: 503 }))
  });

  await assert.rejects(
    () => gateway.readWorkflow(),
    (error: unknown) => error instanceof GatewayError && error.status === 503 && /asleep/.test(error.message)
  );
});

test('a gateway that accepts and never answers times out', async () => {
  const gateway = new Gateway({
    origin: 'http://localhost:8080',
    timeoutMs: 20,
    fetch: ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch
  });

  await assert.rejects(() => gateway.readWorkflow(), (error: unknown) => error instanceof GatewayTimeoutError);
});

test('an unreachable gateway is a clear message, not a raw TypeError', async () => {
  const gateway = new Gateway({
    origin: 'http://localhost:8080',
    fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch
  });

  await assert.rejects(
    () => gateway.readWorkflow(),
    (error: unknown) => error instanceof GatewayError && /Could not reach the gateway/.test(error.message)
  );
});

// ---- explaining a connect that found nothing ------------------------------

test('a paired-but-unreachable device is not reported as missing', () => {
  // Measured on a real DE1 that was switched off: Decaid still lists it, with
  // available:false. Saying "no machine found" would send someone looking for
  // a pairing problem they do not have.
  const devices = [
    { name: 'Decent Scale', id: 'a', state: 'connected', type: 'scale', available: true },
    { name: 'DE1', id: 'b', state: 'disconnected', type: 'machine', available: false }
  ];

  assert.match(describeFailedConnect('machine', devices), /DE1 is paired but not responding/);
  assert.match(describeFailedConnect('machine', devices), /switch it on/);
});

test('a device the gateway has never seen reads as missing', () => {
  assert.match(describeFailedConnect('machine', []), /No machine found/);
  assert.match(describeFailedConnect('scale', []), /No scale found/);
  assert.match(describeFailedConnect('scale', []), /Bluetooth range/);
});

test('a reachable device that still refuses is its own case', () => {
  const devices = [{ name: 'DE1', id: 'b', state: 'disconnected', type: 'machine', available: true }];
  assert.match(describeFailedConnect('machine', devices), /found but would not connect/);
});

/**
 * Decaid requires four fields on a new profile that Crema never authored, so
 * every AI-written profile and every profile built in the step editor failed
 * to save with a bare "Invalid request". Verified against a live gateway 0.8.6,
 * which names one missing field per attempt.
 */
test('a created profile carries the fields Decaid requires', async () => {
  let sent: Record<string, unknown> | null = null;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)).profile;
    return new Response(JSON.stringify({ id: 'p1', profile: sent }), { status: 200 });
  }) as typeof fetch;

  const gw = new Gateway({ origin: 'http://gw:8080', fetch: fetchImpl });
  await gw.createProfile({ title: 'Authored', steps: [], target_weight: 36 });

  const body = sent as unknown as Record<string, unknown>;
  assert.equal(body['tank_temperature'], 0);
  assert.equal(body['target_volume'], 0);
  assert.equal(body['target_volume_count_start'], 0);
  assert.equal(body['version'], '2');
  // what the caller did set survives
  assert.equal(body['title'], 'Authored');
  assert.equal(body['target_weight'], 36);
});

test('a duplicated profile keeps its own values rather than the defaults', async () => {
  let sent: Record<string, unknown> | null = null;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)).profile;
    return new Response(JSON.stringify({ id: 'p1', profile: sent }), { status: 200 });
  }) as typeof fetch;

  const gw = new Gateway({ origin: 'http://gw:8080', fetch: fetchImpl });
  await gw.createProfile({
    version: '2', title: 'Copy of Adaptive', steps: [],
    target_volume: 36, target_volume_count_start: 3, tank_temperature: 92
  });

  const body = sent as unknown as Record<string, unknown>;
  assert.equal(body['target_volume'], 36);
  assert.equal(body['target_volume_count_start'], 3);
  assert.equal(body['tank_temperature'], 92);
});
