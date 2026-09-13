import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeApplied, applyDiff, diffRecipe, fieldChanged, formatValue, type Recipe } from '../domain/recipe.ts';

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

// ---- stepping by exactly one epsilon -------------------------------------

test('a step of exactly one epsilon always registers, whatever the binary says', () => {
  // 0.85 - 0.8 is 0.04999999999999993 in doubles. Comparing that against a
  // 0.05 threshold dropped every other tap, which trapped the grind between
  // 0.75 and 0.80 on a real machine.
  for (const from of [0.7, 0.75, 0.8, 0.85, 0.9, 1.05, 1.2, 2.35, 12.4]) {
    const coarser = Number((from + 0.05).toFixed(2));
    const finer = Number((from - 0.05).toFixed(2));
    assert.equal(fieldChanged('grind', from, coarser), true, `${from} -> ${coarser}`);
    assert.equal(fieldChanged('grind', from, finer), true, `${from} -> ${finer}`);
  }
});

test('the whole dial is reachable one tap at a time', () => {
  // Walk up from the seed and make sure nothing gets stuck.
  let grind = 0.75;
  const seen: number[] = [grind];
  for (let i = 0; i < 12; i += 1) {
    const next = Number((grind + 0.05).toFixed(2));
    if (!fieldChanged('grind', grind, next)) break;
    grind = next;
    seen.push(grind);
  }
  assert.equal(seen.length, 13, `stuck at ${grind} after ${seen.length} steps: ${seen.join(', ')}`);
  assert.equal(grind, 1.35);
});

test('a change smaller than the dial can express is still no change', () => {
  // The slack must not swallow the threshold it is guarding.
  assert.equal(fieldChanged('grind', 0.8, 0.81), false);
  assert.equal(fieldChanged('grind', 0.8, 0.8), false);
});

// ---- what the brew banner says was applied --------------------------------

const starterDiff = () =>
  diffRecipe(
    { profileTitle: 'Adaptive v3', grind: 1.5, doseG: 18, targetYieldG: 36, temperatureC: 93 },
    { profileTitle: 'Adaptive v3', grind: 0.6, doseG: 18, targetYieldG: 36, temperatureC: 93 }
  );

test('a starting point reports every setting, not just the one that moved', () => {
  // Dose, yield and temperature already matched the machine, so they land in
  // `held` — and the banner used to list only `changes`, reporting "grind"
  // alone while the card showed all five settings.
  const diff = starterDiff();
  assert.deepEqual(diff.changes.map((c) => c.field), ['grind'], 'only grind actually moved');

  const note = describeApplied(diff, null, true);
  assert.match(note, /grind 0\.6/);
  assert.match(note, /dose 18/);
  assert.match(note, /yield 36/);
  assert.match(note, /93/);
});

test('a starting point has no before, in the banner as on the card', () => {
  const note = describeApplied(starterDiff(), null, true);
  assert.ok(!note.includes('1.5'), 'the leftover dial value is not quoted');
  assert.ok(!note.includes('›'), 'and nothing is shown as a transition');
});

test('a correction reports the move, and only what moved', () => {
  const diff = diffRecipe(
    { profileTitle: 'Adaptive v3', grind: 1.5, doseG: 18, targetYieldG: 40, temperatureC: 93 },
    { profileTitle: 'Adaptive v3', grind: 0.6, doseG: 18, targetYieldG: 36, temperatureC: 93 }
  );
  const note = describeApplied(diff, null, false);
  assert.match(note, /grind 1\.5 › 0\.6/);
  assert.match(note, /yield 40\.0 › 36\.0/);
  assert.ok(!note.includes('dose'), 'deliberately held values are not reported as applied');
});

test('a profile switch leads the summary', () => {
  assert.match(describeApplied(starterDiff(), 'Gentle Decline', true), /^profile Gentle Decline ·/);
  assert.match(
    describeApplied(diffRecipe({ grind: 1.5 } as never, { grind: 0.6 } as never), 'Gentle Decline', false),
    /^profile › Gentle Decline ·/
  );
});

test('applying something the machine already matched says so', () => {
  const same = { profileTitle: 'Adaptive v3', grind: 0.6, doseG: 18, targetYieldG: 36, temperatureC: 93 };
  assert.match(describeApplied(diffRecipe(same, same), null, false), /No numbers changed/);
});

// ---- reopening advice that was already applied ---------------------------

test('advice must be read against the recipe it was given for, not the live one', () => {
  const before = { profileTitle: 'Adaptive v3', grind: 1.5, doseG: 18, targetYieldG: 40, temperatureC: 93 };
  const advised = { profileTitle: 'Adaptive v3', grind: 0.6, doseG: 18, targetYieldG: 36, temperatureC: 93 };

  // What the card showed when the advice arrived.
  const asGiven = diffRecipe(before, advised);
  assert.deepEqual(asGiven.changes.map((c) => c.field), ['grind', 'targetYieldG']);

  // After Apply the machine *is* the advice. Re-diffing against it — which is
  // what reopening the card used to do — empties the card: nothing left to
  // change, so every field falls into "held" and the screen shows a stub.
  const afterApply = diffRecipe(advised, advised);
  assert.equal(afterApply.changes.length, 0, 'this is the bug: an empty card');
  assert.equal(afterApply.held.length, 5, 'everything reported as deliberately unchanged');

  // Reopening has to reuse the original ground, so the card is unchanged.
  const reopened = diffRecipe(before, advised);
  assert.deepEqual(reopened.changes.map((c) => c.field), asGiven.changes.map((c) => c.field));
  assert.equal(
    describeApplied(reopened, null, false),
    describeApplied(asGiven, null, false),
    'and it summarises identically'
  );
});
