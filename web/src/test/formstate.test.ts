/**
 * The rule that matters here is "restore only what the user touched".
 *
 * Restoring everything would freeze the screen against real updates; restoring
 * nothing is the bug this exists to fix — backgrounding the app and coming
 * back cleared a half-filled bag, and the same thing ate text in Settings.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureScroll, formKey, isDirty, type ControlLike } from '../formstate.ts';

const control = (over: Partial<ControlLike> = {}): ControlLike => ({
  name: 'roastLevel',
  type: 'text',
  value: '',
  defaultValue: '',
  checked: false,
  defaultChecked: false,
  ...over
});

test('an untouched field is not restored, so the screen can still update', () => {
  // The edit-bean form renders the saved name. If the gateway renames it
  // elsewhere, the new name must win — the user was not editing this.
  assert.equal(isDirty(control({ value: 'Gesha', defaultValue: 'Gesha' })), false);
});

test('a typed field is restored, even when it started with a value', () => {
  assert.equal(isDirty(control({ value: 'Geshaa', defaultValue: 'Gesha' })), true);
});

test('typing into an empty field counts', () => {
  assert.equal(isDirty(control({ value: '2026-09-12', type: 'date' })), true);
});

test('clearing a prefilled field counts too', () => {
  // Deleting what was there is an edit; putting it back would fight the user.
  assert.equal(isDirty(control({ value: '', defaultValue: 'Gesha' })), true);
});

test('toggles compare checked, not value', () => {
  assert.equal(isDirty(control({ type: 'checkbox', checked: true, defaultChecked: true })), false);
  assert.equal(isDirty(control({ type: 'checkbox', checked: true, defaultChecked: false })), true);
});

test('a nameless control is skipped — there is nothing to match it back to', () => {
  assert.equal(isDirty(control({ name: '', value: 'typed' })), false);
});

test('forms are identified by what survives a re-render', () => {
  // Node references and positions do not survive innerHTML; data-action does.
  assert.equal(formKey('add-batch', undefined, 0), 'add-batch');
  assert.equal(formKey('edit-bean', 'b1', 3), 'edit-bean:b1');
  assert.notEqual(formKey('edit-bean', 'b1', 0), formKey('edit-bean', 'b2', 0));
  assert.equal(formKey(undefined, undefined, 2), 'form:2');
});

// ---- keeping your place across a re-render --------------------------------

test('scroll containers are keyed by something that survives innerHTML', () => {
  // Node references do not survive a re-render, and neither does position in a
  // NodeList unless it is recomputed against the same selector. Two lists on
  // one screen must not collapse to a single key.
  const memos = captureScroll(fakeRoot([
    { selector: '.app', top: 420 },
    { selector: '.list', top: 0 },
    { selector: '.list', top: 88 }
  ]));

  assert.deepEqual(memos.map((m) => m.key), ['.app#0', '.list#1']);
  assert.equal(memos[0]!.top, 420);
  assert.equal(memos[1]!.top, 88, 'the second list keeps its own position');
});

test('containers already at the top are not recorded', () => {
  // Restoring a zero is harmless but pointless, and it makes the memo noisy.
  assert.deepEqual(captureScroll(fakeRoot([{ selector: '.app', top: 0 }])), []);
});

/** A minimal stand-in for the parts of the DOM captureScroll touches. */
function fakeRoot(items: ReadonlyArray<{ selector: string; top: number }>): ParentNode {
  return {
    querySelectorAll(selector: string) {
      return items
        .filter((item) => item.selector === selector)
        .map((item) => ({ scrollTop: item.top, scrollLeft: 0 }));
    }
  } as unknown as ParentNode;
}
