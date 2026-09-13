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
import type { BeanBatchWire, BeanWire, DeviceInfoWire, ProfileEntryWire, WorkflowPatch, WorkflowWire } from './gateway/types.ts';
import { describeFailedConnect } from './gateway/devices.ts';
import { applyDiff, describeApplied, diffRecipe, type Recipe } from './domain/recipe.ts';
import type { Profile } from './domain/profile.ts';
import { addStep, duplicateProfile, editStep, moveStep, newProfile, profileProblem, removeStep } from './domain/profile-edit.ts';
import { formatGrind, isSaneGrind, snapGrind, startingGrind } from './domain/grind.ts';
import { last } from './domain/last.ts';
import { applyCompatFlags } from './compat.ts';
import { buildTrail, type TrailNode, type TrailShot } from './domain/trail.ts';
import { describeRating, EMPTY_RATING, type Rating, type RatingKey } from './domain/rating.ts';
import { analyseFlowPhases } from './advice/phases.ts';
import { parseAdvice } from './advice/parse.ts';
import { adviceToDiff } from './advice/proposal.ts';
import { buildPrompt, buildStarterPrompt, daysOffRoast } from './advice/prompt.ts';
import { askProvider, resolveBaseUrl } from './advice/provider.ts';
import { discoverServer } from './advice/discover.ts';
import type { Advice } from './advice/schema.ts';
import type { ShotCurves } from './advice/curves.ts';
import { LiveMonitor, toCurves, type LiveShot } from './live.ts';
import { hasCurves, needsRating, newShotRecord, Store, type ShotRecord } from './store.ts';
import type { CommandableState } from './gateway/types.ts';
import {
  renderAdvice,
  renderAdviceStrip,
  renderBean,
  renderBeansScreen,
  BAG_SIZE_START_G,
  renderLive,
  renderNav,
  renderProfiles,
  renderProfileEditor,
  renderRating,
  renderRecipe,
  renderSetup,
  renderShot,
  renderGraphOverlay,
  renderShots,
  renderActionBar,
  renderWater,
  renderStatus,
  renderGhcStop,
  isRunningMachineState,
  REBUTTAL_OPTIONS,
  TABS,
  type BeanRow,
  type BatchRow,
  type ProfileRow,
  type ShotRow,
  type ShotDetailModel,
  type ShotChartModel,
  type Tab
} from './ui/views.ts';
import { isReady, loadKnownGhc, loadSettings, saveKnownGhc, saveSettings, type CremaSettings, type Theme } from './settings.ts';
import { watchSafeArea } from './safearea.ts';
import { captureForms, captureScroll, restoreForms, restoreScroll } from './formstate.ts';
import { attachScrub } from './ui/scrub.ts';

const root = document.querySelector<HTMLElement>('#app')!;
const gateway = new Gateway({
  origin: resolveGatewayOrigin(window.location, import.meta.env['VITE_GATEWAY'] ?? null)
});
const store = new Store(gateway);

let chimeContext: AudioContext | null = null;

function prepareChime(): void {
  try {
    chimeContext ??= new AudioContext();
    if (chimeContext.state === 'suspended') void chimeContext.resume();
  } catch {
    // Audio is a courtesy; an older tablet must never lose the rating screen.
  }
}

function playShotChime(): void {
  try {
    prepareChime();
    if (!chimeContext) return;
    const now = chimeContext.currentTime;
    for (const [offset, frequency] of [[0, 660], [0.13, 880]] as const) {
      const oscillator = chimeContext.createOscillator();
      const gain = chimeContext.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.08, now + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.11);
      oscillator.connect(gain).connect(chimeContext.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.12);
    }
  } catch {
    // Some embedded browsers have no usable audio output; keep shot capture.
  }
}

const EMPTY_RECIPE: Recipe = {
  profileTitle: null,
  grind: null,
  doseG: null,
  targetYieldG: null,
  temperatureC: null
};

interface AdviceBase {
  recipe: Recipe;
  starting: boolean;
}

interface State {
  tab: Tab;
  gatewayOnline: boolean;
  machineConnected: boolean;
  /**
   * Null until the gateway has been asked. Never reset by a disconnect: a
   * machine that has a group-head controller still has one while it is
   * offline, and clearing it on every device event made the brew rail flash
   * in and out during a connect.
   */
  machineHasGhc: boolean | null;
  scaleConnected: boolean;
  devices: DeviceInfoWire[];
  deviceBusy: boolean;
  machineState: string | null;
  groupTempC: number | null;
  waterLevelMm: number | null;
  scaleG: number | null;
  workflow: WorkflowWire | null;
  recipe: Recipe;

  /** The shot in progress, if any. */
  live: LiveShot | null;
  /** The finished shot awaiting a rating, plus its curves. */
  pending: { record: ShotRecord; curves: ShotCurves } | null;
  rating: Rating;
  asking: boolean;
  /** When the current advice request started, for the waiting readout. */
  askingSince: number | null;
  adviceError: string | null;
  /** Real advice for the pending shot, once the model has answered. */
  advice: Advice | null;

  records: ShotRecord[];
  profiles: ProfileEntryWire[] | null;
  profileFilter: string;
  /** The profile being written by hand, when one is. */
  editingProfile: { profile: Profile; fresh: boolean } | null;
  beans: BeanWire[] | null;
  /** Batches of the selected bean, loaded lazily. */
  batches: BeanBatchWire[] | null;
  activeBeanId: string | null;
  /** The bean whose details panel is open, when one is. */
  editingBeanId: string | null;
  /** Chip choices on the add-bag form; in state so a re-render cannot drop them. */
  newBatch: { roastLevel: string | null; weightG: number | null };
  deleteArmedBeanId: string | null;
  selectedShotId: string | null;
  rebuttalOpen: boolean;
  rebuttalText: string;
  reconsidering: boolean;
  reviewingShotId: string | null;
  storedRebuttalOpen: boolean;
  storedRebuttalText: string;
  storedRebuttalReasons: string[];
  deleteArmedShotId: string | null;
  comparisonOffset: number;
  historyTrailOffset: number;
  chartExpanded: boolean;
  shotActionError: string | null;
  settings: CremaSettings;
  settingsSaved: boolean;
  setupKeyVisible: boolean;
  setupTesting: boolean;
  setupTestStatus: string | null;
  starter: { beanId: string; bean: ShotRecord['bean'] } | null;
  starting: boolean;
  starterError: string | null;
  storageBlocked: boolean;
  lastApplied: { before: WorkflowWire; patch: WorkflowPatch } | null;
  /** A human summary of the last Apply, shown on the brew screen. */
  appliedNote: string | null;
  /** Kept so the brew strip can reopen the advice it is summarising. */
  lastAdvice: { advice: Advice; base: AdviceBase } | null;
  /**
   * The ground the advice card reads against: the recipe that was on the
   * machine when the advice was given, and whether it was a first-shot
   * starting point. Both have to be remembered rather than re-derived —
   * after Apply the live recipe *is* the advice, so diffing against it shows
   * an empty card with everything "held", and `state.starter` has been
   * cleared by then, so the card would call a starting point a correction.
   */
  adviceBase: AdviceBase | null;
  busy: boolean;
  error: string | null;
}

const state: State = {
  tab: 'brew',
  gatewayOnline: false,
  machineConnected: false,
  machineHasGhc: loadKnownGhc(),
  scaleConnected: false,
  devices: [],
  deviceBusy: false,
  machineState: null,
  groupTempC: null,
  waterLevelMm: null,
  scaleG: null,
  workflow: null,
  recipe: EMPTY_RECIPE,
  live: null,
  pending: null,
  rating: { ...EMPTY_RATING },
  asking: false,
  askingSince: null,
  adviceError: null,
  advice: null,
  records: [],
  profiles: null,
  profileFilter: '',
  editingProfile: null,
  beans: null,
  batches: null,
  activeBeanId: null,
  editingBeanId: null,
  newBatch: { roastLevel: null, weightG: null },
  deleteArmedBeanId: null,
  selectedShotId: null,
  rebuttalOpen: false,
  rebuttalText: '',
  reconsidering: false,
  reviewingShotId: null,
  storedRebuttalOpen: false,
  storedRebuttalText: '',
  storedRebuttalReasons: [],
  deleteArmedShotId: null,
  comparisonOffset: 0,
  historyTrailOffset: 0,
  chartExpanded: false,
  shotActionError: null,
  settings: loadSettings(),
  settingsSaved: false,
  setupKeyVisible: false,
  setupTesting: false,
  setupTestStatus: null,
  starter: null,
  starting: false,
  starterError: null,
  storageBlocked: false,
  lastApplied: null,
  appliedNote: null,
  lastAdvice: null,
  adviceBase: null,
  busy: false,
  error: null
};

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

function bagIdentity(record: ShotRecord): string | null {
  return record.bean.batchId ?? record.bean.roastDate ?? null;
}

function sameDialIn(a: ShotRecord, b: ShotRecord): boolean {
  if (a.bean.beanId && b.bean.beanId && a.bean.beanId !== b.bean.beanId) return false;
  if (a.bean.name !== b.bean.name) return false;
  const bag = bagIdentity(a);
  return bag === null || bagIdentity(b) === bag;
}

function trailNodes(anchor: ShotRecord | string | null = currentBean().name): TrailNode[] {
  const beanName = typeof anchor === 'object' && anchor !== null ? anchor.bean.name : anchor;

  // The pending shot is usually already in `records` (it is saved unrated the
  // moment it finishes), so it has to be excluded before being re-added with
  // the live rating, or the trail counts the same cup twice.
  const pendingId = state.pending?.record.id ?? null;

  const shots: TrailShot[] = state.records
    .filter((r) => r.id !== pendingId)
    .filter((r) => typeof anchor === 'object' && anchor !== null ? sameDialIn(anchor, r) : r.bean.name === beanName)
    .map((r) => ({ id: r.id, at: r.at, score: r.rating.score, recipe: r.recipe }));

  if (state.pending && state.pending.record.bean.name === beanName) {
    shots.push({
      id: state.pending.record.id,
      at: state.pending.record.at,
      score: state.rating.score,
      recipe: state.pending.record.recipe
    });
  }

  return buildTrail(shots.sort((a, b) => a.at - b.at).slice(-8));
}

function bagGroupKey(record: ShotRecord): string {
  return `${record.bean.beanId ?? record.bean.name ?? ''}\u0000${bagIdentity(record) ?? ''}`;
}

function historyTrailRecords(): ShotRecord[] {
  const seen = new Set<string>();
  return state.records.filter((record) => {
    const key = bagGroupKey(record);
    if (!record.bean.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The history trail follows the opened shot, or the selected bag on the page. */
function historyTrailRecord(): ShotRecord | null {
  const selected = state.records.find((record) => record.id === state.selectedShotId);
  const bags = historyTrailRecords();
  return selected ?? bags[state.historyTrailOffset % Math.max(bags.length, 1)] ?? state.records[0] ?? null;
}

function historyTrailLabel(record: ShotRecord | null): string | null {
  if (!record) return null;
  const sameNameDates = new Set(
    state.records
      .filter((candidate) => candidate.bean.name === record.bean.name)
      .map((candidate) => candidate.bean.roastDate)
      .filter((date): date is string => Boolean(date))
  );
  const roast = record.bean.roastDate?.slice(0, 10);
  return sameNameDates.size > 1 && roast ? `${record.bean.name ?? 'Coffee'} · roasted ${roast}` : record.bean.name;
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
function previousRecord(current: ShotRecord): ShotRecord | null {
  return state.records.find((record) => record.at < current.at && sameDialIn(current, record) && hasCurves(record)) ?? null;
}

function previousCurves(current: ShotRecord): ShotCurves | null {
  return previousRecord(current)?.curves ?? null;
}

function comparisonRecords(current: ShotRecord): ShotRecord[] {
  return state.records
    .filter((record) => record.at < current.at && sameDialIn(current, record) && hasCurves(record))
    .sort((a, b) => b.at - a.at);
}

function selectedComparison(current: ShotRecord): ShotRecord | null {
  if (state.comparisonOffset < 0) return null;
  return comparisonRecords(current)[state.comparisonOffset] ?? null;
}

function comparisonLabel(record: ShotRecord | null): string | null {
  if (!record) return null;
  const when = new Date(record.at).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${when}${record.rating.score === null ? '' : ` · ${record.rating.score}/5`}`;
}

function shotChart(): { curves: ShotCurves | null; evidence: Advice['evidence']; previous: ShotCurves | null } {
  if (state.live) {
    const activeBatchId = state.workflow?.context?.beanBatchId ?? null;
    const latest = state.records.find((record) =>
      record.bean.name === currentBean().name &&
      hasCurves(record) &&
      (activeBatchId === null || record.bean.batchId === undefined || record.bean.batchId === activeBatchId)
    );
    return { curves: toCurves(state.live), evidence: [], previous: latest?.curves ?? null };
  }

  if (state.pending) {
    return {
      curves: state.pending.curves,
      evidence: state.advice?.evidence ?? [],
      previous: previousCurves(state.pending.record)
    };
  }

  const latest = state.records.find((r) => hasCurves(r));
  if (latest?.curves) {
    return { curves: latest.curves, evidence: [], previous: previousCurves(latest) };
  }

  // Nothing pulled and nothing stored: draw the placeholder rather than
  // inventing a shot.
  return { curves: null, evidence: [], previous: null };
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

/** Titles already taken, so a new one cannot collide with an existing profile. */
function installedTitles(): string[] {
  const editing = state.editingProfile?.profile.title ?? null;
  return (state.profiles ?? [])
    .map((entry) => entry.profile.title ?? '')
    .filter((title) => title !== '' && title !== editing);
}

function profileRows(): ProfileRow[] {
  const active = state.recipe.profileTitle;

  // "Recently used" from the shots actually pulled, rather than a separate
  // favourites list to curate: the history already knows.
  const used = new Map<string, number>();
  for (const record of state.records) {
    const title = record.recipe.profileTitle;
    if (title) used.set(title, (used.get(title) ?? 0) + 1);
  }

  return (state.profiles ?? []).map((entry) => {
    const title = entry.profile.title ?? '(untitled)';
    return {
      id: entry.id,
      title,
      author: entry.profile.author ?? '',
      steps: entry.profile.steps?.length ?? 0,
      plan: entry.profile,
      usedCount: used.get(title) ?? 0,
      active: active !== null && title === active
    };
  });
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

function starterModel() {
  const bean = (state.beans ?? []).find((candidate) => candidate.id === state.activeBeanId) ?? null;
  const available = bean !== null && !state.records.some((record) => record.bean.name === bean.name);
  const batch = activeBatch();
  let hint: string | null = null;
  if (available && state.pending) hint = 'Finish or discard the shot waiting for a rating first.';
  else if (available && !batch) hint = 'Add and select a bag first.';
  else if (available && !batch?.roastLevel) hint = 'Set the bag roast level first; it is the strongest input for a useful starting point.';
  else if (available && !isReady(state.settings)) hint = 'Add an AI provider key in Settings first.';
  else if (available && state.starterError) hint = state.starterError;

  return {
    starterAvailable: available,
    starterReady: available && !state.pending && Boolean(batch?.roastLevel) && isReady(state.settings),
    starterBusy: state.starting,
    starterHint: hint
  };
}

/**
 * The same first-shot offer, resolved from what the machine is set to brew
 * rather than from a bean tapped on another screen.
 *
 * Brew has no "selected bean": the coffee is whatever the workflow says. So
 * the bean is matched by name out of the library, which is also what decides
 * whether any shot history exists for it.
 */
function brewStarterModel(): { available: boolean; ready: boolean; busy: boolean; hint: string | null } {
  const name = currentBean().name;
  const bean = name === null ? null : (state.beans ?? []).find((candidate) => candidate.name === name) ?? null;
  const batch = activeBatch();
  const available =
    bean !== null && !state.records.some((record) => record.bean.name === bean.name) && state.pending === null;

  let hint: string | null = null;
  if (available && !batch) hint = 'Select this coffee\u2019s bag in Beans & grind first.';
  else if (available && !batch?.roastLevel) hint = 'Set the bag\u2019s roast level first \u2014 it is the strongest input for a useful starting point.';
  else if (available && !isReady(state.settings)) hint = 'Add an AI provider in Settings first.';
  else if (available && state.starterError) hint = state.starterError;

  return {
    available,
    ready: available && Boolean(batch?.roastLevel) && isReady(state.settings),
    busy: state.starting,
    hint
  };
}

function waterModel() {
  const steam = state.workflow?.steamSettings ?? {};
  const hot = state.workflow?.hotWaterData ?? {};
  const rinse = state.workflow?.rinseData ?? {};

  return {
    steam: {
      targetTemperature: steam.targetTemperature ?? null,
      duration: steam.duration ?? null,
      flow: steam.flow ?? null
    },
    hotWater: {
      targetTemperature: hot.targetTemperature ?? null,
      duration: hot.duration ?? null,
      volume: hot.volume ?? null,
      flow: hot.flow ?? null
    },
    rinse: {
      targetTemperature: rinse.targetTemperature ?? null,
      duration: rinse.duration ?? null,
      flow: rinse.flow ?? null
    },
    busy: state.busy
  };
}

/** The selected stored shot, replayed from its own record. */
function shotDetail(): ShotDetailModel | null {
  const record = state.records.find((r) => r.id === state.selectedShotId);
  if (!record) return null;

  const dose = record.recipe.doseG;
  const out = record.finalYieldG;
  const tasted = describeRating(record.rating);
  const comparisons = comparisonRecords(record);
  const compared = selectedComparison(record);

  return {
    id: record.id,
    summary: dose !== null && out !== null ? `${dose.toFixed(1)}g → ${out.toFixed(1)}g` : 'Shot',
    when: new Date(record.at).toLocaleString(),
    profileTitle: record.recipe.profileTitle ?? '—',
    coffeeName: record.bean.name ?? '',
    rating: tasted || 'not rated',
    score: record.rating.score,
    advice: record.advice,
    ready: isReady(state.settings),
    busy: state.reviewingShotId === record.id,
    canApply: record.advice?.full !== undefined && state.workflow !== null,
    rebuttalOpen: state.storedRebuttalOpen,
    rebuttalText: state.storedRebuttalText,
    rebuttalReasons: state.storedRebuttalReasons,
    error: state.shotActionError,
    deleteArmed: state.deleteArmedShotId === record.id,
    chart: hasCurves(record)
      ? {
          ...record.curves!,
          previous: compared?.curves ?? null,
          comparisonLabel: comparisonLabel(compared),
          canCycleComparison: comparisons.length > 0,
          evidence: [],
          title: 'Shot curves',
          phases: analyseFlowPhases({
            elapsedS: record.curves!.elapsedS,
            pressureBar: record.curves!.pressureBar,
            flowMlS: record.curves!.flowMlS,
            weightFlow: record.curves!.weightFlow
          })
        }
      : null
  };
}

function shotRows(): ShotRow[] {
  const trailRecord = historyTrailRecord();
  return state.records.map((r) => {
    const out = r.finalYieldG;
    const dose = r.recipe.doseG;
    const summary = dose !== null && out !== null
      ? `${dose.toFixed(1)}g → ${out.toFixed(1)}g`
      : dose !== null
        ? `${dose.toFixed(1)}g · yield unavailable`
        : 'Recipe unavailable';
    const score = r.rating.score === null ? 'unrated' : `${'★'.repeat(r.rating.score)}${'☆'.repeat(5 - r.rating.score)}`;
    const elapsed = r.curves?.elapsedS.length ? r.curves.elapsedS[r.curves.elapsedS.length - 1] ?? null : null;

    return {
      id: r.id,
      when: new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      profileTitle: r.recipe.profileTitle ?? '—',
      coffeeName: r.bean.name ?? '',
      summary,
      grind: r.recipe.grind === null ? '—' : r.recipe.grind.toFixed(2),
      duration: elapsed === null ? '—' : `${Math.round(elapsed)}s`,
      score,
      scoreValue: r.rating.score,
      taste: r.rating.taste,
      adviceSummary: r.advice?.summary ?? null,
      inTrail: trailRecord !== null && sameDialIn(trailRecord, r)
    };
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderBrew(): string {
  const chart = shotChart();
  const phases = chart.curves
    ? analyseFlowPhases({
        elapsedS: chart.curves.elapsedS,
        pressureBar: chart.curves.pressureBar,
        flowMlS: chart.curves.flowMlS,
        weightFlow: chart.curves.weightFlow ?? null
      })
    : null;

  // Real advice once we have it, the sample only as a placeholder.
  const source = state.advice;
  const advice = source
    ? {
        diagnosis: source.diagnosis,
        confidence: source.confidence,
        diff: adviceToDiff(source, state.adviceBase?.recipe ?? state.recipe),
        canUndo: state.lastApplied !== null,
        busy: state.busy,
        rebuttalOpen: state.rebuttalOpen,
        rebuttalText: state.rebuttalText,
        reconsidering: state.reconsidering,
        // Only a real shot can be reconsidered: there is nothing to re-examine
        // behind the sample.
        canReconsider: state.pending !== null && state.advice !== null,
        starting: state.adviceBase?.starting ?? false
      }
    : null;

  const bean = currentBean();
  const pendingSummary = state.pending
    ? state.pending.record.finalYieldG === null
      ? `${state.pending.record.recipe.doseG === null ? 'Dose unavailable' : `${state.pending.record.recipe.doseG}g`} · yield unavailable`
      : `${state.pending.record.recipe.doseG ?? '?'}g → ${state.pending.record.finalYieldG.toFixed(1)}g`
    : null;

  // Not while asking: the taste screen is done with once the question has been
  // sent, and holding it for the half-minute the model takes reads as stuck.
  if (state.pending && state.advice === null && !state.asking) {
    return `<main class="focus-screen taste-screen">
      ${renderRating({
        rating: state.rating,
        shotSummary: pendingSummary,
        asking: state.asking,
        error: state.adviceError,
        ready: isReady(state.settings)
        ,grind: state.pending.record.recipe.grind
      })}
    </main>`;
  }

  if (state.advice !== null && advice !== null) {
    return `<main class="focus-screen advice-screen">${renderAdvice(advice)}</main>`;
  }

  const liveSample = state.live ? last(state.live.samples) : null;
  const latestSavedAdvice = state.records.find((record) => record.advice !== null)?.advice ?? null;
  const statusMessage = state.live
    ? 'Watching this shot. Taste it when it finishes.'
    : latestSavedAdvice?.summary ?? (chart.curves === null
      ? 'Pull a shot and Crema will read it.'
      : 'Ready for the next shot.');

  return `
    <div class="brew-layout">
      <main class="brew-main">
        <div class="brew-top">
          ${renderBean({
            name: bean.name,
            roaster: bean.roaster,
            roastDate: activeBatch()?.roastDate ?? null
          })}
          ${renderRecipe(state.recipe)}
          ${state.machineHasGhc === true && isRunningMachineState(state.machineState) ? renderGhcStop(state.machineState!, state.busy) : ''}
        </div>
        ${renderLive({
          pressureBar: liveSample?.pressureBar ?? 0,
          flowMlS: liveSample?.flowMlS ?? 0,
          elapsedS: liveSample?.elapsedS ?? 0,
          weightG: liveSample?.weightG ?? state.scaleG,
          phase: state.live ? state.machineState : null
        })}
        <!-- The chart is always the chart: the last shot's trace, whatever
             else is going on. The first-shot offer lives in the strip. -->
        <div class="shot-stage">${renderShot(
          chart.curves === null ? null : { ...chart.curves, previous: chart.previous, evidence: chart.evidence, phases }
        )}</div>
        ${renderAdviceStrip(
          statusMessage,
          latestSavedAdvice !== null,
          brewStarterModel(),
          state.appliedNote === null
            ? null
            : { summary: state.appliedNote, canUndo: state.lastApplied !== null, busy: state.busy },
          state.asking && state.askingSince !== null ? (Date.now() - state.askingSince) / 1000 : null
        )}
      </main>
      <aside class="brew-rail" aria-label="Machine controls">
        ${renderActionBar({ machineState: state.machineConnected ? state.machineState : null, busy: state.busy, hasGhc: state.machineHasGhc === true })}
      </aside>
    </div>`;
}

const loading = (what: string) => `<section class="card"><p class="empty">Loading ${what}…</p></section>`;

function renderBody(): string {
  switch (state.tab) {
    case 'brew':
      return renderBrew();
    case 'profiles':
      if (state.editingProfile) {
        return renderProfileEditor({
          profile: state.editingProfile.profile,
          fresh: state.editingProfile.fresh,
          problem: profileProblem(state.editingProfile.profile, installedTitles()),
          busy: state.busy
        });
      }
      return state.profiles === null ? loading('profiles') : renderProfiles(profileRows(), state.profileFilter, state.busy);
    case 'beans':
      return state.beans === null
        ? loading('beans')
        : renderBeansScreen({
            rows: beanRows(),
            busy: state.busy,
            activeBeanId: state.activeBeanId,
            activeBeanName: (state.beans ?? []).find((b) => b.id === state.activeBeanId)?.name ?? null,
            batches: state.activeBeanId === null ? null : batchRows(),
            grind: state.recipe.grind,
            grinderName: state.settings.grinderName,
            grinderRange: state.settings.grinderRange,
            newBatch: state.newBatch,
            activeBean: beanRows().find((bean) => bean.id === state.activeBeanId) ?? null,
            editingBean: beanRows().find((bean) => bean.id === state.editingBeanId) ?? null,
            deleteArmed: state.deleteArmedBeanId === state.editingBeanId,
            ...starterModel()
          });
    case 'shots':
      return renderShots(
        shotRows(),
        state.records.length,
        state.selectedShotId,
        shotDetail(),
        trailNodes(historyTrailRecord()),
        historyTrailLabel(historyTrailRecord()),
        historyTrailRecords().length > 1
      );
    case 'setup':
      return `<main class="screen settings-screen">${renderSetup({
        ...state.settings,
        ready: isReady(state.settings),
        saved: state.settingsSaved,
        storageBlocked: state.storageBlocked,
        keyVisible: state.setupKeyVisible,
        testing: state.setupTesting,
        testStatus: state.setupTestStatus,
      })}${state.workflow === null ? '' : renderWater(waterModel())}</main>`;
  }
}

/**
 * Forms whose next render should come back empty because they were just
 * submitted successfully. Cleared by the render that consumes them.
 */
const submittedForms = new Set<string>();

/** Call after a successful submit so the emptied form is not refilled. */
function formSubmitted(key: string): void {
  submittedForms.add(key);
}

function render(): void {
  // Rendering replaces the whole tree, so anything half-typed has to be
  // carried across it by hand. See formstate.ts.
  const snapshot = captureForms(root, document, submittedForms);
  // Replacing the tree resets every scroll container to the top. Settings
  // saves on each field change, so without this, filling in a form threw you
  // back to the top of the page on every field you left.
  const scroll = captureScroll(root);
  submittedForms.clear();

  const detail = state.tab === 'shots' ? shotDetail() : null;
  const brewChart = state.tab === 'brew' ? shotChart() : null;
  const brewCurves = brewChart?.curves ?? null;
  const expanded: ShotChartModel | null = detail?.chart ?? (brewChart && brewCurves
    ? {
        ...brewCurves,
        previous: brewChart.previous,
        evidence: brewChart.evidence,
        phases: analyseFlowPhases({
          elapsedS: brewCurves.elapsedS,
          pressureBar: brewCurves.pressureBar,
          flowMlS: brewCurves.flowMlS,
          weightFlow: brewCurves.weightFlow ?? null
        })
      }
    : null);
  root.innerHTML = `
    <div class="app app--${state.tab}${state.live ? ' app--live' : ''}${state.pending || state.advice ? ' app--focus' : ''}${state.machineHasGhc === true ? ' app--ghc' : ''}${state.machineHasGhc === true && isRunningMachineState(state.machineState) ? ' app--ghc-running' : ''}">
      ${renderStatus({
        // Decaid's own settings dashboard, so machine setup, scales and skin
        // switching are one tap away rather than requiring a swipe people do
        // not know about. The forum is full of "how do I get back?".
        settingsUrl: `${gateway.httpOrigin}/api/v1/plugins/settings.reaplugin/ui?backName=Crema`,
        canExit: typeof window.decentApp?.exitToDashboard === 'function',
        gatewayOnline: state.gatewayOnline,
        machineConnected: state.machineConnected,
        scaleConnected: state.scaleConnected,
        machineState: state.machineState,
        groupTempC: state.groupTempC,
        waterLevelMm: state.waterLevelMm,
        scaleG: state.scaleG,
        deviceBusy: state.deviceBusy,
        busy: state.busy,
        // Brew is the instrument panel and gets the full-height strip. The
        // other screens carry their own large heading, so the strip shrinks —
        // but it stays, because it is the only way back out to Decaid and the
        // only place that says whether the machine is connected.
        compact: state.tab !== 'brew'
      })}
      ${state.error ? `<section class="notice" role="status">${state.error}</section>` : ''}
      ${renderBody()}
      <footer class="nav-dock">${renderNav(state.tab, !isReady(state.settings))}</footer>
      ${state.chartExpanded && expanded ? renderGraphOverlay(expanded) : ''}
    </div>`;

  restoreScroll(root, scroll);
  restoreForms(root, document, snapshot);
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
  void refreshActiveBeanContext();
}

/**
 * Warm the current bag context on launch. Advice must use the roast attached
 * to the shot, even when the Beans screen has never been opened this session.
 */
async function refreshActiveBeanContext(): Promise<void> {
  const name = currentBean().name;
  if (!name) return;
  try {
    const beans = state.beans ?? await gateway.readBeans();
    state.beans = beans;
    const bean = beans.find((candidate) => candidate.name === name) ?? null;
    state.activeBeanId = bean?.id ?? null;
    state.batches = bean?.id ? await gateway.readBatches(bean.id) : null;
    render();
  } catch {
    // The brew loop remains usable without library metadata; the shot record
    // simply leaves roast age unknown instead of borrowing another bag's age.
  }
}

async function loadTab(tab: Tab): Promise<void> {
  try {
    if (tab === 'profiles' && state.profiles === null) state.profiles = await gateway.readProfiles();
    if (tab === 'beans' && state.beans === null) {
      state.beans = await gateway.readBeans();
      const activeName = currentBean().name;
      const active = state.beans.find((bean) => bean.name === activeName) ?? null;
      state.activeBeanId = active?.id ?? null;
      if (state.activeBeanId !== null) state.batches = await gateway.readBatches(state.activeBeanId);
    }
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
  onDevices(devices) {
    const wasConnected = state.machineConnected;
    // A BLE connect emits a burst of these — scanning, connecting, connected —
    // and most carry nothing the screen shows. Re-rendering on every one threw
    // the brew grid away and rebuilt it each time.
    const before = `${state.machineConnected}|${state.scaleConnected}|${state.devices.map((d) => `${d.id}:${d.state}`).join(',')}`;
    syncDeviceState(devices);
    const after = `${state.machineConnected}|${state.scaleConnected}|${state.devices.map((d) => `${d.id}:${d.state}`).join(',')}`;
    if (before !== after) render();
    if (!wasConnected && state.machineConnected) void refreshMachineHardware();
  },

  onSnapshot(snapshot) {
    const next = snapshot.state?.state ?? null;
    const temp = snapshot.groupTemperature ?? null;

    // Group temperature is tracked but not drawn anywhere, and on a live
    // machine it changes several times a second. Re-rendering for it rebuilt
    // the whole brew screen at that rate, which replaced every button on it
    // between a finger going down and coming up — taps were landing in the
    // gaps. Only the machine state is on screen, so only it renders.
    const shown = next !== state.machineState;
    state.machineState = next;
    state.groupTempC = temp;
    if (shown && state.tab === 'brew') render();
  },

  onMachineConnectionChange(connected) {
    if (state.machineConnected === connected) return;
    state.machineConnected = connected;
    if (!connected) {
      state.machineState = null;
      state.groupTempC = null;
    } else {
      void refreshMachineHardware();
    }
    render();
  },

  onScaleSnapshot(snapshot) {
    state.scaleG = snapshot.weight ?? null;
    const value = root.querySelector<HTMLElement>('[data-live-scale]');
    if (value) value.textContent = state.scaleG === null ? '—' : `${state.scaleG.toFixed(1)} g`;
  },

  onScaleConnectionChange(connected) {
    if (state.scaleConnected === connected) return;
    state.scaleConnected = connected;
    if (!connected) state.scaleG = null;
    render();
  },

  onWaterLevels(levels) {
    state.waterLevelMm = levels.currentLevel ?? null;
    const value = root.querySelector<HTMLElement>('[data-live-water]');
    if (value) value.textContent = state.waterLevelMm === null ? '—' : `${Math.round(state.waterLevelMm)} mm`;
  },

  onShotStart() {
    // A new shot supersedes whatever was awaiting a rating: keep the screen
    // about the cup in front of you.
    state.pending = null;
    state.advice = null;
    state.adviceError = null;
    state.appliedNote = null;
    state.lastAdvice = null;
    state.adviceBase = null;
    state.rating = { ...EMPTY_RATING };
    render();
  },

  onShotSample(shot) {
    state.live = shot;
    if (state.tab === 'brew') render();
  },

  async onShotEnd(shot) {
    state.live = null;
    playShotChime();
    const curves = toCurves(shot);
    const batch = activeBatch();
    const record = newShotRecord(
      `local-${shot.startedAt}`,
      state.recipe,
      {
        ...currentBean(),
        beanId: state.activeBeanId,
        batchId: state.workflow?.context?.beanBatchId ?? null,
        roastDate: batch?.roastDate ?? null,
        roastLevel: batch?.roastLevel ?? null
      },
      last(shot.samples)?.weightG ?? null,
      { ...curves }
    );

    state.pending = { record, curves };
    state.rating = { ...EMPTY_RATING };
    state.tab = 'brew';
    render();

    // Save unrated so the shot is never lost if the tablet sleeps mid-rating.
    await store.saveShot(record);
  },

});

/**
 * The request, in one place, so a reconsider is the same request plus the
 * pushback — not a second, subtly different one.
 */
function adviceRequest(record: ShotRecord, curves: ShotCurves, rebuttal?: string) {
  const currentBatch = record.bean.name === currentBean().name ? activeBatch() : null;

  return {
    bean: {
      name: record.bean.name,
      roaster: record.bean.roaster,
      roastDate: record.bean.roastDate ?? currentBatch?.roastDate ?? null,
      roastLevel: record.bean.roastLevel ?? currentBatch?.roastLevel ?? null
    },
    grinder: { name: state.settings.grinderName, range: state.settings.grinderRange },
    recipe: record.recipe,
    curves,
    rating: record.rating,
    finalYieldG: record.finalYieldG,
    trail: trailNodes(record),
    ...(rebuttal
      ? {
          rebuttal,
          priorSummary: record.advice?.summary ?? '',
          priorDiagnosis: record.advice?.diagnosis ?? ''
        }
      : {})
  };
}

/**
 * Ask the provider, and find the Mac again if it has moved.
 *
 * Only the local-server provider can move: a hosted API's address is fixed.
 * The sweep runs solely after a real failure, and a discovered address is
 * saved, so the next request goes straight there.
 */
async function ask(prompt: string): Promise<string> {
  try {
    return await askProvider(state.settings, prompt);
  } catch (cause) {
    if (state.settings.provider !== 'server') throw cause;

    const saved = resolveBaseUrl(state.settings);
    const found = await discoverServer(saved);
    if (found === null || found === saved) throw cause;

    state.settings = { ...state.settings, baseUrl: found };
    state.storageBlocked = !saveSettings(state.settings);
    return askProvider(state.settings, prompt);
  }
}

/**
 * Tick the waiting readout without re-rendering.
 *
 * Only the elapsed seconds change, and a render here would replace the tree
 * once a second — throwing away anything half-typed and fighting every tap.
 */
let askingTicker: ReturnType<typeof setInterval> | null = null;

function startAskingClock(): void {
  state.askingSince = Date.now();
  if (askingTicker !== null) clearInterval(askingTicker);
  askingTicker = setInterval(() => {
    if (!state.asking || state.askingSince === null) return;
    const el = root.querySelector<HTMLElement>('[data-asking-elapsed]');
    if (el) el.textContent = `${Math.round((Date.now() - state.askingSince) / 1000)}s`;
  }, 1000);
}

function stopAskingClock(): void {
  if (askingTicker !== null) clearInterval(askingTicker);
  askingTicker = null;
  state.askingSince = null;
}

async function getAdvice(): Promise<void> {
  if (!state.pending || state.asking) return;

  state.asking = true;
  startAskingClock();
  state.tab = 'brew';
  state.adviceError = null;
  render();

  const { record, curves } = state.pending;
  record.rating = { ...state.rating };
  record.deferred = false;

  const prompt = buildPrompt(adviceRequest(record, curves));

  try {
    const reply = await ask(prompt);
    const parsed = parseAdvice(reply, { shotDurationS: last(curves.elapsedS) });

    if (!parsed.ok) {
      state.adviceError = parsed.error;
    } else {
      state.advice = parsed.advice;
      state.adviceBase = { recipe: state.recipe, starting: false };
      state.appliedNote = null;
      state.lastAdvice = null;
      // The answer is the thing that was asked for: bring it forward wherever
      // they wandered off to while it was being worked out.
      state.tab = 'brew';
      record.advice = { summary: parsed.advice.screenSummary, diagnosis: parsed.advice.diagnosis, full: parsed.advice };
    }
  } catch (cause) {
    state.adviceError = (cause as Error).message;
  } finally {
    state.asking = false;
    stopAskingClock();
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
    const reply = await ask(buildPrompt(adviceRequest(record, curves, rebuttal)));
    const parsed = parseAdvice(reply, { shotDurationS: last(curves.elapsedS) });

    if (!parsed.ok) {
      state.adviceError = parsed.error;
    } else {
      state.advice = parsed.advice;
      state.adviceBase = { recipe: state.recipe, starting: false };
      state.appliedNote = null;
      state.lastAdvice = null;
      record.advice = { summary: parsed.advice.screenSummary, diagnosis: parsed.advice.diagnosis, full: parsed.advice };
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

async function saveRatingWithoutAdvice(): Promise<void> {
  if (!state.pending || state.rating.score === null || state.asking) return;
  state.pending.record.rating = { ...state.rating };
  state.pending.record.deferred = false;
  await store.saveShot(state.pending.record);
  state.records = await store.readRecent();
  state.pending = null;
  state.rating = { ...EMPTY_RATING };
  state.adviceError = null;
  render();
}

async function discardPendingShot(): Promise<void> {
  if (!state.pending || state.asking) return;
  const id = state.pending.record.id;
  if (!await store.deleteShot(id)) {
    state.adviceError = 'The shot could not be discarded from Decaid storage.';
    render();
    return;
  }
  state.records = state.records.filter((record) => record.id !== id);
  state.pending = null;
  state.rating = { ...EMPTY_RATING };
  state.adviceError = null;
  render();
}

function bumpPendingGrind(delta: number): void {
  const record = state.pending?.record;
  if (!record || record.recipe.grind === null) return;
  record.recipe = { ...record.recipe, grind: Number((record.recipe.grind + delta).toFixed(2)) };
  render();
}

async function reviewStoredShot(id: string, objection?: string): Promise<void> {
  const record = state.records.find((candidate) => candidate.id === id);
  if (!record || !hasCurves(record) || state.reviewingShotId !== null || !isReady(state.settings)) return;

  state.reviewingShotId = id;
  state.shotActionError = null;
  render();
  try {
    const reply = await ask(buildPrompt(adviceRequest(record, record.curves!, objection?.trim() || undefined)));
    const parsed = parseAdvice(reply, { shotDurationS: last(record.curves!.elapsedS) });
    if (!parsed.ok) {
      state.shotActionError = parsed.error;
    } else {
      record.advice = { summary: parsed.advice.screenSummary, diagnosis: parsed.advice.diagnosis, full: parsed.advice };
      await store.saveShot(record);
      state.records = await store.readRecent();
      state.storedRebuttalOpen = false;
      state.storedRebuttalText = '';
      state.storedRebuttalReasons = [];
    }
  } catch (cause) {
    state.shotActionError = (cause as Error).message;
  } finally {
    state.reviewingShotId = null;
    render();
  }
}

async function rateStoredShot(id: string, score: number): Promise<void> {
  const record = state.records.find((candidate) => candidate.id === id);
  if (!record || !Number.isInteger(score) || score < 1 || score > 5) return;
  const before = record.rating.score;
  record.rating = { ...record.rating, score };
  render();
  if (!await store.saveShot(record)) {
    record.rating = { ...record.rating, score: before };
    state.shotActionError = 'The rating could not be saved to Decaid storage.';
  } else {
    state.shotActionError = null;
  }
  render();
}

async function applyStoredAdvice(id: string): Promise<void> {
  const record = state.records.find((candidate) => candidate.id === id);
  if (!record?.advice?.full) return;
  await applyAdviceResult(record.advice.full, record);
}

async function deleteStoredShot(id: string): Promise<void> {
  if (state.deleteArmedShotId !== id) {
    state.deleteArmedShotId = id;
    render();
    return;
  }

  const deleted = await store.deleteShot(id);
  if (!deleted) {
    state.shotActionError = 'The shot could not be deleted from Decaid storage.';
  } else {
    state.records = state.records.filter((record) => record.id !== id);
    state.selectedShotId = null;
    state.deleteArmedShotId = null;
    state.shotActionError = null;
  }
  render();
}

function syncDeviceState(devices: readonly DeviceInfoWire[]): void {
  state.devices = [...devices];
  state.machineConnected = devices.some((device) => device.type === 'machine' && device.state === 'connected');
  state.scaleConnected = devices.some((device) => device.type === 'scale' && device.state === 'connected');
  // machineHasGhc is deliberately not cleared here: it describes the machine,
  // not the connection, and re-deriving it on every device event is what made
  // the rail glitch while connecting.
  if (!state.scaleConnected) state.scaleG = null;
}

async function refreshMachineHardware(): Promise<void> {
  if (!state.machineConnected) return;
  try {
    const info = await gateway.readMachineInfo();
    const hasGhc = info.GHC === true;
    saveKnownGhc(hasGhc);
    if (state.machineHasGhc === hasGhc) return;
    state.machineHasGhc = hasGhc;
    if (state.tab === 'brew') render();
  } catch {
    // State and brewing remain useful when an older gateway lacks this route.
  }
}

async function controlDevice(kind: 'machine' | 'scale'): Promise<void> {
  if (state.deviceBusy) return;
  state.deviceBusy = true;
  state.error = null;
  render();
  try {
    if (kind === 'scale' && state.scaleConnected) {
      await gateway.tareScale();
    } else {
      const alreadyOn = kind === 'machine' ? state.machineConnected : state.scaleConnected;
      const devices = alreadyOn ? await gateway.readDevices() : await gateway.connectKind(kind);
      syncDeviceState(devices);
      void refreshMachineHardware();

      // A scan that connects nothing used to look identical to one that
      // worked: the button ran, no error appeared, and the pill still said
      // "Connect machine". Say which of the two things happened.
      const connected = kind === 'machine' ? state.machineConnected : state.scaleConnected;
      if (!connected) state.error = describeFailedConnect(kind, devices);
    }
  } catch (cause) {
    state.error = (cause as Error).message;
  } finally {
    state.deviceBusy = false;
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

/** Apply profile advice before its numeric recipe changes, matching the DE1 app. */
async function applyAdviceResult(source: Advice, record: ShotRecord | null): Promise<void> {
  if (!state.workflow || state.busy) return;

  const before = state.workflow;
  let applied: WorkflowPatch = {};
  state.busy = true;
  state.error = null;
  render();

  try {
    let working = before;

    if (source.profile.action === 'create' && source.profile.createdProfile) {
      const authored = source.profile.createdProfile;
      const beanName = record?.bean.name ?? currentBean().name;
      const created = await gateway.createProfile({
        version: '2',
        title: beanName ? `AI · ${beanName}` : authored.title,
        author: 'Crema AI',
        notes: authored.notes ? `${authored.title} — ${authored.notes}` : authored.title,
        beverage_type: 'espresso',
        target_weight: authored.targetWeightG,
        steps: authored.steps
      });
      working = await gateway.selectProfile(created.profile);
      applied.profile = created.profile;
      state.profiles = null;
    } else if (source.profile.action === 'switch' && source.profile.switchTo) {
      const profiles = state.profiles ?? await gateway.readProfiles();
      state.profiles = profiles;
      const wanted = source.profile.switchTo.trim().toLocaleLowerCase();
      const match = profiles.find((entry) => (entry.profile.title ?? '').trim().toLocaleLowerCase() === wanted);
      if (!match) throw new Error(`The profile “${source.profile.switchTo}” is not installed in Decaid.`);
      working = await gateway.selectProfile(match.profile);
      applied.profile = match.profile;
    }

    // A profile brings its own defaults. Recalculate against the selected
    // profile and then write grind/dose/yield/temp so those accepted changes
    // win rather than being clobbered by the switch.
    const diff = adviceToDiff(source, workflowToRecipe(working));
    const recipePatch = diffToWorkflowPatch(diff, working);
    const updated = Object.keys(recipePatch).length > 0 ? await gateway.updateWorkflow(recipePatch) : working;
    applied = { ...applied, ...recipePatch };

    const accepted = adviceToDiff(source, workflowToRecipe(before));
    state.workflow = updated;
    state.recipe = workflowToRecipe(updated);
    state.lastApplied = Object.keys(applied).length > 0 ? { before, patch: applied } : null;
    state.appliedNote = describeApplied(
      accepted,
      source.profile.action !== 'keep' ? source.profile.switchTo : null,
      state.starter !== null
    );
    state.lastAdvice = {
      advice: source,
      base: state.adviceBase ?? { recipe: workflowToRecipe(before), starting: state.starter !== null }
    };

    if (record) {
      const accepted = adviceToDiff(source, workflowToRecipe(before)).changes.map((change) => change.field);
      if (source.profile.action !== 'keep') accepted.push('profileTitle');
      record.applied = [...new Set(accepted)];
      record.appliedRecipe = workflowToRecipe(updated);
      await store.saveShot(record);
      state.records = await store.readRecent();
    } else if (state.starter) {
      const saved = await store.saveBeanDialIn(state.starter.beanId, workflowToRecipe(updated));
      if (!saved) throw new Error('The starting point reached the machine but could not be saved for this bean.');
    }

    // Applying is the end of this screen's job — the change is on the machine
    // and the next thing to do is pull a shot. Leaving the card up with no way
    // off it stranded people here until they started another shot, which was
    // the only thing that used to clear it. Undo stays reachable on Brew.
    dismissAdvice();
  } catch (cause) {
    state.error = (cause as Error).message;
  } finally {
    state.busy = false;
    render();
  }
}


/**
 * Put the chosen palette on the document.
 *
 * Only the `--*` tokens differ between the two, so this is one attribute and
 * no re-render: the stylesheet is written against the tokens throughout.
 */
function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/** Close the advice card and go back to the brew screen. */
function dismissAdvice(): void {
  state.advice = null;
  state.adviceError = null;
  state.starter = null;
  state.rebuttalOpen = false;
  state.rebuttalText = '';
  state.pending = null;
  state.rating = { ...EMPTY_RATING };
  state.tab = 'brew';
}

async function bump(field: keyof Recipe, delta: number): Promise<void> {
  if (!state.workflow) return;

  let current = state.recipe[field];

  // An unset grind used to make both steppers dead buttons, which left no way
  // at all to set one — the main lever in the whole dial-in loop. The first
  // nudge now seeds from the middle of the configured dial range; with no
  // range to go on, the card offers direct entry instead.
  if (current === null && field === 'grind') {
    current = startingGrind(state.settings.grinderRange);
    if (current === null) return;
    delta = 0;
  }

  if (typeof current !== 'number') return;

  const diff = diffRecipe(state.recipe, { [field]: Number((current + delta).toFixed(2)) });
  if (diff.changes.length === 0) return;

  const before = state.workflow;
  state.recipe = applyDiff(state.recipe, diff);
  render();
  await push(diffToWorkflowPatch(diff, before), before);
}

/** Write the hand-built profile to Decaid and select it for the next shot. */
async function saveEditedProfile(): Promise<void> {
  const editing = state.editingProfile;
  if (!editing || state.busy) return;
  if (profileProblem(editing.profile, installedTitles()) !== null) return;

  const before = state.workflow;
  state.busy = true;
  render();
  try {
    const created = await gateway.createProfile(editing.profile);
    state.profiles = await gateway.readProfiles();

    // Saving and then having to hunt for it in the list is a chore; the reason
    // anyone builds one is to pull a shot with it.
    const updated = await gateway.selectProfile(created.profile ?? editing.profile);
    state.workflow = updated;
    state.recipe = workflowToRecipe(updated);
    if (before) state.lastApplied = { before, patch: { profile: created.profile ?? editing.profile } };

    state.editingProfile = null;
    state.error = null;
    state.tab = 'brew';
  } catch (cause) {
    state.error = (cause as Error).message;
  } finally {
    state.busy = false;
    render();
  }
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

  // Restore the last proven setup for this coffee. The classic skin treats a
  // bean as a dial-in preset, not just a label, so selecting one must bring
  // back its grind, dose, yield and profile where that profile still exists.
  const saved = (newest?.id
    ? state.records.find((record) => record.bean.batchId === newest.id)
    : null) ?? state.records.find((record) => record.bean.beanId === id || (record.bean.beanId === undefined && record.bean.name === bean.name)) ?? null;
  const preset = await store.readBeanDialIn(id);
  const savedRecipe = preset?.recipe ?? saved?.appliedRecipe ?? saved?.recipe ?? null;
  let savedProfile: WorkflowPatch['profile'];
  if (savedRecipe?.profileTitle) {
    try {
      const profiles = state.profiles ?? await gateway.readProfiles();
      state.profiles = profiles;
      const title = savedRecipe.profileTitle.trim().toLocaleLowerCase();
      const match = profiles.find((entry) => (entry.profile.title ?? '').trim().toLocaleLowerCase() === title);
      if (match) {
        const withProfile: WorkflowWire = { ...state.workflow, profile: match.profile };
        const tempPatch = savedRecipe.temperatureC === null
          ? {}
          : diffToWorkflowPatch(diffRecipe(workflowToRecipe(withProfile), { temperatureC: savedRecipe.temperatureC }), withProfile);
        savedProfile = tempPatch.profile ?? match.profile;
      }
    } catch {
      // Coffee selection still works when the profile library is unavailable;
      // Decaid keeps the current profile and restores the numeric context.
    }
  }

  await push(
    {
      context: {
        coffeeName: bean.name,
        coffeeRoaster: bean.roaster,
        ...(newest?.id ? { beanBatchId: newest.id } : {}),
        ...(savedRecipe?.grind !== null && savedRecipe?.grind !== undefined ? { grinderSetting: formatGrind(savedRecipe.grind) } : {}),
        ...(savedRecipe?.doseG !== null && savedRecipe?.doseG !== undefined ? { targetDoseWeight: savedRecipe.doseG } : {}),
        ...(savedRecipe?.targetYieldG !== null && savedRecipe?.targetYieldG !== undefined ? { targetYield: savedRecipe.targetYieldG } : {})
      },
      ...(savedProfile ? { profile: savedProfile } : {})
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

async function requestStarterAdvice(): Promise<void> {
  // Reachable from Brew as well as Beans & grind, and on Brew there is no
  // selected bean — fall back to whatever the workflow is set to brew.
  const byName = (state.beans ?? []).find((candidate) => candidate.name === currentBean().name) ?? null;
  const bean = (state.beans ?? []).find((candidate) => candidate.id === state.activeBeanId) ?? byName;
  const beanId = bean?.id ?? null;
  const batch = activeBatch();
  if (!beanId || !bean || !batch?.roastLevel || !state.workflow || !isReady(state.settings) || state.pending) return;

  state.starting = true;
  state.starterError = null;
  render();
  try {
    const profiles = state.profiles ?? await gateway.readProfiles();
    state.profiles = profiles;
    const beanContext: ShotRecord['bean'] = {
      beanId,
      name: bean.name,
      roaster: bean.roaster,
      batchId: batch.id ?? null,
      roastDate: batch.roastDate ?? null,
      roastLevel: batch.roastLevel ?? null
    };
    const prompt = buildStarterPrompt({
      bean: {
        name: bean.name,
        roaster: bean.roaster,
        roastDate: batch.roastDate ?? null,
        roastLevel: batch.roastLevel ?? null
      },
      grinder: { name: state.settings.grinderName || null, range: state.settings.grinderRange || null },
      recipe: state.recipe,
      profileTitles: profiles.map((entry) => entry.profile.title ?? '').filter(Boolean)
    });
    const reply = await ask(prompt);
    const parsed = parseAdvice(reply, {});
    if (!parsed.ok) throw new Error(parsed.error);
    state.advice = parsed.advice;
    state.adviceBase = { recipe: state.recipe, starting: true };
    state.appliedNote = null;
    state.lastAdvice = null;
    state.starter = { beanId, bean: beanContext };
    state.rebuttalOpen = false;
    state.tab = 'brew';
  } catch (cause) {
    state.starterError = (cause as Error).message;
  } finally {
    state.starting = false;
    render();
  }
}

async function addBatch(form: HTMLFormElement): Promise<void> {
  if (state.activeBeanId === null) return;

  const data = new FormData(form);
  const roastDate = String(data.get('roastDate') ?? '').trim();
  const roastLevel = state.newBatch.roastLevel ?? '';
  const weight = state.newBatch.weightG ?? NaN;
  if (roastDate === '') return;

  state.busy = true;
  render();
  try {
    const created = await gateway.createBatch(state.activeBeanId, {
      roastDate: new Date(`${roastDate}T12:00:00`).toISOString(),
      ...(roastLevel ? { roastLevel } : {}),
      ...(Number.isFinite(weight) && weight > 0 ? { weight } : {})
    });
    state.batches = await gateway.readBatches(state.activeBeanId);
    if (created.id && state.workflow) {
      state.workflow = await gateway.updateWorkflow({ context: { beanBatchId: created.id } });
      state.recipe = workflowToRecipe(state.workflow);
    }
    // Only on success: a failed add must keep what was typed, or the barista
    // retypes a roast date because the gateway blinked.
    formSubmitted('add-batch');
    state.newBatch = { roastLevel: null, weightG: null };
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
    const created = await gateway.createBean({ roaster, name, ...(country ? { country } : {}) });
    state.beans = await gateway.readBeans();
    state.activeBeanId = created.id ?? null;
    state.batches = [];
    if (state.workflow) {
      state.workflow = await gateway.updateWorkflow({
        context: { coffeeName: name, coffeeRoaster: roaster, beanBatchId: null }
      });
      state.recipe = workflowToRecipe(state.workflow);
    }
    formSubmitted('add-bean');
    state.error = null;
  } catch (cause) {
    state.error = (cause as Error).message;
  } finally {
    state.busy = false;
    render();
  }
}

async function editBean(form: HTMLFormElement): Promise<void> {
  const id = form.dataset['id'] ?? '';
  const data = new FormData(form);
  const roaster = String(data.get('roaster') ?? '').trim();
  const name = String(data.get('name') ?? '').trim();
  const country = String(data.get('country') ?? '').trim();
  if (!id || !roaster || !name) return;
  const original = state.beans?.find((bean) => bean.id === id) ?? null;

  state.busy = true;
  state.deleteArmedBeanId = null;
  render();
  try {
    await gateway.updateBean(id, { roaster, name, country: country || null });
    if (original) {
      const changedRecords = state.records.filter((record) =>
        record.bean.beanId === id ||
        (record.bean.beanId === undefined && record.bean.name === original.name && record.bean.roaster === original.roaster)
      );
      for (const record of changedRecords) {
        record.bean = { ...record.bean, beanId: id, name, roaster };
        await store.saveShot(record);
      }
    }
    state.beans = await gateway.readBeans();
    if (state.workflow && state.activeBeanId === id) {
      const updated = await gateway.updateWorkflow({ context: { coffeeName: name, coffeeRoaster: roaster } });
      state.workflow = updated;
      state.recipe = workflowToRecipe(updated);
    }
    state.editingBeanId = null;
    state.error = null;
  } catch (cause) {
    state.error = (cause as Error).message;
  } finally {
    state.busy = false;
    render();
  }
}

async function deleteBean(id: string): Promise<void> {
  if (state.deleteArmedBeanId !== id) {
    state.deleteArmedBeanId = id;
    render();
    return;
  }

  state.busy = true;
  render();
  try {
    await gateway.deleteBean(id);
    await store.deleteBeanDialIn(id);
    state.beans = await gateway.readBeans();
    if (state.activeBeanId === id) {
      state.activeBeanId = null;
      state.batches = null;
    }
    // The panel is about a bean that no longer exists.
    if (state.editingBeanId === id) state.editingBeanId = null;
    state.deleteArmedBeanId = null;
    state.error = null;
  } catch (cause) {
    state.error = (cause as Error).message;
  } finally {
    state.busy = false;
    render();
  }
}

function settingsFromForm(form: HTMLFormElement): CremaSettings {
  const data = new FormData(form);
  const str = (k: string) => String(data.get(k) ?? '').trim();

  return {
    ...state.settings,
    provider: (str('provider') || 'anthropic') as CremaSettings['provider'],
    apiKey: str('apiKey'),
    model: str('model'),
    baseUrl: str('baseUrl'),
    grinderName: str('grinderName'),
    grinderRange: str('grinderRange')
  };
}

/**
 * Save the settings form.
 *
 * There is no Save button: these live in this device's browser storage, so
 * there is nothing to commit and nothing to fail — a button you have to scroll
 * to find is pure ceremony. Each field writes as it is left, and a quiet tick
 * says so. `navigate` is what the Enter key used to do.
 */
function saveSetup(form: HTMLFormElement, navigate = false): void {
  state.settings = settingsFromForm(form);

  const ok = saveSettings(state.settings);
  state.storageBlocked = !ok;
  state.settingsSaved = ok;
  if (navigate) {
    state.setupTestStatus = null;
    state.tab = 'brew';
  }
  render();
}

/** The tick fades on its own; a permanent "Saved" stops meaning anything. */
let savedNoticeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Update the few things a saved setting changes, without a re-render.
 *
 * Rendering replaces the whole tree, which resets the scroll container and
 * fights the caret — and settings save on every field you leave, so a render
 * per field threw you back to the top of the page as you filled the form in.
 * Nothing on this screen depends on the settings except the tick, the ready
 * pill and the nav dot, so those three are written in place instead.
 */
function refreshSetupChrome(): void {
  const ready = isReady(state.settings);

  const pill = root.querySelector<HTMLElement>('.setup-intro .pill');
  if (pill) {
    pill.className = `pill ${ready ? 'ok' : 'off'}`;
    pill.textContent = ready ? 'ready' : 'needs a key';
  }

  const dot = root.querySelector<HTMLElement>('.tab[data-tab="setup"] .dot');
  if (ready && dot) dot.remove();
  if (!ready && !dot) {
    root.querySelector('.tab[data-tab="setup"]')?.insertAdjacentHTML('beforeend', '<i class="dot"></i>');
  }

  const feedback = root.querySelector<HTMLElement>('.setup-feedback');
  if (!feedback) return;
  feedback.innerHTML = state.storageBlocked
    ? '<span class="saved warn">This browser blocked storage, so settings will not persist.</span>'
    : state.settingsSaved
      ? '<span class="saved">✓ Saved</span>'
      : '';
}

function autosaveSetup(form: HTMLFormElement): void {
  state.settings = settingsFromForm(form);
  state.storageBlocked = !saveSettings(state.settings);
  state.settingsSaved = !state.storageBlocked;
  refreshSetupChrome();

  if (savedNoticeTimer !== null) clearTimeout(savedNoticeTimer);
  savedNoticeTimer = setTimeout(() => {
    savedNoticeTimer = null;
    if (!state.settingsSaved) return;
    state.settingsSaved = false;
    if (state.tab === 'setup') refreshSetupChrome();
  }, 2200);
}

async function testSetup(form: HTMLFormElement): Promise<void> {
  const candidate = settingsFromForm(form);
  state.settings = candidate;
  state.settingsSaved = false;
  state.setupTesting = true;
  state.setupTestStatus = null;
  render();
  try {
    await askProvider(candidate, 'Reply with exactly OK. This is a connection test; do not add anything else.');
    state.setupTestStatus = 'Connected — the provider answered.';
  } catch (cause) {
    state.setupTestStatus = (cause as Error).message;
  } finally {
    state.setupTesting = false;
    render();
  }
}

/**
 * Command the machine.
 *
 * Water moves when this runs, so it is only ever reached from a deliberate
 * button press. A failure is reported rather than swallowed — silently doing
 * nothing when someone asks for steam is worse than saying why not.
 */
async function commandMachine(next: string): Promise<void> {
  const allowed: CommandableState[] = ['espresso', 'steam', 'hotWater', 'flush', 'steamRinse', 'idle', 'sleeping'];
  if (!allowed.includes(next as CommandableState)) return;

  state.busy = true;
  render();
  try {
    await gateway.setState(next as CommandableState);
    state.error = null;
  } catch (cause) {
    state.error = (cause as Error).message;
  } finally {
    state.busy = false;
    render();
  }
}

/**
 * The steam / hot-water / flush fields a stepper may touch.
 *
 * Declared explicitly rather than indexed by string: it keeps the compiler
 * checking every read and write, and it means an unknown field name cannot
 * reach the machine at all. Same reasoning as `applyDiff`.
 */
const WATER_FIELDS: Record<
  string,
  { get: (w: WorkflowWire) => number | null; patch: (w: WorkflowWire, value: number) => WorkflowPatch }
> = {
  'steamSettings.targetTemperature': {
    get: (w) => w.steamSettings?.targetTemperature ?? null,
    patch: (w, v) => ({ steamSettings: { ...w.steamSettings, targetTemperature: v } })
  },
  'steamSettings.duration': {
    get: (w) => w.steamSettings?.duration ?? null,
    patch: (w, v) => ({ steamSettings: { ...w.steamSettings, duration: v } })
  },
  'steamSettings.flow': {
    get: (w) => w.steamSettings?.flow ?? null,
    patch: (w, v) => ({ steamSettings: { ...w.steamSettings, flow: v } })
  },
  'hotWaterData.targetTemperature': {
    get: (w) => w.hotWaterData?.targetTemperature ?? null,
    patch: (w, v) => ({ hotWaterData: { ...w.hotWaterData, targetTemperature: v } })
  },
  'hotWaterData.duration': {
    get: (w) => w.hotWaterData?.duration ?? null,
    patch: (w, v) => ({ hotWaterData: { ...w.hotWaterData, duration: v } })
  },
  'hotWaterData.volume': {
    get: (w) => w.hotWaterData?.volume ?? null,
    patch: (w, v) => ({ hotWaterData: { ...w.hotWaterData, volume: v } })
  },
  'hotWaterData.flow': {
    get: (w) => w.hotWaterData?.flow ?? null,
    patch: (w, v) => ({ hotWaterData: { ...w.hotWaterData, flow: v } })
  },
  'rinseData.targetTemperature': {
    get: (w) => w.rinseData?.targetTemperature ?? null,
    patch: (w, v) => ({ rinseData: { ...w.rinseData, targetTemperature: v } })
  },
  'rinseData.duration': {
    get: (w) => w.rinseData?.duration ?? null,
    patch: (w, v) => ({ rinseData: { ...w.rinseData, duration: v } })
  },
  'rinseData.flow': {
    get: (w) => w.rinseData?.flow ?? null,
    patch: (w, v) => ({ rinseData: { ...w.rinseData, flow: v } })
  }
};

/**
 * Nudge a steam / hot-water / flush value and write it through. These live on
 * the workflow, which is where the machine reads them, so there is no separate
 * settings store to keep in step.
 */
async function bumpWater(group: string, field: string, delta: number): Promise<void> {
  if (!state.workflow) return;

  const entry = WATER_FIELDS[`${group}.${field}`];
  if (!entry) return;

  const before = state.workflow;
  const current = entry.get(before);
  if (current === null) return;

  // Negative time, temperature or flow is meaningless; stop at zero rather
  // than sending the machine something it has to reject.
  const next = Math.max(0, Number((current + delta).toFixed(1)));
  if (next === current) return;

  await push(entry.patch(before, next), before);
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

  if (action === 'open-beans' || action === 'open-profiles') {
    const tab: Tab = action === 'open-beans' ? 'beans' : 'profiles';
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

  if (action === 'save-rating') {
    void saveRatingWithoutAdvice();
    return;
  }

  if (action === 'pending-grind') {
    bumpPendingGrind(Number(target.dataset['step'] ?? 0));
    return;
  }

  if (action === 'discard-shot') {
    void discardPendingShot();
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

  if (action === 'toggle-api-key') {
    const form = target.closest<HTMLFormElement>('form[data-action="save-setup"]');
    if (form) state.settings = settingsFromForm(form);
    state.setupKeyVisible = !state.setupKeyVisible;
    state.settingsSaved = false;
    render();
    root.querySelector<HTMLInputElement>('input[name="apiKey"]')?.focus();
    return;
  }

  if (action === 'test-ai') {
    const form = target.closest<HTMLFormElement>('form[data-action="save-setup"]');
    if (form) void testSetup(form);
    return;
  }

  if (action === 'use-bean') {
    state.deleteArmedBeanId = null;
    void useBean(target.dataset['id'] ?? '');
    return;
  }

  if (action === 'set-theme') {
    const theme: Theme = target.dataset['value'] === 'light' ? 'light' : 'dark';
    state.settings = { ...state.settings, theme };
    state.storageBlocked = !saveSettings(state.settings);
    applyTheme(theme);
    render();
    return;
  }

  if (action === 'change-model') {
    // Handled on `change`, below — a select fires there, not on click.
    return;
  }

  if (action === 'profile-new') {
    state.editingProfile = { profile: newProfile(), fresh: true };
    render();
    return;
  }

  if (action === 'profile-duplicate') {
    const entry = (state.profiles ?? []).find((candidate) => candidate.id === target.dataset['id']);
    if (!entry) return;
    const base = entry.profile.title ?? 'Profile';
    // Decaid keys a profile by the hash of its content, so a copy keeping the
    // original's name would collide with it rather than sit beside it.
    let title = `${base} (copy)`;
    for (let n = 2; installedTitles().some((t) => t.toLowerCase() === title.toLowerCase()); n += 1) {
      title = `${base} (copy ${n})`;
    }
    state.editingProfile = { profile: duplicateProfile(entry.profile, title), fresh: false };
    render();
    return;
  }

  if (action === 'profile-edit-close') {
    state.editingProfile = null;
    render();
    return;
  }

  if (action === 'step-add' && state.editingProfile) {
    state.editingProfile = { ...state.editingProfile, profile: addStep(state.editingProfile.profile) };
    render();
    return;
  }

  if (action === 'step-remove' && state.editingProfile) {
    const index = Number(target.dataset['index'] ?? -1);
    state.editingProfile = { ...state.editingProfile, profile: removeStep(state.editingProfile.profile, index) };
    render();
    return;
  }

  if (action === 'step-move' && state.editingProfile) {
    const index = Number(target.dataset['index'] ?? -1);
    const by = Number(target.dataset['by'] ?? 0) < 0 ? -1 : 1;
    state.editingProfile = { ...state.editingProfile, profile: moveStep(state.editingProfile.profile, index, by) };
    render();
    return;
  }

  // The chip fields (pump, transition) commit on tap; the numeric ones commit
  // on change, below, so a half-typed number is never pushed into the profile.
  if (action === 'step-edit' && state.editingProfile && target.dataset['value']) {
    const index = Number(target.dataset['index'] ?? -1);
    const field = target.dataset['field'] ?? '';
    const value = target.dataset['value'] ?? '';
    if (field === 'pump' || field === 'transition') {
      state.editingProfile = {
        ...state.editingProfile,
        profile: editStep(state.editingProfile.profile, index, { [field]: value } as never)
      };
      render();
    }
    return;
  }

  if (action === 'profile-save' && state.editingProfile) {
    void saveEditedProfile();
    return;
  }

  if (action === 'edit-bean-open') {
    state.editingBeanId = target.dataset['id'] ?? null;
    state.deleteArmedBeanId = null;
    render();
    return;
  }

  if (action === 'edit-bean-close') {
    state.editingBeanId = null;
    state.deleteArmedBeanId = null;
    render();
    return;
  }

  if (action === 'pick-roast-level') {
    const value = target.dataset['value'] ?? '';
    state.newBatch = { ...state.newBatch, roastLevel: state.newBatch.roastLevel === value ? null : value };
    render();
    return;
  }

  if (action === 'bag-size') {
    const step = Number(target.dataset['step'] ?? 0);
    const current = state.newBatch.weightG;
    // From unset, the first tap up lands on 250g — the size most coffee is
    // sold in — rather than crawling from zero. Stepping back to zero or below
    // returns the field to unset, which is what "optional" has to mean.
    const next = current === null ? (step > 0 ? BAG_SIZE_START_G : null) : current + step;
    state.newBatch = { ...state.newBatch, weightG: next !== null && next > 0 ? next : null };
    render();
    return;
  }

  if (action === 'use-batch') {
    void useBatch(target.dataset['id'] ?? '');
    return;
  }

  if (action === 'starter-advice') {
    void requestStarterAdvice();
    return;
  }

  if (action === 'exit-skin') {
    // Only present when Decaid injected the API, but guard anyway: a stale
    // page can outlive the script that defined it.
    window.decentApp?.exitToDashboard?.();
    return;
  }

  if (action === 'machine') {
    void commandMachine(target.dataset['state'] ?? '');
    return;
  }

  if (action === 'water-inc' || action === 'water-dec') {
    const step = Number(target.dataset['step'] ?? 0);
    void bumpWater(
      target.dataset['group'] ?? '',
      target.dataset['field'] ?? '',
      action === 'water-inc' ? step : -step
    );
    return;
  }

  if (action === 'open-shot') {
    const id = target.dataset['id'] ?? '';
    // Tapping the open shot closes it, so the list is never stuck expanded.
    state.selectedShotId = state.selectedShotId === id ? null : id;
    state.comparisonOffset = 0;
    state.storedRebuttalOpen = false;
    state.storedRebuttalText = '';
    state.storedRebuttalReasons = [];
    state.deleteArmedShotId = null;
    state.shotActionError = null;
    render();

    // The detail opens below the list, so on a tablet it lands off screen and
    // the tap looks like it did nothing. Bring it into view.
    if (state.selectedShotId !== null) {
      root.querySelector('.shot-detail-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }

  if (action === 'close-shot') {
    state.selectedShotId = null;
    state.shotActionError = null;
    render();
    return;
  }

  if (action === 'cycle-trail') {
    const count = historyTrailRecords().length;
    if (count < 2) return;
    state.selectedShotId = null;
    state.historyTrailOffset = (state.historyTrailOffset + 1) % count;
    state.comparisonOffset = 0;
    render();
    return;
  }

  if (action === 'review-shot') {
    void reviewStoredShot(target.dataset['id'] ?? '');
    return;
  }

  if (action === 'rate-stored') {
    void rateStoredShot(target.dataset['id'] ?? '', Number(target.dataset['value'] ?? 0));
    return;
  }

  if (action === 'toggle-stored-rebuttal') {
    state.storedRebuttalOpen = !state.storedRebuttalOpen;
    state.deleteArmedShotId = null;
    if (!state.storedRebuttalOpen) state.storedRebuttalReasons = [];
    render();
    if (state.storedRebuttalOpen) root.querySelector<HTMLTextAreaElement>('.stored-rebuttal textarea')?.focus();
    return;
  }


  if (action === 'stored-reason') {
    const reason = target.dataset['reason'] ?? '';
    if (!REBUTTAL_OPTIONS.some((option) => option.key === reason)) return;
    state.storedRebuttalReasons = state.storedRebuttalReasons.includes(reason)
      ? state.storedRebuttalReasons.filter((candidate) => candidate !== reason)
      : [...state.storedRebuttalReasons, reason];
    render();
    return;
  }

  if (action === 'apply-stored') {
    void applyStoredAdvice(target.dataset['id'] ?? '');
    return;
  }

  if (action === 'delete-shot') {
    void deleteStoredShot(target.dataset['id'] ?? '');
    return;
  }

  if (action === 'delete-bean') {
    void deleteBean(target.dataset['id'] ?? '');
    return;
  }

  if (action === 'expand-graph') {
    state.chartExpanded = true;
    render();
    return;
  }

  if (action === 'cycle-comparison') {
    const record = state.records.find((candidate) => candidate.id === state.selectedShotId);
    if (!record) return;
    const count = comparisonRecords(record).length;
    if (count === 0) return;
    state.comparisonOffset = state.comparisonOffset < 0
      ? 0
      : state.comparisonOffset + 1 < count
        ? state.comparisonOffset + 1
        : -1;
    render();
    return;
  }

  if (action === 'close-graph') {
    state.chartExpanded = false;
    render();
    return;
  }

  if (action === 'device-control') {
    const kind = target.dataset['device'];
    if (kind === 'machine' || kind === 'scale') void controlDevice(kind);
    return;
  }

  if (action === 'advice-details') {
    // The advice that is being summarised, if we still have it: reopening the
    // card people just came from beats sending them to a different screen.
    if (state.lastAdvice) {
      // Restore the ground too, or the card re-diffs against a machine that
      // has already been changed to match — which shows an empty card with
      // everything "held" — and forgets that it was a starting point.
      state.advice = state.lastAdvice.advice;
      state.adviceBase = state.lastAdvice.base;
      state.tab = 'brew';
      render();
      return;
    }

    // Otherwise it is the last stored shot's advice the strip is quoting. Open
    // that as the advice card, right here — the strip says "Details", and
    // being thrown onto a different tab showing a shot you did not ask for is
    // not what that word promises.
    const record = state.records.find((candidate) => candidate.advice?.full);
    if (record?.advice?.full) {
      state.advice = record.advice.full;
      state.adviceBase = { recipe: record.recipe, starting: false };
      state.tab = 'brew';
      render();
      return;
    }

    // A record from before full advice was stored has only a summary, so the
    // shot itself is the most that can be shown.
    const older = state.records.find((candidate) => candidate.advice !== null);
    if (older) {
      state.selectedShotId = older.id;
      state.tab = 'shots';
      state.shotActionError = null;
      render();
    } else {
      state.chartExpanded = true;
      render();
    }
    return;
  }

  if (action === 'toggle-rebuttal') {
    state.rebuttalOpen = !state.rebuttalOpen;
    render();
    if (state.rebuttalOpen) root.querySelector<HTMLTextAreaElement>('.rebuttal textarea')?.focus();
    return;
  }

  if (action === 'apply' && state.workflow) {
    const source = state.advice;
    // Sample advice is illustrative only. It must never write to the machine.
    if (!source || (!state.pending && !state.starter)) return;
    void applyAdviceResult(source, state.pending?.record ?? null);
    return;
  }

  if (action === 'dismiss-advice') {
    dismissAdvice();
    render();
    return;
  }

  if (action === 'undo' && state.lastApplied) {
    const { before, patch } = state.lastApplied;
    state.lastApplied = null;
    // The change is being taken back, so the confirmation of it goes too.
    state.appliedNote = null;
    state.lastAdvice = null;
    state.adviceBase = null;
    void push(undoPatch(before, patch), before, false);
  }
});

root.addEventListener('submit', (event) => {
  const form = (event.target as HTMLElement).closest<HTMLFormElement>('form[data-action]');
  if (!form) return;
  event.preventDefault();

  if (form.dataset['action'] === 'add-bean') void addBean(form);
  if (form.dataset['action'] === 'edit-bean') void editBean(form);
  if (form.dataset['action'] === 'add-batch') void addBatch(form);
  if (form.dataset['action'] === 'save-setup') saveSetup(form, true);
  if (form.dataset['action'] === 'reconsider') {
    const text = new FormData(form).get('rebuttal');
    void reconsider(String(text ?? ''));
  }
  if (form.dataset['action'] === 'reconsider-stored') {
    const text = new FormData(form).get('storedRebuttal');
    const quick = REBUTTAL_OPTIONS
      .filter((option) => state.storedRebuttalReasons.includes(option.key))
      .map((option) => option.text);
    const objection = [...quick, String(text ?? '').trim()].filter(Boolean).join(' ');
    if (objection) void reviewStoredShot(form.dataset['id'] ?? '', objection);
  }
});

/** Commit a typed grind. Rejects nonsense rather than pushing it to the machine. */
async function setGrind(raw: string): Promise<void> {
  if (!state.workflow) return;
  const trimmed = raw.trim();
  if (trimmed === '') return;

  const value = snapGrind(Number(trimmed));
  if (!isSaneGrind(value)) return;

  const diff = diffRecipe(state.recipe, { grind: value });
  if (diff.changes.length === 0) return;

  const before = state.workflow;
  state.recipe = applyDiff(state.recipe, diff);
  render();
  await push(diffToWorkflowPatch(diff, before), before);
}

root.addEventListener('change', (event) => {
  const el = event.target as HTMLInputElement;
  if (el.dataset && el.dataset['action'] === 'set-grind') {
    void setGrind(el.value);
    return;
  }

  if (el.dataset && el.dataset['action'] === 'change-model') {
    const picked = el.value;
    // "Other" means "let me type one", so the field is emptied for the user to
    // fill rather than pre-seeded with a value they did not choose.
    const model = picked === '__other__' ? ' ' : picked;
    state.settings = { ...state.settings, model: model === ' ' ? ' ' : model };
    state.storageBlocked = !saveSettings(state.settings);
    render();
    root.querySelector<HTMLInputElement>('input[name="model"]:not([type="hidden"])')?.focus();
    return;
  }

  if (el.dataset && el.dataset['action'] === 'profile-title' && state.editingProfile) {
    state.editingProfile = {
      ...state.editingProfile,
      profile: { ...state.editingProfile.profile, title: el.value }
    };
    render();
    return;
  }

  if (el.dataset && el.dataset['action'] === 'step-edit' && state.editingProfile) {
    const index = Number(el.dataset['index'] ?? -1);
    const field = el.dataset['field'] ?? '';
    if (field === 'name') {
      state.editingProfile = {
        ...state.editingProfile,
        profile: editStep(state.editingProfile.profile, index, { name: el.value })
      };
      render();
      return;
    }
    const value = Number(el.value);
    if (!Number.isFinite(value)) return;
    state.editingProfile = {
      ...state.editingProfile,
      profile: editStep(state.editingProfile.profile, index, { [field]: value } as never)
    };
    render();
    return;
  }

  // Settings save themselves as each field is left.
  const form = el.closest<HTMLFormElement>('form[data-action="save-setup"]');
  if (form) autosaveSetup(form);
});

root.addEventListener('input', (event) => {
  const area = event.target as HTMLTextAreaElement;
  if (area.name === 'rebuttal') {
    // Held in state so an unrelated re-render (a snapshot arriving, say) does
    // not wipe what is being typed.
    state.rebuttalText = area.value;
    return;
  }
  if (area.name === 'storedRebuttal') {
    state.storedRebuttalText = area.value;
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

  const form = select.closest<HTMLFormElement>('form[data-action="save-setup"]');
  if (form) state.settings = settingsFromForm(form);
  state.settings = { ...state.settings, provider: select.value as CremaSettings['provider'] };
  state.settingsSaved = false;
  state.setupTestStatus = null;
  render();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Before the first paint, so the fallback spacing is in place rather than
// applied after the layout has already been seen. The same goes for the
// hardware insets: Decaid's webview reports none, so they have to be resolved
// and published before the tab dock is positioned against them.
applyCompatFlags();
watchSafeArea();
applyTheme(state.settings.theme);
// Delegated from the app root, so it survives the re-renders that replace the
// charts themselves.
attachScrub(root);
window.addEventListener('pointerdown', prepareChime, { once: true });

render();
void refreshWorkflow();
void gateway.readDevices().then((devices) => {
  syncDeviceState(devices);
  render();
  void refreshMachineHardware();
}).catch(() => {});
// Device discovery tells us that the machine exists, but the websocket may
// not emit a fresh state snapshot after a page reload. Seed the controls from
// REST so the action rail never says "no machine connected" while the header
// correctly reports a connected machine.
void gateway.readMachineState().then((snapshot) => {
  state.machineConnected = true;
  state.machineState = snapshot.state?.state ?? null;
  state.groupTempC = snapshot.groupTemperature ?? snapshot.mixTemperature ?? null;
  render();
}).catch(() => {});
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

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.chartExpanded) {
    state.chartExpanded = false;
    render();
  }
});
