import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderAdvice, renderBeansScreen, renderRating, type AdviceModel, type BeansModel } from '../ui/views.ts';
import { diffRecipe, type Recipe } from '../domain/recipe.ts';
import { EMPTY_RATING } from '../domain/rating.ts';

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
