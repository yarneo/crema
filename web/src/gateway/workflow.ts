/**
 * Mapping between Decaid's workflow and Crema's recipe.
 *
 * Pure on purpose: every rule about how a recipe becomes machine state is
 * testable without a gateway, a network, or a DE1.
 *
 * The one piece of real judgement here is temperature. Decaid has no single
 * brew-temperature field; temperature lives per step inside the profile. So we
 * read the hottest step as the recipe's temperature, and we *apply* a
 * temperature by shifting every step by the same delta. That preserves the
 * profile's shape — a bloom that ran 3° cooler than extraction still does —
 * and matches how Decent's own Streamline skin describes its temperature
 * control.
 */

import { formatGrind } from '../domain/grind.ts';
import { profileTemperature, shiftProfileTemperature } from '../domain/profile.ts';
import type { Recipe, RecipeDiff } from '../domain/recipe.ts';
import type { WorkflowContextWire, WorkflowPatch, WorkflowWire } from './types.ts';

export { profileTemperature, shiftProfileTemperature };

/** Read the current workflow as a Crema recipe. */
export function workflowToRecipe(workflow: WorkflowWire): Recipe {
  const context = workflow.context ?? {};

  // grinderSetting is a string on the wire, and may be blank or non-numeric.
  const grindRaw = context.grinderSetting;
  const grind = grindRaw === null || grindRaw === undefined || grindRaw.trim() === ''
    ? null
    : Number.parseFloat(grindRaw);

  return {
    profileTitle: workflow.profile?.title ?? null,
    grind: typeof grind === 'number' && Number.isFinite(grind) ? grind : null,
    doseG: context.targetDoseWeight ?? null,
    targetYieldG: context.targetYield ?? null,
    temperatureC: profileTemperature(workflow.profile)
  };
}

/**
 * Build the PUT body that turns the current workflow into the accepted diff.
 *
 * Only fields that actually change are included, so an apply never rewrites
 * settings the user did not agree to. A profile *switch* is deliberately not
 * handled here: selecting a different profile means sending that profile's own
 * definition, which the caller has to fetch first — see `applyProfileSwitch`.
 */
export function diffToWorkflowPatch(diff: RecipeDiff, workflow: WorkflowWire): WorkflowPatch {
  const patch: WorkflowPatch = {};
  const context: WorkflowContextWire = {};

  for (const change of diff.changes) {
    switch (change.field) {
      case 'grind':
        if (typeof change.to === 'number') context.grinderSetting = formatGrind(change.to);
        break;
      case 'doseG':
        if (typeof change.to === 'number') context.targetDoseWeight = change.to;
        break;
      case 'targetYieldG':
        if (typeof change.to === 'number') context.targetYield = change.to;
        break;
      case 'temperatureC': {
        const from = typeof change.from === 'number' ? change.from : profileTemperature(workflow.profile);
        if (typeof change.to === 'number' && from !== null && workflow.profile) {
          patch.profile = shiftProfileTemperature(workflow.profile, change.to - from);
        }
        break;
      }
      case 'profileTitle':
        // Handled separately: needs the target profile's steps, not just a name.
        break;
    }
  }

  if (Object.keys(context).length > 0) patch.context = context;
  return patch;
}

/**
 * The exact values to send to put things back, captured *before* an apply.
 *
 * Undo is the whole point of taking this snapshot (issue #7). Storing the
 * pre-apply workflow slice rather than re-deriving it later means undo still
 * works after the user has navigated away, and cannot be confused by anything
 * that changed in between.
 */
export function undoPatch(before: WorkflowWire, applied: WorkflowPatch): WorkflowPatch {
  const patch: WorkflowPatch = {};

  if (applied.context) {
    const context: WorkflowContextWire = {};
    const previous = before.context ?? {};
    for (const key of Object.keys(applied.context) as (keyof WorkflowContextWire)[]) {
      // `?? null` matters: a field that had no value must be sent back as null,
      // not omitted, or the apply's value would survive the undo.
      (context as Record<string, unknown>)[key] = previous[key] ?? null;
    }
    patch.context = context;
  }

  if (applied.profile && before.profile) {
    patch.profile = before.profile;
  }

  return patch;
}
