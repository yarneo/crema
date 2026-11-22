import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdvice } from '../advice/parse.ts';
import { applyToWorkflow } from '../advice/apply.ts';
import { Gateway } from '../gateway/client.ts';
import { workflowToRecipe } from '../gateway/workflow.ts';
import type { WorkflowWire, WorkflowPatch } from '../gateway/types.ts';
import type { Profile } from '../domain/profile.ts';

const pour = { name: 'pour', pump: 'flow', flow: 2.5, seconds: 30, temperature: 93 };
function withStep(step: object) {
  return parseAdvice(JSON.stringify({
    diagnosis: 'Use the flow profile.',
    actions: { grind: { delta: -0.08 }, temperature_c: 94, target_yield_g: 39 },
    profile: { action: 'create', created_profile: { title: 'Slow pour', target_weight_g: 36, steps: [step] } }
  }));
}

test('Apply saves the final profile and selects it with the dial calculated from the advised shot', async () => {
  const parsed = withStep({ ...pour, pressure_limit_bar: 9 });
  assert.ok(parsed.ok);
  const before: WorkflowWire = { context: { grinderSetting: '0.8' }, profile: { title: 'Original' } };
  let saved: Profile | undefined;
  let updates = 0;
  const gateway = new Gateway({ origin: 'http://sim', fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith('/profiles')) {
      saved = body.profile;
      return Response.json({ profile: saved, id: 'revision-2' });
    }
    assert.ok(String(url).endsWith('/workflow'));
    updates++;
    const patch: WorkflowPatch = body;
    assert.deepEqual(patch.profile, saved);
    return Response.json({ ...before, ...patch });
  }});
  const base = { ...workflowToRecipe(before), grind: 0.2 };
  const result = await applyToWorkflow(gateway, parsed.advice, base, before, 'Ratnagiri');
  assert.equal(updates, 1);
  assert.equal(result.profileId, 'revision-2');
  assert.equal(saved?.title, 'AI · Ratnagiri');
  assert.equal(saved?.target_weight, 39);
  assert.equal(saved?.steps?.[0]?.temperature, 94);
  assert.deepEqual(saved?.steps?.[0]?.limiter, { value: 9, range: 0.6 });
  assert.equal(result.updated.context?.grinderSetting, '0.12');
});

test('pressure ceilings stay separate from exits and unused pressure setpoints', () => {
  for (const [extra, expected] of [
    [{ pressure: 9, exit: { type: 'pressure', condition: 'over', value: 3 } }, null],
    [{ pressure_limit_bar: 0 }, null],
    [{ limiter: { value: 8, range: 0.4 } }, { value: 8, range: 0.4 }]
  ] as const) {
    const result = withStep({ ...pour, ...extra });
    assert.ok(result.ok);
    assert.deepEqual(result.advice.profile.createdProfile?.steps[0]?.limiter, expected);
  }
  for (const extra of [{ pressure_limit_bar: 'bad' }, { pressure_limit_bar: 11 },
    { pump: 'pressure', pressure_limit_bar: 9 }, { limiter: { value: 9 } }]) {
    assert.equal(withStep({ ...pour, ...extra }).ok, false);
  }
});
