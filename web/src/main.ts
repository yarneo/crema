/**
 * Crema's shell: state, routing, and the handful of actions that reach the
 * machine.
 *
 * Data is fetched per tab rather than all at once, because the profile list is
 * large (73 on a stock gateway) and the brew screen must be usable at once.
 *
 * The trail and the shot chart still run on a clearly-labelled sample until
 * there are real rated shots; the "sample shot" pill is never hidden, and
 * sample data never writes to the machine.
 */

import './styles.css';

import { Gateway, resolveGatewayOrigin } from './gateway/client.ts';
import { diffToWorkflowPatch, undoPatch, workflowToRecipe } from './gateway/workflow.ts';
import type { BeanWire, ProfileEntryWire, ShotPageWire, WorkflowPatch, WorkflowWire } from './gateway/types.ts';
import { applyDiff, diffRecipe, type Recipe } from './domain/recipe.ts';
import { buildTrail } from './domain/trail.ts';
import { analyseFlowPhases } from './advice/phases.ts';
import { parseAdvice } from './advice/parse.ts';
import { adviceToDiff } from './advice/proposal.ts';
import {
  renderAdvice,
  renderBean,
  renderBeans,
  renderNav,
  renderProfiles,
  renderRecipe,
  renderSetup,
  renderShot,
  renderShots,
  renderStatus,
  renderTrail,
  TABS,
  type BeanRow,
  type ProfileRow,
  type ShotRow,
  type Tab
} from './ui/views.ts';
import { isReady, loadSettings, saveSettings, type CremaSettings } from './settings.ts';
import { SAMPLE_ADVICE_JSON, SAMPLE_BEAN, sampleShot, sampleTrailShots } from './mock/sample.ts';

const root = document.querySelector<HTMLElement>('#app')!;
const gateway = new Gateway({
  origin: resolveGatewayOrigin(window.location, import.meta.env['VITE_GATEWAY'] ?? null)
});

const EMPTY_RECIPE: Recipe = {
  profileTitle: null,
  grind: null,
  doseG: null,
  targetYieldG: null,
  temperatureC: null
};

interface State {
  tab: Tab;
  gatewayOnline: boolean;
  machineState: string | null;
  groupTempC: number | null;
  workflow: WorkflowWire | null;
  recipe: Recipe;
  profiles: ProfileEntryWire[] | null;
  profileFilter: string;
  beans: BeanWire[] | null;
  shots: ShotPageWire | null;
  settings: CremaSettings;
  settingsSaved: boolean;
  storageBlocked: boolean;
  lastApplied: { before: WorkflowWire; patch: WorkflowPatch } | null;
  busy: boolean;
  error: string | null;
}

const state: State = {
  tab: 'brew',
  gatewayOnline: false,
  machineState: null,
  groupTempC: null,
  workflow: null,
  recipe: EMPTY_RECIPE,
  profiles: null,
  profileFilter: '',
  beans: null,
  shots: null,
  settings: loadSettings(),
  settingsSaved: false,
  storageBlocked: false,
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

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

function profileRows(): ProfileRow[] {
  const active = state.recipe.profileTitle;
  return (state.profiles ?? []).map((entry) => ({
    id: entry.id,
    title: entry.profile.title ?? '(untitled)',
    author: entry.profile.author ?? '',
    steps: entry.profile.steps?.length ?? 0,
    active: active !== null && entry.profile.title === active
  }));
}

function beanRows(): BeanRow[] {
  const activeName = state.workflow?.context?.coffeeName ?? null;
  return (state.beans ?? []).map((bean) => ({
    id: bean.id ?? '',
    roaster: bean.roaster,
    name: bean.name,
    origin: bean.country ?? '',
    active: activeName !== null && bean.name === activeName
  }));
}

function shotRows(): ShotRow[] {
  return (state.shots?.items ?? []).map((s) => {
    const dose = s.doseWeight ?? null;
    const out = s.finalWeight ?? null;
    const summary =
      dose !== null && out !== null
        ? `${dose.toFixed(1)}g → ${out.toFixed(1)}g${s.duration ? ` @ ${Math.round(s.duration)}s` : ''}`
        : 'shot';

    return {
      id: s.id,
      when: s.timestamp ? new Date(s.timestamp).toLocaleString() : 'unknown time',
      profileTitle: s.profileTitle ?? '—',
      coffeeName: s.coffeeName ?? '',
      summary
    };
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderBrew(): string {
  const advice = parsed.ok
    ? {
        diagnosis: parsed.advice.diagnosis,
        confidence: parsed.advice.confidence,
        diff: adviceToDiff(parsed.advice, state.recipe),
        canUndo: state.lastApplied !== null,
        busy: state.busy
      }
    : null;

  return `
    ${renderBean(SAMPLE_BEAN)}
    ${renderRecipe(state.recipe)}
    <div class="columns">
      ${renderAdvice(advice)}
      ${renderShot({ ...shot, evidence: parsed.ok ? parsed.advice.evidence : [], phases })}
    </div>
    ${renderTrail(trail)}`;
}

const loading = (what: string) => `<section class="card"><p class="empty">Loading ${what}…</p></section>`;

function renderBody(): string {
  switch (state.tab) {
    case 'brew':
      return renderBrew();
    case 'profiles':
      return state.profiles === null ? loading('profiles') : renderProfiles(profileRows(), state.profileFilter, state.busy);
    case 'beans':
      return state.beans === null ? loading('beans') : renderBeans(beanRows(), state.busy);
    case 'shots':
      return state.shots === null ? loading('shots') : renderShots(shotRows(), state.shots.total);
    case 'setup':
      return renderSetup({
        ...state.settings,
        ready: isReady(state.settings),
        saved: state.settingsSaved,
        storageBlocked: state.storageBlocked
      });
  }
}

function render(): void {
  root.innerHTML = `
    <div class="app">
      ${renderStatus({
        gatewayOnline: state.gatewayOnline,
        machineState: state.machineState,
        groupTempC: state.groupTempC,
        waterMl: null,
        scaleG: null,
        demo: state.tab === 'brew'
      })}
      ${renderNav(state.tab, !isReady(state.settings))}
      ${state.error ? `<section class="card"><p class="empty">${state.error}</p></section>` : ''}
      ${renderBody()}
    </div>`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function refreshWorkflow(): Promise<void> {
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

  // A missing machine is normal, not a fault: the loop still works against
  // stored shots, so this failure only clears the readout.
  try {
    const machine = await gateway.readMachineState();
    state.machineState = machine.state?.state ?? null;
    state.groupTempC = machine.groupTemperature ?? null;
  } catch {
    state.machineState = null;
    state.groupTempC = null;
  }

  render();
}

/** Fetch whatever a newly-shown tab needs, once. */
async function loadTab(tab: Tab): Promise<void> {
  try {
    if (tab === 'profiles' && state.profiles === null) state.profiles = await gateway.readProfiles();
    if (tab === 'beans' && state.beans === null) state.beans = await gateway.readBeans();
    if (tab === 'shots' && state.shots === null) state.shots = await gateway.readShots();
    state.error = null;
  } catch (cause) {
    // Leave the slot null so switching away and back retries, rather than
    // showing an empty list as though the library really were empty.
    state.error = (cause as Error).message;
  }
  render();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function push(patch: WorkflowPatch, before: WorkflowWire, remember = true): Promise<void> {
  if (Object.keys(patch).length === 0) return;

  state.busy = true;
  render();
  try {
    const updated = await gateway.updateWorkflow(patch);
    state.workflow = updated;
    state.recipe = workflowToRecipe(updated);
    state.lastApplied = remember ? { before, patch } : null;
    state.error = null;
  } catch (cause) {
    state.error = (cause as Error).message;
  } finally {
    state.busy = false;
    render();
  }
}

/** Nudge one recipe field and push it to the machine. */
async function bump(field: keyof Recipe, delta: number): Promise<void> {
  const current = state.recipe[field];
  if (typeof current !== 'number' || !state.workflow) return;

  const diff = diffRecipe(state.recipe, { [field]: Number((current + delta).toFixed(2)) });
  if (diff.changes.length === 0) return;

  const before = state.workflow;
  state.recipe = applyDiff(state.recipe, diff);
  render();
  await push(diffToWorkflowPatch(diff, before), before);
}

async function useProfile(id: string): Promise<void> {
  const entry = (state.profiles ?? []).find((p) => p.id === id);
  if (!entry || !state.workflow) return;

  const before = state.workflow;
  state.busy = true;
  render();
  try {
    const updated = await gateway.selectProfile(entry.profile);
    state.workflow = updated;
    state.recipe = workflowToRecipe(updated);
    state.lastApplied = { before, patch: { profile: entry.profile } };
    state.error = null;
    state.tab = 'brew';
  } catch (cause) {
    state.error = (cause as Error).message;
  } finally {
    state.busy = false;
    render();
  }
}

async function useBean(id: string): Promise<void> {
  const bean = (state.beans ?? []).find((b) => b.id === id);
  if (!bean || !state.workflow) return;

  await push({ context: { coffeeName: bean.name, coffeeRoaster: bean.roaster } }, state.workflow);
  state.tab = 'brew';
  render();
}

async function addBean(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const roaster = String(data.get('roaster') ?? '').trim();
  const name = String(data.get('name') ?? '').trim();
  const country = String(data.get('country') ?? '').trim();
  if (roaster === '' || name === '') return;

  state.busy = true;
  render();
  try {
    await gateway.createBean({ roaster, name, ...(country ? { country } : {}) });
    state.beans = await gateway.readBeans();
    state.error = null;
  } catch (cause) {
    state.error = (cause as Error).message;
  } finally {
    state.busy = false;
    render();
  }
}

function saveSetup(form: HTMLFormElement): void {
  const data = new FormData(form);
  const str = (k: string) => String(data.get(k) ?? '').trim();

  state.settings = {
    ...state.settings,
    provider: (str('provider') || 'anthropic') as CremaSettings['provider'],
    apiKey: str('apiKey'),
    model: str('model'),
    baseUrl: str('baseUrl'),
    grinderName: str('grinderName'),
    grinderRange: str('grinderRange')
  };

  const ok = saveSettings(state.settings);
  state.storageBlocked = !ok;
  state.settingsSaved = ok;
  render();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target || target.tagName === 'FORM' || target.tagName === 'INPUT' || target.tagName === 'SELECT') return;

  const action = target.dataset['action'];

  if (action === 'tab') {
    const tab = target.dataset['tab'] as Tab;
    if (!TABS.includes(tab)) return;
    state.tab = tab;
    state.settingsSaved = false;
    render();
    void loadTab(tab);
    return;
  }

  const field = target.dataset['field'] as keyof Recipe | undefined;
  if ((action === 'inc' || action === 'dec') && field) {
    const step = Number(target.dataset['step'] ?? 0);
    void bump(field, action === 'inc' ? step : -step);
    return;
  }

  if (action === 'use-profile') {
    void useProfile(target.dataset['id'] ?? '');
    return;
  }

  if (action === 'use-bean') {
    void useBean(target.dataset['id'] ?? '');
    return;
  }

  if (action === 'apply' && parsed.ok && state.workflow) {
    const before = state.workflow;
    void push(diffToWorkflowPatch(adviceToDiff(parsed.advice, state.recipe), before), before);
    return;
  }

  if (action === 'undo' && state.lastApplied) {
    const { before, patch } = state.lastApplied;
    state.lastApplied = null;
    void push(undoPatch(before, patch), before, false);
  }
});

root.addEventListener('submit', (event) => {
  const form = (event.target as HTMLElement).closest<HTMLFormElement>('form[data-action]');
  if (!form) return;
  event.preventDefault();

  if (form.dataset['action'] === 'add-bean') void addBean(form);
  if (form.dataset['action'] === 'save-setup') saveSetup(form);
});

root.addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.dataset['action'] !== 'filter-profiles') return;

  // The whole body is replaced on render, so focus and caret have to be put
  // back or typing in the search box would drop after one character.
  state.profileFilter = input.value;
  render();
  const next = root.querySelector<HTMLInputElement>('[data-action="filter-profiles"]');
  next?.focus();
  next?.setSelectionRange(next.value.length, next.value.length);
});

root.addEventListener('change', (event) => {
  const select = event.target as HTMLSelectElement;
  if (select.dataset['action'] !== 'change-provider') return;

  // Switching provider changes which fields matter, so re-render the form.
  state.settings = { ...state.settings, provider: select.value as CremaSettings['provider'] };
  state.settingsSaved = false;
  render();
});

render();
void refreshWorkflow();
