/**
 * The recipe is the set of things Crema can change between one shot and the
 * next. Everything the advisor proposes lands here, and the diff between the
 * recipe you pulled with and the recipe being proposed *is* the advice card:
 * see `diffRecipe`.
 *
 * Kept deliberately free of any gateway or DOM types so it can be unit-tested
 * in isolation, and so the same model backs both the advice card and the undo
 * snapshot.
 */

import { formatGrind } from './grind.ts';

export interface Recipe {
  /** Title of the selected profile, or null when nothing is selected. */
  profileTitle: string | null;
  /** Grinder dial setting, in the grinder's own units. Lower is finer. */
  grind: number | null;
  /** Dry coffee in, grams. */
  doseG: number | null;
  /** Target liquid out, grams. */
  targetYieldG: number | null;
  /** Target brew temperature, °C. */
  temperatureC: number | null;
}

export type RecipeField = keyof Recipe;

/** Display order on the advice card. Grind first: it is the usual lever. */
export const RECIPE_FIELDS: readonly RecipeField[] = [
  'grind',
  'doseG',
  'targetYieldG',
  'temperatureC',
  'profileTitle'
] as const;

const LABELS: Record<RecipeField, string> = {
  grind: 'Grind',
  doseG: 'Dose',
  targetYieldG: 'Yield',
  temperatureC: 'Temp',
  profileTitle: 'Profile'
};

const UNITS: Record<RecipeField, string> = {
  grind: '',
  doseG: 'g',
  targetYieldG: 'g',
  temperatureC: '°C',
  profileTitle: ''
};

/**
 * Per-field tolerance below which a "change" is really float noise or a
 * rounding artefact from the gateway, not something to show the user.
 * Grind is the tightest because 0.1 of a dial is a real move on a Lagom.
 */
const EPSILON: Partial<Record<RecipeField, number>> = {
  grind: 0.05,
  doseG: 0.05,
  targetYieldG: 0.05,
  temperatureC: 0.05
};

export interface FieldChange {
  field: RecipeField;
  /** Human label, e.g. "Grind". */
  label: string;
  /** Unit suffix for display, e.g. "g". Empty when unitless. */
  unit: string;
  from: number | string | null;
  to: number | string | null;
  /** One line from the advisor on why. Empty when it gave none. */
  reason: string;
}

export interface RecipeDiff {
  /** Fields that actually move, in `RECIPE_FIELDS` order. */
  changes: FieldChange[];
  /**
   * Fields the advisor left alone, and which have a value worth showing.
   * Rendering these is the point: it makes "one change at a time" visible
   * rather than implied, so the next shot tells you one thing cleanly.
   */
  held: FieldChange[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** True when the two values differ by enough to be worth showing. */
/**
 * Slack for comparing a step against the threshold it is meant to clear.
 *
 * The steppers move by exactly one epsilon, and in binary that difference is
 * not exactly one epsilon: 0.85 - 0.8 is 0.04999999999999993, just under the
 * 0.05 threshold. Without this, every other tap was reported as "no change"
 * and silently dropped, which trapped the grind between 0.75 and 0.80 — the
 * only two values whose subtraction happens to round the other way. Far below
 * any real dial's precision, so it cannot mask a genuine no-op.
 */
const FLOAT_SLACK = 1e-9;

export function fieldChanged(field: RecipeField, from: Recipe[RecipeField], to: Recipe[RecipeField]): boolean {
  if (from === null || from === undefined) return to !== null && to !== undefined;
  if (to === null || to === undefined) return false; // proposing "no value" is not a change
  if (isNum(from) && isNum(to)) {
    return Math.abs(to - from) + FLOAT_SLACK >= (EPSILON[field] ?? 0);
  }
  return String(from).trim() !== String(to).trim();
}

/**
 * Build the advice card's diff.
 *
 * `proposed` carries only the fields the advisor wants to move; a null or
 * missing field means "leave it", never "clear it". That asymmetry is
 * deliberate — a model omitting a key must not wipe the user's recipe.
 */
export function diffRecipe(
  current: Recipe,
  proposed: Partial<Recipe>,
  reasons: Partial<Record<RecipeField, string>> = {}
): RecipeDiff {
  const changes: FieldChange[] = [];
  const held: FieldChange[] = [];

  for (const field of RECIPE_FIELDS) {
    const from = current[field] ?? null;
    const to = proposed[field] ?? null;
    const entry: FieldChange = {
      field,
      label: LABELS[field],
      unit: UNITS[field],
      from,
      to,
      reason: (reasons[field] ?? '').trim()
    };

    if (fieldChanged(field, from, to)) {
      changes.push(entry);
    } else if (from !== null && from !== '') {
      held.push({ ...entry, to: from });
    }
  }

  return { changes, held };
}

/**
 * Apply a diff to a recipe, producing the recipe to pull the next shot with.
 *
 * The switch is exhaustive rather than a dynamic assignment so the compiler
 * checks every field, and so a value of the wrong runtime type (a model
 * returning a string grind, say) lands as null instead of corrupting the
 * recipe.
 */
export function applyDiff(current: Recipe, diff: RecipeDiff): Recipe {
  const next: Recipe = { ...current };

  for (const { field, to } of diff.changes) {
    switch (field) {
      case 'profileTitle':
        next.profileTitle = typeof to === 'string' && to !== '' ? to : null;
        break;
      case 'grind':
      case 'doseG':
      case 'targetYieldG':
      case 'temperatureC':
        next[field] = isNum(to) ? to : null;
        break;
    }
  }

  return next;
}

/** Format a field value for display. Numbers keep the precision that matters. */
export function formatValue(field: RecipeField, value: number | string | null): string {
  if (value === null || value === '') return '—';
  if (!isNum(value)) return String(value);
  const decimals = field === 'temperatureC' || field === 'grind' ? 1 : 1;
  return value.toFixed(decimals);
}

/**
 * One line naming what a diff put on the machine.
 *
 * This has to agree with the advice card it summarises, which is why
 * `starting` is a parameter rather than something inferred here. Before a
 * first shot nothing is "held" — every value is part of the recipe just
 * accepted, and none of them has a before. Listing only `changes` meant a
 * setting that already matched the machine (dose 18, temperature 93) went
 * unmentioned, so accepting a whole starting point reported "grind" alone
 * while the card listed five settings.
 */
export function describeApplied(
  diff: RecipeDiff,
  profileSwitchTo: string | null,
  starting: boolean
): string {
  const show = (change: FieldChange, side: 'from' | 'to'): string => {
    const value = change[side];
    return change.field === 'grind' && typeof value === 'number'
      ? formatGrind(value)
      : formatValue(change.field, value);
  };

  const fields = starting ? [...diff.changes, ...diff.held] : diff.changes;
  const parts = fields
    .filter((change) => change.field !== 'profileTitle')
    .map((change) =>
      starting
        ? `${change.label.toLowerCase()} ${show(change, 'to')}`
        : `${change.label.toLowerCase()} ${show(change, 'from')} › ${show(change, 'to')}`
    );

  if (profileSwitchTo) {
    parts.unshift(starting ? `profile ${profileSwitchTo}` : `profile › ${profileSwitchTo}`);
  } else if (starting) {
    const held = diff.held.find((change) => change.field === 'profileTitle');
    if (held && typeof held.to === 'string' && held.to) parts.unshift(`profile ${held.to}`);
  }

  if (parts.length > 0) return parts.join(' · ');
  return starting ? 'The machine was already set this way.' : 'No numbers changed — pull it again the same way.';
}
