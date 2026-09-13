/**
 * Setting a grind for the first time.
 *
 * An unset grind made both steppers dead buttons, so there was no way to enter
 * one at all — and the grind is the main lever in the whole dial-in loop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseGrinderRange, startingGrind } from '../domain/grind.ts';

test('a dial range is read however it was typed', () => {
  assert.deepEqual(parseGrinderRange('0.1-0.5'), { min: 0.1, max: 0.5 });
  assert.deepEqual(parseGrinderRange('0.1 – 0.5'), { min: 0.1, max: 0.5 });
  assert.deepEqual(parseGrinderRange('1 to 12'), { min: 1, max: 12 });
  assert.deepEqual(parseGrinderRange('50-0'), { min: 0, max: 50 }, 'order given does not matter');
});

test('nonsense ranges are refused rather than half-read', () => {
  assert.equal(parseGrinderRange(''), null);
  assert.equal(parseGrinderRange(null), null);
  assert.equal(parseGrinderRange('fine to coarse'), null);
  assert.equal(parseGrinderRange('0.3'), null, 'one number is not a range');
  assert.equal(parseGrinderRange('2-2'), null, 'a range of zero width says nothing');
});

test('the first nudge starts in the middle of the configured dial', () => {
  assert.equal(startingGrind('0.1-0.5'), 0.3);
  assert.equal(startingGrind('1-12'), 6.5);
});

test('with no range there is no defensible guess, so the value must be typed', () => {
  // Stepping 0.05 at a time from zero cannot reach a Niche's 20, and we have
  // no way to know the barista's scale unless they told us.
  assert.equal(startingGrind(''), null);
  assert.equal(startingGrind(null), null);
  assert.equal(startingGrind('0-0'), null);
});
