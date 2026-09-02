import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTrail, isConverging, type TrailShot } from '../domain/trail.ts';
import { attemptLogSection, extractAttempts } from '../advice/attempts.ts';
import type { Recipe } from '../domain/recipe.ts';

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  profileTitle: 'Gentle Decline',
  grind: 12.4,
  doseG: 18,
  targetYieldG: 40,
  temperatureC: 92,
  ...over
});

/** The worked example from the design brief: a thrash, then convergence. */
const session: TrailShot[] = [
  { id: 's1', at: 1, score: 2, recipe: recipe() },
  { id: 's2', at: 2, score: 3, recipe: recipe({ grind: 12.0 }) },
  { id: 's3', at: 3, score: 2, recipe: recipe({ grind: 12.0, temperatureC: 93 }) },
  { id: 's4', at: 4, score: 3, recipe: recipe({ grind: 11.7, temperatureC: 93 }) },
  { id: 's5', at: 5, score: 4, recipe: recipe({ grind: 11.7, temperatureC: 93, targetYieldG: 36 }) }
];

test('the first shot is the baseline and carries no direction', () => {
  const [first] = buildTrail(session);
  assert.equal(first?.label, 'baseline');
  assert.equal(first?.direction, 'unknown');
  assert.deepEqual(first?.changes, []);
});

test('each node is labelled with the single thing that changed', () => {
  const labels = buildTrail(session).map((n) => n.label);
  assert.deepEqual(labels, ['baseline', 'grind −0.4', 'temp +1.0', 'grind −0.3', 'yield 36.0']);
});

test('direction tracks the score against the previous rated shot', () => {
  const dirs = buildTrail(session).map((n) => n.direction);
  assert.deepEqual(dirs, ['unknown', 'up', 'down', 'up', 'up']);
});

test('shots are ordered oldest first regardless of input order', () => {
  const shuffled = [session[3]!, session[0]!, session[4]!, session[1]!, session[2]!];
  assert.deepEqual(buildTrail(shuffled).map((n) => n.id), ['s1', 's2', 's3', 's4', 's5']);
});

test('an unchanged shot reads as a repeat', () => {
  const trail = buildTrail([
    { id: 'a', at: 1, score: 3, recipe: recipe() },
    { id: 'b', at: 2, score: 3, recipe: recipe() }
  ]);
  assert.equal(trail[1]?.label, 'repeat');
  assert.equal(trail[1]?.direction, 'flat');
});

test('several changes at once are counted, not enumerated', () => {
  const trail = buildTrail([
    { id: 'a', at: 1, score: 2, recipe: recipe() },
    { id: 'b', at: 2, score: 3, recipe: recipe({ grind: 12.0, doseG: 19, temperatureC: 94 }) }
  ]);
  assert.equal(trail[1]?.label, '3 changes');
});

test('an unrated shot keeps its place but does not break the comparison chain', () => {
  const trail = buildTrail([
    { id: 'a', at: 1, score: 2, recipe: recipe() },
    { id: 'b', at: 2, score: null, recipe: recipe({ grind: 12.2 }) },
    { id: 'c', at: 3, score: 3, recipe: recipe({ grind: 12.0 }) }
  ]);
  assert.equal(trail[1]?.direction, 'unknown');
  assert.equal(trail[2]?.direction, 'up', 'compares against the last rated shot, not the unrated one');
});

test('dialled in is a property of the score, not of the trend', () => {
  const flags = buildTrail(session).map((n) => n.dialedIn);
  assert.deepEqual(flags, [false, false, false, false, true]);
});

test('convergence needs three rated shots before it will claim a trend', () => {
  assert.equal(isConverging(buildTrail(session.slice(0, 2))), null);
  assert.equal(isConverging(buildTrail(session)), true);
});

// ---- attempt log ----------------------------------------------------------

test('attempts pair each change with the outcome that followed it', () => {
  const attempts = extractAttempts(buildTrail(session));
  assert.deepEqual(attempts, [
    { change: 'grind −0.4', scoreBefore: 2, scoreAfter: 3, outcome: 'better' },
    { change: 'temp +1.0', scoreBefore: 3, scoreAfter: 2, outcome: 'worse' },
    { change: 'grind −0.3', scoreBefore: 2, scoreAfter: 3, outcome: 'better' },
    { change: 'yield 36.0', scoreBefore: 3, scoreAfter: 4, outcome: 'better' }
  ]);
});

test('the baseline and repeats are not attempts', () => {
  const attempts = extractAttempts(
    buildTrail([
      { id: 'a', at: 1, score: 2, recipe: recipe() },
      { id: 'b', at: 2, score: 2, recipe: recipe() }
    ])
  );
  assert.deepEqual(attempts, []);
});

test('the attempt log names the failed lever so it is not suggested again', () => {
  const section = attemptLogSection(buildTrail(session));
  assert.match(section, /temp \+1\.0 -> score 3 to 2 \(worse\)/);
  assert.match(section, /ALREADY TRIED/);
});

test('an empty log is empty, so callers can concatenate without guarding', () => {
  assert.equal(attemptLogSection(buildTrail([{ id: 'a', at: 1, score: 3, recipe: recipe() }])), '');
});
