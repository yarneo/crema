import { diffRecipe, type Recipe } from '../domain/recipe.ts';
import type { Profile } from '../domain/profile.ts';
import type { Gateway } from '../gateway/client.ts';
import type { ProfileEntryWire, WorkflowPatch, WorkflowWire } from '../gateway/types.ts';
import { diffToWorkflowPatch, workflowToRecipe } from '../gateway/workflow.ts';
import { toProposal } from './proposal.ts';
import type { Advice } from './schema.ts';

/** Save a created profile to the library, then commit the profile and dial in one workflow update. */
export async function applyToWorkflow(
  gateway: Gateway, advice: Advice, base: Recipe, before: WorkflowWire, beanName: string | null
) {
  const { proposed, reasons } = toProposal(advice, base);
  let profile: Profile | undefined;
  let selected: ProfileEntryWire | undefined;
  const authored = advice.profile.createdProfile;
  if (advice.profile.action === 'create' && authored) {
    profile = {
      version: '2', title: beanName ? `AI · ${beanName}` : authored.title,
      author: 'Crema AI', notes: authored.notes ? `${authored.title} — ${authored.notes}` : authored.title,
      beverage_type: 'espresso', target_weight: proposed.targetYieldG ?? authored.targetWeightG,
      steps: authored.steps
    };
  } else if (advice.profile.action === 'switch' && advice.profile.switchTo) {
    const wanted = advice.profile.switchTo.trim().toLocaleLowerCase();
    selected = (await gateway.readProfiles()).find(entry => entry.profile.title?.trim().toLocaleLowerCase() === wanted);
    if (!selected) throw new Error(`The profile “${advice.profile.switchTo}” is not installed in Decaid.`);
    profile = selected.profile;
  }

  // Resolve deltas against the shot that produced the advice. Compare the
  // resulting absolute values against the workflow we are actually changing.
  const working = profile ? { ...before, profile } : before;
  const diff = diffRecipe(workflowToRecipe(working), proposed, reasons);
  const patch: WorkflowPatch = diffToWorkflowPatch(diff, working);
  if (profile) {
    if (advice.profile.action === 'create') {
      selected = await gateway.createProfile(patch.profile ?? profile);
      patch.profile = selected.profile;
    } else {
      patch.profile ??= profile;
    }
  }
  const updated = Object.keys(patch).length ? await gateway.updateWorkflow(patch) : before;
  return { updated, patch, profileId: selected?.id, accepted: diffRecipe(base, proposed, reasons) };
}
