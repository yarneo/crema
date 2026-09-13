/**
 * Rendering. Plain HTML strings and a delegated click handler — no framework
 * runtime, which is the norm for Decaid skins and keeps the bundle small
 * enough to start instantly on a tablet.
 *
 * Every view here takes data and returns markup. Nothing fetches.
 */

import { formatGrind } from '../domain/grind.ts';
import { KNOWN_MODELS, defaultModel, type ProviderId } from '../advice/provider.ts';
import { formatValue, type FieldChange, type Recipe, type RecipeDiff, type RecipeField } from '../domain/recipe.ts';
import { DIALED_IN_SCORE, type TrailNode } from '../domain/trail.ts';
import { describePlan, profilePlan, type PlanPoint, type Profile } from '../domain/profile.ts';
import { stepTargetOf } from '../domain/profile-edit.ts';
import type { EvidenceWindow } from '../advice/schema.ts';
import type { FlowPhases } from '../advice/phases.ts';
import { stallVerdict } from '../advice/phases.ts';
import { RATING_QUESTIONS, SCORES, type Rating } from '../domain/rating.ts';

const escape = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

// ---------------------------------------------------------------------------
// Status strip
// ---------------------------------------------------------------------------

export interface StatusModel {
  /** URL of Decaid's own settings dashboard, or null when unknown. */
  settingsUrl: string | null;
  /** True when Decaid is hosting us and can be returned to. */
  canExit: boolean;
  gatewayOnline: boolean;
  machineConnected: boolean;
  scaleConnected: boolean;
  machineState: string | null;
  groupTempC: number | null;
  waterLevelMm: number | null;
  scaleG: number | null;
  deviceBusy?: boolean;
  busy?: boolean;
  /** Compact form for the screens that carry their own big heading. */
  compact?: boolean;
}

/**
 * The header strip.
 *
 * One row of utilities, in one flow, in a fixed order: what is connected, then
 * the machine's power state, then the way out to Decaid. Nothing here is
 * positioned outside the row — an earlier version floated the sleep control
 * with `position: fixed`, which meant it could not participate in the row's
 * alignment and drifted whenever the row wrapped.
 *
 * "Decaid ›" is a single control. Returning to the host app and opening its
 * settings page are the same intent ("get me out of the skin"), so they were
 * two buttons doing one job; the in-app exit is preferred and the URL is the
 * fallback for a skin opened in a plain browser.
 */
export function renderStatus(model: StatusModel): string {
  const gateway = model.gatewayOnline ? 'Decaid ready' : 'Decaid offline';
  const machine = model.machineConnected ? `Machine · ${model.machineState ?? 'connected'}` : 'Connect machine';
  const scale = model.scaleConnected ? 'Scale · tare' : 'Connect scale';
  const asleep = model.machineState === 'sleeping';

  const exit = model.canExit
    ? '<button class="statlink out" data-action="exit-skin">Decaid ›</button>'
    : model.settingsUrl
      ? `<a class="statlink out" href="${escape(model.settingsUrl)}">Decaid ›</a>`
      : '';

  return `
    <div class="statusbar${model.compact ? ' statusbar--compact' : ''}">
      <span class="wordmark">Crema</span>
      <div class="water-readout">
        <span>water</span>
        <b data-live-water>${escape(model.waterLevelMm === null ? '—' : `${Math.round(model.waterLevelMm)} mm`)}</b>
        <small>${escape(gateway)}</small>
      </div>
      <div class="header-utilities">
        <div class="connection-controls" aria-label="Device connections">
          <button class="connection-pill ${model.machineConnected ? 'on' : 'off'}" data-action="device-control" data-device="machine" ${model.deviceBusy ? 'disabled' : ''}>${escape(machine)}</button>
          <button class="connection-pill ${model.scaleConnected ? 'on' : 'off'}" data-action="device-control" data-device="scale" ${model.deviceBusy ? 'disabled' : ''}>${escape(scale)}</button>
        </div>
        <button class="statlink sleep-control" data-action="machine" data-state="${asleep ? 'idle' : 'sleeping'}" ${model.machineConnected && !model.busy ? '' : 'disabled'}>${asleep ? 'Wake' : 'Sleep'}</button>
        ${exit}
      </div>
      <span class="sr-only" data-live-scale>${escape(model.scaleG === null ? '—' : `${model.scaleG.toFixed(1)} g`)}</span>
    </div>`;
}

// ---------------------------------------------------------------------------
// Bean headline and the inline recipe row
// ---------------------------------------------------------------------------

export interface BeanModel {
  name: string | null;
  roaster?: string | null;
  roastDate: string | null;
}

/** Days off roast, which is real dial-in information, not decoration. */
export function daysOffRoast(roastDate: string | null, now = Date.now()): number | null {
  if (!roastDate) return null;
  const parsed = Date.parse(roastDate);
  if (Number.isNaN(parsed)) return null;
  const days = Math.floor((now - parsed) / 86_400_000);
  return days >= 0 && days < 3650 ? days : null;
}

export function renderBean(bean: BeanModel): string {
  const age = daysOffRoast(bean.roastDate);
  return `
    <button class="bean brew-jump" type="button" data-action="open-beans" aria-label="Open beans and grind">
      <span class="label">Bean</span>
      <span class="bean-title" role="heading" aria-level="1">${escape(bean.name ?? 'No bean selected')}</span>
      <span class="bean-meta">
        ${bean.roaster ? `<span>${escape(bean.roaster)}</span>` : ''}
        ${age === null ? '' : `<span>${age} ${age === 1 ? 'day' : 'days'} off roast</span>`}
      </span>
    </button>`;
}

const ratioOf = (recipe: Recipe): string =>
  recipe.doseG && recipe.targetYieldG ? `1:${(recipe.targetYieldG / recipe.doseG).toFixed(1)}` : '—';

function cell(label: string, valueHtml: string, field?: string, step?: number, action?: string): string {
  const controls =
    field === undefined
      ? ''
      : `<button class="step" data-action="dec" data-field="${field}" data-step="${step}" aria-label="decrease ${label}">−</button>
         <button class="step" data-action="inc" data-field="${field}" data-step="${step}" aria-label="increase ${label}">+</button>`;
  const [dec, inc] = controls ? controls.split('\n         ') : ['', ''];
  const tag = action ? 'button' : 'div';
  const rowTag = action ? 'span' : 'div';
  return `
    <${tag} class="cell${action ? ' recipe-jump' : ''}"${action ? ` type="button" data-action="${action}"` : ''}>
      <span class="label">${escape(label)}</span>
      <${rowTag} class="row">${dec ?? ''}<span class="value${field ? '' : ' text'}">${valueHtml}</span>${inc ?? ''}</${rowTag}>
    </${tag}>`;
}

export function renderRecipe(recipe: Recipe): string {
  const grind = recipe.grind === null ? 'Not set' : formatGrind(recipe.grind);
  return `
    <div class="recipe">
      <div class="recipe-summary">
        ${cell('Dose', escape(formatValue('doseG', recipe.doseG)))}
        <span class="recipe-arrow">›</span>
        ${cell('Yield', escape(formatValue('targetYieldG', recipe.targetYieldG)))}
        <span class="recipe-dot">·</span>
        ${cell('Profile', escape(recipe.profileTitle ?? '—'), undefined, undefined, 'open-profiles')}
        <span class="recipe-dot">·</span>
        ${cell('Temp', escape(formatValue('temperatureC', recipe.temperatureC)))}
        <span class="ratio">${escape(ratioOf(recipe))}</span>
      </div>
      <div class="grind-card">
        <button class="grind-jump" type="button" data-action="open-beans" aria-label="Open beans and grind">
          <span class="label">Grind setting</span>
          <strong class="${recipe.grind === null ? 'unset' : ''}">${escape(grind)}</strong>
        </button>
        <div class="grind-actions">
          <button data-action="dec" data-field="grind" data-step="0.05" aria-label="grind finer">finer</button>
          <span>‹</span><span>›</span>
          <button data-action="inc" data-field="grind" data-step="0.05" aria-label="grind coarser">coarser</button>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// The advice card, as a diff
// ---------------------------------------------------------------------------

export interface AdviceModel {
  diagnosis: string;
  confidence: string;
  diff: RecipeDiff;
  canUndo: boolean;
  busy: boolean;
  /** True while the pushback box is open. */
  rebuttalOpen: boolean;
  rebuttalText: string;
  /** True while a reconsider request is in flight. */
  reconsidering: boolean;
  /** Whether a shot exists to reconsider advice about. */
  canReconsider: boolean;
  /**
   * True when this is a first-shot starting point rather than a correction.
   * There is no previous recipe to move from, so the card shows the settings
   * to use rather than a before-and-after of numbers that never applied.
   */
  starting?: boolean;
}

/**
 * The single change to shout about, phrased as an instruction.
 *
 * Grind wins when it moved, because it is the usual lever and the direction
 * matters ("finer 12.0" says more than "12.4 → 12.0"). Otherwise the first
 * change in display order leads. Null when nothing changed, so the card can
 * say so instead of showing an empty hero.
 */
export function leadChange(diff: RecipeDiff): { verb: string; value: string; detail: string } | null {
  const change = diff.changes.find((c) => c.field === 'grind') ?? diff.changes[0];
  if (!change) return null;

  if (change.field === 'grind' && typeof change.from === 'number' && typeof change.to === 'number') {
    return {
      verb: change.to < change.from ? 'finer' : 'coarser',
      value: formatGrind(change.to),
      detail: `grind · ${formatGrind(change.from)} › ${formatGrind(change.to)}`
    };
  }

  if (change.field === 'profileTitle') {
    return { verb: 'switch to', value: String(change.to ?? ''), detail: 'profile' };
  }

  const verbs: Partial<Record<RecipeField, string>> = {
    doseG: 'dose',
    targetYieldG: 'yield',
    temperatureC: 'temp'
  };

  return {
    verb: verbs[change.field] ?? change.label.toLowerCase(),
    value: formatValue(change.field, change.to),
    detail: `${change.label.toLowerCase()} · ${formatValue(change.field, change.from)} › ${formatValue(change.field, change.to)}`
  };
}

function diffRow(label: string, from: string, to: string, why: string): string {
  return `
    <div class="drow">
      <span class="label k">${escape(label)}</span>
      <div>
        <div class="nums"><span class="was">${escape(from)}</span><span class="arr">→</span><span class="now">${escape(to)}</span></div>
        ${why ? `<div class="why">${escape(why)}</div>` : ''}
      </div>
    </div>`;
}

/** One setting of a starting point: the value to use, with no transition. */
function settingRow(label: string, value: string, why: string): string {
  return `
    <div class="drow">
      <span class="label k">${escape(label)}</span>
      <div>
        <div class="nums"><span class="now">${escape(value)}</span></div>
        ${why ? `<div class="why">${escape(why)}</div>` : ''}
      </div>
    </div>`;
}

export function renderAdvice(model: AdviceModel | null): string {
  if (!model) {
    return `<section class="card"><header><h2>Advice</h2></header>
      <p class="empty">Pull a shot and rate it, and the advice lands here as a single reviewable change.</p></section>`;
  }

  const { diff } = model;
  const shown = (change: FieldChange, side: 'from' | 'to'): string => {
    const value = change[side];
    return change.field === 'grind' && typeof value === 'number'
      ? formatGrind(value)
      : formatValue(change.field, value);
  };

  // A starting point sets the recipe; it does not move it. Everything the
  // advisor named is one list of settings, with no "was" — the number on the
  // dial beforehand is left over from another coffee and was never a choice.
  const rows = model.starting
    ? [...diff.changes, ...diff.held]
        .map((change) => settingRow(change.label, shown(change, 'to'), change.reason))
        .join('')
    : diff.changes
        .map((change) => diffRow(change.label, shown(change, 'from'), shown(change, 'to'), change.reason))
        .join('');

  // The held row is the point: it makes one-change-at-a-time visible rather
  // than implied, so the next shot tells us one thing cleanly.
  const held = model.starting
    ? ''
    : diff.held
        .map((h) => `${h.label.toLowerCase()} ${h.field === 'grind' && typeof h.to === 'number' ? formatGrind(h.to) : formatValue(h.field, h.to)}`)
        .join(' · ');

  // The Tcl skin's best idea: the instruction IS the headline, set large
  // enough to read from across the kitchen. The per-field diff stays, but it
  // belongs under the headline rather than being the only thing there.
  const lead = model.starting ? null : leadChange(diff);
  const startAt = model.starting
    ? [...diff.changes, ...diff.held].find((change) => change.field === 'grind') ?? null
    : null;

  return `
    <section class="card">
      <header>
        <h2>${model.starting ? 'Starting point' : 'Dial-in advice'}</h2>
        <span class="label">confidence ${escape(model.confidence)}</span>
        <button class="card-close" data-action="dismiss-advice" aria-label="Close advice">✕</button>
      </header>
      <div class="advice-body">
        ${lead ? `<div class="hero"><b>${escape(lead.verb)}</b><span>${escape(lead.value)}</span></div>
                  <div class="herosub">${escape(lead.detail)}</div>` : ''}
        ${startAt ? `<div class="hero"><b>start at</b><span>${escape(shown(startAt, 'to'))}</span></div>
                     <div class="herosub">grind \u00b7 first shot for this bag</div>` : ''}
        <p class="diagnosis">${escape(model.diagnosis)}</p>
        ${rows || '<p class="empty">Nothing to change. Pull it again the same way.</p>'}
        ${held ? `<div class="drow"><span class="label k">Held</span><div><div class="held">${escape(held)}</div><div class="why">Deliberately unchanged, so the next shot tells us one thing cleanly.</div></div></div>` : ''}
      </div>
      <!--
        Close is not optional. Applying the advice used to leave this card up
        with no exit, and the only thing that cleared it was starting another
        shot — so the screen became a trap.
      -->
      <div class="actions">
        <button class="btn primary" data-action="apply" ${model.busy ? 'disabled' : ''}>${model.starting ? 'Use these settings' : 'Use for next shot'}</button>
        ${model.canReconsider ? `<button class="btn" data-action="toggle-rebuttal">${model.rebuttalOpen ? 'Never mind' : 'I disagree'}</button>` : ''}
        <button class="btn" data-action="undo" ${model.canUndo && !model.busy ? '' : 'disabled'}>Undo</button>
        <button class="btn ghost" data-action="dismiss-advice" ${model.busy ? 'disabled' : ''}>Close</button>
      </div>
      ${model.rebuttalOpen ? rebuttalBox(model) : ''}
    </section>`;
}

export interface FirstShotModel {
  /** True only for a coffee with no shot history and no shot awaiting a rating. */
  available: boolean;
  ready: boolean;
  busy: boolean;
  hint: string | null;
}

/**
 * The AI strip under the chart.
 *
 * This is also where the first-shot offer lives. It was briefly drawn inside
 * the chart, which cost the chart — the point of that panel is the trace of
 * the last shot, and it should keep showing one whatever else is going on.
 */
/** What the last Apply put on the machine, so the brew screen can say so. */
export interface AppliedNote {
  summary: string;
  canUndo: boolean;
  busy: boolean;
}

export function renderAdviceStrip(
  message: string,
  actionable = true,
  starter: FirstShotModel | null = null,
  applied: AppliedNote | null = null,
  askingForS: number | null = null
): string {
  // Waiting for advice used to hold the taste screen with nothing but a
  // changed button label, for the thirty-odd seconds the model takes. The
  // screen is handed back instead and the wait reported here, so it reads as
  // working rather than stuck.
  if (askingForS !== null) {
    return `
      <section class="advice-strip asking-strip" role="status">
        <span class="ai-badge">AI</span>
        <span class="asking-copy">
          <b>Reading your shot<span class="ellipsis"></span></b>
          <small>Usually under a minute. You can keep using the skin.</small>
        </span>
        <span class="asking-elapsed" data-asking-elapsed>${Math.max(0, Math.round(askingForS))}s</span>
      </section>`;
  }

  // Applying used to drop you back on the brew screen with nothing to show
  // for it: the recipe row had quietly changed and there was no confirmation
  // and no way back. This says what moved, and offers the undo.
  if (applied) {
    return `
      <section class="advice-strip applied-strip" data-action="advice-details" role="button" tabindex="0"
        aria-label="Reopen the advice that was applied">
        <span class="ai-badge">AI</span>
        <span class="applied-copy">
          <b>Applied</b>
          <span>${escape(applied.summary)}</span>
        </span>
        <b class="applied-details">Details ›</b>
        ${applied.canUndo ? `<button class="btn applied-undo" data-action="undo" ${applied.busy ? 'disabled' : ''}>Undo</button>` : ''}
      </section>`;
  }

  if (starter?.available) {
    return `
      <section class="advice-strip starter-strip">
        <span class="ai-badge">AI</span>
        <span class="starter-copy">
          <b>No shots for this coffee yet.</b>
          <small>${escape(starter.hint ?? 'Ask AI for a profile, grind, dose, ratio and temperature for this bag.')}</small>
        </span>
        <button class="btn primary starter-go" data-action="starter-advice" ${starter.ready && !starter.busy ? '' : 'disabled'}>${starter.busy ? 'Asking…' : 'Get a starting point'}</button>
      </section>`;
  }

  const tag = actionable ? 'button' : 'section';
  return `
    <${tag} class="advice-strip${actionable ? '' : ' static'}" ${actionable ? 'data-action="advice-details" aria-label="Open AI advice details"' : ''}>
      <span class="ai-badge">AI</span>
      <span>${escape(message)}</span>
      ${actionable ? '<b>Details ›</b>' : ''}
    </${tag}>`;
}

/**
 * Pushing back on the advice.
 *
 * Framed as a disagreement rather than a "why?", because that is what it is
 * for: the barista tasted the cup and the model did not. The prompt is told to
 * engage with the objection and to neither cave reflexively nor repeat itself.
 */
function rebuttalBox(model: AdviceModel): string {
  return `
    <form class="rebuttal" data-action="reconsider">
      <span class="label">What did it get wrong?</span>
      <textarea name="rebuttal" rows="2" placeholder="e.g. it was not sour, it was thin and watery"
        ${model.reconsidering ? 'disabled' : ''}>${escape(model.rebuttalText)}</textarea>
      <button class="btn primary" type="submit" ${model.reconsidering ? 'disabled' : ''}>
        ${model.reconsidering ? 'Rethinking…' : 'Reconsider'}
      </button>
    </form>`;
}

// ---------------------------------------------------------------------------
// Convergence trail
// ---------------------------------------------------------------------------

export function renderTrail(nodes: readonly TrailNode[], coffeeName?: string | null, canCycle = false): string {
  const title = `Dial-in${coffeeName ? ` · ${escape(coffeeName)}` : ' trail'}`;
  if (nodes.length === 0) {
    return `<section class="card"><header><h2>${canCycle ? `<button class="trail-switch" data-action="cycle-trail">${title} ›</button>` : title}</h2></header>
      <p class="empty">Once this coffee has a few rated shots, the trail shows whether you are converging.</p></section>`;
  }

  // A wide, flat viewBox on purpose. The SVG scales to the card's width, so
  // its aspect ratio decides how much vertical space the card takes: at 210
  // units tall this card ran to ~270px on an iPad and pushed the shot list
  // itself below the fold, which is the wrong thing to be reading first.
  const W = 640;
  const H = 140;
  // The end labels are centred under their node, so the plot needs a margin
  // wide enough for half a label at each end or the first and last get clipped.
  const left = 52;
  const right = W - 52;
  const top = 26;
  const bottom = H - 44;
  const unratedY = bottom + 18;

  const span = Math.max(nodes.length - 1, 1);
  const x = (i: number) => left + (i * (right - left)) / span;
  const y = (score: number) => bottom - ((score - 1) / 4) * (bottom - top);

  let priorRated = -1;
  const segments = nodes.map((node, index) => {
    if (node.score === null) return '';
    if (priorRated < 0) {
      priorRated = index;
      return '';
    }
    const before = nodes[priorRated]!;
    const dashed = index - priorRated > 1 ? ' stroke-dasharray="7 6"' : '';
    const segment = `<line x1="${x(priorRated)}" y1="${y(before.score!)}" x2="${x(index)}" y2="${y(node.score)}" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"${dashed}/>`;
    priorRated = index;
    return segment;
  }).join('');

  const bandTop = y(5);
  const bandHeight = y(DIALED_IN_SCORE) - bandTop;

  const dots = nodes
    .map((n, i) => {
      if (n.score === null) return `<circle cx="${x(i)}" cy="${unratedY}" r="5" fill="none" stroke="var(--muted)" stroke-width="2"/>`;
      const stroke = n.direction === 'up' ? 'var(--good)' : n.direction === 'down' ? 'var(--bad)' : 'var(--muted)';
      const fill = n.dialedIn ? 'var(--accent)' : 'var(--bg)';
      return `<circle cx="${x(i)}" cy="${y(n.score)}" r="5.5" fill="${fill}" stroke="${n.dialedIn ? 'var(--accent)' : stroke}" stroke-width="2"/>`;
    })
    .join('');

  const labels = nodes
    .map((n, i) => {
      const plain = n.label === 'baseline' || n.label === 'repeat';
      // Anchor the outermost labels inward so they cannot run off the viewBox.
      const anchor = i === 0 ? 'start' : i === nodes.length - 1 ? 'end' : 'middle';
      const tx = i === 0 ? x(i) - 14 : i === nodes.length - 1 ? x(i) + 14 : x(i);
      return `<text class="trailnode${plain ? ' plain' : ''}" x="${tx}" y="${H - 8}" text-anchor="${anchor}">${escape(n.label)}</text>`;
    })
    .join('');

  return `
    <section class="card">
      <header><h2>${canCycle ? `<button class="trail-switch" data-action="cycle-trail">${title} ›</button>` : title}</h2><span class="label">${nodes.length} shots</span></header>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Taste score across this bean's shots, each labelled with the one thing that changed">
        <rect x="${left}" y="${bandTop}" width="${right - left}" height="${bandHeight}" fill="var(--good)" opacity="0.10" rx="3"/>
        <text class="tick" x="${left + 6}" y="${bandTop - 6}" fill="var(--good)">dialled in</text>
        <line class="axis" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"/>
        <text class="tick" x="${left - 9}" y="${y(5) + 4}" text-anchor="end">5</text>
        <text class="tick" x="${left - 9}" y="${y(1) + 4}" text-anchor="end">1</text>
        ${segments}
        ${dots}${labels}
      </svg>
    </section>`;
}

// ---------------------------------------------------------------------------
// Shot chart with evidence bands
// ---------------------------------------------------------------------------

export interface ShotChartModel {
  elapsedS: readonly number[];
  pressureBar: readonly number[];
  flowMlS: readonly number[];
  weightFlow?: readonly number[] | null;
  pressureGoal?: readonly number[] | null;
  flowGoal?: readonly number[] | null;
  weightG?: readonly number[] | null;
  temperatureC?: readonly number[] | null;
  previous?: {
    elapsedS: readonly number[];
    pressureBar: readonly number[];
    flowMlS: readonly number[];
    temperatureC?: readonly number[] | null;
  } | null;
  evidence: readonly EvidenceWindow[];
  phases: FlowPhases | null;
  title?: string;
  comparisonLabel?: string | null;
  canCycleComparison?: boolean;
}


export function renderShot(model: ShotChartModel | null, detailed = false): string {
  if (!model || model.elapsedS.length < 2) {
    return `<section class="card shot-placeholder">
      <header><h2>Last shot</h2></header>
      <div class="first-shot">
        <p class="empty">Pull a shot and its pressure and flow are drawn here, live.</p>
      </div>
    </section>`;
  }

  const W = 1000;
  const showDetail = detailed && Boolean(model.weightG?.length || model.temperatureC?.length);
  const H = showDetail ? 410 : detailed ? 285 : 260;
  const left = 46;
  const right = W - 46;
  const top = 16;
  const primaryBottom = showDetail ? 248 : H - 30;
  const detailTop = 292;
  const detailBottom = H - 30;

  const duration = Math.max(model.elapsedS[model.elapsedS.length - 1]!, model.previous?.elapsedS.at(-1) ?? 0, 0.1);
  const maxY = 12; // bar and mL/s share a 0-12 axis, as on the DE1's own chart
  const x = (t: number) => left + (t / duration) * (right - left);
  const y = (v: number) => primaryBottom - (Math.max(0, Math.min(maxY, v)) / maxY) * (primaryBottom - top);

  const path = (elapsed: readonly number[], values: readonly number[], yFor: (v: number) => number = y) =>
    values.slice(0, elapsed.length).map((v, i) => `${x(elapsed[i] ?? 0)},${yFor(v)}`).join(' ');
  const mainPath = (values: readonly number[]) => path(model.elapsedS, values);

  // Recover profile-stage boundaries from its pressure/flow targets. A jump
  // or a switch between pressure and flow control is a real new stage; small
  // sample-by-sample ramps are deliberately ignored.
  const goalLength = Math.min(model.elapsedS.length, model.pressureGoal?.length ?? 0, model.flowGoal?.length ?? 0);
  const regime = (index: number): { kind: 'p' | 'f' | '-'; target: number } => {
    const pressure = model.pressureGoal?.[index] ?? 0;
    const flow = model.flowGoal?.[index] ?? 0;
    if (Number.isFinite(pressure) && pressure > 0) return { kind: 'p', target: pressure };
    if (Number.isFinite(flow) && flow > 0) return { kind: 'f', target: flow };
    return { kind: '-', target: 0 };
  };
  const boundaryIndexes: number[] = goalLength >= 4 ? [0] : [];
  for (let index = 1; index < goalLength; index += 1) {
    const before = regime(index - 1);
    const after = regime(index);
    const jumpLimit = after.kind === 'p' ? 0.4 : 0.7;
    if (after.kind === before.kind && Math.abs(after.target - before.target) <= jumpLimit) continue;
    const previousBoundary = boundaryIndexes.at(-1) ?? 0;
    if ((model.elapsedS[index] ?? 0) - (model.elapsedS[previousBoundary] ?? 0) >= 0.5) boundaryIndexes.push(index);
  }
  // Labels are spaced in PIXELS, not in seconds.
  //
  // The boundaries themselves are kept 0.5s apart, which on a 35s shot is
  // about thirteen pixels — while "8.0 mL/s" is nearer fifty. So on a busy
  // profile the labels sat on top of each other. The dividing line is still
  // drawn at every boundary; only the text is dropped when there is no room
  // for it, which is the part that could not be read anyway.
  const MIN_LABEL_GAP_PX = 58;
  let lastLabelX = -Infinity;

  const stageMarkers = boundaryIndexes.map((index, markerIndex) => {
    const point = regime(index);
    const label = point.kind === 'p' ? `${point.target.toFixed(1)} bar` : point.kind === 'f' ? `${point.target.toFixed(1)} mL/s` : 'preinfuse';
    const sx = x(model.elapsedS[index] ?? 0);

    const line = markerIndex === 0
      ? ''
      : `<line class="stage-line" x1="${sx}" y1="${top}" x2="${sx}" y2="${primaryBottom}"/>`;

    // Also drop a label that would run off the right edge rather than clipping it.
    const room = sx + MIN_LABEL_GAP_PX <= right;
    if (sx - lastLabelX < MIN_LABEL_GAP_PX || !room) return line;
    lastLabelX = sx;

    return `${line}<text class="stage-label" x="${sx + 5}" y="${top + 12}">${label}</text>`;
  }).join('');

  // The evidence band is the whole point: the model cites a window, we shade
  // it, and the diagnosis stops being an assertion.
  const bands = model.evidence
    .map((w) => {
      const bx = x(w.fromS);
      const bw = Math.max(x(w.toS) - bx, 2);
      return `
        <rect x="${bx}" y="${top}" width="${bw}" height="${primaryBottom - top}" fill="var(--accent)" opacity="0.13"/>
        <line class="gridline" x1="${bx}" y1="${top}" x2="${bx}" y2="${primaryBottom}" stroke="var(--accent)" stroke-dasharray="3 3"/>
        <line class="gridline" x1="${bx + bw}" y1="${top}" x2="${bx + bw}" y2="${primaryBottom}" stroke="var(--accent)" stroke-dasharray="3 3"/>
        ${w.label ? `<text class="evlabel" x="${bx + 5}" y="${top + 30}">${escape(w.label)}</text>` : ''}`;
    })
    .join('');

  const verdict = model.phases ? stallVerdict(model.phases) : null;
  const yGrid = [0, 3, 6, 9, 12]
    .map((tick) => `<line class="gridline" x1="${left}" y1="${y(tick)}" x2="${right}" y2="${y(tick)}"/><text class="tick" x="${left - 9}" y="${y(tick) + 4}" text-anchor="end">${tick}</text>`)
    .join('');
  const previous = model.previous
    ? `<polyline class="previous-line" points="${path(model.previous.elapsedS, model.previous.pressureBar)}" fill="none" stroke="var(--good)"/>
       <polyline class="previous-line" points="${path(model.previous.elapsedS, model.previous.flowMlS)}" fill="none" stroke="var(--blue)"/>`
    : '';
  const goals = `${model.pressureGoal?.length ? `<polyline class="goal-line" points="${mainPath(model.pressureGoal)}" fill="none" stroke="var(--good)"/>` : ''}
    ${model.flowGoal?.length ? `<polyline class="goal-line" points="${mainPath(model.flowGoal)}" fill="none" stroke="var(--blue)"/>` : ''}`;

  let detailPlot = '';
  if (showDetail) {
    const maxWeight = Math.max(50, ...(model.weightG ?? [0]));
    const weightY = (value: number) => detailBottom - (Math.max(0, value) / maxWeight) * (detailBottom - detailTop);
    const tempY = (value: number) => detailBottom - ((Math.max(75, Math.min(100, value)) - 75) / 25) * (detailBottom - detailTop);
    detailPlot = `
      <line class="axis" x1="${left}" y1="${detailBottom}" x2="${right}" y2="${detailBottom}"/>
      <line class="axis" x1="${left}" y1="${detailTop}" x2="${left}" y2="${detailBottom}"/>
      <text class="tick" x="${left}" y="${detailTop - 8}">weight · 0–${Math.ceil(maxWeight)}g</text>
      <text class="tick" x="${right}" y="${detailTop - 8}" text-anchor="end">temperature · 75–100°C</text>
      ${model.weightG?.length ? `<polyline points="${path(model.elapsedS, model.weightG, weightY)}" fill="none" stroke="var(--accent)" stroke-width="2.4"/>` : ''}
      ${model.previous?.temperatureC?.length ? `<polyline class="previous-line" points="${path(model.previous.elapsedS, model.previous.temperatureC, tempY)}" fill="none" stroke="var(--warm)"/>` : ''}
      ${model.temperatureC?.length ? `<polyline points="${path(model.elapsedS, model.temperatureC, tempY)}" fill="none" stroke="var(--warm)" stroke-width="2.4"/>` : ''}`;
  }

  return `
    <section class="card shot-chart${detailed ? ' detailed' : ''}">
      <header>
        <h2>${escape(model.title ?? 'Last shot')}</h2>
        <div class="chart-heading"><span class="label">${duration.toFixed(1)}s${
          model.phases ? ` · ${model.phases.preinfusionS}s to first flow${verdict ? ` · ${verdict}` : ''}` : ''
        }</span>${model.canCycleComparison ? `<button class="btn compare-cycle" data-action="cycle-comparison">${escape(model.comparisonLabel ? `Compare · ${model.comparisonLabel}` : 'Compare · off')}</button>` : ''}</div>
      </header>
      ${detailed ? '' : '<button class="graph-open" data-action="expand-graph">Detailed graph ↗</button>'}
      <!--
        data-scrub carries just enough geometry to turn a touch back into a
        time and a value: the plot box, the axis maximum and the shot length.
        The samples themselves are not repeated here — they are already in the
        polylines below, and reading them back beats shipping 350 numbers
        twice.
      -->
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pressure and flow over the shot, with the cited window shaded"
        data-scrub="${left},${right},${top},${primaryBottom},${maxY},${duration}">
        ${bands}
        ${yGrid}
        ${stageMarkers}
        <line class="axis" x1="${left}" y1="${primaryBottom}" x2="${right}" y2="${primaryBottom}"/>
        <line class="axis" x1="${left}" y1="${top}" x2="${left}" y2="${primaryBottom}"/>
        ${previous}${goals}
        <polyline points="${mainPath(model.pressureBar)}" fill="none" stroke="var(--good)" stroke-width="2.2" stroke-linejoin="round"/>
        <polyline points="${mainPath(model.flowMlS)}" fill="none" stroke="var(--blue)" stroke-width="2.2" stroke-linejoin="round"/>
        ${model.weightFlow?.length ? `<polyline points="${mainPath(model.weightFlow)}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/>` : ''}
        ${detailPlot}
        <text class="tick" x="${left}" y="${H - 10}">0s</text>
        <text class="tick" x="${right}" y="${H - 10}" text-anchor="end">${duration.toFixed(0)}s</text>
        <g class="scrub" aria-hidden="true">
          <line class="scrub-line" y1="${top}" y2="${primaryBottom}"/>
          <circle class="scrub-dot" data-series="pressure" r="4.5" fill="var(--good)"/>
          <circle class="scrub-dot" data-series="flow" r="4.5" fill="var(--blue)"/>
          ${model.weightFlow?.length ? '<circle class="scrub-dot" data-series="weight" r="4.5" fill="var(--accent)"/>' : ''}
        </g>
      </svg>
      <div class="scrub-readout" aria-live="polite"></div>
      <div class="legend">
        <span><i style="background:var(--good)"></i>pressure · bar</span>
        <span><i style="background:var(--blue)"></i>flow · mL/s</span>
        ${model.weightFlow?.length ? '<span><i style="background:var(--accent)"></i>weight · g/s</span>' : ''}
        ${model.pressureGoal?.length || model.flowGoal?.length ? '<span class="target-key"><i></i>target</span>' : '<span class="target-key unavailable"><i></i>target · captured next shot</span>'}
        ${model.previous ? `<span class="previous-key"><i></i>${escape(model.comparisonLabel ?? 'previous shot')}</span>` : `<span class="previous-key unavailable"><i></i>${model.canCycleComparison ? 'comparison off' : 'previous shot · none for this bean'}</span>`}
        ${showDetail && model.weightG?.length ? '<span><i style="background:var(--accent)"></i>total weight · g</span>' : ''}
        ${showDetail && model.temperatureC?.length ? '<span><i style="background:var(--warm)"></i>temperature · °C</span>' : ''}
        ${model.evidence.length ? '<span><i style="background:var(--accent)"></i>what the advice is pointing at</span>' : ''}
      </div>
    </section>`;
}

export function renderGraphOverlay(model: ShotChartModel): string {
  const finalWeight = model.weightG?.at(-1);
  const peakPressure = Math.max(...model.pressureBar);
  const peakFlow = Math.max(...model.flowMlS);
  return `<div class="graph-overlay" role="dialog" aria-modal="true" aria-label="Detailed shot graph">
    <div class="graph-dialog">
      <button class="graph-close" data-action="close-graph" aria-label="Close detailed graph">×</button>
      ${renderShot(model, true)}
      <div class="graph-stats">
        <span><small>Peak pressure</small><b>${peakPressure.toFixed(1)} bar</b></span>
        <span><small>Peak flow</small><b>${peakFlow.toFixed(1)} mL/s</b></span>
        <span><small>Final weight</small><b>${finalWeight === undefined ? '—' : `${finalWeight.toFixed(1)} g`}</b></span>
        <span><small>First flow</small><b>${model.phases ? `${model.phases.preinfusionS.toFixed(1)} s` : '—'}</b></span>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export const TABS = ['brew', 'shots', 'beans', 'profiles', 'setup'] as const;
export type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  brew: 'Brew',
  profiles: 'Profiles',
  beans: 'Beans & grind',
  shots: 'Shots',
  setup: 'Settings'
};

export function renderNav(active: Tab, needsSetup: boolean): string {
  const items = TABS.map((tab) => {
    const badge = tab === 'setup' && needsSetup ? '<i class="dot"></i>' : '';
    return `<button class="tab${tab === active ? ' on' : ''}" data-action="tab" data-tab="${tab}"${tab === active ? ' aria-current="page"' : ''}>${TAB_LABELS[tab]}${badge}</button>`;
  }).join('');
  return `<nav class="tabs">${items}</nav>`;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface ProfileRow {
  id: string;
  title: string;
  author: string;
  steps: number;
  /** The profile itself, so the row can draw what it plans to do. */
  plan?: Profile;
  /** How many of this barista's shots used it — what "recently used" means here. */
  usedCount?: number;
  active: boolean;
}

/**
 * A profile's plan, small enough to sit in a list row.
 *
 * "Adaptive v3 · Decent · 7 steps" tells you nothing about what the machine
 * will do. The same row with a nine-bar block and a decline drawn next to it
 * tells you at a glance, which is the whole reason to look at this screen.
 */
function planSpark(plan: { points: readonly PlanPoint[]; totalS: number }): string {
  if (plan.points.length < 2 || plan.totalS <= 0) return '<div class="spark empty-spark"></div>';

  const W = 116;
  const H = 34;
  const maxY = 12; // the same 0-12 axis the shot chart uses, so shapes compare
  const x = (t: number) => (t / plan.totalS) * W;
  const y = (v: number) => H - Math.max(0, Math.min(maxY, v)) / maxY * H;

  const line = (pick: (point: PlanPoint) => number | null, stroke: string): string => {
    const points = plan.points
      .map((point) => {
        const value = pick(point);
        return value === null ? null : `${x(point.t).toFixed(1)},${y(value).toFixed(1)}`;
      })
      .filter((pair): pair is string => pair !== null);
    if (points.length < 2) return '';
    return `<polyline points="${points.join(' ')}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round"/>`;
  };

  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    ${line((point) => point.pressure, 'var(--good)')}
    ${line((point) => point.flow, 'var(--blue)')}
  </svg>`;
}

export interface ProfileEditorModel {
  profile: Profile;
  /** Why it cannot be saved yet, or null. */
  problem: string | null;
  busy: boolean;
  /** True when this is a brand new profile rather than a copy of one. */
  fresh: boolean;
}

/**
 * The step editor.
 *
 * Four fields per step, because those four decide the shape of a shot: what it
 * holds, at what value, for how long, and how hot. Exit conditions and
 * limiters are preserved but not shown — they are carried through a duplicate
 * untouched, and adding them here would turn a dial-in coach into a profile
 * IDE.
 */
export function renderProfileEditor(model: ProfileEditorModel): string {
  const steps = model.profile.steps ?? [];
  const plan = profilePlan(model.profile);

  const rows = steps.map((step, index) => {
    const target = stepTargetOf(step);
    const unit = step.pump === 'pressure' ? 'bar' : 'mL/s';
    return `
      <li class="stepcard">
        <div class="stepcard-head">
          <span class="steporder">${index + 1}</span>
          <input class="stepname" name="name" value="${escape(step.name)}" aria-label="Step ${index + 1} name"
            data-action="step-edit" data-index="${index}" data-field="name" />
          <span class="stepmove">
            <button type="button" data-action="step-move" data-index="${index}" data-by="-1" aria-label="Move step up" ${index === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" data-action="step-move" data-index="${index}" data-by="1" aria-label="Move step down" ${index === steps.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="stepdrop" data-action="step-remove" data-index="${index}" aria-label="Remove step" ${steps.length <= 1 ? 'disabled' : ''}>✕</button>
          </span>
        </div>
        <div class="stepfields">
          <label class="bag-field"><span class="label">Holds</span>
            <span class="chips">
              ${(['pressure', 'flow'] as const).map((mode) =>
                `<button type="button" class="chip${step.pump === mode ? ' on' : ''}" data-action="step-edit" data-index="${index}" data-field="pump" data-value="${mode}">${mode === 'pressure' ? 'Pressure' : 'Flow'}</button>`
              ).join('')}
            </span>
          </label>
          <label class="bag-field"><span class="label">Target <em>${unit}</em></span>
            <input type="number" inputmode="decimal" step="0.1" min="0" value="${target}"
              data-action="step-edit" data-index="${index}" data-field="target" />
          </label>
          <label class="bag-field"><span class="label">Seconds</span>
            <input type="number" inputmode="numeric" step="1" min="0" value="${step.seconds ?? 0}"
              data-action="step-edit" data-index="${index}" data-field="seconds" />
          </label>
          <label class="bag-field"><span class="label">Temp <em>°C</em></span>
            <input type="number" inputmode="decimal" step="0.5" min="0" value="${step.temperature ?? ''}"
              data-action="step-edit" data-index="${index}" data-field="temperature" />
          </label>
          <label class="bag-field"><span class="label">Enters</span>
            <span class="chips">
              ${(['fast', 'smooth'] as const).map((mode) =>
                `<button type="button" class="chip${step.transition === mode ? ' on' : ''}" data-action="step-edit" data-index="${index}" data-field="transition" data-value="${mode}">${mode === 'fast' ? 'Jump' : 'Ramp'}</button>`
              ).join('')}
            </span>
          </label>
        </div>
      </li>`;
  }).join('');

  return `
    <main class="screen profile-editor">
      <header class="screen-heading">
        <div><h1>${model.fresh ? 'New profile' : 'Edit profile'}</h1><p>${escape(describePlan(model.profile))}</p></div>
        <button class="btn" type="button" data-action="profile-edit-close">Cancel</button>
      </header>

      <div class="editor-top">
        <label class="bag-field editor-title"><span class="label">Name</span>
          <input name="profileTitle" value="${escape(model.profile.title ?? '')}" data-action="profile-title"
            placeholder="What to call it" />
        </label>
        <div class="editor-preview">${planSpark(plan)}</div>
      </div>

      <ol class="steplist">${rows}</ol>

      <div class="editor-actions">
        <button class="btn" type="button" data-action="step-add" ${model.busy ? 'disabled' : ''}>Add step</button>
        <span class="editor-problem">${model.problem ? escape(model.problem) : ''}</span>
        <button class="btn primary" type="button" data-action="profile-save" ${model.problem || model.busy ? 'disabled' : ''}>
          ${model.busy ? 'Saving…' : 'Save &amp; use'}
        </button>
      </div>
    </main>`;
}

export function renderProfiles(rows: readonly ProfileRow[], filter: string, busy: boolean): string {
  if (rows.length === 0) {
    return `<main class="screen profiles-screen"><header class="screen-heading"><div><h1>Profiles</h1><p>Choose the pressure and flow plan for the next shot.</p></div></header>
      <p class="empty empty-screen">No profiles from the gateway yet.</p></main>`;
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle ? rows.filter((r) => r.title.toLowerCase().includes(needle)) : rows;

  const row = (entry: ProfileRow): string => `
      <button class="listrow profilerow${entry.active ? ' active' : ''}" data-action="use-profile" data-id="${escape(entry.id)}" ${busy ? 'disabled' : ''}>
        <span class="rowmain">${escape(entry.title)}</span>
        <span class="rowmeta">${escape(entry.author || 'unknown')} · ${escape(entry.plan ? describePlan(entry.plan) : `${entry.steps} steps`)}</span>
        ${entry.plan ? planSpark(profilePlan(entry.plan)) : ''}
        <span class="rowcopy" data-action="profile-duplicate" data-id="${escape(entry.id)}" role="button" tabindex="0"
          aria-label="Duplicate ${escape(entry.title)}">copy</span>
        ${entry.active
          ? '<span class="pill ok">in use</span>'
          : entry.usedCount
            ? `<span class="rowgo">${entry.usedCount} shot${entry.usedCount === 1 ? '' : 's'}</span>`
            : '<span class="rowgo">use</span>'}
      </button>`;

  // Grouped, because 73 profiles in gateway order is a haystack. What is on
  // the machine now, then what this barista has actually pulled with, then the
  // rest. Searching flattens it — you already know what you are looking for.
  const section = (title: string, entries: readonly ProfileRow[]): string =>
    entries.length === 0
      ? ''
      : `<h2 class="profile-group">${escape(title)}</h2><div class="list">${entries.map(row).join('')}</div>`;

  const body = needle
    ? `<div class="list">${shown.map(row).join('') || '<p class="empty">Nothing matches that.</p>'}</div>`
    : [
        section('In use', shown.filter((entry) => entry.active)),
        section('You have brewed with', shown.filter((entry) => !entry.active && (entry.usedCount ?? 0) > 0)),
        section('Everything else', shown.filter((entry) => !entry.active && !(entry.usedCount ?? 0)))
      ].join('');

  return `
    <main class="screen profiles-screen">
      <header class="screen-heading"><div><h1>Profiles</h1><p>Choose the pressure and flow plan for the next shot.</p></div><span>${shown.length} of ${rows.length}</span></header>
      <div class="profile-tools">
        <input class="search" type="search" placeholder="Search profiles" value="${escape(filter)}" data-action="filter-profiles" />
        <button class="btn" type="button" data-action="profile-new" ${busy ? 'disabled' : ''}>New profile</button>
      </div>
      ${body}
    </main>`;
}

// ---------------------------------------------------------------------------
// Beans
// ---------------------------------------------------------------------------

export interface BeanRow {
  id: string;
  roaster: string;
  name: string;
  origin: string;
  active: boolean;
}

export interface BatchRow {
  id: string;
  roastDate: string | null;
  roastLevel: string | null;
  daysOffRoast: number | null;
  weightRemaining: number | null;
  active: boolean;
}

export interface BeansModel {
  rows: readonly BeanRow[];
  busy: boolean;
  /** The bean whose batches are shown, when one is selected. */
  activeBeanId: string | null;
  activeBeanName: string | null;
  batches: readonly BatchRow[] | null;
  grind?: number | null;
  grinderName?: string | null;
  /** The dial range from Settings, which decides whether a nudge can seed. */
  grinderRange?: string | null;
  activeBean?: BeanRow | null;
  /** The bean whose details are open for editing, when one is. */
  editingBean?: BeanRow | null;
  /** In-progress choices on the add-bag form, held in state so a re-render keeps them. */
  newBatch?: { roastLevel: string | null; weightG: number | null };
  deleteArmed?: boolean;
  starterAvailable?: boolean;
  starterReady?: boolean;
  starterBusy?: boolean;
  starterHint?: string | null;
}

/**
 * The bags of the selected bean.
 *
 * Roast date lives on the batch rather than the bean, so this is where
 * days-off-roast actually comes from — and days-off-roast changes the advice,
 * which is why it is worth the extra screen.
 */
/**
 * Roast level is a fixed vocabulary, as it is in the machine app, where the
 * field is a `category` shown in a combobox rather than free text. It also
 * feeds the advisor — "the strongest input for a useful starting point" — so a
 * consistent ordinal scale is worth more than whatever someone types twice.
 */
export const ROAST_LEVELS = ['Light', 'Medium-light', 'Medium', 'Medium-dark', 'Dark'] as const;

/** Where the bag-size stepper starts, and how far each tap moves it. */
export const BAG_SIZE_START_G = 250;
export const BAG_SIZE_STEP_G = 50;

/** Format a bag weight the way the bag is labelled. */
export function formatBagSize(grams: number | null): string {
  if (grams === null || grams <= 0) return 'Not set';
  return grams % 1000 === 0 ? `${grams / 1000} kg` : `${grams} g`;
}

function renderBatches(model: BeansModel): string {
  if (model.activeBeanId === null) {
    return '<p class="empty">Select a bean to record its bags and roast dates.</p>';
  }
  if (model.batches === null) {
    return '<p class="empty">Loading bags…</p>';
  }

  const list = model.batches
    .map((batch) => {
      const age =
        batch.daysOffRoast === null
          ? 'no roast date'
          : `${batch.daysOffRoast} ${batch.daysOffRoast === 1 ? 'day' : 'days'} off roast`;
      const left = batch.weightRemaining === null ? '' : ` · ${Math.round(batch.weightRemaining)}g left`;
      return `
        <button class="listrow${batch.active ? ' active' : ''}" data-action="use-batch" data-id="${escape(batch.id)}" ${model.busy ? 'disabled' : ''}>
          <span class="rowmain">${escape(batch.roastDate ? new Date(batch.roastDate).toLocaleDateString() : 'undated bag')}</span>
          <span class="rowmeta">${escape(age)}${escape(left)}${batch.roastLevel ? ` · ${escape(batch.roastLevel)}` : ''}</span>
          ${batch.active ? '<span class="pill ok">in use</span>' : '<span class="rowgo">use</span>'}
        </button>`;
    })
    .join('');

  const chosen = model.newBatch ?? { roastLevel: null, weightG: null };

  const levelChips = ROAST_LEVELS.map(
    (level) =>
      `<button type="button" class="chip${chosen.roastLevel === level ? ' on' : ''}" data-action="pick-roast-level" data-value="${escape(level)}">${escape(level)}</button>`
  ).join('');

  return `
    ${list ? `<div class="list">${list}</div>` : '<p class="empty">No bags recorded for this bean yet.</p>'}
    <form class="addbean bag-form" data-action="add-batch">
      <!--
        Every field carries its own visible label. The roast date was an
        unlabelled empty box before, which on a tablet is indistinguishable
        from no field at all, and the other two were free text where the
        machine app offers a fixed vocabulary.
      -->
      <label class="bag-field">
        <span class="label">Roast date</span>
        <!--
          A date input cannot carry a placeholder, and Safari draws an empty
          one as a bare box — which is why this field read as missing. The hint
          is an overlay instead, shown while the input is still :invalid
          (which for a required date means "empty") and gone the moment a date
          is picked.
        -->
        <span class="date-wrap">
          <input name="roastDate" type="date" required />
          <span class="date-hint" aria-hidden="true">Tap to choose the roast date</span>
        </span>
      </label>

      <div class="bag-field">
        <span class="label">Roast level <em>optional</em></span>
        <div class="chips">${levelChips}</div>
      </div>

      <div class="bag-field">
        <span class="label">Bag size <em>optional</em></span>
        <div class="bag-stepper">
          <button type="button" class="step" data-action="bag-size" data-step="-${BAG_SIZE_STEP_G}" aria-label="smaller bag">−</button>
          <span class="bag-size-value${chosen.weightG === null ? ' unset' : ''}">${escape(formatBagSize(chosen.weightG))}</span>
          <button type="button" class="step" data-action="bag-size" data-step="${BAG_SIZE_STEP_G}" aria-label="larger bag">+</button>
        </div>
      </div>

      <button class="btn primary bag-submit" type="submit" ${model.busy ? 'disabled' : ''}>Add bag</button>
    </form>`;
}

export function renderBeansScreen(model: BeansModel): string {
  return `
    <main class="screen beans-screen">
      <header class="screen-heading"><div><h1>Beans &amp; grind</h1><p>Keep each coffee and bag tied to the setting that dialled it in.</p></div></header>
      <div class="beans-grid">
        ${renderBeans(model.rows, model.busy, model.editingBean ?? null, model.deleteArmed ?? false)}
        <section class="card bags-card">
      <header>
        <h2>Bags${model.activeBeanName ? ` · ${escape(model.activeBeanName)}` : ''}</h2>
        ${model.batches ? `<span class="label">${model.batches.length} recorded</span>` : ''}
      </header>
      ${renderBatches(model)}
        </section>
        <section class="grind-library-card">
          <span class="label">${escape(model.grinderName || 'Grind setting')}</span>
          <!--
            Typeable, not just steppable. Grinders run on wildly different
            scales — 0.1-0.5 on a Lagom, 0-50 on a Niche — so stepping by 0.05
            from nothing cannot reach the barista's number, and before this
            there was no way to set a grind at all.
          -->
          <input class="grind-entry${model.grind === null || model.grind === undefined ? ' unset' : ''}"
            type="number" inputmode="decimal" step="0.05" min="0"
            name="grind" data-action="set-grind" aria-label="Grind setting"
            placeholder="Not set"
            value="${model.grind === null || model.grind === undefined ? '' : escape(formatGrind(model.grind))}" />
          <div class="grind-actions">
            <button data-action="dec" data-field="grind" data-step="0.05">finer</button><span>‹</span><span>›</span><button data-action="inc" data-field="grind" data-step="0.05">coarser</button>
          </div>
          ${model.grind === null || model.grind === undefined
            ? `<p class="grind-hint">${model.grinderRange ? 'Tap the number to type it, or nudge to start from the middle of your dial range.' : 'Tap the number to type your grinder&rsquo;s setting.'}</p>`
            : ''}
        </section>
      </div>
    </main>`;
}

/**
 * The edit panel, rendered directly under the row it belongs to.
 *
 * It used to live at the foot of the screen, which meant tapping the pencil
 * appeared to do nothing at all until you scrolled down and found it.
 */
function beanEditor(bean: BeanRow, busy: boolean, deleteArmed: boolean): string {
  return `
    <section class="bean-editor-inline">
      <p class="bean-editor-note">Correct a typo without losing this coffee&rsquo;s shot history.</p>
      <form class="editbean" data-action="edit-bean" data-id="${escape(bean.id)}">
        <label class="bag-field"><span class="label">Roaster</span><input name="roaster" value="${escape(bean.roaster)}" required /></label>
        <label class="bag-field"><span class="label">Bean</span><input name="name" value="${escape(bean.name)}" required /></label>
        <label class="bag-field"><span class="label">Origin <em>optional</em></span><input name="country" value="${escape(bean.origin)}" /></label>
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>Save details</button>
      </form>
      <div class="bean-danger">
        <button class="btn danger" type="button" data-action="delete-bean" data-id="${escape(bean.id)}" ${busy ? 'disabled' : ''}>${deleteArmed ? 'Tap again to delete bean' : 'Delete bean'}</button>
      </div>
    </section>`;
}

export function renderBeans(
  rows: readonly BeanRow[],
  busy: boolean,
  editing: BeanRow | null = null,
  deleteArmed = false
): string {
  const list = rows
    .map(
      (row) => `
      <div class="beanrow${row.active ? ' active' : ''}${editing?.id === row.id ? ' editing' : ''}">
        <button class="listrow" data-action="use-bean" data-id="${escape(row.id)}" ${busy ? 'disabled' : ''}>
          <span class="rowmain">${escape(row.name)}</span>
          <span class="rowmeta">${escape(row.roaster)}${row.origin ? ` · ${escape(row.origin)}` : ''}</span>
          ${row.active ? '<span class="pill ok">in use</span>' : '<span class="rowgo">use</span>'}
        </button>
        <button class="beanedit" data-action="${editing?.id === row.id ? 'edit-bean-close' : 'edit-bean-open'}" data-id="${escape(row.id)}"
          aria-label="${editing?.id === row.id ? 'Close' : 'Edit'} ${escape(row.name)}" ${busy ? 'disabled' : ''}>${editing?.id === row.id ? '✕' : '✎'}</button>
      </div>
      ${editing?.id === row.id ? beanEditor(editing, busy, deleteArmed) : ''}`
    )
    .join('');

  return `
    <section class="card beans-library-card">
      <header><h2>Beans</h2><span class="label">${rows.length} in the library</span></header>
      ${list ? `<div class="list">${list}</div>` : '<p class="empty">No beans yet. Add the bag in the hopper and Crema will keep its dial-in.</p>'}
      <form class="addbean" data-action="add-bean">
        <input name="roaster" placeholder="Roaster" required />
        <input name="name" placeholder="Bean" required />
        <input name="country" placeholder="Origin (optional)" />
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>Add bean</button>
      </form>
    </section>`;
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

export interface ShotRow {
  id: string;
  when: string;
  profileTitle: string;
  coffeeName: string;
  summary: string;
  grind?: string;
  duration?: string;
  score?: string;
  scoreValue?: number | null;
  taste?: string | null;
  adviceSummary?: string | null;
  inTrail?: boolean;
}

export interface ShotDetailModel {
  id?: string;
  summary: string;
  when: string;
  profileTitle: string;
  coffeeName: string;
  rating: string;
  score?: number | null;
  advice: { summary: string; diagnosis: string } | null;
  chart: ShotChartModel | null;
  ready?: boolean;
  busy?: boolean;
  canApply?: boolean;
  rebuttalOpen?: boolean;
  rebuttalText?: string;
  rebuttalReasons?: readonly string[];
  error?: string | null;
  deleteArmed?: boolean;
}

export const REBUTTAL_OPTIONS = [
  { key: 'slow', label: 'Already ran slow', text: 'This shot already ran slow, so slowing it further seems wrong to me.' },
  { key: 'worse', label: 'Tasted worse that way', text: 'I tried that direction before and it tasted worse, not better.' },
  { key: 'grind', label: 'Different grind', text: 'I was not on the grind you assumed; re-check the dial I actually used.' },
  { key: 'hot', label: 'Hot enough already', text: 'The brew temperature is already high enough; I do not want to go hotter.' },
  { key: 'channel', label: 'Maybe channeling', text: 'The flow looked uneven; could this be channeling rather than grind?' },
  { key: 'lever', label: 'Try another lever', text: 'I would rather change the ratio or profile than the grind.' }
] as const;

export function renderShots(
  rows: readonly ShotRow[],
  total: number,
  selectedId: string | null,
  detail: ShotDetailModel | null,
  trail: readonly TrailNode[] = [],
  trailCoffee?: string | null,
  canCycleTrail = false
): string {
  // With nothing recorded there is nothing to plot, and a trail card here said
  // the opposite of the sentence directly beneath it.
  if (rows.length === 0) {
    return `<main class="screen shot-history"><header class="screen-heading"><div><h1>Recent shots</h1><p>Your saved recipes, tasting notes, and advice.</p></div></header>
      <p class="empty empty-screen">No shots recorded yet. Pull one and it will appear here with its advice — and once a coffee has a few rated shots, its dial-in trail appears above.</p></main>`;
  }

  const list = rows
    .map(
      (row) => `
      <button class="shot-row${row.id === selectedId ? ' active' : ''}${row.inTrail ? ' in-trail' : ''}" data-action="open-shot" data-id="${escape(row.id)}">
        <span class="shot-copy">
          <b>${escape(row.coffeeName || 'Coffee')}</b>
          <small>${escape([row.when, row.duration, row.grind && row.grind !== '—' ? `grind ${row.grind}` : null, row.taste].filter(Boolean).join(' · '))}</small>
          <small class="shot-advice">${escape(row.adviceSummary ?? 'No AI review yet')}</small>
        </span>
        <strong class="shot-recipe">${escape(row.summary)}</strong>
        <span class="shot-score ${row.scoreValue !== null && row.scoreValue !== undefined && row.scoreValue >= 4 ? 'good' : ''}">
          ${row.scoreValue === null || row.scoreValue === undefined ? 'Rate ›' : `${row.scoreValue}/5`}
          <small>Open review ›</small>
        </span>
      </button>`
    )
    .join('');

  return `
    <main class="screen shot-history">
      <header class="screen-heading"><div><h1>Recent shots</h1><p>Open any shot to get or re-run its AI review, disagree, apply, or delete.</p></div><span>${rows.length} of ${total}</span></header>
      <div class="history-trail">${renderTrail(trail, trailCoffee, canCycleTrail)}</div>
      <div class="shot-list">
        ${list}
      </div>
      ${detail ? `<div class="shot-detail-wrap">${renderShotDetail(detail)}</div>` : ''}
    </main>`;
}

/**
 * One stored shot, reopened.
 *
 * The curves are replayed from the record rather than re-fetched, which is the
 * whole reason they are persisted: a shot stays reviewable long after the
 * machine has forgotten it.
 */
export function renderShotDetail(detail: ShotDetailModel): string {
  return `
    <section class="card shot-detail">
      <header>
        <h2>${escape(detail.summary)}</h2>
        <span class="label">${escape(detail.when)}</span>
        <button class="card-close" data-action="close-shot" aria-label="Close this shot">✕</button>
      </header>
      <div class="drow">
        <span class="label k">Setup</span>
        <div class="held">${escape(detail.profileTitle)}${detail.coffeeName ? ` · ${escape(detail.coffeeName)}` : ''}</div>
      </div>
      <div class="drow">
        <span class="label k">Tasted</span>
        <div>
          <div class="held">${escape(detail.rating)}</div>
          ${detail.id ? `<div class="stored-score" aria-label="Rate this stored shot">${[1, 2, 3, 4, 5].map((score) =>
            `<button class="score-dot${detail.score === score ? ' on' : ''}" data-action="rate-stored" data-id="${escape(detail.id!)}" data-value="${score}" aria-label="Rate ${score} out of 5">${score}</button>`
          ).join('')}</div>` : ''}
        </div>
      </div>
      ${detail.advice
        ? `<div class="drow"><span class="label k">Advice</span><div>
             <div class="held">${escape(detail.advice.summary)}</div>
             <div class="why">${escape(detail.advice.diagnosis)}</div>
           </div></div>`
        : '<div class="drow"><span class="label k">Advice</span><div class="why">None was asked for.</div></div>'}
      ${detail.error ? `<p class="why err">${escape(detail.error)}</p>` : ''}
      ${detail.id ? `<div class="shot-actions">
        ${detail.advice
          ? `<button class="btn" data-action="toggle-stored-rebuttal" data-id="${escape(detail.id)}">${detail.rebuttalOpen ? 'Never mind' : 'I disagree'}</button>
             <button class="btn" data-action="review-shot" data-id="${escape(detail.id)}" ${detail.busy || !detail.ready || !detail.chart ? 'disabled' : ''}>${detail.busy ? 'Reviewing…' : 'Re-run AI review'}</button>
             <button class="btn primary" data-action="apply-stored" data-id="${escape(detail.id)}" ${detail.busy || !detail.canApply ? 'disabled' : ''}>Use for next shot</button>`
          : `<button class="btn primary" data-action="review-shot" data-id="${escape(detail.id)}" ${detail.busy || !detail.ready || !detail.chart ? 'disabled' : ''}>${detail.busy ? 'Reviewing…' : 'Get AI review'}</button>
             <span class="review-hint">Then you can Disagree · Re-run · Apply</span>`}
        <button class="btn danger" data-action="delete-shot" data-id="${escape(detail.id)}" ${detail.busy ? 'disabled' : ''}>${detail.deleteArmed ? 'Tap again to delete' : 'Delete'}</button>
      </div>` : ''}
      ${detail.rebuttalOpen && detail.id ? `<form class="rebuttal stored-rebuttal" data-action="reconsider-stored" data-id="${escape(detail.id)}">
        <span class="label">What did it get wrong?</span>
        <div class="rebuttal-chips">${REBUTTAL_OPTIONS.map((option) =>
          `<button class="chip${detail.rebuttalReasons?.includes(option.key) ? ' on' : ''}" type="button" data-action="stored-reason" data-reason="${option.key}">${option.label}</button>`
        ).join('')}</div>
        <textarea name="storedRebuttal" rows="3" placeholder="e.g. it was not sour; the finish was dry" ${detail.busy ? 'disabled' : ''}>${escape(detail.rebuttalText ?? '')}</textarea>
        <button class="btn primary" type="submit" ${detail.busy ? 'disabled' : ''}>Reconsider</button>
      </form>` : ''}
    </section>
    ${detail.chart ? renderShot(detail.chart) : '<section class="card"><p class="empty">This shot was recorded before curves were stored, so there is nothing to replay.</p></section>'}`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export interface SetupModel {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  grinderName: string;
  grinderRange: string;
  ready: boolean;
  saved: boolean;
  storageBlocked: boolean;
  keyVisible: boolean;
  testing: boolean;
  testStatus: string | null;
  theme: 'dark' | 'light';
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  google: 'Google (Gemini)',
  compatible: 'OpenAI-compatible (Ollama, LM Studio…)',
  server: 'Local Mac server'
};

/**
 * Choosing a model.
 *
 * This was a free-text box, which asks people to know the exact id — "opus",
 * "opus 5", "opus-5" and "claude-opus-5" are all plausible and only one is
 * right. A list removes the guess; "Other" keeps the box for anyone running
 * something we do not know about.
 */
function renderModelField(model: SetupModel): string {
  const known = KNOWN_MODELS[model.provider as ProviderId] ?? [];

  if (model.provider === 'server') {
    return `<label><span class="label">Model</span>
      <input name="model" value="${escape(model.model)}" disabled placeholder="chosen on the Mac" />
      <small class="field-note">The Mac server picks this — set CREMA_MODEL there.</small>
    </label>`;
  }

  const custom = model.model !== '' && !known.some((entry) => entry.id === model.model);
  const options = [
    `<option value=""${model.model === '' ? ' selected' : ''}>Default (${escape(defaultModel(model.provider as ProviderId))})</option>`,
    ...known.map((entry) =>
      `<option value="${escape(entry.id)}"${model.model === entry.id ? ' selected' : ''}>${escape(entry.label)} — ${escape(entry.id)}</option>`
    ),
    `<option value="__other__"${custom ? ' selected' : ''}>Other…</option>`
  ].join('');

  const chosen = known.find((entry) => entry.id === model.model);

  return `<label><span class="label">Model</span>
    <select name="modelChoice" data-action="change-model">${options}</select>
    ${custom
      // The stored value may be a lone space — the sentinel that means "the
      // user asked to type one" — so it is trimmed for display.
      ? `<input name="model" value="${escape(model.model.trim())}" placeholder="exact model id" />`
      : `<input type="hidden" name="model" value="${escape(model.model)}" />`}
    ${chosen ? `<small class="field-note">${escape(chosen.note)}</small>` : ''}
  </label>`;
}

export function renderSetup(model: SetupModel): string {
  const options = Object.entries(PROVIDER_LABELS)
    .map(([id, label]) => `<option value="${id}"${id === model.provider ? ' selected' : ''}>${escape(label)}</option>`)
    .join('');

  const keyless = model.provider === 'compatible' || model.provider === 'server';

  return `
    <section class="setup-intro">
      <header class="screen-heading">
        <div><h1>Set up Crema</h1><p>Your grinder and AI provider stay on this tablet.</p></div>
        <span class="pill ${model.ready ? 'ok' : 'off'}">${model.ready ? 'ready' : 'needs a key'}</span>
      </header>
      <form class="setup" data-action="save-setup">
        <section class="setup-block"><h2>Grinder</h2><div class="setup-fields">
          <label><span class="label">Name</span><input name="grinderName" placeholder="e.g. Lagom 01" value="${escape(model.grinderName)}" /></label>
          <label><span class="label">Dial range</span><input name="grinderRange" placeholder="e.g. 0.1–0.5 (optional)" value="${escape(model.grinderRange)}" /></label>
        </div></section>
        <section class="setup-block"><h2>Appearance</h2><div class="theme-pick">
          ${(['dark', 'light'] as const).map((option) =>
            `<button type="button" class="chip${model.theme === option ? ' on' : ''}" data-action="set-theme" data-value="${option}">${option === 'dark' ? 'Dark' : 'Light'}</button>`
          ).join('')}
        </div></section>
        <section class="setup-block"><h2>AI provider</h2><p>The key goes only to the provider you choose&mdash;never to the machine gateway.${
          model.provider === 'server'
            ? ' <b>Base URL must be the Mac\u2019s own address</b> — its Bonjour name (<code>http://your-mac.local:8877</code>) or LAN IP. <code>localhost</code> only works when the skin is running on that same Mac.'
            : ''
        }</p><div class="setup-fields provider-fields">
          <label><span class="label">Provider</span><select name="provider" data-action="change-provider">${options}</select></label>
          <label><span class="label">API key${keyless ? ' (often not needed)' : ''}</span><span class="key-field"><input name="apiKey" type="${model.keyVisible ? 'text' : 'password'}" autocomplete="off" placeholder="${keyless ? 'leave blank if none' : 'paste your key'}" value="${escape(model.apiKey)}" /><button class="key-toggle" type="button" data-action="toggle-api-key" aria-label="${model.keyVisible ? 'Hide API key' : 'Show API key'}">${model.keyVisible ? 'Hide' : 'Show'}</button></span></label>
          ${renderModelField(model)}
          <label><span class="label">Base URL</span><input name="baseUrl" placeholder="blank uses the provider default" value="${escape(model.baseUrl)}" /></label>
        </div></section>
        <!--
          No Save button. These settings live in this device's browser storage,
          so there is nothing to commit; each field writes as it is left and
          the tick below says so. What remains is the one action that is not
          automatic — actually calling the provider to see if it answers.
        -->
        <div class="setup-save"><div class="setup-feedback">${model.testStatus ? `<span class="saved${model.testStatus.startsWith('Connected') ? '' : ' warn'}">${escape(model.testStatus)}</span>` : ''}${model.saved ? '<span class="saved">✓ Saved</span>' : ''}${model.storageBlocked ? '<span class="saved warn">This browser blocked storage, so settings will not persist.</span>' : ''}</div><button class="btn" type="button" data-action="test-ai" ${model.testing ? 'disabled' : ''}>${model.testing ? 'Testing…' : 'Test request'}</button></div>
      </form>
    </section>`;
}

// ---------------------------------------------------------------------------
// Rating the shot
// ---------------------------------------------------------------------------

export interface RatingModel {
  rating: Rating;
  /** Null until a shot has actually been pulled. */
  shotSummary: string | null;
  asking: boolean;
  error: string | null;
  ready: boolean;
  grind?: number | null;
}

export function renderRating(model: RatingModel): string {
  if (model.shotSummary === null) {
    return `<section class="card"><header><h2>How was that shot?</h2></header>
      <p class="empty">Pull a shot and the questionnaire opens here. Four taps and a score.</p></section>`;
  }

  const groups = RATING_QUESTIONS.map((question) => {
    const chosen = model.rating[question.key];
    const chips = question.options
      .map(
        (option) =>
          `<button class="chip${option === chosen ? ' on' : ''}" data-action="rate" data-key="${question.key}" data-value="${escape(option)}">${escape(option)}</button>`
      )
      .join('');
    return `<div class="qrow"><span class="label">${escape(question.label)}</span><div class="chips">${chips}</div></div>`;
  }).join('');

  const scores = SCORES.map(
    (score) =>
      `<button class="chip score${score === model.rating.score ? ' on' : ''}" data-action="rate" data-key="score" data-value="${score}">${score}</button>`
  ).join('');

  return `
    <section class="card">
      <header>
        <h2>How was that shot?</h2>
        <span class="label">${escape(model.shotSummary)}</span>
      </header>
      <div class="pending-grind">
        <span class="label">Grind used</span>
        <button class="step" data-action="pending-grind" data-step="-0.05" aria-label="record a finer grind">−</button>
        <strong>${escape(model.grind === null || model.grind === undefined ? 'Not set' : formatGrind(model.grind))}</strong>
        <button class="step" data-action="pending-grind" data-step="0.05" aria-label="record a coarser grind">+</button>
      </div>
      ${groups}
      <div class="qrow"><span class="label">Score</span><div class="chips">${scores}</div></div>
      ${model.error ? `<p class="why err">${escape(model.error)}</p>` : ''}
      <div class="rating-footer">
        <button class="btn danger" data-action="discard-shot" ${model.asking ? 'disabled' : ''}>Discard</button>
        <div class="actions">
          <button class="btn" data-action="save-rating" ${model.asking || model.rating.score === null ? 'disabled' : ''}>Save without AI</button>
          <button class="btn primary" data-action="get-advice" ${model.asking || model.rating.score === null ? 'disabled' : ''}>
            ${model.asking ? 'Asking…' : 'Get advice'}
          </button>
          ${model.ready ? '' : '<span class="saved warn">Add an API key in Settings first.</span>'}
        </div>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Live shot
// ---------------------------------------------------------------------------

export interface LiveModel {
  pressureBar: number;
  flowMlS: number;
  elapsedS: number;
  weightG: number | null;
  phase: string | null;
}

/** One giant number while a shot runs, readable from across a kitchen. */
export function renderLive(model: LiveModel): string {
  return `
    <section class="live-metrics" aria-label="Live espresso measurements">
      <div><span class="label">Time</span><b class="num">${Math.round(model.elapsedS)}s</b></div>
      <div><span class="label">Pressure bar</span><b class="num pressure">${model.pressureBar.toFixed(1)}</b></div>
      <div><span class="label">Flow mL/s</span><b class="num flow">${model.flowMlS.toFixed(1)}</b></div>
      <div><span class="label">In cup</span><b class="num weight">${model.weightG === null ? '—' : `${model.weightG.toFixed(1)}g`}</b></div>
      <div class="phase"><span class="label">Phase</span><b>${escape(model.phase ?? '')}</b></div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Machine action bar
// ---------------------------------------------------------------------------

export interface ActionBarModel {
  /** Null when no machine is connected; nothing is commandable then. */
  machineState: string | null;
  busy: boolean;
  /** A GHC-equipped machine supplies its own four physical start controls. */
  hasGhc?: boolean;
}

/** States where the machine is doing something that should be stoppable. */
const RUNNING_STATES = new Set(['espresso', 'steam', 'hotWater', 'flush', 'steamRinse']);

export function isRunningMachineState(machineState: string | null): boolean {
  return machineState !== null && RUNNING_STATES.has(machineState);
}

/** The original skin replaces the grind card with Stop on a GHC machine. */
export function renderGhcStop(machineState: string, busy: boolean): string {
  return `
    <div class="grind-card ghc-stop-card">
      <button class="ghc-stop" data-action="machine" data-state="idle" ${busy ? 'disabled' : ''}>Stop</button>
      <span>${escape(machineState)} running</span>
    </div>`;
}

const MACHINE_ACTIONS: readonly { state: string; label: string }[] = [
  { state: 'espresso', label: 'Espresso' },
  { state: 'steam', label: 'Steam' },
  { state: 'hotWater', label: 'Water' },
  { state: 'flush', label: 'Flush' }
];

/**
 * The machine controls.
 *
 * While something is running, the only thing offered is Stop — a row of start
 * buttons during a live shot is how you end up steaming mid-extraction. Every
 * button is disabled without a connected machine rather than failing on press.
 */
export function renderActionBar(model: ActionBarModel): string {
  const connected = model.machineState !== null;
  const running = isRunningMachineState(model.machineState);
  const asleep = model.machineState === 'sleeping';

  if (running) {
    if (model.hasGhc) return '<div class="actionbar"></div>';
    return `
      <div class="actionbar">
        <button class="act stop" data-action="machine" data-state="idle" ${model.busy ? 'disabled' : ''}>Stop</button>
        <span class="actnote">${escape(model.machineState!)} running</span>
      </div>`;
  }

  const buttons = model.hasGhc ? '' : MACHINE_ACTIONS.map(
    (action) =>
      `<button class="act" data-action="machine" data-state="${action.state}" ${connected && !asleep && !model.busy ? '' : 'disabled'}>${escape(action.label)}</button>`
  ).join('');

  // Sleep/Wake is not here: it sits in the header strip with the other
  // machine-state controls, where it is reachable from every tab instead of
  // only from Brew, and where it can align with the row it belongs to.
  // On a GHC machine this rail has nothing to offer — the start controls are
  // physical — and the layout collapses it to nothing. Anything left inside
  // then spills out of a zero-size box and paints over the bean headline. The
  // header's connection pill already says whether a machine is there.
  if (model.hasGhc) return '<div class="actionbar"></div>';

  return `
    <div class="actionbar">
      ${buttons}
      <span class="spacer"></span>
      ${connected ? '' : '<span class="actnote">no machine connected</span>'}
    </div>`;
}

// ---------------------------------------------------------------------------
// Steam, hot water and flush settings
// ---------------------------------------------------------------------------

export interface WaterModel {
  steam: { targetTemperature: number | null; duration: number | null; flow: number | null };
  hotWater: { targetTemperature: number | null; duration: number | null; volume: number | null; flow: number | null };
  rinse: { targetTemperature: number | null; duration: number | null; flow: number | null };
  busy: boolean;
}

function waterCell(label: string, unit: string, group: string, field: string, value: number | null, step: number): string {
  return `
    <div class="cell">
      <span class="label">${escape(label)}${unit ? ` (${escape(unit)})` : ''}</span>
      <div class="row">
        <button class="step" data-action="water-dec" data-group="${group}" data-field="${field}" data-step="${step}" aria-label="decrease ${label}">−</button>
        <span class="value">${value === null ? '—' : escape(value.toFixed(step < 1 ? 1 : 0))}</span>
        <button class="step" data-action="water-inc" data-group="${group}" data-field="${field}" data-step="${step}" aria-label="increase ${label}">+</button>
      </div>
    </div>`;
}

/**
 * Milk drinks and cleaning, so this stops being a skin you have to leave to
 * make a cappuccino. Values write straight through to the workflow, which is
 * where the machine reads them from.
 */
export function renderWater(model: WaterModel): string {
  return `
    <section class="machine-settings"><header class="section-heading"><div><h2>Machine settings</h2><p>Steam, hot water, and flush defaults.</p></div></header><div class="water-grid">
    <section class="card water-card">
      <header><h2>Steam</h2><span class="label">for milk drinks</span></header>
      <div class="recipe">
        ${waterCell('Temp', '°C', 'steamSettings', 'targetTemperature', model.steam.targetTemperature, 1)}
        ${waterCell('Time', 's', 'steamSettings', 'duration', model.steam.duration, 1)}
        ${waterCell('Flow', 'ml/s', 'steamSettings', 'flow', model.steam.flow, 0.1)}
      </div>
    </section>
    <section class="card water-card">
      <header><h2>Hot water</h2><span class="label">for americanos and tea</span></header>
      <div class="recipe">
        ${waterCell('Temp', '°C', 'hotWaterData', 'targetTemperature', model.hotWater.targetTemperature, 1)}
        ${waterCell('Volume', 'ml', 'hotWaterData', 'volume', model.hotWater.volume, 5)}
        ${waterCell('Time', 's', 'hotWaterData', 'duration', model.hotWater.duration, 1)}
        ${waterCell('Flow', 'ml/s', 'hotWaterData', 'flow', model.hotWater.flow, 0.5)}
      </div>
    </section>
    <section class="card water-card">
      <header><h2>Flush</h2><span class="label">rinsing the group</span></header>
      <div class="recipe">
        ${waterCell('Temp', '°C', 'rinseData', 'targetTemperature', model.rinse.targetTemperature, 1)}
        ${waterCell('Time', 's', 'rinseData', 'duration', model.rinse.duration, 1)}
        ${waterCell('Flow', 'ml/s', 'rinseData', 'flow', model.rinse.flow, 0.5)}
      </div>
    </section></div></section>`;
}
