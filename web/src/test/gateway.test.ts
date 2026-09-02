import { test } from 'node:test';
import assert from 'node:assert/strict';

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
