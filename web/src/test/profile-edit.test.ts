/**
 * Editing a profile is the one place in the skin that writes something the
 * machine will execute, so the edits have to mean exactly what they say.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addStep, duplicateProfile, editStep, moveStep, newProfile,
  profileProblem, removeStep, stepTargetOf
} from '../domain/profile-edit.ts';

test('a new profile is pullable, not an empty shell', () => {
  const p = newProfile('Test');
  assert.equal(p.title, 'Test');
  assert.equal(p.steps?.length, 2, 'preinfuse then extract');
  assert.equal(p.steps?.[0]?.pump, 'flow');
  assert.equal(p.steps?.[1]?.pump, 'pressure');
  assert.equal(profileProblem(p, []), null, 'and it saves as-is');
});

test('switching a step to flow moves the target, it does not reinterpret it', () => {
  // 9 bar and 9 mL/s are not the same shot. Carrying the number across axes
  // silently turns an extraction step into a flood.
  const p = newProfile();
  const before = p.steps![1]!;
  assert.equal(stepTargetOf(before), 9);

  const after = editStep(p, 1, { pump: 'flow' }).steps![1]!;
  assert.equal(after.pump, 'flow');
  assert.equal(after.flow, 2, 'a sane flow default, not 9');
  assert.equal(after.pressure, undefined, 'the unused axis carries no value');
});

test('only the axis in use carries a value', () => {
  const p = editStep(newProfile(), 0, { pump: 'pressure', target: 6 });
  const step = p.steps![0]!;
  assert.equal(step.pressure, 6);
  assert.equal(step.flow, undefined);
});

test('editing one field leaves the others alone', () => {
  const p = editStep(newProfile(), 1, { seconds: 30 });
  assert.equal(p.steps![1]!.seconds, 30);
  assert.equal(p.steps![1]!.pressure, 9, 'target untouched');
  assert.equal(p.steps![1]!.transition, 'smooth');
});

test('edits never mutate the profile they were given', () => {
  const p = newProfile();
  const snapshot = JSON.stringify(p);
  editStep(p, 0, { seconds: 99 });
  addStep(p);
  removeStep(p, 0);
  moveStep(p, 0, 1);
  assert.equal(JSON.stringify(p), snapshot, 'the editor re-renders from state');
});

test('steps can be reordered, and the ends do not wrap around', () => {
  const p = newProfile();
  const swapped = moveStep(p, 0, 1);
  assert.equal(swapped.steps![0]!.name, 'extract');
  assert.equal(moveStep(p, 0, -1).steps![0]!.name, 'preinfuse', 'nothing moves off the top');
  assert.equal(moveStep(p, 1, 1).steps![1]!.name, 'extract', 'nor off the bottom');
});

test('the last step cannot be removed — a profile with none cannot be pulled', () => {
  let p = newProfile();
  p = removeStep(p, 0);
  assert.equal(p.steps?.length, 1);
  p = removeStep(p, 0);
  assert.equal(p.steps?.length, 1, 'refused');
});

test('a duplicate is a real copy under a new name', () => {
  const original = newProfile('Original');
  const copy = duplicateProfile(original, 'Copy');
  assert.equal(copy.title, 'Copy');
  assert.notEqual(copy.steps![0], original.steps![0], 'steps are copied, not shared');

  editStep(copy, 0, { seconds: 3 });
  assert.equal(original.steps![0]!.seconds, 8, 'the original is untouched');
});

test('a duplicate keeps the parts this editor does not show', () => {
  // Decaid steps carry exit conditions and limiters. Duplicating must not
  // quietly drop them just because the editor has no field for them.
  const source = newProfile();
  source.steps![0]!.exit = { type: 'pressure', condition: 'over', value: 4 } as never;
  const copy = duplicateProfile(source, 'Copy');
  assert.deepEqual(copy.steps![0]!.exit, { type: 'pressure', condition: 'over', value: 4 });
});

test('a profile is refused rather than saved broken', () => {
  const why = (p: Parameters<typeof profileProblem>[0], titles: string[] = []) =>
    profileProblem(p, titles) ?? '(none)';
  assert.match(why({ ...newProfile(), title: '  ' }), /Give the profile a name/);
  assert.match(why(newProfile('Espresso'), ['espresso']), /already exists/, 'case-insensitive');
  assert.match(why({ ...newProfile(), steps: [] }), /at least one step/);
});

test('a name that clashes with nothing is fine', () => {
  assert.equal(profileProblem(newProfile('Brand New'), ['Adaptive v3', 'Blooming']), null);
});
