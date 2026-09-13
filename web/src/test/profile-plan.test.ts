/**
 * A profile's plan is what the machine is told to do. Drawing it is what makes
 * a list of names legible, so the shape has to be right — a `fast` transition
 * is a step, a `smooth` one is a ramp, and the two look nothing alike.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { describePlan, profilePlan } from '../domain/profile.ts';
import type { Profile, ProfileStep } from '../domain/profile.ts';

const step = (over: Partial<ProfileStep>): ProfileStep => ({
  name: 'step',
  pump: 'pressure',
  transition: 'fast',
  exit: null,
  volume: 0,
  seconds: 10,
  weight: 0,
  temperature: 93,
  sensor: 'coffee',
  limiter: null,
  ...over
});

const profile = (steps: ProfileStep[]): Profile => ({ title: 'test', steps } as Profile);

test('a fast transition holds its target for the whole step', () => {
  const { points, totalS } = profilePlan(profile([step({ pressure: 9, seconds: 20 })]));
  assert.equal(totalS, 20);
  assert.deepEqual(points, [
    { t: 0, pressure: 9, flow: 0 },
    { t: 20, pressure: 9, flow: 0 }
  ]);
});

test('a smooth transition ramps from where the last step left off', () => {
  const { points } = profilePlan(profile([
    step({ pressure: 3, seconds: 10 }),
    step({ pressure: 9, seconds: 10, transition: 'smooth' })
  ]));
  // The ramp enters at 3 and leaves at 9 — a slope, not a jump.
  assert.equal(points[2]!.pressure, 3, 'enters at the previous target');
  assert.equal(points[3]!.pressure, 9, 'leaves at its own');
});

test('a flow step is drawn on the flow axis, not the pressure one', () => {
  const { points } = profilePlan(profile([step({ pump: 'flow', flow: 2.5, seconds: 8 })]));
  assert.equal(points[1]!.flow, 2.5);
  assert.equal(points[1]!.pressure, 0, 'pressure is not invented for a flow step');
});

test('a mixed profile keeps each axis at its last commanded value', () => {
  const { points } = profilePlan(profile([
    step({ pump: 'flow', flow: 4, seconds: 5 }),
    step({ pump: 'pressure', pressure: 9, seconds: 10 })
  ]));
  const end = points[points.length - 1]!;
  assert.equal(end.pressure, 9);
  assert.equal(end.flow, 4, 'the flow target is held, not zeroed, when pressure takes over');
});

test('a step with no duration still marks its boundary', () => {
  const { points, totalS } = profilePlan(profile([step({ pressure: 6, seconds: null })]));
  assert.equal(totalS, 0);
  assert.equal(points.length, 2, 'an open-ended step is a boundary, not a gap');
});

test('an empty profile plots nothing rather than throwing', () => {
  assert.deepEqual(profilePlan(profile([])), { points: [], totalS: 0 });
  assert.equal(describePlan(profile([])), 'no steps');
});

test('the one-line description says what kind of plan it is', () => {
  assert.equal(
    describePlan(profile([step({ pressure: 9, seconds: 20 }), step({ pressure: 6, seconds: 10 })])),
    '2 steps · pressure · 30s'
  );
  assert.equal(
    describePlan(profile([step({ pump: 'flow', flow: 2, seconds: 25 })])),
    '1 steps · flow · 25s'
  );
  assert.match(
    describePlan(profile([step({ pressure: 9, seconds: 5 }), step({ pump: 'flow', flow: 2, seconds: 5 })])),
    /pressure and flow/
  );
});
