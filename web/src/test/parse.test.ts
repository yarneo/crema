import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coerceNumber, extractJsonObject, parseAdvice, readEvidence } from '../advice/parse.ts';
import { adviceToDiff, toProposal } from '../advice/proposal.ts';
import { resolveGrind, snapGrind, formatGrind, isSaneGrind } from '../domain/grind.ts';
import type { Recipe } from '../domain/recipe.ts';

const current: Recipe = {
  profileTitle: 'Gentle Decline',
  grind: 12.4,
  doseG: 18,
  targetYieldG: 40,
  temperatureC: 92
};

const wellFormed = JSON.stringify({
  diagnosis: 'Ran fast and tasted sharp.',
  confidence: 'high',
  evidence: [{ from_s: 10, to_s: 14, label: 'flow ran away' }],
  actions: {
    grind: { delta: -0.4, target: 12.0, reason: '28g out in 19s.' },
    dose_g: { value: null, reason: '' },
    target_yield_g: { value: 36, reason: 'Shorter while the grind settles.' },
    temperature_c: { value: null, reason: '' }
  },
  profile: { action: 'keep', switch_to: null, created_profile: null, reason: '' },
  screen_summary: 'Grind to 12.0 and pull to 36g.'
});

// ---- JSON extraction ------------------------------------------------------

test('extracts JSON from inside markdown fences and prose', () => {
  const reply = 'Sure! Here you go:\n```json\n{"a":1}\n```\nHope that helps.';
  assert.equal(extractJsonObject(reply), '{"a":1}');
});

test('braces inside strings do not end the object early', () => {
  const reply = '{"note":"a } brace","b":2}';
  assert.equal(extractJsonObject(reply), reply);
});

test('escaped quotes inside strings are honoured', () => {
  const reply = String.raw`{"note":"he said \"fine\" }","b":2}`;
  assert.equal(extractJsonObject(reply), reply);
});

test('nested objects come back whole', () => {
  assert.equal(extractJsonObject('x {"a":{"b":{"c":1}}} y'), '{"a":{"b":{"c":1}}}');
});

test('unbalanced or absent JSON is null, not an exception', () => {
  assert.equal(extractJsonObject('no object here'), null);
  assert.equal(extractJsonObject('{"a":1'), null);
});

// ---- number coercion ------------------------------------------------------

test('numbers survive arriving as strings, units and Unicode minus', () => {
  assert.equal(coerceNumber(12.4), 12.4);
  assert.equal(coerceNumber('12.4'), 12.4);
  assert.equal(coerceNumber('18g'), 18);
  assert.equal(coerceNumber('93 C'), 93);
  assert.equal(coerceNumber('−0.4'), -0.4, 'Unicode minus');
  assert.equal(coerceNumber('–0.4'), -0.4, 'en dash');
});

test('non-numbers are null rather than NaN', () => {
  for (const value of [null, undefined, '', 'none', 'n/a', {}, [], Number.NaN, Infinity]) {
    assert.equal(coerceNumber(value), null, `${String(value)} should be null`);
  }
});

// ---- parsing --------------------------------------------------------------

test('a well-formed reply parses into advice', () => {
  const result = parseAdvice(wellFormed, { shotDurationS: 29 });
  assert.ok(result.ok);
  assert.equal(result.advice.diagnosis, 'Ran fast and tasted sharp.');
  assert.equal(result.advice.confidence, 'high');
  assert.equal(result.advice.actions.grind.target, 12.0);
  assert.equal(result.advice.actions.targetYieldG.value, 36);
  assert.deepEqual(result.warnings, []);
});

test('an unknown confidence falls back to low rather than being trusted', () => {
  const result = parseAdvice('{"diagnosis":"x","confidence":"very sure"}');
  assert.ok(result.ok);
  assert.equal(result.advice.confidence, 'low');
});

test('a bare number for grind is read as an absolute dial', () => {
  const result = parseAdvice('{"diagnosis":"x","actions":{"grind":11.8}}');
  assert.ok(result.ok);
  assert.equal(result.advice.actions.grind.target, 11.8);
});

test('a bare number for a value field is accepted', () => {
  const result = parseAdvice('{"diagnosis":"x","actions":{"dose_g":18.5}}');
  assert.ok(result.ok);
  assert.equal(result.advice.actions.doseG.value, 18.5);
});

test('garbage is reported, never thrown', () => {
  assert.equal(parseAdvice('I could not analyse that shot.').ok, false);
  assert.equal(parseAdvice('{"a":').ok, false);
  assert.equal(parseAdvice('{"a":1}').ok, false, 'no diagnosis and no summary is not advice');
  assert.equal(parseAdvice('').ok, false);
});

// ---- evidence -------------------------------------------------------------

test('evidence windows are clamped into the shot', () => {
  const { windows } = readEvidence([{ from_s: -3, to_s: 40, label: 'x' }], 29);
  assert.deepEqual(windows, [{ fromS: 0, toS: 29, label: 'x' }]);
});

test('a window entirely outside the shot is dropped and reported', () => {
  const { windows, warnings } = readEvidence([{ from_s: 40, to_s: 50, label: 'x' }], 29);
  assert.deepEqual(windows, []);
  assert.equal(warnings.length, 1);
});

test('a reversed window is put back in order', () => {
  const { windows } = readEvidence([{ from_s: 14, to_s: 10, label: 'x' }], 29);
  assert.deepEqual(windows, [{ fromS: 10, toS: 14, label: 'x' }]);
});

test('zero-length and malformed windows are discarded', () => {
  const { windows } = readEvidence(
    [{ from_s: 5, to_s: 5, label: 'x' }, { label: 'no times' }, 'nonsense'],
    29
  );
  assert.deepEqual(windows, []);
});

test('no more than three windows are drawn', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ from_s: i, to_s: i + 0.5, label: `w${i}` }));
  assert.equal(readEvidence(many, 29).windows.length, 3);
});

test('long labels are truncated to what the chart can show', () => {
  const label = 'x'.repeat(80);
  assert.equal(readEvidence([{ from_s: 1, to_s: 2, label }], 29).windows[0]?.label.length, 40);
});

// ---- profile --------------------------------------------------------------

test('a switch with no target is downgraded to keep', () => {
  const result = parseAdvice('{"diagnosis":"x","profile":{"action":"switch","switch_to":null}}');
  assert.ok(result.ok);
  assert.equal(result.advice.profile.action, 'keep');
  assert.equal(result.warnings.length, 1);
});

test('a create with no usable steps is downgraded to keep', () => {
  const result = parseAdvice(
    '{"diagnosis":"x","profile":{"action":"create","created_profile":{"title":"T","steps":[]}}}'
  );
  assert.ok(result.ok);
  assert.equal(result.advice.profile.action, 'keep');
});

test('an authored profile is kept when it has a title and steps', () => {
  const reply = JSON.stringify({
    diagnosis: 'x',
    profile: {
      action: 'create',
      created_profile: {
        title: 'AI Gesha',
        notes: 'longer bloom',
        target_weight_g: 40,
        steps: [{ name: 'bloom', temperature: 92, seconds: 20, pump: 'flow', flow: 2, transition: 'smooth' }]
      }
    }
  });
  const result = parseAdvice(reply);
  assert.ok(result.ok);
  assert.equal(result.advice.profile.action, 'create');
  assert.equal(result.advice.profile.createdProfile?.steps.length, 1);
  assert.equal(result.advice.profile.createdProfile?.steps[0]?.pump, 'flow');
});

// ---- grind ----------------------------------------------------------------

test('grind snaps to the 0.05 grid and drops a trailing zero', () => {
  assert.equal(snapGrind(12.43), 12.45);
  assert.equal(snapGrind(12.41), 12.4);
  assert.equal(formatGrind(0.1), '0.1');
  assert.equal(formatGrind(0.15), '0.15');
});

test('an absolute target wins over a delta', () => {
  assert.equal(resolveGrind(12.4, 12.0, -0.4), 12.0);
});

test('a delta is used only when there is no usable target', () => {
  assert.equal(resolveGrind(12.4, null, -0.4), 12.0);
  assert.equal(resolveGrind(12.4, null, 0), null, 'a zero delta is not a change');
  assert.equal(resolveGrind(null, null, -0.4), null, 'no current grind, nothing to add to');
});

test('a fine grind is never clamped up to a configured range', () => {
  // The Tcl skin used to clamp to the user's grinder_range and forced a
  // correct 0.15 up to 0.4. This asserts we do not reintroduce that.
  assert.equal(resolveGrind(0.2, 0.15, null), 0.15);
  assert.equal(isSaneGrind(0.15), true);
});

test('impossible grinds are rejected', () => {
  assert.equal(resolveGrind(12.4, 0, null), null);
  assert.equal(resolveGrind(12.4, -5, null), null);
  assert.equal(resolveGrind(12.4, 5000, null), null);
});

// ---- proposal -------------------------------------------------------------

test('advice becomes a diff of only what actually moves', () => {
  const result = parseAdvice(wellFormed, { shotDurationS: 29 });
  assert.ok(result.ok);

  const diff = adviceToDiff(result.advice, current);
  assert.deepEqual(diff.changes.map((c) => c.field), ['grind', 'targetYieldG']);
  assert.equal(diff.changes[0]?.reason, '28g out in 19s.');
  assert.deepEqual(diff.held.map((h) => h.field).sort(), ['doseG', 'profileTitle', 'temperatureC']);
});

test('out-of-range values are dropped instead of applied', () => {
  const reply = JSON.stringify({
    diagnosis: 'x',
    actions: {
      dose_g: { value: 0 },
      target_yield_g: { value: -5 },
      temperature_c: { value: 400 }
    }
  });
  const result = parseAdvice(reply);
  assert.ok(result.ok);

  const { proposed } = toProposal(result.advice, current);
  assert.deepEqual(proposed, {}, 'nothing impossible reaches the Apply button');
});

test('a created profile proposes its own title as the next profile', () => {
  const reply = JSON.stringify({
    diagnosis: 'x',
    profile: {
      action: 'create',
      reason: 'needs a longer bloom',
      created_profile: {
        title: 'AI Gesha',
        steps: [{ name: 'bloom', temperature: 92, seconds: 20, pump: 'flow' }]
      }
    }
  });
  const result = parseAdvice(reply);
  assert.ok(result.ok);

  const diff = adviceToDiff(result.advice, current);
  const profileChange = diff.changes.find((c) => c.field === 'profileTitle');
  assert.equal(profileChange?.to, 'AI Gesha');
  assert.equal(profileChange?.reason, 'needs a longer bloom');
});
