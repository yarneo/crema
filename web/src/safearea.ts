/**
 * Where the hardware eats the screen.
 *
 * CSS `env(safe-area-inset-*)` is the right answer when the browser tells the
 * truth. Decaid's webview does not: measured on an iPad Air (4th gen) running
 * Decaid 0.8.6, the page gets the entire 1180x820 screen and every inset
 * reports 0, so a tab row pinned to the bottom lands under the home
 * indicator. The same skin in Safari on the same iPad reports 25.
 *
 *   Safari      inner 1180x713  screen 820x1180  env-bottom 25   (honest)
 *   Decaid app  inner 1180x820  screen 820x1180  env-bottom 0    (not)
 *
 * So the inset is resolved rather than read: believe a non-zero `env()`, and
 * otherwise infer it from the page owning the whole physical screen on a
 * touch device.
 *
 * The fallback is deliberately biased. It fires only when a touch device has
 * handed the page its entire screen and then claimed nothing is in the way,
 * and the worst it can do is reserve ~20px on a device with no home indicator
 * — a home-button iPad, or a touchscreen laptop running Decaid maximised.
 * That is a few idle pixels under the tab row. Guessing the other way puts the
 * navigation under the indicator, which is the bug this exists to stop.
 *
 * It is also self-retiring: if Decaid's webview is ever fixed to propagate
 * insets, `env()` starts answering and the first branch takes over with no
 * change here.
 */

/**
 * Home-indicator strip heights, in CSS px, as the platforms actually report
 * them when they report anything:
 *
 *   iPad     20 in both orientations
 *   iPhone   34 portrait, 21 landscape
 *
 * These are the values to fall back to, not invented padding — the point is to
 * land on the same number the browser would have given us if it were honest.
 */
const INDICATOR_TABLET = 20;
const INDICATOR_PHONE_PORTRAIT = 34;
const INDICATOR_PHONE_LANDSCAPE = 21;

/**
 * Phones and tablets are told apart by the screen's short edge. Every iPhone
 * is under 500pt across; every iPad is over 700. Nothing ships in between, so
 * the boundary has room on both sides.
 */
const PHONE_MAX_SHORT_EDGE_PX = 500;

/** Screen dimensions are reported in the device's natural orientation. */
const TOLERANCE_PX = 2;

export interface ViewportFacts {
  /** What `env(safe-area-inset-bottom)` measured, in px. */
  envBottomPx: number;
  innerWidth: number;
  innerHeight: number;
  screenWidth: number;
  screenHeight: number;
  maxTouchPoints: number;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE_PX;

/**
 * Whether the page occupies the entire physical screen.
 *
 * `screen` keeps the device's natural orientation while `innerWidth/Height`
 * follow the current one, so the two are compared as an unordered pair. A
 * browser with any chrome at all — Safari's toolbar, a desktop window — fails
 * this, which is exactly the discrimination we need.
 */
export function isFullBleed(facts: ViewportFacts): boolean {
  const viewport = [facts.innerWidth, facts.innerHeight].sort((a, b) => a - b);
  const screen = [facts.screenWidth, facts.screenHeight].sort((a, b) => a - b);
  return near(viewport[0]!, screen[0]!) && near(viewport[1]!, screen[1]!);
}

/** The bottom inset to actually reserve, in px. */
export function resolveBottomInset(facts: ViewportFacts): number {
  // A browser that reports an inset is telling the truth; never second-guess it.
  if (facts.envBottomPx > 0) return facts.envBottomPx;

  // No touch, no home indicator. Desktop keeps its pixels.
  if (facts.maxTouchPoints <= 0) return 0;

  if (!isFullBleed(facts)) return 0;

  const shortEdge = Math.min(facts.screenWidth, facts.screenHeight);
  if (shortEdge > PHONE_MAX_SHORT_EDGE_PX) return INDICATOR_TABLET;

  return facts.innerHeight > facts.innerWidth ? INDICATOR_PHONE_PORTRAIT : INDICATOR_PHONE_LANDSCAPE;
}

/** Measure a CSS length expression, in px, without disturbing layout. */
function measureCss(expression: string, doc: Document): number {
  const probe = doc.createElement('div');
  probe.style.cssText = `position:fixed;left:-9999px;width:0;height:${expression}`;
  const host = doc.body ?? doc.documentElement;
  host.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  host.removeChild(probe);
  return height;
}

/**
 * Publish the resolved insets as `--safe-*` so the stylesheet can use them.
 *
 * The stylesheet already defaults these to `env()`, so a failure here leaves
 * the browser's own answer in place rather than breaking the layout.
 */
export function applySafeArea(win: Window = window): void {
  const doc = win.document;

  const facts: ViewportFacts = {
    envBottomPx: measureCss('env(safe-area-inset-bottom, 0px)', doc),
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    screenWidth: win.screen.width,
    screenHeight: win.screen.height,
    maxTouchPoints: win.navigator.maxTouchPoints ?? 0
  };

  doc.documentElement.style.setProperty('--safe-bottom', `${resolveBottomInset(facts)}px`);
}

/** Keep the insets correct across rotation and window resizes. */
export function watchSafeArea(win: Window = window): void {
  applySafeArea(win);
  win.addEventListener('resize', () => applySafeArea(win));
  win.addEventListener('orientationchange', () => setTimeout(() => applySafeArea(win), 120));
}
