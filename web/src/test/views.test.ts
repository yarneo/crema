import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderActionBar,
  renderAdvice,
  renderBeansScreen,
  renderRating,
  renderShots,
  renderStatus,
  renderWater,
  type AdviceModel,
  type BeansModel
} from '../ui/views.ts';
import { diffRecipe, type Recipe } from '../domain/recipe.ts';
import { EMPTY_RATING } from '../domain/rating.ts';
import { applyCompatFlags, supportsFlexGap } from '../compat.ts';

const recipe: Recipe = {
  profileTitle: 'Gentle Decline',
  grind: 12.4,
  doseG: 18,
  targetYieldG: 40,
  temperatureC: 92
};

const advice: AdviceModel = {
  diagnosis: 'Ran fast and tasted sharp.',
  confidence: 'high',
  diff: diffRecipe(recipe, { grind: 12.0 }, { grind: '28g out in 19s.' }),
  canUndo: false,
  busy: false,
  rebuttalOpen: false,
  rebuttalText: '',
  reconsidering: false,
  canReconsider: true
};

// ---- advice card ----------------------------------------------------------

test('the diff shows the change, its reason, and what was held', () => {
  const html = renderAdvice(advice);
  assert.match(html, /12\.4/);
  assert.match(html, /12\.0/);
  assert.match(html, /28g out in 19s/);
  assert.match(html, /Held/);
  assert.match(html, /one thing cleanly/);
});

test('pushback is offered only when there is a real shot behind the advice', () => {
  assert.match(renderAdvice(advice), /data-action="toggle-rebuttal"/);
  assert.ok(!renderAdvice({ ...advice, canReconsider: false }).includes('toggle-rebuttal'));
});

test('the pushback box opens with its text preserved', () => {
  const html = renderAdvice({ ...advice, rebuttalOpen: true, rebuttalText: 'it was thin, not sour' });
  assert.match(html, /data-action="reconsider"/);
  assert.match(html, /it was thin, not sour/);
  assert.match(html, /Never mind/, 'the toggle flips so it can be closed again');
});

test('a reconsider in flight disables its own controls', () => {
  const html = renderAdvice({ ...advice, rebuttalOpen: true, reconsidering: true });
  assert.match(html, /Rethinking…/);
  assert.match(html, /textarea[^>]*disabled/);
});

test('undo is disabled until something has been applied', () => {
  assert.match(renderAdvice(advice), /data-action="undo"[^>]*disabled/);
  assert.ok(!/data-action="undo"[^>]*disabled/.test(renderAdvice({ ...advice, canUndo: true })));
});

test('advice text is escaped, so a model cannot inject markup', () => {
  const html = renderAdvice({ ...advice, diagnosis: '<img src=x onerror="alert(1)">' });
  assert.ok(!html.includes('<img'), 'the tag must not survive into the DOM');
  assert.match(html, /&lt;img/);
});

// ---- questionnaire --------------------------------------------------------

test('with no shot the questionnaire explains itself instead of showing chips', () => {
  const html = renderRating({ rating: { ...EMPTY_RATING }, shotSummary: null, asking: false, error: null, ready: true });
  assert.match(html, /Pull a shot/);
  assert.ok(!html.includes('data-action="rate"'));
});

test('get advice is blocked until a score is chosen', () => {
  const base = { shotSummary: '18g → 36g', asking: false, error: null, ready: true };
  assert.match(renderRating({ ...base, rating: { ...EMPTY_RATING } }), /data-action="get-advice"[^>]*disabled/);
  assert.ok(
    !/data-action="get-advice"[^>]*disabled/.test(renderRating({ ...base, rating: { ...EMPTY_RATING, score: 3 } }))
  );
});

test('a missing key is called out where the button is', () => {
  const html = renderRating({
    rating: { ...EMPTY_RATING, score: 3 },
    shotSummary: '18g → 36g',
    asking: false,
    error: null,
    ready: false
  });
  assert.match(html, /Add an API key in Setup/);
});

test('chosen answers are marked, unchosen are not', () => {
  const html = renderRating({
    rating: { ...EMPTY_RATING, taste: 'sour', score: 2 },
    shotSummary: '18g → 36g',
    asking: false,
    error: null,
    ready: true
  });
  assert.match(html, /class="chip on"[^>]*data-value="sour"/);
  assert.ok(!/class="chip on"[^>]*data-value="bitter"/.test(html));
});

// ---- beans and bags -------------------------------------------------------

const beans: BeansModel = {
  rows: [{ id: 'b1', roaster: 'Moonwake', name: 'La Estrella Gesha', origin: 'Colombia', active: true }],
  busy: false,
  activeBeanId: null,
  activeBeanName: null,
  batches: null
};

test('bags prompt for a bean before showing anything', () => {
  assert.match(renderBeansScreen(beans), /Select a bean to record its bags/);
});

test('a selected bean with no bags says so rather than looking broken', () => {
  const html = renderBeansScreen({ ...beans, activeBeanId: 'b1', activeBeanName: 'La Estrella Gesha', batches: [] });
  assert.match(html, /No bags recorded for this bean yet/);
  assert.match(html, /data-action="add-batch"/);
});

test('a bag shows its age, which is the reason bags exist', () => {
  const html = renderBeansScreen({
    ...beans,
    activeBeanId: 'b1',
    activeBeanName: 'La Estrella Gesha',
    batches: [
      { id: 'x1', roastDate: '2026-08-20T09:00:00.000Z', roastLevel: 'light', daysOffRoast: 13, weightRemaining: 250, active: true }
    ]
  });
  assert.match(html, /13 days off roast/);
  assert.match(html, /250g left/);
  assert.match(html, /in use/);
});

test('an undated bag is labelled, not silently blank', () => {
  const html = renderBeansScreen({
    ...beans,
    activeBeanId: 'b1',
    activeBeanName: 'x',
    batches: [{ id: 'x2', roastDate: null, roastLevel: null, daysOffRoast: null, weightRemaining: null, active: false }]
  });
  assert.match(html, /undated bag/);
  assert.match(html, /no roast date/);
});

test('one day reads as a day, not 1 days', () => {
  const html = renderBeansScreen({
    ...beans,
    activeBeanId: 'b1',
    activeBeanName: 'x',
    batches: [{ id: 'x3', roastDate: '2026-09-01T09:00:00.000Z', roastLevel: null, daysOffRoast: 1, weightRemaining: null, active: false }]
  });
  assert.match(html, /1 day off roast/);
});

// ---- ways out of the skin ------------------------------------------------

test('the status bar links to machine setup and back to the dashboard', () => {
  const html = renderStatus({
    settingsUrl: 'http://localhost:8080/api/v1/plugins/settings.reaplugin/ui?backName=Crema',
    canExit: true,
    gatewayOnline: true,
    machineState: 'idle',
    groupTempC: 93,
    waterMl: null,
    scaleG: null,
    demo: false
  });
  assert.match(html, /Machine setup/);
  assert.match(html, /backName=Crema/, 'so Decaid offers a way back to us');
  assert.match(html, /data-action="exit-skin"/);
});

test('no dashboard button outside Decaid, where there is nothing to return to', () => {
  const html = renderStatus({
    settingsUrl: null,
    canExit: false,
    gatewayOnline: true,
    machineState: null,
    groupTempC: null,
    waterMl: null,
    scaleG: null,
    demo: true
  });
  assert.ok(!html.includes('exit-skin'));
  assert.ok(!html.includes('Machine setup'));
  assert.match(html, /sample shot/);
});

// ---- machine action bar ---------------------------------------------------

test('nothing is commandable without a connected machine', () => {
  const html = renderActionBar({ machineState: null, busy: false });
  assert.match(html, /no machine connected/);
  for (const label of ['Brew', 'Steam', 'Hot water', 'Flush', 'Rinse']) {
    assert.match(html, new RegExp(`${label}</button>`), `${label} is present`);
  }
  assert.equal((html.match(/disabled/g) ?? []).length, 6, 'all five actions plus sleep are disabled');
});

test('a sleeping machine offers only Wake', () => {
  const html = renderActionBar({ machineState: 'sleeping', busy: false });
  assert.match(html, /Wake/);
  assert.match(html, /data-state="idle"/);
  assert.match(html, /data-state="espresso"[^>]*disabled/, 'no brewing until it is awake');
});

test('while something runs, Stop is the only thing offered', () => {
  for (const running of ['espresso', 'steam', 'hotWater', 'flush', 'steamRinse']) {
    const html = renderActionBar({ machineState: running, busy: false });
    assert.match(html, /class="act stop"/, running);
    assert.match(html, /data-state="idle"/);
    // A row of start buttons mid-shot is how you steam during extraction.
    assert.ok(!html.includes('data-state="steam"'), `no start buttons during ${running}`);
    assert.ok(!html.includes('data-state="espresso"'));
  }
});

test('an idle machine can start anything, and be put to sleep', () => {
  const html = renderActionBar({ machineState: 'idle', busy: false });
  assert.ok(!/data-state="espresso"[^>]*disabled/.test(html));
  assert.match(html, /data-state="sleeping"/);
  assert.match(html, /Sleep/);
});

test('a command in flight disables the bar rather than queueing presses', () => {
  const html = renderActionBar({ machineState: 'idle', busy: true });
  assert.match(html, /data-state="espresso"[^>]*disabled/);
});

// ---- water settings -------------------------------------------------------

const water = {
  steam: { targetTemperature: 150, duration: 50, flow: 0.8 },
  hotWater: { targetTemperature: 75, duration: 30, volume: 50, flow: 10 },
  rinse: { targetTemperature: 90, duration: 10, flow: 6 },
  busy: false
};

test('every water value is shown with a stepper naming its own field', () => {
  const html = renderWater(water);
  assert.match(html, /data-group="steamSettings"[^>]*data-field="targetTemperature"/);
  assert.match(html, /data-group="hotWaterData"[^>]*data-field="volume"/);
  assert.match(html, /data-group="rinseData"[^>]*data-field="flow"/);
  assert.match(html, /150/);
  assert.match(html, /0\.8/, 'flow keeps its decimal');
  assert.match(html, /for milk drinks/);
});

test('a value the gateway did not send reads as unset, not zero', () => {
  const html = renderWater({ ...water, steam: { targetTemperature: null, duration: null, flow: null } });
  assert.match(html, /—/);
  assert.ok(!/>0<\/span>/.test(html), 'zero would look like a real setting');
});

// ---- shot detail ----------------------------------------------------------

const shotRows = [
  { id: 's1', when: '2 Sep', profileTitle: 'Adaptive v3', coffeeName: 'Gesha', summary: '18.0g → 36.0g · 2/5' }
];

test('shot rows are openable and mark the open one', () => {
  assert.match(renderShots(shotRows, 1, null, null), /data-action="open-shot"[^>]*data-id="s1"/);
  assert.match(renderShots(shotRows, 1, 's1', null), /class="listrow active"/);
});

test('the detail replays the rating and the advice that was given', () => {
  const html = renderShots(shotRows, 1, 's1', {
    summary: '18.0g → 36.0g',
    when: '2 Sep',
    profileTitle: 'Adaptive v3',
    coffeeName: 'Gesha',
    rating: 'taste=sour, score=2/5',
    advice: { summary: 'Grind finer to 12.0', diagnosis: 'Ran fast.' },
    chart: { elapsedS: [0, 1, 2], pressureBar: [1, 6, 9], flowMlS: [0, 1, 2], evidence: [], phases: null }
  });
  assert.match(html, /taste=sour, score=2\/5/);
  assert.match(html, /Grind finer to 12\.0/);
  assert.match(html, /Ran fast\./);
});

test('a shot with no advice says so instead of leaving a blank row', () => {
  const html = renderShots(shotRows, 1, 's1', {
    summary: '18.0g → 36.0g', when: '2 Sep', profileTitle: 'p', coffeeName: '',
    rating: 'not rated', advice: null, chart: null
  });
  assert.match(html, /None was asked for/);
  assert.match(html, /recorded before curves were stored/, 'and explains the missing chart honestly');
});

// ---- old-browser compatibility -------------------------------------------

test('flex gap is measured, not feature-queried', () => {
  // A fake DOM where a column flex box with a row gap reports no height, the
  // way Chrome 78 behaves. @supports cannot see this, because grid gap is far
  // older and answers true.
  const classes = new Set<string>();
  const noGapDoc = {
    createElement: () => ({ style: {}, appendChild() {}, scrollHeight: 0 }),
    body: { appendChild() {}, removeChild() {} },
    documentElement: { classList: { add: (c: string) => classes.add(c) } }
  } as unknown as Document;

  assert.equal(supportsFlexGap(noGapDoc), false);
  applyCompatFlags(noGapDoc);
  assert.ok(classes.has('no-flex-gap'));
});

test('a browser that honours gap is left alone', () => {
  const classes = new Set<string>();
  const okDoc = {
    createElement: () => ({ style: {}, appendChild() {}, scrollHeight: 10 }),
    body: { appendChild() {}, removeChild() {} },
    documentElement: { classList: { add: (c: string) => classes.add(c) } }
  } as unknown as Document;

  assert.equal(supportsFlexGap(okDoc), true);
  applyCompatFlags(okDoc);
  assert.equal(classes.size, 0, 'no fallback class, so modern spacing is not doubled');
});
