import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  brewRatio,
  buildCurvePayload,
  downsample,
  isWeightCurveTrustworthy,
  MAX_CURVE_POINTS,
  shotDuration
} from '../advice/curves.ts';

const ramp = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

test('a short curve is passed through untouched', () => {
  const values = [1, 2, 3];
  assert.deepEqual(downsample(values), values);
  assert.notEqual(downsample(values), values, 'but it is a copy, not the same array');
});

test('a long curve is reduced to the point budget', () => {
  assert.equal(downsample(ramp(1000, (i) => i)).length, MAX_CURVE_POINTS);
});

test('downsampling picks real samples rather than averaging them', () => {
  const values = ramp(100, (i) => i);
  const out = downsample(values, 10);
  assert.deepEqual(out, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  for (const v of out) assert.ok(values.includes(v), 'every point is one that was actually measured');
});

test('the first sample always survives, so the curve still starts where it started', () => {
  assert.equal(downsample(ramp(500, (i) => i * 2), 20)[0], 0);
});

// ---- weight-curve gating --------------------------------------------------

test('a plausible espresso weight curve is trusted', () => {
  assert.equal(isWeightCurveTrustworthy([0, 0.1, 1.2, 2.1, 1.8]), true);
});

test('a flat or absent scale curve is not sent', () => {
  assert.equal(isWeightCurveTrustworthy([]), false);
  assert.equal(isWeightCurveTrustworthy(null), false);
  assert.equal(isWeightCurveTrustworthy(undefined), false);
  assert.equal(isWeightCurveTrustworthy([0, 0, 0]), false);
  assert.equal(isWeightCurveTrustworthy([0, 0.2, 0.1]), false, 'below the floor is effectively no flow');
});

test('an implausible curve is rejected rather than fed to the model', () => {
  assert.equal(isWeightCurveTrustworthy([0, 50, 900]), false, 'not weight per second from a shot');
  assert.equal(isWeightCurveTrustworthy([Number.NaN, Number.NaN]), false);
});

// ---- payload --------------------------------------------------------------

const curves = {
  elapsedS: [0, 1, 2, 3],
  pressureBar: [0, 3, 6, 6],
  flowMlS: [0, 1, 2, 2]
};

test('basket temperature is never included', () => {
  const payload = buildCurvePayload({ ...curves, weightFlow: [0, 1, 2] });
  assert.ok(!('basket_temp' in payload), 'the DE1 sensor runs ~20C cool and misleads temperature advice');
  assert.deepEqual(Object.keys(payload).sort(), ['elapsed_s', 'flow_mls', 'pressure_bar', 'weight_out_gs']);
});

test('an untrustworthy weight curve is omitted entirely', () => {
  const payload = buildCurvePayload({ ...curves, weightFlow: [0, 0, 0] });
  assert.equal(payload['weight_out_gs'], undefined);
});

test('profile target curves are included only when the shot has them', () => {
  assert.equal(buildCurvePayload(curves)['pressure_target_bar'], undefined, 'older shots simply lack them');

  const withGoals = buildCurvePayload({ ...curves, pressureGoal: [0, 6, 6, 6], flowGoal: [2, 2, 2, 2] });
  assert.deepEqual(withGoals['pressure_target_bar'], [0, 6, 6, 6]);
  assert.deepEqual(withGoals['flow_target_mls'], [2, 2, 2, 2]);
});

// ---- derived numbers ------------------------------------------------------

test('shot duration is the last elapsed sample', () => {
  assert.equal(shotDuration([0, 10, 28.84]), 28.8);
  assert.equal(shotDuration([]), null);
});

test('brew ratio reads the way a barista writes it', () => {
  assert.equal(brewRatio(18, 40), '1:2.2');
  assert.equal(brewRatio(20, 40), '1:2.0');
});

test('a ratio is not invented from missing or impossible values', () => {
  assert.equal(brewRatio(null, 40), null);
  assert.equal(brewRatio(18, null), null);
  assert.equal(brewRatio(0, 40), null, 'no dividing by a zero dose');
});
