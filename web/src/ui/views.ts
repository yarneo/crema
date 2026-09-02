/**
 * Rendering. Plain HTML strings and a delegated click handler — no framework
 * runtime, which is the norm for Decaid skins and keeps the bundle small
 * enough to start instantly on a tablet.
 *
 * Every view here takes data and returns markup. Nothing fetches.
 */

import { formatGrind } from '../domain/grind.ts';
import { formatValue, type Recipe, type RecipeDiff } from '../domain/recipe.ts';
import { DIALED_IN_SCORE, type TrailNode } from '../domain/trail.ts';
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
  gatewayOnline: boolean;
  machineState: string | null;
  groupTempC: number | null;
  waterMl: number | null;
  scaleG: number | null;
  demo: boolean;
}

const stat = (label: string, value: string) =>
  `<div class="stat"><span class="label">${escape(label)}</span><b>${escape(value)}</b></div>`;

export function renderStatus(model: StatusModel): string {
  const pills = [
    model.gatewayOnline
      ? '<span class="pill ok">gateway · online</span>'
      : '<span class="pill off">gateway · offline</span>',
    model.machineState
      ? `<span class="pill ok">machine · ${escape(model.machineState)}</span>`
      : '<span class="pill off">machine · not connected</span>',
    model.demo ? '<span class="pill demo">sample shot</span>' : ''
  ].join('');

  return `
    <div class="statusbar">
      <span class="wordmark">Crema</span>
      ${stat('group', model.groupTempC === null ? '—' : `${model.groupTempC.toFixed(1)}°C`)}
      ${stat('water', model.waterMl === null ? '—' : `${Math.round(model.waterMl)} ml`)}
      ${stat('scale', model.scaleG === null ? '—' : `${model.scaleG.toFixed(1)} g`)}
      <span class="spacer"></span>
      ${pills}
    </div>`;
}

// ---------------------------------------------------------------------------
// Bean headline and the inline recipe row
// ---------------------------------------------------------------------------

export interface BeanModel {
  name: string | null;
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
    <div class="bean">
      <h1>${escape(bean.name ?? 'No bean selected')}</h1>
      ${age === null ? '' : `<span class="age">${age} ${age === 1 ? 'day' : 'days'} off roast</span>`}
    </div>`;
}

const ratioOf = (recipe: Recipe): string =>
  recipe.doseG && recipe.targetYieldG ? `1:${(recipe.targetYieldG / recipe.doseG).toFixed(1)}` : '—';

function cell(label: string, valueHtml: string, field?: string, step?: number): string {
  const controls =
    field === undefined
      ? ''
      : `<button class="step" data-action="dec" data-field="${field}" data-step="${step}" aria-label="decrease ${label}">−</button>
         <button class="step" data-action="inc" data-field="${field}" data-step="${step}" aria-label="increase ${label}">+</button>`;
  const [dec, inc] = controls ? controls.split('\n         ') : ['', ''];
  return `
    <div class="cell">
      <span class="label">${escape(label)}</span>
      <div class="row">${dec ?? ''}<span class="value${field ? '' : ' text'}">${valueHtml}</span>${inc ?? ''}</div>
    </div>`;
}

export function renderRecipe(recipe: Recipe): string {
  return `
    <div class="recipe">
      ${cell('Profile', escape(recipe.profileTitle ?? '—'))}
      ${cell('Dose', escape(formatValue('doseG', recipe.doseG)), 'doseG', 0.1)}
      ${cell('Yield', escape(formatValue('targetYieldG', recipe.targetYieldG)), 'targetYieldG', 1)}
      ${cell('Ratio', escape(ratioOf(recipe)))}
      ${cell('Grind', escape(recipe.grind === null ? '—' : formatGrind(recipe.grind)), 'grind', 0.05)}
      ${cell('Temp', escape(formatValue('temperatureC', recipe.temperatureC)), 'temperatureC', 0.5)}
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

export function renderAdvice(model: AdviceModel | null): string {
  if (!model) {
    return `<section class="card"><header><h2>Advice</h2></header>
      <p class="empty">Pull a shot and rate it, and the advice lands here as a single reviewable change.</p></section>`;
  }

  const { diff } = model;
  const rows = diff.changes
    .map((change) =>
      diffRow(
        change.label,
        change.field === 'grind' && typeof change.from === 'number'
          ? formatGrind(change.from)
          : formatValue(change.field, change.from),
        change.field === 'grind' && typeof change.to === 'number'
          ? formatGrind(change.to)
          : formatValue(change.field, change.to),
        change.reason
      )
    )
    .join('');

  // The held row is the point: it makes one-change-at-a-time visible rather
  // than implied, so the next shot tells us one thing cleanly.
  const held = diff.held
    .map((h) => `${h.label.toLowerCase()} ${h.field === 'grind' && typeof h.to === 'number' ? formatGrind(h.to) : formatValue(h.field, h.to)}`)
    .join(' · ');

  return `
    <section class="card">
      <header>
        <h2>${escape(model.diagnosis ? 'Running fast' : 'Advice')}</h2>
        <span class="label">confidence ${escape(model.confidence)}</span>
      </header>
      <p class="diagnosis">${escape(model.diagnosis)}</p>
      ${rows || '<p class="empty">Nothing to change. Pull it again the same way.</p>'}
      ${held ? `<div class="drow"><span class="label k">Held</span><div><div class="held">${escape(held)}</div><div class="why">Deliberately unchanged, so the next shot tells us one thing cleanly.</div></div></div>` : ''}
      <div class="actions">
        <button class="btn primary" data-action="apply" ${model.busy ? 'disabled' : ''}>Use for next shot</button>
        <button class="btn" data-action="undo" ${model.canUndo && !model.busy ? '' : 'disabled'}>Undo</button>
        ${model.canReconsider ? `<button class="btn" data-action="toggle-rebuttal">${model.rebuttalOpen ? 'Never mind' : 'I disagree'}</button>` : ''}
      </div>
      ${model.rebuttalOpen ? rebuttalBox(model) : ''}
    </section>`;
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

export function renderTrail(nodes: readonly TrailNode[]): string {
  if (nodes.length === 0) {
    return `<section class="card"><header><h2>Dial-in trail</h2></header>
      <p class="empty">Once this bean has a few rated shots, the trail shows whether you are converging.</p></section>`;
  }

  const W = 640;
  const H = 210;
  // The end labels are centred under their node, so the plot needs a margin
  // wide enough for half a label at each end or the first and last get clipped.
  const left = 52;
  const right = W - 52;
  const top = 30;
  const bottom = H - 40;

  const span = Math.max(nodes.length - 1, 1);
  const x = (i: number) => left + (i * (right - left)) / span;
  const y = (score: number) => bottom - ((score - 1) / 4) * (bottom - top);

  const rated = nodes.filter((n) => n.score !== null);
  const line = rated.map((n) => `${x(nodes.indexOf(n))},${y(n.score!)}`).join(' ');

  const bandTop = y(5);
  const bandHeight = y(DIALED_IN_SCORE) - bandTop;

  const dots = nodes
    .map((n, i) => {
      if (n.score === null) return '';
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
      return `<text class="trailnode${plain ? ' plain' : ''}" x="${tx}" y="${H - 14}" text-anchor="${anchor}">${escape(n.label)}</text>`;
    })
    .join('');

  return `
    <section class="card">
      <header><h2>Dial-in trail</h2><span class="label">${nodes.length} shots</span></header>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Taste score across this bean's shots, each labelled with the one thing that changed">
        <rect x="${left}" y="${bandTop}" width="${right - left}" height="${bandHeight}" fill="var(--good)" opacity="0.10" rx="3"/>
        <text class="tick" x="${left + 6}" y="${bandTop - 7}" fill="var(--good)">dialled in</text>
        <line class="axis" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"/>
        <text class="tick" x="${left - 9}" y="${y(5) + 4}" text-anchor="end">5</text>
        <text class="tick" x="${left - 9}" y="${y(1) + 4}" text-anchor="end">1</text>
        <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
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
  evidence: readonly EvidenceWindow[];
  phases: FlowPhases | null;
}

export function renderShot(model: ShotChartModel | null): string {
  if (!model || model.elapsedS.length < 2) {
    return `<section class="card"><header><h2>Last shot</h2></header><p class="empty">No shot yet.</p></section>`;
  }

  const W = 640;
  const H = 230;
  const left = 32;
  const right = W - 12;
  const top = 16;
  const bottom = H - 30;

  const duration = model.elapsedS[model.elapsedS.length - 1]!;
  const maxY = 12; // bar and mL/s share a 0-12 axis, as on the DE1's own chart
  const x = (t: number) => left + (t / duration) * (right - left);
  const y = (v: number) => bottom - (v / maxY) * (bottom - top);

  const path = (values: readonly number[]) =>
    values.map((v, i) => `${x(model.elapsedS[i] ?? 0)},${y(v)}`).join(' ');

  // The evidence band is the whole point: the model cites a window, we shade
  // it, and the diagnosis stops being an assertion.
  const bands = model.evidence
    .map((w) => {
      const bx = x(w.fromS);
      const bw = Math.max(x(w.toS) - bx, 2);
      return `
        <rect x="${bx}" y="${top}" width="${bw}" height="${bottom - top}" fill="var(--accent)" opacity="0.13"/>
        <line class="gridline" x1="${bx}" y1="${top}" x2="${bx}" y2="${bottom}" stroke="var(--accent)" stroke-dasharray="3 3"/>
        <line class="gridline" x1="${bx + bw}" y1="${top}" x2="${bx + bw}" y2="${bottom}" stroke="var(--accent)" stroke-dasharray="3 3"/>
        ${w.label ? `<text class="evlabel" x="${bx + 5}" y="${top + 13}">${escape(w.label)}</text>` : ''}`;
    })
    .join('');

  const verdict = model.phases ? stallVerdict(model.phases) : null;

  return `
    <section class="card">
      <header>
        <h2>Last shot</h2>
        <span class="label">${duration.toFixed(1)}s${
          model.phases ? ` · ${model.phases.preinfusionS}s to first flow${verdict ? ` · ${verdict}` : ''}` : ''
        }</span>
      </header>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pressure and flow over the shot, with the cited window shaded">
        ${bands}
        <line class="axis" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"/>
        <line class="axis" x1="${left}" y1="${top}" x2="${left}" y2="${bottom}"/>
        <polyline points="${path(model.pressureBar)}" fill="none" stroke="var(--good)" stroke-width="2.2" stroke-linejoin="round"/>
        <polyline points="${path(model.flowMlS)}" fill="none" stroke="var(--blue)" stroke-width="2.2" stroke-linejoin="round"/>
        <text class="tick" x="${left}" y="${H - 10}">0s</text>
        <text class="tick" x="${right}" y="${H - 10}" text-anchor="end">${duration.toFixed(0)}s</text>
      </svg>
      <div class="legend">
        <span><i style="background:var(--good)"></i>pressure bar</span>
        <span><i style="background:var(--blue)"></i>flow ml/s</span>
        ${model.evidence.length ? '<span><i style="background:var(--accent)"></i>what the advice is pointing at</span>' : ''}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export const TABS = ['brew', 'profiles', 'beans', 'shots', 'setup'] as const;
export type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  brew: 'Brew',
  profiles: 'Profiles',
  beans: 'Beans',
  shots: 'Shots',
  setup: 'Setup'
};

export function renderNav(active: Tab, needsSetup: boolean): string {
  const items = TABS.map((tab) => {
    const badge = tab === 'setup' && needsSetup ? '<i class="dot"></i>' : '';
    return `<button class="tab${tab === active ? ' on' : ''}" data-action="tab" data-tab="${tab}">${TAB_LABELS[tab]}${badge}</button>`;
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
  active: boolean;
}

export function renderProfiles(rows: readonly ProfileRow[], filter: string, busy: boolean): string {
  if (rows.length === 0) {
    return `<section class="card"><header><h2>Profiles</h2></header>
      <p class="empty">No profiles from the gateway yet.</p></section>`;
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle ? rows.filter((r) => r.title.toLowerCase().includes(needle)) : rows;

  const list = shown
    .map(
      (row) => `
      <button class="listrow${row.active ? ' active' : ''}" data-action="use-profile" data-id="${escape(row.id)}" ${busy ? 'disabled' : ''}>
        <span class="rowmain">${escape(row.title)}</span>
        <span class="rowmeta">${escape(row.author || 'unknown')} · ${row.steps} steps</span>
        ${row.active ? '<span class="pill ok">in use</span>' : '<span class="rowgo">use</span>'}
      </button>`
    )
    .join('');

  return `
    <section class="card">
      <header><h2>Profiles</h2><span class="label">${shown.length} of ${rows.length}</span></header>
      <input class="search" type="search" placeholder="Search profiles" value="${escape(filter)}" data-action="filter-profiles" />
      <div class="list">${list || '<p class="empty">Nothing matches that.</p>'}</div>
    </section>`;
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
}

/**
 * The bags of the selected bean.
 *
 * Roast date lives on the batch rather than the bean, so this is where
 * days-off-roast actually comes from — and days-off-roast changes the advice,
 * which is why it is worth the extra screen.
 */
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

  return `
    ${list ? `<div class="list">${list}</div>` : '<p class="empty">No bags recorded for this bean yet.</p>'}
    <form class="addbean" data-action="add-batch">
      <input name="roastDate" type="date" required aria-label="Roast date" />
      <input name="roastLevel" placeholder="Roast level (optional)" />
      <input name="weight" type="number" step="1" min="0" placeholder="Bag grams (optional)" />
      <button class="btn primary" type="submit" ${model.busy ? 'disabled' : ''}>Add bag</button>
    </form>`;
}

export function renderBeansScreen(model: BeansModel): string {
  return `
    ${renderBeans(model.rows, model.busy)}
    <section class="card">
      <header>
        <h2>Bags${model.activeBeanName ? ` · ${escape(model.activeBeanName)}` : ''}</h2>
        ${model.batches ? `<span class="label">${model.batches.length} recorded</span>` : ''}
      </header>
      ${renderBatches(model)}
    </section>`;
}

export function renderBeans(rows: readonly BeanRow[], busy: boolean): string {
  const list = rows
    .map(
      (row) => `
      <button class="listrow${row.active ? ' active' : ''}" data-action="use-bean" data-id="${escape(row.id)}" ${busy ? 'disabled' : ''}>
        <span class="rowmain">${escape(row.name)}</span>
        <span class="rowmeta">${escape(row.roaster)}${row.origin ? ` · ${escape(row.origin)}` : ''}</span>
        ${row.active ? '<span class="pill ok">in use</span>' : '<span class="rowgo">use</span>'}
      </button>`
    )
    .join('');

  return `
    <section class="card">
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
}

export function renderShots(rows: readonly ShotRow[], total: number): string {
  if (rows.length === 0) {
    return `<section class="card"><header><h2>Shots</h2></header>
      <p class="empty">No shots recorded yet. Pull one and it will appear here with its advice.</p></section>`;
  }

  const list = rows
    .map(
      (row) => `
      <div class="listrow static">
        <span class="rowmain">${escape(row.summary)}</span>
        <span class="rowmeta">${escape(row.profileTitle)}${row.coffeeName ? ` · ${escape(row.coffeeName)}` : ''} · ${escape(row.when)}</span>
      </div>`
    )
    .join('');

  return `
    <section class="card">
      <header><h2>Shots</h2><span class="label">${rows.length} of ${total}</span></header>
      <div class="list">${list}</div>
    </section>`;
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
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  google: 'Google (Gemini)',
  compatible: 'OpenAI-compatible (Ollama, LM Studio…)',
  server: 'Local Mac server'
};

export function renderSetup(model: SetupModel): string {
  const options = Object.entries(PROVIDER_LABELS)
    .map(([id, label]) => `<option value="${id}"${id === model.provider ? ' selected' : ''}>${escape(label)}</option>`)
    .join('');

  const keyless = model.provider === 'compatible' || model.provider === 'server';

  return `
    <section class="card">
      <header>
        <h2>AI setup</h2>
        <span class="pill ${model.ready ? 'ok' : 'off'}">${model.ready ? 'ready' : 'needs a key'}</span>
      </header>
      <p class="diagnosis">The key is stored on this device only. It goes to the provider you pick and nowhere else, never to the gateway.</p>
      <form class="setup" data-action="save-setup">
        <label><span class="label">Provider</span><select name="provider" data-action="change-provider">${options}</select></label>
        <label><span class="label">API key${keyless ? ' (often not needed)' : ''}</span>
          <input name="apiKey" type="password" autocomplete="off" placeholder="${keyless ? 'leave blank if none' : 'paste your key'}" value="${escape(model.apiKey)}" /></label>
        <label><span class="label">Model</span><input name="model" placeholder="blank uses a sensible default" value="${escape(model.model)}" /></label>
        <label><span class="label">Base URL</span><input name="baseUrl" placeholder="blank uses the provider default" value="${escape(model.baseUrl)}" /></label>
        <label><span class="label">Grinder</span><input name="grinderName" placeholder="e.g. Lagom 01" value="${escape(model.grinderName)}" /></label>
        <label><span class="label">Dial range</span><input name="grinderRange" placeholder="e.g. 0.1-0.5 (optional)" value="${escape(model.grinderRange)}" /></label>
        <button class="btn primary" type="submit">Save</button>
        ${model.saved ? '<span class="saved">Saved</span>' : ''}
        ${model.storageBlocked ? '<span class="saved warn">This browser blocked storage, so settings will not persist.</span>' : ''}
      </form>
      <p class="why">A stronger model gives noticeably better advice. If it ever feels generic, switch to the best model your provider offers before changing anything else.</p>
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
      ${groups}
      <div class="qrow"><span class="label">Score</span><div class="chips">${scores}</div></div>
      ${model.error ? `<p class="why err">${escape(model.error)}</p>` : ''}
      <div class="actions">
        <button class="btn primary" data-action="get-advice" ${model.asking || model.rating.score === null ? 'disabled' : ''}>
          ${model.asking ? 'Asking…' : 'Get advice'}
        </button>
        ${model.ready ? '' : '<span class="saved warn">Add an API key in Setup first.</span>'}
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
}

/** One giant number while a shot runs, readable from across a kitchen. */
export function renderLive(model: LiveModel): string {
  return `
    <section class="card live">
      <header><h2>Pulling</h2><span class="label">${model.elapsedS.toFixed(1)}s</span></header>
      <div class="bignums">
        <div><b class="num">${model.pressureBar.toFixed(1)}</b><span class="label">bar</span></div>
        <div><b class="num">${model.flowMlS.toFixed(1)}</b><span class="label">ml/s</span></div>
      </div>
    </section>`;
}
