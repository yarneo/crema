import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyseFlowPhases, describeFlowPhases, stallVerdict, type PhaseInput } from '../advice/phases.ts';

const seconds = (n: number) => Array.from({ length: n }, (_, i) => i);

/** A normal shot: 8s of low-pressure bloom, then a steady pour. */
const normal: PhaseInput = {
  elapsedS: seconds(20),
  pressureBar: [...Array(8).fill(2), ...Array(12).fill(6)],
  flowMlS: [...Array(8).fill(0.1), ...Array(12).fill(2.0)],
  weightFlow: [...Array(8).fill(0), ...Array(12).fill(1.6)]
};

/** A choked shot: full pressure the whole way, output never arrives. */
const choked: PhaseInput = {
  elapsedS: seconds(30),
  pressureBar: Array(30).fill(9),
  flowMlS: Array(30).fill(0.2),
  weightFlow: Array(30).fill(0)
};

test('a normal shot splits into stall and pour', () => {
  const phases = analyseFlowPhases(normal)!;
  assert.equal(phases.choked, false);
  assert.equal(phases.preinfusionS, 8);
  assert.equal(phases.pourDurationS, 11, 'from first real flow to the last sample');
  assert.equal(phases.pourAvg, 1.6);
});

test('the pour is measured from the scale when the scale recorded something', () => {
  const phases = analyseFlowPhases(normal)!;
  assert.equal(phases.source, 'weight');
  assert.equal(phases.unit, 'g/s', 'grams in the cup is the number that matters');
});

test('with no usable scale curve it falls back to machine flow', () => {
  const phases = analyseFlowPhases({ ...normal, weightFlow: Array(20).fill(0) })!;
  assert.equal(phases.source, 'flow');
  assert.equal(phases.unit, 'mL/s');
  assert.equal(phases.pourAvg, 2);
});

test('a missing scale curve is not an error', () => {
  assert.equal(analyseFlowPhases({ ...normal, weightFlow: null })?.source, 'flow');
  assert.equal(analyseFlowPhases({ ...normal, weightFlow: undefined })?.source, 'flow');
});

// ---- the disambiguator ----------------------------------------------------

test('stall pressure is measured over the stall only, not the whole shot', () => {
  const phases = analyseFlowPhases(normal)!;
  assert.equal(phases.stallAvgBar, 2, 'the 6 bar pour must not drag the stall average up');
  assert.equal(phases.stallPeakBar, 2);
});

test('a choked shot reports the whole shot as stall', () => {
  const phases = analyseFlowPhases(choked)!;
  assert.equal(phases.choked, true);
  assert.equal(phases.preinfusionS, 29);
  assert.equal(phases.pourDurationS, 0);
  assert.equal(phases.stallAvgBar, 9);
});

test('high stall pressure reads as choking, which means grind coarser', () => {
  assert.equal(stallVerdict(analyseFlowPhases(choked)!), 'choking');
});

test('low stall pressure reads as under-pressured, which means fix the profile', () => {
  assert.equal(stallVerdict(analyseFlowPhases(normal)!), 'under-pressured');
});

test('a stall between the thresholds claims nothing', () => {
  const ambiguous = analyseFlowPhases({ ...normal, pressureBar: [...Array(8).fill(5), ...Array(12).fill(6)] })!;
  assert.equal(stallVerdict(ambiguous), null, '5 bar is not evidence either way');
});

test('the two opposite diagnoses are both spelled out for the model', () => {
  const text = describeFlowPhases(analyseFlowPhases(choked)!);
  assert.match(text, /CHOKING under full pressure and the grind is too fine \(coarsen\)/);
  assert.match(text, /never applied enough pressure.*keep the grind/s);
});

test('the normal narrative warns against the coarsen-and-gush trap', () => {
  const text = describeFlowPhases(analyseFlowPhases(normal)!);
  assert.match(text, /do not just grind coarser, which would gush the already-fine pour/);
  assert.match(text, /STALL PRESSURE, not just its length/);
});

// ---- pour detection -------------------------------------------------------

test('a lone spike is not the pour starting', () => {
  // One sample crosses the threshold, then output collapses again.
  const spiky: PhaseInput = {
    elapsedS: seconds(12),
    pressureBar: Array(12).fill(8),
    flowMlS: [0, 0, 2.0, 0.1, 0.1, 0.1, 0.1, 2.0, 2.0, 2.0, 2.0, 2.0],
    weightFlow: null
  };
  const phases = analyseFlowPhases(spiky)!;
  assert.equal(phases.preinfusionS, 7, 'the sustained pour at 7s, not the blip at 2s');
});

test('output that never crosses the threshold is choked', () => {
  const phases = analyseFlowPhases({ ...normal, weightFlow: null, flowMlS: Array(20).fill(0.5) })!;
  assert.equal(phases.choked, true);
});

// ---- degenerate input -----------------------------------------------------

test('too few samples is null rather than a fabricated analysis', () => {
  assert.equal(analyseFlowPhases({ elapsedS: [0, 1], pressureBar: [1, 2], flowMlS: [0, 1] }), null);
  assert.equal(analyseFlowPhases({ elapsedS: [], pressureBar: [], flowMlS: [] }), null);
});

test('mismatched curve lengths use the shorter one instead of reading past the end', () => {
  const phases = analyseFlowPhases({
    elapsedS: seconds(20),
    pressureBar: [2, 2],
    flowMlS: [0, 0, 0, 2, 2, 2, 2, 2]
  });
  assert.ok(phases, 'still analysable');
  assert.equal(phases!.preinfusionS, 3);
});

test('a non-finite end time is null rather than NaN seconds', () => {
  assert.equal(
    analyseFlowPhases({ elapsedS: [0, 1, 2, Number.NaN], pressureBar: [1, 1, 1, 1], flowMlS: [0, 1, 2, 2] }),
    null
  );
});
