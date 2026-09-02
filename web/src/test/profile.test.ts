import { test } from 'node:test';
import assert from 'node:assert/strict';

import { profileTemperature, readExit, readProfileStep, shiftProfileTemperature } from '../domain/profile.ts';
import { describeGatewayError } from '../gateway/client.ts';

/**
 * Copied verbatim from a live Decaid 0.8.4 (`GET /api/v1/profiles`, the
 * "Adaptive v3" profile). This is the contract, not a guess from docs.
 */
const realStep = {
  name: 'Fill',
  pump: 'flow',
  transition: 'fast',
  exit: { type: 'pressure', condition: 'over', value: 3.0 },
  volume: 100.0,
  seconds: 12.0,
  weight: 0.0,
  temperature: 93.0,
  sensor: 'coffee',
  flow: 8.0,
  limiter: { value: 0.0, range: 0.6 }
};

test('a real Decaid step round-trips through the parser unchanged', () => {
  assert.deepEqual(readProfileStep(realStep), {
    name: 'Fill',
    pump: 'flow',
    transition: 'fast',
    exit: { type: 'pressure', condition: 'over', value: 3 },
    volume: 100,
    seconds: 12,
    weight: 0,
    temperature: 93,
    sensor: 'coffee',
    flow: 8,
    limiter: { value: 0, range: 0.6 }
  });
});

test('a pressure step carries pressure and not flow, and vice versa', () => {
  const pressure = readProfileStep({ ...realStep, pump: 'pressure', pressure: 6, flow: 8 });
  assert.equal(pressure?.pressure, 6);
  assert.equal(pressure?.flow, undefined, 'a flow target on a pressure step would be ignored by the machine');

  const flow = readProfileStep({ ...realStep, pump: 'flow', flow: 4, pressure: 9 });
  assert.equal(flow?.flow, 4);
  assert.equal(flow?.pressure, undefined);
});

test('a null exit stays null rather than becoming a bogus condition', () => {
  assert.equal(readProfileStep({ ...realStep, exit: null })?.exit, null);
});

test('the Tcl skins flat exit fields are translated, not discarded', () => {
  // A model that has seen many de1app profiles will emit this older shape.
  const legacy = readProfileStep({
    name: 'Fill',
    pump: 'flow',
    flow: 8,
    temperature: 93,
    seconds: 12,
    exit_pressure_over: 3
  });
  assert.deepEqual(legacy?.exit, { type: 'pressure', condition: 'over', value: 3 });

  const underFlow = readExit(undefined, { exit_flow_under: 1.2 });
  assert.deepEqual(underFlow, { type: 'flow', condition: 'under', value: 1.2 });
});

test('an exit with no value is no exit', () => {
  assert.equal(readExit({ type: 'pressure', condition: 'over' }), null);
  assert.equal(readExit(undefined, { exit_pressure_over: 0 }), null, 'zero is the de1app "unset" marker');
});

test('unknown enum values fall back rather than reaching the machine', () => {
  const step = readProfileStep({ ...realStep, pump: 'magic', transition: 'wobbly', sensor: 'elbow' });
  assert.equal(step?.pump, 'pressure');
  assert.equal(step?.transition, 'fast');
  assert.equal(step?.sensor, 'coffee');
});

test('a nameless step is unusable and dropped', () => {
  assert.equal(readProfileStep({ ...realStep, name: '   ' }), null);
  assert.equal(readProfileStep(null), null);
  assert.equal(readProfileStep('bloom'), null);
});

// ---- temperature ----------------------------------------------------------

const profile = { title: 'p', steps: [realStep, { ...realStep, temperature: 88 }].map(readProfileStep) as never };

test('brew temperature is the hottest step', () => {
  assert.equal(profileTemperature(profile), 93);
});

test('shifting keeps the gaps between stages', () => {
  const shifted = shiftProfileTemperature(profile, 2);
  assert.deepEqual(shifted.steps?.map((s) => s.temperature), [95, 90]);
});

// ---- gateway error bodies -------------------------------------------------

test('Decaids JSON error body is unwrapped into a sentence', () => {
  // Verbatim from a live gateway with no machine paired.
  const body = '{"error":"DeviceNotConnectedException: machine not connected"}';
  const message = describeGatewayError('/api/v1/machine/state', 500, body);

  assert.match(message, /machine is not connected/i);
  assert.ok(!message.includes('Exception'), 'an exception class name helps nobody at 6am');
  assert.ok(!message.includes('{'), 'and neither does raw JSON');
});

test('a non-JSON body is passed through', () => {
  assert.equal(describeGatewayError('/x', 500, 'plain failure'), 'plain failure');
});

test('an empty body still names what failed', () => {
  assert.match(describeGatewayError('/api/v1/workflow', 502, ''), /\/api\/v1\/workflow failed with 502/);
});
