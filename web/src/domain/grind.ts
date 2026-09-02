/**
 * Grind handling, ported from the Tcl skin with its two hard-won rules intact.
 */

/** Below or above this and the number is not a dial setting, whatever it says. */
const MIN_SANE_GRIND = 0;
const MAX_SANE_GRIND = 100;

/**
 * Snap to the 0.05 grid so a manual bump and an advisor's grind land on the
 * same scale. Trailing zeros go, because "0.10" reads as more precision than
 * a dial actually has: 0.10 -> 0.1, 0.15 -> 0.15.
 */
export function snapGrind(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 20) / 20;
}

/** Render a snapped grind the way the dial is labelled. */
export function formatGrind(value: number): string {
  const snapped = snapGrind(value);
  return snapped.toFixed(2).replace(/(\.\d)0$/, '$1');
}

/**
 * Whether a proposed grind is worth applying at all.
 *
 * This is a sanity check and deliberately *not* a clamp to the user's
 * configured grinder range. An earlier version of the Tcl skin did clamp, and
 * it was wrong: the configured range is user-entered and frequently bogus —
 * one said 0.4–1.0 while the user actually grinds at 0.1–0.2, so the clamp
 * dragged the advisor's correct 0.15 up to 0.4. The model is already told the
 * range in the prompt. Do not second-guess its number; only reject values that
 * cannot be a dial setting at all.
 */
export function isSaneGrind(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > MIN_SANE_GRIND && value <= MAX_SANE_GRIND;
}

/**
 * Resolve the grind to apply.
 *
 * An absolute `target` wins when it is sane, because it is what the model
 * committed to. A `delta` is only used as a fallback, applied to the grind the
 * shot was actually pulled with. Returns null when neither yields something
 * applicable, which the caller should treat as "no grind change".
 */
export function resolveGrind(
  current: number | null,
  target: number | null,
  delta: number | null
): number | null {
  if (isSaneGrind(target)) return snapGrind(target);

  if (typeof delta === 'number' && Number.isFinite(delta) && delta !== 0 && current !== null) {
    const derived = snapGrind(current + delta);
    if (isSaneGrind(derived)) return derived;
  }

  return null;
}
