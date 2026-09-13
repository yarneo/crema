/**
 * The numbers in these cases are not invented: they were measured on an iPad
 * Air (4th generation) with the skin running both ways, which is the only
 * reason the Decaid case is known to differ from Safari at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isFullBleed, resolveBottomInset, type ViewportFacts } from '../safearea.ts';

const iPadAir = {
  screenWidth: 820,
  screenHeight: 1180,
  maxTouchPoints: 5
};

/** Measured: Safari on the iPad, toolbar visible, insets reported honestly. */
const safari: ViewportFacts = { ...iPadAir, envBottomPx: 25, innerWidth: 1180, innerHeight: 713 };

/** Measured: the same skin inside Decaid 0.8.6 — full screen, insets all zero. */
const decaidApp: ViewportFacts = { ...iPadAir, envBottomPx: 0, innerWidth: 1180, innerHeight: 820 };

test('a browser that reports an inset is believed', () => {
  assert.equal(resolveBottomInset(safari), 25);
});

test("Decaid's webview claims no inset while owning the whole screen, so one is inferred", () => {
  assert.equal(isFullBleed(decaidApp), true);
  assert.equal(resolveBottomInset(decaidApp), 20);
});

test('Safari is not full bleed — its toolbar is the difference', () => {
  assert.equal(isFullBleed(safari), false);
});

test('an iPad reserves the same strip in both orientations, as iPadOS does', () => {
  assert.equal(
    resolveBottomInset({ ...iPadAir, envBottomPx: 0, innerWidth: 820, innerHeight: 1180 }),
    20
  );
});

// An iPhone's indicator is a different height, and changes with orientation.
const iPhone = { screenWidth: 393, screenHeight: 852, maxTouchPoints: 5 };

test('a phone in the same webview gets the phone strip, not the tablet one', () => {
  assert.equal(
    resolveBottomInset({ ...iPhone, envBottomPx: 0, innerWidth: 393, innerHeight: 852 }),
    34
  );
  assert.equal(
    resolveBottomInset({ ...iPhone, envBottomPx: 0, innerWidth: 852, innerHeight: 393 }),
    21
  );
});

test('a home-button tablet loses a few idle pixels, never its navigation', () => {
  // No way to detect the absence of an indicator, so the fallback still fires.
  // The cost is 20px of space under the tabs; the alternative failure mode is
  // the tab row sitting under a home indicator, which is the actual bug.
  const iPad9 = { screenWidth: 810, screenHeight: 1080, maxTouchPoints: 5 };
  assert.equal(resolveBottomInset({ ...iPad9, envBottomPx: 0, innerWidth: 1080, innerHeight: 810 }), 20);
});

test('an honest inset always wins, so fixing Decaid retires the guess', () => {
  // Same full-bleed Decaid shape, but the webview now reports the truth.
  assert.equal(resolveBottomInset({ ...decaidApp, envBottomPx: 20 }), 20);
  assert.equal(resolveBottomInset({ ...decaidApp, envBottomPx: 34 }), 34);
});

test('a desktop window keeps every pixel', () => {
  assert.equal(
    resolveBottomInset({
      envBottomPx: 0,
      innerWidth: 1440,
      innerHeight: 900,
      screenWidth: 3008,
      screenHeight: 1692,
      maxTouchPoints: 0
    }),
    0
  );
});

test('a maximised desktop window is not mistaken for a home indicator', () => {
  // Full bleed by size, but no touch input: nothing to avoid.
  assert.equal(
    resolveBottomInset({
      envBottomPx: 0,
      innerWidth: 3008,
      innerHeight: 1692,
      screenWidth: 3008,
      screenHeight: 1692,
      maxTouchPoints: 0
    }),
    0
  );
});

test('a touch device in a browser with chrome is left alone', () => {
  // An old Decent tablet: touch, but the browser owns part of the screen and
  // there is no home indicator to dodge.
  assert.equal(
    resolveBottomInset({
      envBottomPx: 0,
      innerWidth: 1280,
      innerHeight: 700,
      screenWidth: 1280,
      screenHeight: 800,
      maxTouchPoints: 10
    }),
    0
  );
});
