/**
 * Grind handling, ported from the Tcl skin with its two hard-won rules intact.
 */

/** Below or above this and the number is not a dial setting, whatever it says. */
const MIN_SANE_GRIND = 0;
const MAX_SANE_GRIND = 100;

/**
 * Snap manual adjustments to the stepper's 0.05 grid.
 */
export function snapGrind(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 20) / 20;
}

/** Keep the precision of the grinder's actual setting when displaying or saving it. */
export function formatGrind(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
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
  if (isSaneGrind(target)) return target;

  if (typeof delta === 'number' && Number.isFinite(delta) && delta !== 0 && current !== null) {
    const derived = Number((current + delta).toFixed(10));
    if (isSaneGrind(derived)) return derived;
  }

  return null;
}

/**
 * The dial range the barista typed in Settings, e.g. "0.1-0.5" or "1 – 12".
 *
 * Any dash will do — people type hyphens, en dashes and "to" — and the two
 * numbers are returned low-first regardless of the order given.
 */
export function parseGrinderRange(raw: string | null | undefined): { min: number; max: number } | null {
  if (!raw) return null;
  const numbers = raw.match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length < 2) return null;

  const a = Number(numbers[0]);
  const b = Number(numbers[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;

  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/**
 * Where to start when the grind has never been set.
 *
 * The stepper is useless from nothing — it moves by 0.05, so reaching a Niche's
 * 20 takes four hundred taps, and there is no way to know the barista's scale
 * without being told. The configured range is the one honest hint we have, so
 * the first nudge lands in the middle of it. With no range configured there is
 * no defensible guess and this returns null; the value must be typed instead.
 */
export function startingGrind(range: string | null | undefined): number | null {
  const parsed = parseGrinderRange(range);
  if (parsed === null) return null;
  const middle = snapGrind((parsed.min + parsed.max) / 2);
  return isSaneGrind(middle) ? middle : null;
}
