/**
 * The scrub reads values back out of the drawn coordinates, so its inverse has
 * to be exactly the mapping `renderShot` used. These tests round-trip through
 * both directions rather than asserting magic numbers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { nearestIndex, parsePlot, parsePoints, timeAt, valueAt } from '../ui/scrub.ts';

// The geometry a 1000-wide chart writes: left, right, top, bottom, maxY, duration.
const RAW = '46,954,16,230,12,35';
const plot = parsePlot(RAW)!;

/** The forward mappings, copied from renderShot. */
const x = (t: number) => plot.left + (t / plot.duration) * (plot.right - plot.left);
const y = (v: number) => plot.bottom - (v / plot.maxY) * (plot.bottom - plot.top);

test('the plot geometry survives the attribute', () => {
  assert.deepEqual(plot, { left: 46, right: 954, top: 16, bottom: 230, maxY: 12, duration: 35 });
});

test('nonsense geometry is refused rather than half-read', () => {
  assert.equal(parsePlot(null), null);
  assert.equal(parsePlot(''), null);
  assert.equal(parsePlot('46,954,16,230,12'), null, 'too few numbers');
  assert.equal(parsePlot('954,46,16,230,12,35'), null, 'right must exceed left');
  assert.equal(parsePlot('46,954,230,16,12,35'), null, 'bottom must exceed top');
  assert.equal(parsePlot('46,954,16,230,0,35'), null, 'a zero axis has no scale');
  assert.equal(parsePlot('46,954,16,230,12,0'), null, 'a zero-length shot has no time axis');
});

test('a value survives the round trip through the drawing', () => {
  for (const value of [0, 0.4, 2.6, 6, 9.1, 12]) {
    assert.ok(Math.abs(valueAt(plot, y(value)) - value) < 1e-9, `${value} bar`);
  }
});

test('a time survives the round trip through the drawing', () => {
  for (const seconds of [0, 4.5, 12, 28.3, 35]) {
    assert.ok(Math.abs(timeAt(plot, x(seconds)) - seconds) < 1e-9, `${seconds}s`);
  }
});

test('points are read back as they were written', () => {
  const points = parsePoints('46,230 91.4,180.5 136.8,96');
  assert.deepEqual(points, [[46, 230], [91.4, 180.5], [136.8, 96]]);
});

test('malformed point data is skipped, not guessed at', () => {
  assert.deepEqual(parsePoints(''), []);
  assert.deepEqual(parsePoints(null), []);
  assert.deepEqual(parsePoints('46,230 nonsense 136.8,96'), [[46, 230], [136.8, 96]]);
});

test('the crosshair snaps to the nearest sample, not the one before', () => {
  const points: Array<[number, number]> = [[0, 0], [10, 0], [20, 0], [30, 0]];
  assert.equal(nearestIndex(points, 0), 0);
  assert.equal(nearestIndex(points, 4), 0, 'closer to 0 than to 10');
  assert.equal(nearestIndex(points, 6), 1, 'closer to 10 than to 0');
  assert.equal(nearestIndex(points, 19), 2);
  assert.equal(nearestIndex(points, 30), 3);
});

test('a touch beyond either end lands on the end sample', () => {
  const points: Array<[number, number]> = [[10, 0], [20, 0], [30, 0]];
  assert.equal(nearestIndex(points, -100), 0);
  assert.equal(nearestIndex(points, 9999), 2);
});

test('an empty trace has nothing to snap to', () => {
  assert.equal(nearestIndex([], 12), -1);
});

test('a real trace reads the value that was plotted there', () => {
  // Build a trace the way the chart does, then scrub it.
  const elapsed = [0, 5, 10, 15, 20];
  const pressure = [1.8, 6.2, 9, 8.4, 6.1];
  const points = elapsed.map((t, i) => [x(t), y(pressure[i]!)] as [number, number]);

  const index = nearestIndex(points, x(10.4));
  assert.equal(index, 2, 'nearest sample to 10.4s is the one at 10s');
  assert.ok(Math.abs(timeAt(plot, points[index]![0]) - 10) < 1e-9);
  assert.ok(Math.abs(valueAt(plot, points[index]![1]) - 9) < 1e-9);
});
