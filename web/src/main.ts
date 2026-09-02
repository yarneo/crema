/**
 * Crema's shell.
 *
 * Reads the live recipe from Decaid, renders the dial-in loop, and applies or
 * undoes a change against the gateway. Until there are real rated shots, the
 * trail and the shot chart run on a clearly-labelled sample so the screen can
 * be designed and reviewed; the "sample shot" pill is never hidden, and sample
 * data never writes to the machine.
 */

import './styles.css';

import { Gateway, resolveGatewayOrigin } from './gateway/client.ts';
import { diffToWorkflowPatch, undoPatch, workflowToRecipe } from './gateway/workflow.ts';
import type { WorkflowPatch, WorkflowWire } from './gateway/types.ts';
import { applyDiff, diffRecipe, type Recipe } from './domain/recipe.ts';
import { buildTrail } from './domain/trail.ts';
import { analyseFlowPhases } from './advice/phases.ts';
import { parseAdvice } from './advice/parse.ts';
import { adviceToDiff } from './advice/proposal.ts';
import { renderAdvice, renderBean, renderRecipe, renderShot, renderStatus, renderTrail } from './ui/views.ts';
import { SAMPLE_ADVICE_JSON, SAMPLE_BEAN, sampleShot, sampleTrailShots } from './mock/sample.ts';

const root = document.querySelector<HTMLElement>('#app')!;
const gateway = new Gateway({
  origin: resolveGatewayOrigin(window.location, import.meta.env['VITE_GATEWAY'] ?? null)
});

interface State {
  gatewayOnline: boolean;
  workflow: WorkflowWire | null;
  recipe: Recipe;
  /** Captured before an apply so Undo can put things back exactly. */
  lastApplied: { before: WorkflowWire; patch: WorkflowPatch } | null;
  busy: boolean;
  error: string | null;
}

const EMPTY_RECIPE: Recipe = {
  profileTitle: null,
  grind: null,
  doseG: null,
  targetYieldG: null,
  temperatureC: null
};

const state: State = {
  gatewayOnline: false,
  workflow: null,
  recipe: EMPTY_RECIPE,
  lastApplied: null,
  busy: false,
  error: null
};

// The sample shot and its advice go through the real parser and the real diff,
// so what is on screen is the production path, not a mock of it.
const shot = sampleShot();
const phases = analyseFlowPhases(shot);
const parsed = parseAdvice(SAMPLE_ADVICE_JSON, { shotDurationS: shot.elapsedS.at(-1) });
const trail = buildTrail(sampleTrailShots());

function render(): void {
  const advice = parsed.ok
    ? {
        diagnosis: parsed.advice.diagnosis,
        confidence: parsed.advice.confidence,
        diff: adviceToDiff(parsed.advice, state.recipe),
        canUndo: state.lastApplied !== null,
        busy: state.busy
      }
    : null;

  root.innerHTML = `
    <div class="app">
      ${renderStatus({
        gatewayOnline: state.gatewayOnline,
        machineState: null,
        groupTempC: state.recipe.temperatureC,
        waterMl: null,
        scaleG: null,
        demo: true
      })}
      ${renderBean(SAMPLE_BEAN)}
      ${renderRecipe(state.recipe)}
      ${state.error ? `<section class="card"><p class="empty">${state.error}</p></section>` : ''}
      <div class="columns">
        ${renderAdvice(advice)}
        ${renderShot({ ...shot, evidence: parsed.ok ? parsed.advice.evidence : [], phases })}
      </div>
      ${renderTrail(trail)}
    </div>`;
}

async function refresh(): Promise<void> {
  try {
    const workflow = await gateway.readWorkflow();
    state.workflow = workflow;
    state.recipe = workflowToRecipe(workflow);
    state.gatewayOnline = true;
    state.error = null;
  } catch (cause) {
    state.gatewayOnline = false;
    state.error = `${(cause as Error).message} Start Decaid, or set VITE_GATEWAY to its address.`;
  }
  render();
}

/** Nudge one recipe field and push it to the machine. */
async function bump(field: keyof Recipe, delta: number): Promise<void> {
  const current = state.recipe[field];
  if (typeof current !== 'number' || !state.workflow) return;

  const next = Number((current + delta).toFixed(2));
  const diff = diffRecipe(state.recipe, { [field]: next });
  if (diff.changes.length === 0) return;

  state.recipe = applyDiff(state.recipe, diff);
  render();

  await push(diffToWorkflowPatch(diff, state.workflow), state.workflow);
}

async function push(patch: WorkflowPatch, before: WorkflowWire): Promise<void> {
  if (Object.keys(patch).length === 0) return;

  state.busy = true;
  render();
  try {
    const updated = await gateway.updateWorkflow(patch);
    state.workflow = updated;
    state.recipe = workflowToRecipe(updated);
    state.lastApplied = { before, patch };
    state.error = null;
  } catch (cause) {
    state.error = (cause as Error).message;
  } finally {
    state.busy = false;
    render();
  }
}

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;

  const action = target.dataset['action'];
  const field = target.dataset['field'] as keyof Recipe | undefined;
  const step = Number(target.dataset['step'] ?? 0);

  if ((action === 'inc' || action === 'dec') && field) {
    void bump(field, action === 'inc' ? step : -step);
    return;
  }

  if (action === 'apply' && parsed.ok && state.workflow) {
    const diff = adviceToDiff(parsed.advice, state.recipe);
    void push(diffToWorkflowPatch(diff, state.workflow), state.workflow);
    return;
  }

  if (action === 'undo' && state.lastApplied) {
    const { before, patch } = state.lastApplied;
    state.lastApplied = null;
    void push(undoPatch(before, patch), before);
  }
});

render();
void refresh();
