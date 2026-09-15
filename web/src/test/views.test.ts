import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  leadChange,
  renderActionBar,
  renderGhcStop,
  renderAdvice,
  renderAdviceStrip,
  renderBean,
  renderBeansScreen,
  formatBagSize,
  renderRating,
  renderRecipe,
  renderSetup,
  renderShot,
  renderGraphOverlay,
  renderProfiles,
  renderProfileEditor,
  renderShots,
  renderStatus,
  renderWater,
  type AdviceModel,
  type BeansModel
} from '../ui/views.ts';
import { diffRecipe, type Recipe } from '../domain/recipe.ts';
import { newProfile } from '../domain/profile-edit.ts';
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

// ---- brew shortcuts ------------------------------------------------------

test('the brew summary opens the same bean and profile destinations as the full app', () => {
  assert.match(renderBean({ name: 'La Estrella', roastDate: null }), /data-action="open-beans"/);
  const html = renderRecipe(recipe);
  assert.match(html, /data-action="open-beans"/, 'the grind card opens beans and grind');
  assert.match(html, /data-action="open-profiles"/, 'the profile name opens the profile library');
});

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

test('a finished shot can be discarded or saved without AI', () => {
  const html = renderRating({
    rating: { ...EMPTY_RATING },
    shotSummary: '18g → 36g',
    asking: false,
    error: null,
    ready: true
  });
  assert.match(html, /data-action="discard-shot"/);
  assert.match(html, /data-action="save-rating"/, 'a rating can be saved without spending an AI request');
  assert.match(html, /data-action="pending-grind"/, 'the grinder setting actually used can be corrected before saving');
});

test('a missing key is called out where the button is', () => {
  const html = renderRating({
    rating: { ...EMPTY_RATING, score: 3 },
    shotSummary: '18g → 36g',
    asking: false,
    error: null,
    ready: false
  });
  assert.match(html, /Add an API key in Settings/);
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

test('editing a bean is one tap away, not a permanent panel', () => {
  const closed = renderBeansScreen({ ...beans, activeBeanId: 'b1' });
  assert.match(closed, /data-action="edit-bean-open" data-id="b1"/);
  assert.ok(!closed.includes('data-action="edit-bean"'), 'the form is not there until asked for');
  assert.ok(!closed.includes('delete-bean'), 'nor is a delete button');
});

test('the editor opens in place, under the row that was tapped', () => {
  const open = renderBeansScreen({ ...beans, activeBeanId: 'b1', editingBean: beans.rows[0] });
  // It used to render at the foot of the page, so tapping the pencil looked
  // like it had done nothing until you scrolled down and found it.
  const row = open.indexOf('data-action="use-bean" data-id="b1"');
  const editor = open.indexOf('bean-editor-inline');
  const list = open.indexOf('class="list"');
  assert.ok(editor > row, 'the editor follows its row');
  assert.ok(editor > list && editor < open.indexOf('bags-card'), 'and stays inside the beans list');
  assert.match(open, /beanrow[^"]*editing/, 'the row is marked while open');
  assert.match(open, /data-action="edit-bean-close"[^>]*>✕/, 'and the pencil becomes a close');
});

test('the open editor labels its fields and keeps delete away from save', () => {
  const open = renderBeansScreen({
    ...beans,
    activeBeanId: 'b1',
    editingBean: beans.rows[0],
    deleteArmed: false
  });
  assert.match(open, /<span class="label">Roaster<\/span>/);
  assert.match(open, /<span class="label">Bean<\/span>/);
  assert.match(open, /<span class="label">Origin <em>optional<\/em><\/span>/);
  assert.match(open, /value="La Estrella Gesha"/);
  // Delete lives outside the form, behind a rule, and still needs two taps.
  assert.match(open, /<div class="bean-danger">/);
  assert.match(open, /Delete bean/);
  const armed = renderBeansScreen({
    ...beans, activeBeanId: 'b1', editingBean: beans.rows[0], deleteArmed: true
  });
  assert.match(armed, /Tap again to delete bean/);
});

// The first-shot offer moved to Brew, where you actually stand when you are
// about to pull it — see renderFirstShot.
test('the beans screen no longer carries the first-shot offer', () => {
  const html = renderBeansScreen({
    ...beans, activeBeanId: 'b1', activeBean: beans.rows[0], starterAvailable: true, starterReady: true
  });
  assert.ok(!html.includes('starter-advice'));
});

test('the first-shot offer lives in the AI strip, not on the chart', () => {
  const ready = renderAdviceStrip('Ready for the next shot.', false, {
    available: true, ready: true, busy: false, hint: null
  });
  assert.match(ready, /starter-strip/);
  assert.match(ready, /No shots for this coffee yet/);
  assert.match(ready, /data-action="starter-advice"/);
  assert.ok(!/data-action="starter-advice"[^>]*disabled/.test(ready));

  const blocked = renderAdviceStrip('Ready.', false, {
    available: true, ready: false, busy: false, hint: 'Set the bag\u2019s roast level first.'
  });
  assert.match(blocked, /data-action="starter-advice"[^>]*disabled/);
  assert.match(blocked, /Set the bag\u2019s roast level first/, 'says what is missing');
});

test('while the model works, the strip reports the wait instead of holding the screen', () => {
  // The taste screen used to stay up with only a changed button label for the
  // thirty-odd seconds an answer takes, which reads as stuck.
  const html = renderAdviceStrip('Ready.', true, null, null, 12.4);
  assert.match(html, /asking-strip/);
  assert.match(html, /Reading your shot/);
  assert.match(html, /data-asking-elapsed>12s</, 'the wait is counted, not just spun');
  assert.match(html, /keep using the skin/);
  assert.ok(!html.includes('Details ›'), 'nothing to open yet');
});

test('the wait readout never shows a negative age', () => {
  const html = renderAdviceStrip('Ready.', true, null, null, -3);
  assert.match(html, /data-asking-elapsed>0s</);
});

test('the waiting state outranks everything else in the strip', () => {
  // An applied note and a starter offer can both be live when a new question
  // is asked; the question is the news.
  const html = renderAdviceStrip(
    'Ready.',
    true,
    { available: true, ready: true, busy: false, hint: null },
    { summary: 'grind 1.5 › 0.6', canUndo: true, busy: false },
    5
  );
  assert.match(html, /asking-strip/);
  assert.ok(!html.includes('starter-advice'));
  assert.ok(!html.includes('applied-strip'));
});

test('after applying, the brew screen says what changed and offers the undo', () => {
  // Apply used to return you to Brew with nothing to show for it: the recipe
  // row had quietly moved, with no confirmation and no way back.
  const html = renderAdviceStrip('Ready for the next shot.', true, null, {
    summary: 'grind 1.5 › 0.6 · yield 40 › 36',
    canUndo: true,
    busy: false
  });
  assert.match(html, /applied-strip/);
  assert.match(html, /Applied/);
  assert.match(html, /grind 1\.5 › 0\.6 · yield 40 › 36/);
  assert.match(html, /data-action="undo"/);
  // Tapping the banner reopens the advice it is summarising — it had no
  // action at all when first added, so pressing it did nothing.
  assert.match(html, /class="advice-strip applied-strip" data-action="advice-details"/);
  assert.match(html, /Details ›/);
});

test('an applied change with nothing to undo still says what happened', () => {
  const html = renderAdviceStrip('Ready.', true, null, {
    summary: 'grind 1.5 › 0.6', canUndo: false, busy: false
  });
  assert.match(html, /grind 1\.5 › 0\.6/);
  assert.ok(!html.includes('data-action="undo"'));
});

test('a coffee with history gets the ordinary strip', () => {
  const html = renderAdviceStrip('Grind finer to 0.6.', true, {
    available: false, ready: false, busy: false, hint: null
  });
  assert.ok(!html.includes('starter-advice'));
  assert.match(html, /Grind finer to 0\.6\./);
  assert.match(html, /Details ›/);
});

// The chart's job is the last shot's trace; it kept showing one even while the
// offer was on screen, which is why the offer moved off it.
test('the chart is never replaced by the offer', () => {
  const html = renderShot({
    elapsedS: [0, 1, 2], pressureBar: [1, 6, 9], flowMlS: [0, 1, 2], evidence: [], phases: null
  });
  assert.match(html, /<svg/);
  assert.ok(!html.includes('starter-advice'));
});

test('with nothing recorded at all, the chart says what will fill it', () => {
  const html = renderShot(null);
  assert.match(html, /Pull a shot and its pressure and flow are drawn here/);
  assert.ok(!html.includes('starter-advice'));
});

test('the dose you actually pulled is editable, not just displayed', () => {
  // Dose, yield and temp were render-only: the AI could change them through
  // Apply but the barista could not say "I pull 20g", which is the one number
  // only they know.
  const html = renderRecipe({
    profileTitle: 'Adaptive v3', grind: 0.7, doseG: 18, targetYieldG: 36, temperatureC: 93
  });
  for (const field of ['doseG', 'targetYieldG', 'temperatureC', 'grind']) {
    assert.match(html, new RegExp(`data-action="inc" data-field="${field}"`), `${field} has no increase`);
    assert.match(html, new RegExp(`data-action="dec" data-field="${field}"`), `${field} has no decrease`);
  }
});

test('AI setup supports key reveal and a provider test', () => {
  const html = renderSetup({
    provider: 'anthropic', apiKey: 'secret', model: '', baseUrl: '', grinderName: '', grinderRange: '',
    ready: true, saved: false, storageBlocked: false, keyVisible: false, testing: false, testStatus: null,
    theme: 'dark' as const
  });
  assert.match(html, /type="password"/);
  assert.match(html, /data-action="toggle-api-key"/);
  assert.match(html, /data-action="test-ai"/);
});

// The Mac-server default base URL was removed (localhost is right only on the
// Mac itself), which silently invalidated every existing blank field: isReady
// went false and advice just stopped, three screens from the cause.
test('a Mac server with no address says so where it is fixed', () => {
  const base = {
    provider: 'server' as const, apiKey: '', model: '', baseUrl: '', grinderName: '', grinderRange: '',
    ready: false, saved: false, storageBlocked: false, keyVisible: false, testing: false, testStatus: null,
    theme: 'dark' as const
  };
  const blank = renderSetup(base);
  assert.match(blank, /class="needed"/);
  assert.match(blank, /AI advice stays switched off/);
  assert.match(blank, /placeholder="http:\/\/your-mac\.local:8877"/);

  const filled = renderSetup({ ...base, baseUrl: 'http://tiny.local:8877', ready: true });
  assert.ok(!filled.includes('class="needed"'));
  assert.ok(!filled.includes('AI advice stays switched off'));

  // and it is specific to the Mac server: a blank base URL is normal elsewhere
  const anthropic = renderSetup({ ...base, provider: 'anthropic' as const, apiKey: 'k', ready: true });
  assert.ok(!anthropic.includes('class="needed"'));
});

// ---- ways out of the skin ------------------------------------------------

test('inside Decaid, one control leaves the skin — not two doing the same job', () => {
  const html = renderStatus({
    settingsUrl: 'http://localhost:8080/api/v1/plugins/settings.reaplugin/ui?backName=Crema',
    canExit: true,
    gatewayOnline: true,
    machineConnected: true,
    scaleConnected: false,
    machineState: 'idle',
    groupTempC: 93,
    waterLevelMm: 45,
    scaleG: null
  });
  assert.match(html, /data-action="exit-skin"/);
  assert.equal((html.match(/statlink out/g) ?? []).length, 1, 'one way out, not a link beside a button');
  assert.ok(!html.includes('backName=Crema'), 'the in-app exit wins over navigating away');
});

test('in a plain browser the exit falls back to the Decaid settings URL', () => {
  const html = renderStatus({
    settingsUrl: 'http://localhost:8080/api/v1/plugins/settings.reaplugin/ui?backName=Crema',
    canExit: false,
    gatewayOnline: true,
    machineConnected: true,
    scaleConnected: false,
    machineState: 'idle',
    groupTempC: 93,
    waterLevelMm: 45,
    scaleG: null
  });
  assert.match(html, /backName=Crema/, 'so Decaid offers a way back to us');
  assert.ok(!html.includes('exit-skin'));
  assert.equal((html.match(/statlink out/g) ?? []).length, 1);
});

test('sleep and wake sit in the header row, reachable from every tab', () => {
  const asleep = renderStatus({
    settingsUrl: null, canExit: false, gatewayOnline: true, machineConnected: true,
    scaleConnected: false, machineState: 'sleeping', groupTempC: null, waterLevelMm: null,
    scaleG: null
  });
  assert.match(asleep, /data-action="machine" data-state="idle"[^>]*>Wake</);

  const awake = renderStatus({
    settingsUrl: null, canExit: false, gatewayOnline: true, machineConnected: true,
    scaleConnected: false, machineState: 'idle', groupTempC: null, waterLevelMm: null,
    scaleG: null
  });
  assert.match(awake, /data-state="sleeping"[^>]*>Sleep</);

  // Nothing to wake when no machine is connected.
  const offline = renderStatus({
    settingsUrl: null, canExit: false, gatewayOnline: true, machineConnected: false,
    scaleConnected: false, machineState: null, groupTempC: null, waterLevelMm: null,
    scaleG: null
  });
  assert.match(offline, /sleep-control[^>]*disabled/);
});

test('device status is actionable and says machine and scale in full', () => {
  const html = renderStatus({
    settingsUrl: null,
    canExit: false,
    gatewayOnline: true,
    machineConnected: true,
    scaleConnected: false,
    machineState: 'idle',
    groupTempC: 92,
    waterLevelMm: 41,
    scaleG: null
  });
  assert.match(html, /Machine · idle/);
  assert.match(html, /Connect scale/);
  assert.equal((html.match(/data-action="device-control"/g) ?? []).length, 2);
});

test('no dashboard button outside Decaid, where there is nothing to return to', () => {
  const html = renderStatus({
    settingsUrl: null,
    canExit: false,
    gatewayOnline: true,
    machineConnected: false,
    scaleConnected: false,
    machineState: null,
    groupTempC: null,
    waterLevelMm: null,
    scaleG: null
  });
  assert.ok(!html.includes('exit-skin'));
  assert.ok(!html.includes('statlink out'));
});


// ---- machine action bar ---------------------------------------------------

test('nothing is commandable without a connected machine', () => {
  const html = renderActionBar({ machineState: null, busy: false });
  assert.match(html, /no machine connected/);
  for (const label of ['Espresso', 'Steam', 'Water', 'Flush']) {
    assert.match(html, new RegExp(`${label}</button>`), `${label} is present`);
  }
  assert.equal((html.match(/disabled/g) ?? []).length, 4, 'all four actions are disabled');
});

test('a sleeping machine will not brew', () => {
  const html = renderActionBar({ machineState: 'sleeping', busy: false });
  assert.match(html, /data-state="espresso"[^>]*disabled/, 'no brewing until it is awake');
});

// Sleep/Wake belongs to the header strip, where it is reachable from every tab
// and can align with the other machine-state controls. The rail is for the
// things you can only do while looking at the brew screen.
test('the machine rail no longer carries its own Sleep control', () => {
  for (const state of [null, 'sleeping', 'idle']) {
    const html = renderActionBar({ machineState: state, busy: false });
    assert.ok(!html.includes('sleep-control'), `no sleep control for ${state}`);
    assert.ok(!html.includes('>Wake'), `no Wake for ${state}`);
  }
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

test('an idle machine can start anything', () => {
  const html = renderActionBar({ machineState: 'idle', busy: false });
  assert.ok(!/data-state="espresso"[^>]*disabled/.test(html));
});

test('a GHC machine uses its physical start controls, so the rail empties', () => {
  const html = renderActionBar({ machineState: 'idle', busy: false, hasGhc: true });
  assert.ok(!html.includes('data-state='));
});

test('a disconnected GHC machine leaves nothing in the rail to spill out', () => {
  // The layout collapses this rail to 0x0 on a GHC machine. Anything left in
  // it paints outside that box — "no machine connected" turned up over the
  // bean headline once GHC stopped being forgotten on disconnect.
  const html = renderActionBar({ machineState: null, busy: false, hasGhc: true });
  assert.ok(!html.includes('no machine connected'));
  assert.equal(html.trim(), '<div class="actionbar"></div>');
});

test('without a GHC the note still explains an empty rail', () => {
  const html = renderActionBar({ machineState: null, busy: false, hasGhc: false });
  assert.match(html, /no machine connected/);
});

test('a running GHC machine leaves Stop to the brew screen', () => {
  const html = renderActionBar({ machineState: 'espresso', busy: false, hasGhc: true });
  assert.ok(!html.includes('data-state='));

  const stop = renderGhcStop('espresso', false);
  assert.match(stop, /data-state="idle"/);
  assert.match(stop, />Stop<\/button>/);
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
  assert.match(renderShots(shotRows, 1, 's1', null), /class="shot-row active"/);
});

test('the dial-in trail belongs to shot history, not bean management', () => {
  const history = renderShots([{ ...shotRows[0]!, inTrail: true }], 1, null, null, [
    { id: 's1', at: 1, score: 3, label: 'baseline', changes: [], direction: 'unknown', dialedIn: false }
  ], 'Gesha', true);
  assert.match(history, /Dial-in · Gesha/);
  assert.match(history, /data-action="cycle-trail"/);
  assert.match(history, /shot-row in-trail/);
  assert.doesNotMatch(renderBeansScreen(beans), /Dial-in trail/);
});

// A trail card above "No shots recorded yet" said the opposite of the sentence
// under it, and it was drawn from sample data the barista never asked for.
test('an empty history plots nothing, and says so once', () => {
  const html = renderShots([], 0, null, null, [], null, false);
  assert.match(html, /No shots recorded yet/);
  assert.ok(!html.includes('<svg'), 'nothing is plotted when nothing was recorded');
  assert.ok(!html.includes('Dial-in'));
});


test('an empty chart invites a shot rather than inventing one', () => {
  const html = renderShot(null);
  assert.match(html, /shot-placeholder/);
  assert.match(html, /Pull a shot/);
  assert.ok(!html.includes('<svg'));
});

// ---- adding a bag --------------------------------------------------------

test('every bag field is labelled, and the optional ones say so', () => {
  const html = renderBeansScreen({ ...beans, activeBeanId: 'b1', batches: [] });
  assert.match(html, /<span class="label">Roast date<\/span>/);
  assert.match(html, /<span class="label">Roast level <em>optional<\/em><\/span>/);
  assert.match(html, /<span class="label">Bag size <em>optional<\/em><\/span>/);
});

test('the date field carries its own hint, since a date input cannot', () => {
  // Safari draws an empty date input as a bare box — the reason this field
  // read as missing entirely — and `placeholder` does not apply to it.
  const html = renderBeansScreen({ ...beans, activeBeanId: 'b1', batches: [] });
  assert.match(html, /<span class="date-hint" aria-hidden="true">Tap to choose the roast date<\/span>/);
});

test('roast level is chosen from the fixed vocabulary, not typed', () => {
  const html = renderBeansScreen({ ...beans, activeBeanId: 'b1', batches: [] });
  for (const level of ['Light', 'Medium-light', 'Medium', 'Medium-dark', 'Dark']) {
    assert.match(html, new RegExp(`data-action="pick-roast-level" data-value="${level}"`), level);
  }
  assert.ok(!html.includes('placeholder="Roast level (optional)"'));
});

test('bag size is a stepper, and reads as unset until it is touched', () => {
  const blank = renderBeansScreen({ ...beans, activeBeanId: 'b1', batches: [] });
  assert.match(blank, /data-action="bag-size" data-step="-50"/);
  assert.match(blank, /data-action="bag-size" data-step="50"/);
  assert.match(blank, /class="bag-size-value unset">Not set</);
  assert.ok(!blank.includes('placeholder="Bag grams (optional)"'));
});

test('chosen values survive a re-render, because they live in state', () => {
  const html = renderBeansScreen({
    ...beans, activeBeanId: 'b1', batches: [],
    newBatch: { roastLevel: 'Medium-dark', weightG: 500 }
  });
  assert.match(html, /class="chip on" data-action="pick-roast-level" data-value="Medium-dark"/);
  assert.match(html, /class="bag-size-value">500 g</);
});

test('a kilo bag reads as a kilo, not as 1000 g', () => {
  assert.equal(formatBagSize(1000), '1 kg');
  assert.equal(formatBagSize(250), '250 g');
  assert.equal(formatBagSize(null), 'Not set');
  assert.equal(formatBagSize(0), 'Not set', 'zero grams is no bag, not an empty one');
});

// ---- setting a grind -----------------------------------------------------

test('an unset grind can be typed, not only nudged', () => {
  const html = renderBeansScreen({ ...beans, grind: null });
  assert.match(html, /data-action="set-grind"/);
  assert.match(html, /class="grind-entry unset"/);
  assert.match(html, /type your grinder/);
});

test('with a dial range configured, nudging is offered as the way in', () => {
  const html = renderBeansScreen({ ...beans, grind: null, grinderRange: '0.1-0.5' });
  assert.match(html, /middle of your dial range/);
});

test('a set grind shows its value in the entry', () => {
  const html = renderBeansScreen({ ...beans, grind: 12.4 });
  assert.match(html, /data-action="set-grind"[^>]*\n?[^>]*value="12.4"/);
  assert.ok(!html.includes('grind-entry unset'));
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

test('stored shot detail exposes the full review workflow', () => {
  const html = renderShots([], 0, null, null);
  assert.ok(html.includes('No shots'));

  const detailHtml = renderShots(
    [{ id: 'shot-1', when: 'now', profileTitle: 'Bloom', coffeeName: 'Kenya', summary: '18g → 40g' }],
    1,
    'shot-1',
    {
      id: 'shot-1', summary: '18g → 40g', when: 'now', profileTitle: 'Bloom', coffeeName: 'Kenya', rating: 'sweet',
      advice: { summary: 'Go finer', diagnosis: 'The pour ran fast.' },
      chart: { elapsedS: [0, 1], pressureBar: [0, 9], flowMlS: [0, 2], evidence: [], phases: null },
      ready: true, canApply: true, rebuttalOpen: true, rebuttalText: 'not sour'
    }
  );
  for (const action of ['toggle-stored-rebuttal', 'review-shot', 'apply-stored', 'delete-shot', 'reconsider-stored']) {
    assert.match(detailHtml, new RegExp(`data-action="${action}"`));
  }
});

// Pressing Reconsider at the bottom of a long detail page used to change
// nothing within sight: the busy state showed on the *other* button and the
// outcome rendered above the action row, off-screen. It read as a dead button.
const storedDetail = (over: Record<string, unknown>) => renderShots(
  [{ id: 'shot-1', when: 'now', profileTitle: 'Bloom', coffeeName: 'Kenya', summary: '18g → 40g' }],
  1,
  'shot-1',
  {
    id: 'shot-1', summary: '18g → 40g', when: 'now', profileTitle: 'Bloom', coffeeName: 'Kenya', rating: 'sweet',
    advice: { summary: 'Go finer', diagnosis: 'The pour ran fast.' },
    chart: { elapsedS: [0, 1], pressureBar: [0, 9], flowMlS: [0, 2], evidence: [], phases: null },
    ready: true, canApply: true, rebuttalOpen: true, rebuttalText: 'not sour', ...over
  } as never
);

test('a stored reconsider in flight says so on the button that was pressed', () => {
  const idle = storedDetail({});
  assert.match(idle, /type="submit"[^>]*>Reconsider</);

  const busy = storedDetail({ busy: true });
  assert.match(busy, /type="submit" disabled>Rethinking…</);
  assert.ok(!/type="submit"[^>]*>Reconsider</.test(busy));
});

test('a stored review error lands inside the open rebuttal form, not above it', () => {
  const open = storedDetail({ error: 'Could not reach the model.' });
  const form = open.slice(open.indexOf('data-action="reconsider-stored"'));
  assert.match(form, /Could not reach the model\./);
  // and exactly once — not also in the row the user has scrolled past
  assert.equal(open.split('Could not reach the model.').length - 1, 1);

  // with the form closed it goes back to the detail body, which is then in view
  const closed = storedDetail({ error: 'Could not reach the model.', rebuttalOpen: false });
  assert.match(closed, /Could not reach the model\./);
  assert.equal(closed.split('Could not reach the model.').length - 1, 1);
});

test('shot charts show targets, the previous shot, and an expanded detail view', () => {
  const chart = {
    elapsedS: [0, 10, 20], pressureBar: [0, 9, 6], flowMlS: [0, 2, 3],
    pressureGoal: [0, 9, 6], flowGoal: [4, 2, 3], weightG: [0, 18, 38], temperatureC: [88, 92, 92],
    previous: { elapsedS: [0, 10, 20], pressureBar: [0, 8, 5], flowMlS: [0, 3, 4] },
    evidence: [], phases: null
  };
  const compact = renderShot(chart);
  assert.match(compact, /Detailed graph/);
  assert.match(compact, /target/);
  assert.match(compact, /previous shot/);
  const expanded = renderGraphOverlay(chart);
  assert.match(expanded, /temperature · °C/);
  assert.match(expanded, /total weight · g/);
  assert.match(expanded, /data-action="close-graph"/);
});

test('stored charts can cycle named comparison shots', () => {
  const html = renderShot({
    elapsedS: [0, 10], pressureBar: [0, 9], flowMlS: [0, 2],
    previous: { elapsedS: [0, 10], pressureBar: [0, 8], flowMlS: [0, 3] },
    evidence: [], phases: null, canCycleComparison: true, comparisonLabel: 'Sep 10 · 3/5'
  });
  assert.match(html, /data-action="cycle-comparison"/);
  assert.match(html, /Compare · Sep 10 · 3\/5/);
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

// ---- the advice headline -------------------------------------------------

test('a grind change leads with the direction, not just the number', () => {
  // "12.0", not "12" — formatGrind keeps the dial's one decimal, matching the
  // Tcl skin. The grinder is labelled that way, so the advice should be too.
  const finer = leadChange(diffRecipe(recipe, { grind: 12.0 }));
  assert.deepEqual(finer, { verb: 'finer', value: '12.0', detail: 'grind · 12.4 › 12.0' });

  const coarser = leadChange(diffRecipe(recipe, { grind: 12.8 }));
  assert.equal(coarser?.verb, 'coarser', 'direction is the whole point of the word');
});

test('grind leads even when other fields also moved', () => {
  const lead = leadChange(diffRecipe(recipe, { temperatureC: 94, grind: 12.0, targetYieldG: 36 }));
  assert.equal(lead?.verb, 'finer', 'grind is the usual lever, so it gets the headline');
});

test('without a grind change, the first change leads', () => {
  assert.equal(leadChange(diffRecipe(recipe, { targetYieldG: 36 }))?.verb, 'yield');
  assert.equal(leadChange(diffRecipe(recipe, { temperatureC: 94 }))?.verb, 'temp');
});

test('a profile switch reads as an instruction', () => {
  const lead = leadChange(diffRecipe(recipe, { profileTitle: 'Blooming Espresso' }));
  assert.equal(lead?.verb, 'switch to');
  assert.equal(lead?.value, 'Blooming Espresso');
});

test('no change means no headline, rather than an empty one', () => {
  assert.equal(leadChange(diffRecipe(recipe, {})), null);
  assert.ok(!renderAdvice({ ...advice, diff: diffRecipe(recipe, {}) }).includes('class="hero"'));
});

test('the headline appears alongside the diff, not instead of it', () => {
  const html = renderAdvice(advice);
  assert.match(html, /class="hero"/);
  assert.match(html, /finer/);
  assert.match(html, /28g out in 19s/, 'the per-field reason still shows');
  assert.match(html, /Held/, 'and so does what was deliberately not changed');
});


// ---- a starting point is not a correction ---------------------------------

const startingDiff = {
  changes: [
    { field: 'grind', label: 'Grind', unit: '', from: 1.5, to: 0.6, reason: 'Lagom 01 espresso sits around 0.4-1.0.' },
    { field: 'targetYieldG', label: 'Yield', unit: 'g', from: 40, to: 36, reason: '' }
  ],
  held: [
    { field: 'doseG', label: 'Dose', unit: 'g', from: 18, to: 18, reason: '' }
  ]
} as const;

const startingModel = {
  diagnosis: 'No shot data for this bag yet.',
  confidence: 'low',
  diff: startingDiff as never,
  canUndo: false,
  busy: false,
  rebuttalOpen: false,
  rebuttalText: '',
  reconsidering: false,
  canReconsider: false,
  starting: true
};

test('a starting point shows settings to use, never a before and after', () => {
  // The number on the dial beforehand is left over from another coffee and was
  // never a choice, so showing "1.5 › 0.6" invents a decision nobody made.
  const html = renderAdvice(startingModel);
  assert.ok(!html.includes('class="was"'), 'no struck-through previous value');
  assert.ok(!html.includes('1.5'), 'and the leftover number is not quoted at all');
  assert.match(html, /Starting point/);
  assert.match(html, /start at<\/b><span>0\.6</, 'the headline states the value, not a direction');
  assert.ok(!html.includes('finer'), '"finer" is a comparative with nothing to compare to');
  assert.match(html, /Use these settings/);
});

test('a starting point lists every setting, including the unchanged ones', () => {
  // "Held" means "deliberately not moved", which is meaningless before the
  // first shot — dose 18 is simply part of the recipe to pull.
  const html = renderAdvice(startingModel);
  assert.match(html, /Dose/);
  assert.ok(!html.includes('Deliberately unchanged'));
});

test('an ordinary correction still shows the move', () => {
  const html = renderAdvice({ ...startingModel, starting: false });
  assert.match(html, /class="was"/);
  assert.match(html, /Dial-in advice/);
  assert.match(html, /Use for next shot/);
});

// ---- stage labels on a busy profile ---------------------------------------

/**
 * A profile whose target steps every `everyS` seconds across a full-length
 * shot — the shape that overlapped. Boundaries are kept 0.5s apart upstream,
 * and on a 36s shot half a second is about thirteen pixels, so a dense
 * profile puts far more labels on the axis than there is room to read.
 */
function busyProfile(stages: number, everyS = 0.6) {
  const step = 0.2;
  const perStage = Math.round(everyS / step);
  const elapsedS: number[] = [];
  const pressureGoal: number[] = [];
  for (let i = 0; i < stages * perStage; i += 1) {
    elapsedS.push(Number((i * step).toFixed(1)));
    pressureGoal.push(2 + (Math.floor(i / perStage) % 6) * 1.5);
  }
  return {
    elapsedS,
    pressureBar: elapsedS.map(() => 6),
    flowMlS: elapsedS.map(() => 2),
    pressureGoal,
    flowGoal: elapsedS.map(() => 0),
    evidence: [],
    phases: null
  };
}

test('stage labels are dropped rather than stacked on top of each other', () => {
  const html = renderShot(busyProfile(60));
  const labels = [...html.matchAll(/<text class="stage-label" x="([\d.]+)"/g)].map((m) => Number(m[1]));
  const lines = [...html.matchAll(/class="stage-line"/g)].length;

  assert.ok(labels.length >= 2, 'some labels survive');
  assert.ok(lines > labels.length, 'every boundary still gets its dividing line');

  // Whatever is drawn must be readable: no two labels within a label's width.
  for (let i = 1; i < labels.length; i += 1) {
    assert.ok(labels[i]! - labels[i - 1]! >= 58, `labels at ${labels[i - 1]} and ${labels[i]} would overlap`);
  }
});

test('a label with no room before the right edge is dropped, not clipped', () => {
  const html = renderShot(busyProfile(60));
  const labels = [...html.matchAll(/<text class="stage-label" x="([\d.]+)"/g)].map((m) => Number(m[1]));
  for (const at of labels) assert.ok(at + 58 <= 954, `label at ${at} runs past the plot`);
});

test('the evidence label does not share a row with the stage labels', () => {
  const html = renderShot({
    ...busyProfile(4, 2),
    evidence: [{ fromS: 1, toS: 3, label: 'flow ran away' }]
  });
  const stage = html.match(/<text class="stage-label"[^>]*y="(\d+)"/);
  const evidence = html.match(/<text class="evlabel"[^>]*y="(\d+)"/);
  assert.ok(stage && evidence);
  assert.notEqual(stage![1], evidence![1], 'they used to be drawn at the same height');
});

// ---- getting back out of an open shot -------------------------------------

test('an open shot can be closed, and the list is still there behind it', () => {
  const html = renderShots(shotRows, 1, 's1', {
    summary: '18.0g → 36.0g',
    when: '2 Sep',
    profileTitle: 'Adaptive v3',
    coffeeName: 'Gesha',
    rating: 'taste=sour, score=2/5',
    advice: null,
    chart: null
  });
  assert.match(html, /data-action="close-shot"/);
  // The detail opens beneath the list rather than replacing it — which is why
  // it needs both a close and a scroll, not just one of them.
  assert.ok(html.indexOf('shot-list') < html.indexOf('shot-detail-wrap'));
  assert.match(html, /data-action="open-shot"/, 'other shots remain reachable');
});

// ---- building a profile by hand -------------------------------------------

test('the profiles screen offers a way to make one', () => {
  const html = renderProfiles(
    [{ id: 'p1', title: 'Adaptive v3', author: 'Decent', steps: 7, active: true }],
    '',
    false
  );
  assert.match(html, /data-action="profile-new"/);
  assert.match(html, /data-action="profile-duplicate" data-id="p1"/, 'and a way to start from an existing one');
});

test('the editor exposes the four fields that decide a shot', () => {
  const html = renderProfileEditor({
    profile: newProfile('Mine'),
    problem: null,
    busy: false,
    fresh: true
  });
  for (const field of ['pump', 'target', 'seconds', 'temperature']) {
    assert.match(html, new RegExp(`data-field="${field}"`), field);
  }
  assert.match(html, /data-action="step-add"/);
  assert.match(html, /data-action="step-move"[^>]*data-by="-1"/);
  assert.match(html, /data-action="step-remove"/);
  assert.match(html, /value="Mine"/);
});

test('the target unit follows what the step holds', () => {
  const pressure = renderProfileEditor({ profile: newProfile(), problem: null, busy: false, fresh: true });
  assert.match(pressure, /Target <em>mL\/s<\/em>/, 'the flow step is measured in mL/s');
  assert.match(pressure, /Target <em>bar<\/em>/, 'the pressure step in bar');
});

test('a profile that cannot be saved says why, and Save is refused', () => {
  const html = renderProfileEditor({
    profile: newProfile(''),
    problem: 'Give the profile a name.',
    busy: false,
    fresh: true
  });
  assert.match(html, /Give the profile a name\./);
  assert.match(html, /data-action="profile-save"[^>]*disabled/);
});

test('the editor shows the plan it is building', () => {
  const html = renderProfileEditor({ profile: newProfile(), problem: null, busy: false, fresh: true });
  assert.match(html, /class="spark"/, 'the curve updates as the steps change');
  assert.match(html, /2 steps · pressure and flow/);
});
