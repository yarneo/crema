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
export function fieldChanged(field: RecipeField, from: Recipe[RecipeField], to: Recipe[RecipeField]): boolean {
  if (from === null || from === undefined) return to !== null && to !== undefined;
  if (to === null || to === undefined) return false; // proposing "no value" is not a change
  if (isNum(from) && isNum(to)) {
    return Math.abs(to - from) >= (EPSILON[field] ?? 0);
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
