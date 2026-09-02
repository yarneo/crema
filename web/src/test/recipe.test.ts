import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyDiff, diffRecipe, fieldChanged, formatValue, type Recipe } from '../domain/recipe.ts';

const base: Recipe = {
  profileTitle: 'Gentle Decline',
  grind: 12.4,
  doseG: 18,
  targetYieldG: 40,
  temperatureC: 92
};

test('a proposed grind move shows as a change and leaves the rest held', () => {
  const diff = diffRecipe(base, { grind: 12.0 }, { grind: 'Running fast at 19s.' });

  assert.equal(diff.changes.length, 1);
  assert.equal(diff.changes[0]?.field, 'grind');
  assert.equal(diff.changes[0]?.from, 12.4);
  assert.equal(diff.changes[0]?.to, 12.0);
  assert.equal(diff.changes[0]?.reason, 'Running fast at 19s.');

  const heldFields = diff.held.map((h) => h.field).sort();
  assert.deepEqual(heldFields, ['doseG', 'profileTitle', 'targetYieldG', 'temperatureC']);
});

test('omitted fields mean leave alone, never clear', () => {
  const diff = diffRecipe(base, { grind: 12.0 });
  assert.ok(!diff.changes.some((c) => c.to === null), 'no change may propose a null');

  const next = applyDiff(base, diff);
  assert.equal(next.doseG, 18, 'dose survives a grind-only diff');
  assert.equal(next.profileTitle, 'Gentle Decline');
  assert.equal(next.grind, 12.0);
});

test('an explicit null does not wipe the field', () => {
  const diff = diffRecipe(base, { doseG: null });
  assert.equal(diff.changes.length, 0);
  assert.equal(applyDiff(base, diff).doseG, 18);
});

test('float noise below the per-field epsilon is not a change', () => {
  assert.equal(fieldChanged('grind', 12.4, 12.400001), false);
  assert.equal(fieldChanged('grind', 12.4, 12.3), true);
  assert.equal(fieldChanged('temperatureC', 92, 92.02), false);
});

test('a profile switch is a change, whitespace alone is not', () => {
  assert.equal(fieldChanged('profileTitle', 'Gentle Decline', 'Blooming Espresso'), true);
  assert.equal(fieldChanged('profileTitle', 'Gentle Decline', ' Gentle Decline '), false);
});

test('setting a field that had no value counts as a change', () => {
  const empty: Recipe = { ...base, grind: null };
  const diff = diffRecipe(empty, { grind: 12.0 });
  assert.equal(diff.changes.length, 1);
  assert.equal(diff.changes[0]?.from, null);
});

test('held rows omit fields that have no value to hold', () => {
  const sparse: Recipe = { profileTitle: null, grind: 12.4, doseG: null, targetYieldG: null, temperatureC: null };
  const diff = diffRecipe(sparse, { doseG: 18 });
  assert.deepEqual(diff.held.map((h) => h.field), ['grind']);
});

test('changes come back in display order, grind first', () => {
  const diff = diffRecipe(base, { temperatureC: 93, grind: 12.0, targetYieldG: 36 });
  assert.deepEqual(diff.changes.map((c) => c.field), ['grind', 'targetYieldG', 'temperatureC']);
});

test('missing values render as an em dash rather than null', () => {
  assert.equal(formatValue('grind', null), '—');
  assert.equal(formatValue('doseG', 18), '18.0');
});
