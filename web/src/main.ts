/**
 * Crema's shell: state, routing, the live shot, and the dial-in loop.
 *
 * The loop, end to end: the WebSocket sees the machine start brewing and
 * accumulates the curves; when it stops, the questionnaire opens; the answers
 * plus the curves plus what we already tried go to whichever model the user
 * configured; the reply is parsed into a reviewable diff; applying it writes
 * to the machine and is undoable.
 *
 * Per-tab fetching, because the profile list is 73 entries on a stock gateway
 * and the brew screen has to be usable immediately.
 *
 * Until there is a real rated shot, the trail and chart run on a
 * clearly-labelled sample. The "sample shot" pill is never hidden, and sample
 * data never writes to the machine.
 */

import './styles.css';

import { Gateway, resolveGatewayOrigin } from './gateway/client.ts';
import { diffToWorkflowPatch, undoPatch, workflowToRecipe } from './gateway/workflow.ts';
import type { BeanBatchWire, BeanWire, ProfileEntryWire, WorkflowPatch, WorkflowWire } from './gateway/types.ts';
import { applyDiff, diffRecipe, type Recipe } from './domain/recipe.ts';
import { buildTrail, type TrailNode, type TrailShot } from './domain/trail.ts';
import { EMPTY_RATING, type Rating, type RatingKey } from './domain/rating.ts';
import { analyseFlowPhases } from './advice/phases.ts';
import { parseAdvice } from './advice/parse.ts';
import { adviceToDiff } from './advice/proposal.ts';
import { buildPrompt, daysOffRoast } from './advice/prompt.ts';
import { askProvider } from './advice/provider.ts';
import type { Advice } from './advice/schema.ts';
import type { ShotCurves } from './advice/curves.ts';
import { LiveMonitor, toCurves, type LiveShot } from './live.ts';
import { hasCurves, needsRating, newShotRecord, Store, type ShotRecord } from './store.ts';
import {
  renderAdvice,
  renderBean,
  renderBeansScreen,
  renderLive,
  renderNav,
  renderProfiles,
  renderRating,
  renderRecipe,
  renderSetup,
  renderShot,
  renderShots,
  renderStatus,
  renderTrail,
  TABS,
  type BeanRow,
  type BatchRow,
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
const store = new Store(gateway);

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
  scaleG: number | null;
  workflow: WorkflowWire | null;
  recipe: Recipe;

  /** The shot in progress, if any. */
  live: LiveShot | null;
  /** The finished shot awaiting a rating, plus its curves. */
  pending: { record: ShotRecord; curves: ShotCurves } | null;
  rating: Rating;
  asking: boolean;
  adviceError: string | null;
  /** Real advice for the pending shot, once the model has answered. */
  advice: Advice | null;

  records: ShotRecord[];
  profiles: ProfileEntryWire[] | null;
  profileFilter: string;
  beans: BeanWire[] | null;
  /** Batches of the selected bean, loaded lazily. */
  batches: BeanBatchWire[] | null;
  activeBeanId: string | null;
  rebuttalOpen: boolean;
  rebuttalText: string;
  reconsidering: boolean;
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
  scaleG: null,
  workflow: null,
  recipe: EMPTY_RECIPE,
  live: null,
  pending: null,
  rating: { ...EMPTY_RATING },
  asking: false,
  adviceError: null,
  advice: null,
  records: [],
  profiles: null,
  profileFilter: '',
  beans: null,
  batches: null,
  activeBeanId: null,
  rebuttalOpen: false,
  rebuttalText: '',
  reconsidering: false,
  settings: loadSettings(),
  settingsSaved: false,
  storageBlocked: false,
  lastApplied: null,
  busy: false,
  error: null
};

// Sample fallbacks, used only until there is real history. Both go through the
// real parser and the real diff, so the rendered path is the production one.
const sample = sampleShot();
const sampleParsed = parseAdvice(SAMPLE_ADVICE_JSON, { shotDurationS: sample.elapsedS.at(-1) });
const sampleTrail = buildTrail(sampleTrailShots());

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

// The pill must agree with what is actually on screen, so this asks the same
// question shotChart() does: is there any real shot to draw?
const usingSample = () =>
  state.pending === null && !state.records.some((r) => hasCurves(r));

function trailNodes(): TrailNode[] {
  if (usingSample()) return sampleTrail;

  // The pending shot is usually already in `records` (it is saved unrated the
  // moment it finishes), so it has to be excluded before being re-added with
  // the live rating, or the trail counts the same cup twice.
  const pendingId = state.pending?.record.id ?? null;

  const shots: TrailShot[] = state.records
    .filter((r) => r.id !== pendingId)
    .map((r) => ({ id: r.id, at: r.at, score: r.rating.score, recipe: r.recipe }));

  if (state.pending) {
    shots.push({
      id: state.pending.record.id,
      at: state.pending.record.at,
      score: state.rating.score,
      recipe: state.pending.record.recipe
    });
  }

  return buildTrail(shots);
}

/**
 * What the "Last shot" card draws.
 *
 * The shot awaiting a rating wins, then the most recent stored shot that has
 * curves, and only then the sample. Falling straight through to the sample
 * whenever nothing was pending meant a real shot you had already rated was
 * replaced on screen by fabricated data, which is exactly the confusion the
 * sample pill exists to prevent.
 */
function shotChart(): { curves: ShotCurves; evidence: Advice['evidence'] } {
  if (state.pending) {
    return { curves: state.pending.curves, evidence: state.advice?.evidence ?? [] };
  }

  const latest = state.records.find((r) => hasCurves(r));
  if (latest?.curves) return { curves: latest.curves, evidence: [] };

  return { curves: sample, evidence: sampleParsed.ok ? sampleParsed.advice.evidence : [] };
}

function currentBean(): { name: string | null; roaster: string | null } {
  return {
    name: state.workflow?.context?.coffeeName ?? null,
    roaster: state.workflow?.context?.coffeeRoaster ?? null
  };
}

/**
 * The bag currently in use, resolved from the workflow's beanBatchId. Roast
 * date lives on the batch, and it is what makes days-off-roast real rather
 * than sampled.
 */
function activeBatch(): BeanBatchWire | null {
  const id = state.workflow?.context?.beanBatchId ?? null;
  if (id === null) return null;
  return (state.batches ?? []).find((b) => b.id === id) ?? null;
}

function batchRows(): BatchRow[] {
  const activeId = state.workflow?.context?.beanBatchId ?? null;
  return (state.batches ?? []).map((batch) => ({
    id: batch.id ?? '',
    roastDate: batch.roastDate ?? null,
    roastLevel: batch.roastLevel ?? null,
    daysOffRoast: daysOffRoast(batch.roastDate ?? null),
    weightRemaining: batch.weightRemaining ?? null,
    active: activeId !== null && batch.id === activeId
  }));
}

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
  const activeName = currentBean().name;
  return (state.beans ?? []).map((bean) => ({
    id: bean.id ?? '',
    roaster: bean.roaster,
    name: bean.name,
    origin: bean.country ?? '',
    active: activeName !== null && bean.name === activeName
  }));
}

function shotRows(): ShotRow[] {
  return state.records.map((r) => {
    const out = r.finalYieldG;
    const dose = r.recipe.doseG;
    const summary =
      dose !== null && out !== null ? `${dose.toFixed(1)}g → ${out.toFixed(1)}g` : 'shot';
    const score = r.rating.score === null ? 'unrated' : `${r.rating.score}/5`;

    return {
      id: r.id,
      when: new Date(r.at).toLocaleString(),
      profileTitle: r.recipe.profileTitle ?? '—',
      coffeeName: r.bean.name ?? '',
      summary: `${summary} · ${score}`
    };
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderBrew(): string {
  const chart = shotChart();
  const phases = analyseFlowPhases({
    elapsedS: chart.curves.elapsedS,
    pressureBar: chart.curves.pressureBar,
    flowMlS: chart.curves.flowMlS,
    weightFlow: chart.curves.weightFlow ?? null
  });

  // Real advice once we have it, the sample only as a placeholder.
  const source = state.advice ?? (usingSample() && sampleParsed.ok ? sampleParsed.advice : null);
  const advice = source
    ? {
        diagnosis: source.diagnosis,
        confidence: source.confidence,
        diff: adviceToDiff(source, state.recipe),
        canUndo: state.lastApplied !== null,
        busy: state.busy,
        rebuttalOpen: state.rebuttalOpen,
        rebuttalText: state.rebuttalText,
        reconsidering: state.reconsidering,
        // Only a real shot can be reconsidered: there is nothing to re-examine
        // behind the sample.
        canReconsider: state.pending !== null && state.advice !== null
      }
    : null;

  const bean = currentBean();
  const pendingSummary = state.pending
    ? `${state.pending.record.recipe.doseG ?? '?'}g → ${state.pending.record.finalYieldG?.toFixed(1) ?? '?'}g`
    : null;

  return `
    ${renderBean({
      name: bean.name ?? SAMPLE_BEAN.name,
      roastDate: activeBatch()?.roastDate ?? (usingSample() ? SAMPLE_BEAN.roastDate : null)
    })}
    ${renderRecipe(state.recipe)}
    ${state.live ? renderLive({
      pressureBar: state.live.samples.at(-1)?.pressureBar ?? 0,
      flowMlS: state.live.samples.at(-1)?.flowMlS ?? 0,
      elapsedS: state.live.samples.at(-1)?.elapsedS ?? 0
    }) : ''}
    ${state.pending || state.advice ? renderRating({
      rating: state.rating,
      shotSummary: pendingSummary,
      asking: state.asking,
      error: state.adviceError,
      ready: isReady(state.settings)
    }) : ''}
    <div class="columns">
      ${renderAdvice(advice)}
      ${renderShot({ ...chart.curves, evidence: chart.evidence, phases })}
    </div>
    ${renderTrail(trailNodes())}`;
}

const loading = (what: string) => `<section class="card"><p class="empty">Loading ${what}…</p></section>`;

function renderBody(): string {
  switch (state.tab) {
    case 'brew':
      return renderBrew();
    case 'profiles':
      return state.profiles === null ? loading('profiles') : renderProfiles(profileRows(), state.profileFilter, state.busy);
    case 'beans':
      return state.beans === null
        ? loading('beans')
        : renderBeansScreen({
            rows: beanRows(),
            busy: state.busy,
            activeBeanId: state.activeBeanId,
            activeBeanName: (state.beans ?? []).find((b) => b.id === state.activeBeanId)?.name ?? null,
            batches: state.activeBeanId === null ? null : batchRows()
          });
    case 'shots':
      return renderShots(shotRows(), state.records.length);
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
        scaleG: state.scaleG,
        demo: state.tab === 'brew' && usingSample()
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
  render();
}

async function loadTab(tab: Tab): Promise<void> {
  try {
    if (tab === 'profiles' && state.profiles === null) state.profiles = await gateway.readProfiles();
    if (tab === 'beans' && state.beans === null) state.beans = await gateway.readBeans();
    state.error = null;
  } catch (cause) {
    // Leave the slot null so returning to the tab retries, rather than showing
    // an empty list as though the library really were empty.
    state.error = (cause as Error).message;
  }
  render();
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

const live = new LiveMonitor(gateway.wsOrigin, {
  onSnapshot(snapshot) {
    const next = snapshot.state?.state ?? null;
    const temp = snapshot.groupTemperature ?? null;
    if (next === state.machineState && temp === state.groupTempC) return;
    state.machineState = next;
    state.groupTempC = temp;
    if (state.tab === 'brew') render();
  },

  onShotStart() {
    // A new shot supersedes whatever was awaiting a rating: keep the screen
    // about the cup in front of you.
    state.pending = null;
    state.advice = null;
    state.adviceError = null;
    state.rating = { ...EMPTY_RATING };
    render();
  },

  onShotSample(shot) {
    state.live = shot;
    if (state.tab === 'brew') render();
  },

  async onShotEnd(shot) {
    state.live = null;
    const curves = toCurves(shot);
    const record = newShotRecord(
      `local-${shot.startedAt}`,
      state.recipe,
      currentBean(),
      state.recipe.targetYieldG,
      { ...curves }
    );

    state.pending = { record, curves };
    state.rating = { ...EMPTY_RATING };
    state.tab = 'brew';
    render();

    // Save unrated so the shot is never lost if the tablet sleeps mid-rating.
    await store.saveShot(record);
  },

  onConnectionChange(connected) {
    if (!connected) {
      state.machineState = null;
      state.groupTempC = null;
      if (state.tab === 'brew') render();
    }
  }
});

/**
 * The request, in one place, so a reconsider is the same request plus the
 * pushback — not a second, subtly different one.
 */
function adviceRequest(record: ShotRecord, curves: ShotCurves, rebuttal?: string) {
  const batch = activeBatch();

  return {
    bean: {
      name: record.bean.name,
      roaster: record.bean.roaster,
      roastDate: batch?.roastDate ?? null,
      roastLevel: batch?.roastLevel ?? null
    },
    grinder: { name: state.settings.grinderName, range: state.settings.grinderRange },
    recipe: record.recipe,
    curves,
    rating: state.rating,
    finalYieldG: record.finalYieldG,
    trail: trailNodes(),
    ...(rebuttal
      ? {
          rebuttal,
          priorSummary: record.advice?.summary ?? '',
          priorDiagnosis: record.advice?.diagnosis ?? ''
        }
      : {})
  };
}

async function getAdvice(): Promise<void> {
  if (!state.pending || state.asking) return;

  state.asking = true;
  state.adviceError = null;
  render();

  const { record, curves } = state.pending;
  record.rating = { ...state.rating };

  const prompt = buildPrompt(adviceRequest(record, curves));

  try {
    const reply = await askProvider(state.settings, prompt);
    const parsed = parseAdvice(reply, { shotDurationS: curves.elapsedS.at(-1) });

    if (!parsed.ok) {
      state.adviceError = parsed.error;
    } else {
      state.advice = parsed.advice;
      record.advice = { summary: parsed.advice.screenSummary, diagnosis: parsed.advice.diagnosis };
    }
  } catch (cause) {
    state.adviceError = (cause as Error).message;
  } finally {
    state.asking = false;
    await store.saveShot(record);
    state.records = await store.readRecent();
    render();
  }
}

/**
 * Push back on the advice.
 *
 * The prompt is told to take the objection seriously, and explicitly told not
 * to cave just because it was challenged — a coach that folds on contact is
 * as useless as one that never listens.
 */
async function reconsider(text: string): Promise<void> {
  const rebuttal = text.trim();
  if (!state.pending || rebuttal === '' || state.reconsidering) return;

  state.reconsidering = true;
  state.adviceError = null;
  render();

  const { record, curves } = state.pending;

  try {
    const reply = await askProvider(state.settings, buildPrompt(adviceRequest(record, curves, rebuttal)));
    const parsed = parseAdvice(reply, { shotDurationS: curves.elapsedS.at(-1) });

    if (!parsed.ok) {
      state.adviceError = parsed.error;
    } else {
      state.advice = parsed.advice;
      record.advice = { summary: parsed.advice.screenSummary, diagnosis: parsed.advice.diagnosis };
      state.rebuttalOpen = false;
      state.rebuttalText = '';
    }
  } catch (cause) {
    state.adviceError = (cause as Error).message;
  } finally {
    state.reconsidering = false;
    await store.saveShot(record);
    render();
  }
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

  state.activeBeanId = id;
  state.batches = null;
  render();

  // Load the bags first, so selecting a bean can also select its freshest one
  // in the same step rather than leaving roast date blank.
  let newest: BeanBatchWire | null = null;
  try {
    const batches = await gateway.readBatches(id);
    state.batches = batches;
    newest =
      [...batches]
        .filter((b) => !b.archived)
        .sort((a, b) => Date.parse(b.roastDate ?? '') - Date.parse(a.roastDate ?? ''))[0] ?? null;
  } catch (cause) {
    state.error = (cause as Error).message;
  }

  await push(
    {
      context: {
        coffeeName: bean.name,
        coffeeRoaster: bean.roaster,
        ...(newest?.id ? { beanBatchId: newest.id } : {})
      }
    },
    state.workflow
  );
  render();
}

async function useBatch(id: string): Promise<void> {
  if (!state.workflow) return;
  await push({ context: { beanBatchId: id } }, state.workflow);
  render();
}

async function addBatch(form: HTMLFormElement): Promise<void> {
  if (state.activeBeanId === null) return;

  const data = new FormData(form);
  const roastDate = String(data.get('roastDate') ?? '').trim();
  const roastLevel = String(data.get('roastLevel') ?? '').trim();
  const weight = Number(String(data.get('weight') ?? '').trim());
  if (roastDate === '') return;

  state.busy = true;
  render();
  try {
    await gateway.createBatch(state.activeBeanId, {
      roastDate: new Date(`${roastDate}T12:00:00`).toISOString(),
      ...(roastLevel ? { roastLevel } : {}),
      ...(Number.isFinite(weight) && weight > 0 ? { weight } : {})
    });
    state.batches = await gateway.readBatches(state.activeBeanId);
    state.error = null;
  } catch (cause) {
    state.error = (cause as Error).message;
  } finally {
    state.busy = false;
    render();
  }
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

function rate(key: string, value: string): void {
  if (key === 'score') {
    const score = Number(value);
    state.rating = { ...state.rating, score: state.rating.score === score ? null : score };
  } else {
    const k = key as RatingKey;
    state.rating = { ...state.rating, [k]: state.rating[k] === value ? null : value };
  }
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

  if (action === 'rate') {
    rate(target.dataset['key'] ?? '', target.dataset['value'] ?? '');
    return;
  }

  if (action === 'get-advice') {
    void getAdvice();
    return;
  }

  const field = target.dataset['field'] as keyof Recipe | undefined;
  if ((action === 'inc' || action === 'dec') && field) {
    void bump(field, action === 'inc' ? Number(target.dataset['step'] ?? 0) : -Number(target.dataset['step'] ?? 0));
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

  if (action === 'use-batch') {
    void useBatch(target.dataset['id'] ?? '');
    return;
  }

  if (action === 'toggle-rebuttal') {
    state.rebuttalOpen = !state.rebuttalOpen;
    render();
    if (state.rebuttalOpen) root.querySelector<HTMLTextAreaElement>('.rebuttal textarea')?.focus();
    return;
  }

  if (action === 'apply' && state.workflow) {
    const source = state.advice ?? (usingSample() && sampleParsed.ok ? sampleParsed.advice : null);
    if (!source) return;
    const before = state.workflow;
    const diff = adviceToDiff(source, state.recipe);
    if (state.pending) state.pending.record.applied = diff.changes.map((c) => c.field);
    void push(diffToWorkflowPatch(diff, before), before);
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
  if (form.dataset['action'] === 'add-batch') void addBatch(form);
  if (form.dataset['action'] === 'save-setup') saveSetup(form);
  if (form.dataset['action'] === 'reconsider') {
    const text = new FormData(form).get('rebuttal');
    void reconsider(String(text ?? ''));
  }
});

root.addEventListener('input', (event) => {
  const area = event.target as HTMLTextAreaElement;
  if (area.name === 'rebuttal') {
    // Held in state so an unrelated re-render (a snapshot arriving, say) does
    // not wipe what is being typed.
    state.rebuttalText = area.value;
    return;
  }

  const input = event.target as HTMLInputElement;
  if (input.dataset['action'] !== 'filter-profiles') return;

  // The body is replaced on render, so focus and caret must be restored or
  // typing would drop after one character.
  state.profileFilter = input.value;
  render();
  const next = root.querySelector<HTMLInputElement>('[data-action="filter-profiles"]');
  next?.focus();
  next?.setSelectionRange(next.value.length, next.value.length);
});

root.addEventListener('change', (event) => {
  const select = event.target as HTMLSelectElement;
  if (select.dataset['action'] !== 'change-provider') return;

  state.settings = { ...state.settings, provider: select.value as CremaSettings['provider'] };
  state.settingsSaved = false;
  render();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

render();
void refreshWorkflow();
void store.readRecent().then((records) => {
  state.records = records;

  // Reopen an unrated shot so a reload or a slept tablet does not silently
  // lose the cup you were about to rate.
  const latest = records[0];
  if (latest && needsRating(latest)) {
    state.pending = { record: latest, curves: latest.curves! };
    state.rating = { ...latest.rating };
  }

  render();
});
live.start();
