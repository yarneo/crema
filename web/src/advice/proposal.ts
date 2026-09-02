/**
 * The bridge from parsed advice to the advice card.
 *
 * Advice is what the model said; a proposal is what we are willing to put in
 * front of the Apply button. Everything nonsensical is dropped here, so the
 * card and the machine only ever see values that could plausibly be real.
 *
 * As in `diffRecipe`, a dropped field means "leave it alone". There is no path
 * from a bad model response to a cleared recipe.
 */

import { resolveGrind } from '../domain/grind.ts';
import { diffRecipe, type Recipe, type RecipeDiff, type RecipeField } from '../domain/recipe.ts';
import type { Advice } from './schema.ts';

export interface Proposal {
  proposed: Partial<Recipe>;
  reasons: Partial<Record<RecipeField, string>>;
}

/**
 * Plausibility bounds. These reject impossibilities, not opinions: a 0g dose
 * or a 400°C brew is a broken response, whereas an unusually fine grind is
 * just advice we might disagree with. Grind deliberately has no range check
 * beyond `isSaneGrind` — see the note in `domain/grind.ts`.
 */
const BOUNDS: Record<'doseG' | 'targetYieldG' | 'temperatureC', { min: number; max: number }> = {
  doseG: { min: 0, max: 60 },
  targetYieldG: { min: 0, max: 200 },
  temperatureC: { min: 60, max: 110 }
};

function withinBounds(field: keyof typeof BOUNDS, value: number | null): number | null {
  if (value === null) return null;
  const { min, max } = BOUNDS[field];
  return value > min && value <= max ? value : null;
}

/** Which profile title, if any, the advice wants selected next. */
export function proposedProfileTitle(advice: Advice): string | null {
  switch (advice.profile.action) {
    case 'switch':
      return advice.profile.switchTo;
    case 'create':
      return advice.profile.createdProfile?.title ?? null;
    case 'keep':
      return null;
  }
}

/** Convert advice into the recipe fields we are prepared to change. */
export function toProposal(advice: Advice, current: Recipe): Proposal {
  const proposed: Partial<Recipe> = {};
  const reasons: Partial<Record<RecipeField, string>> = {};

  const grind = resolveGrind(current.grind, advice.actions.grind.target, advice.actions.grind.delta);
  if (grind !== null) {
    proposed.grind = grind;
    reasons.grind = advice.actions.grind.reason;
  }

  const doseG = withinBounds('doseG', advice.actions.doseG.value);
  if (doseG !== null) {
    proposed.doseG = doseG;
    reasons.doseG = advice.actions.doseG.reason;
  }

  const targetYieldG = withinBounds('targetYieldG', advice.actions.targetYieldG.value);
  if (targetYieldG !== null) {
    proposed.targetYieldG = targetYieldG;
    reasons.targetYieldG = advice.actions.targetYieldG.reason;
  }

  const temperatureC = withinBounds('temperatureC', advice.actions.temperatureC.value);
  if (temperatureC !== null) {
    proposed.temperatureC = temperatureC;
    reasons.temperatureC = advice.actions.temperatureC.reason;
  }

  const profileTitle = proposedProfileTitle(advice);
  if (profileTitle !== null) {
    proposed.profileTitle = profileTitle;
    reasons.profileTitle = advice.profile.reason;
  }

  return { proposed, reasons };
}

/** The advice card, end to end: what the model said, as a reviewable diff. */
export function adviceToDiff(advice: Advice, current: Recipe): RecipeDiff {
  const { proposed, reasons } = toProposal(advice, current);
  return diffRecipe(current, proposed, reasons);
}
