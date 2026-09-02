import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt, daysOffRoast, type AdviceRequest } from '../advice/prompt.ts';
import { buildTrail } from '../domain/trail.ts';
import { EMPTY_RATING, describeRating, isRated, ratingCompleteness } from '../domain/rating.ts';
import type { Recipe } from '../domain/recipe.ts';
import { toCurves, type LiveShot } from '../live.ts';
import { hasCurves, needsRating, type ShotRecord } from '../store.ts';

const recipe: Recipe = {
  profileTitle: 'Gentle Decline',
  grind: 12.4,
  doseG: 18,
  targetYieldG: 40,
  temperatureC: 92
};

const request: AdviceRequest = {
  bean: { name: 'La Estrella Gesha', roaster: 'Moonwake', roastDate: '2026-08-20', roastLevel: 'light' },
  grinder: { name: 'Lagom 01', range: '0.1-0.5' },
  recipe,
  curves: {
    elapsedS: [0, 5, 10, 15, 20, 25],
    pressureBar: [1, 2, 6, 9, 8, 7],
    flowMlS: [0, 0.2, 0.5, 2.4, 2.2, 2.0],
    weightFlow: null
  },
  rating: { taste: 'sour', body: 'thin', flow: 'gushed', finish: 'short', score: 2 },
  finalYieldG: 41,
  trail: buildTrail([
    { id: 'a', at: 1, score: 2, recipe },
    { id: 'b', at: 2, score: 3, recipe: { ...recipe, grind: 12.0 } },
    { id: 'c', at: 3, score: 2, recipe: { ...recipe, grind: 12.0, temperatureC: 93 } }
  ])
};

const NOW = Date.parse('2026-09-02');

test('the prompt states the bean, its age, and the grinder units', () => {
  const prompt = buildPrompt(request, NOW);
  assert.match(prompt, /Moonwake La Estrella Gesha/);
  assert.match(prompt, /13 days off roast/);
  assert.match(prompt, /Lagom 01/);
  assert.match(prompt, /Express any grind change in ITS dial units/);
  assert.match(prompt, /usable espresso range is roughly 0\.1-0\.5/);
});

test('it reports what was set and what actually came out', () => {
  const prompt = buildPrompt(request, NOW);
  assert.match(prompt, /Dose 18g in/);
  assert.match(prompt, /Target 40g out, actually 41g/);
  assert.match(prompt, /Ratio 1:2\.3/, 'the ratio uses the real yield, not the target');
  assert.match(prompt, /Grind 12\.4/);
});

test('the taste answers are included', () => {
  const prompt = buildPrompt(request, NOW);
  assert.match(prompt, /taste=sour/);
  assert.match(prompt, /score=2\/5/);
});

test('an unrated shot says so rather than omitting the line', () => {
  const prompt = buildPrompt({ ...request, rating: { ...EMPTY_RATING } }, NOW);
  assert.match(prompt, /Tasted: not rated/);
});

test('the curves are embedded as JSON without basket temperature', () => {
  const prompt = buildPrompt(request, NOW);
  assert.match(prompt, /"elapsed_s":\[/);
  assert.match(prompt, /"pressure_bar":\[/);
  assert.ok(!prompt.includes('basket'), 'the DE1 basket sensor misleads temperature advice');
});

test('the phase analysis and its grind-versus-profile rule are present', () => {
  const prompt = buildPrompt(request, NOW);
  assert.match(prompt, /Flow phases:/);
  assert.match(prompt, /STALL PRESSURE/);
});

test('what already failed is carried into the prompt', () => {
  const prompt = buildPrompt(request, NOW);
  assert.match(prompt, /ALREADY TRIED/);
  assert.match(prompt, /temp \+1\.0 -> score 3 to 2 \(worse\)/);
});

test('the rules and schema come last, where they still bind', () => {
  const prompt = buildPrompt(request, NOW);
  const rules = prompt.indexOf('## RULES');
  const schema = prompt.indexOf('## SCHEMA');
  assert.ok(rules > 0 && schema > rules, 'schema after rules');
  assert.ok(schema > prompt.indexOf('ALREADY TRIED'), 'and both after the data');
  assert.match(prompt.slice(schema), /"screen_summary"/);
});

test('a rebuttal turn names both failure modes', () => {
  const prompt = buildPrompt(
    { ...request, rebuttal: 'It was not sour, it was under-extracted', priorSummary: 'Grind finer', priorDiagnosis: 'ran fast' },
    NOW
  );
  assert.match(prompt, /RECONSIDER/);
  assert.match(prompt, /never just\nrepeat the same words/);
  assert.match(prompt, /never cave reflexively/);
});

test('no rebuttal means no reconsider section', () => {
  assert.ok(!buildPrompt(request, NOW).includes('RECONSIDER'));
});

test('the prompt has no runs of blank lines', () => {
  assert.ok(!/\n\n\n/.test(buildPrompt(request, NOW)));
});

// ---- roast age ------------------------------------------------------------

test('roast age handles missing, malformed and absurd dates', () => {
  assert.equal(daysOffRoast(null), null);
  assert.equal(daysOffRoast('not a date'), null);
  assert.equal(daysOffRoast('1970-01-01', NOW), null, 'older than ten years is not a fresh bag');
  assert.equal(daysOffRoast('2026-09-10', NOW), null, 'a future roast date is not usable');
  assert.equal(daysOffRoast('2026-09-02', NOW), 0);
});

// ---- rating ---------------------------------------------------------------

test('a score alone makes a rating usable', () => {
  assert.equal(isRated({ ...EMPTY_RATING }), false);
  assert.equal(isRated({ ...EMPTY_RATING, score: 3 }), true);
  assert.equal(isRated({ ...EMPTY_RATING, taste: 'sour' }), false, 'descriptors sharpen, the score decides');
});

test('completeness counts every answer', () => {
  assert.equal(ratingCompleteness({ ...EMPTY_RATING }), 0);
  assert.equal(ratingCompleteness(request.rating), 1);
});

test('an empty rating describes as nothing, not as a list of nulls', () => {
  assert.equal(describeRating({ ...EMPTY_RATING }), '');
});

// ---- live shot ------------------------------------------------------------

test('live samples become curve arrays', () => {
  const shot: LiveShot = {
    startedAt: 0,
    samples: [
      { elapsedS: 0, pressureBar: 1, flowMlS: 0, weightFlow: null },
      { elapsedS: 0.5, pressureBar: 6, flowMlS: 1.2, weightFlow: null }
    ]
  };
  const curves = toCurves(shot);
  assert.deepEqual(curves.elapsedS, [0, 0.5]);
  assert.deepEqual(curves.pressureBar, [1, 6]);
  assert.equal(curves.weightFlow, null, 'a partial weight curve is dropped, not padded');
});

test('a weight curve is kept only when every sample has one', () => {
  const shot: LiveShot = {
    startedAt: 0,
    samples: [
      { elapsedS: 0, pressureBar: 1, flowMlS: 0, weightFlow: 0 },
      { elapsedS: 1, pressureBar: 6, flowMlS: 1.2, weightFlow: 1.4 }
    ]
  };
  assert.deepEqual(toCurves(shot).weightFlow, [0, 1.4]);
});

// ---- stored records from older versions -----------------------------------

test('a record written before curves existed is not reopened for rating', () => {
  // The exact shape the store held before curves were persisted: no `curves`
  // key at all. `curves !== null` passes for undefined, which crashed the brew
  // screen, so this is a regression test rather than a hypothetical.
  const legacy = {
    id: 'local-1',
    at: 1,
    bean: { name: null, roaster: null },
    recipe,
    rating: { ...EMPTY_RATING },
    finalYieldG: 36,
    advice: null,
    applied: []
  } as unknown as ShotRecord;

  assert.equal(hasCurves(legacy), false);
  assert.equal(needsRating(legacy), false);
});

test('a record with curves and no score is reopened', () => {
  const fresh: ShotRecord = {
    id: 'local-2',
    at: 2,
    bean: { name: null, roaster: null },
    recipe,
    rating: { ...EMPTY_RATING },
    finalYieldG: 36,
    curves: { elapsedS: [0, 1, 2], pressureBar: [1, 6, 9], flowMlS: [0, 1, 2], weightFlow: null },
    advice: null,
    applied: []
  };
  assert.equal(needsRating(fresh), true);
});

test('an already-scored record is not reopened', () => {
  const rated: ShotRecord = {
    id: 'local-3',
    at: 3,
    bean: { name: null, roaster: null },
    recipe,
    rating: { ...EMPTY_RATING, score: 4 },
    finalYieldG: 36,
    curves: { elapsedS: [0, 1, 2], pressureBar: [1, 6, 9], flowMlS: [0, 1, 2], weightFlow: null },
    advice: null,
    applied: []
  };
  assert.equal(needsRating(rated), false);
});

test('a truncated or malformed curve set is rejected', () => {
  const base = {
    id: 'x', at: 1, bean: { name: null, roaster: null }, recipe,
    rating: { ...EMPTY_RATING }, finalYieldG: 36, advice: null, applied: []
  };
  assert.equal(hasCurves({ ...base, curves: { elapsedS: [0], pressureBar: [1], flowMlS: [0], weightFlow: null } } as ShotRecord), false);
  assert.equal(hasCurves({ ...base, curves: { elapsedS: 'nope' } } as unknown as ShotRecord), false);
  assert.equal(hasCurves({ ...base, curves: null } as ShotRecord), false);
});

// ---- reconsider -----------------------------------------------------------

test('a reconsider carries the prior advice so the model can engage with it', () => {
  const prompt = buildPrompt(
    {
      ...request,
      rebuttal: 'It was not sour, it was thin and watery',
      priorSummary: 'Grind finer to 12.0',
      priorDiagnosis: 'Ran fast and tasted sharp'
    },
    NOW
  );

  assert.match(prompt, /Grind finer to 12\.0/, 'the model must see what it said before');
  assert.match(prompt, /Ran fast and tasted sharp/);
  assert.match(prompt, /thin and watery/, 'and the actual objection');
});

test('a reconsider still carries the shot and the attempt log', () => {
  // The whole point is that it is the same request plus the pushback, not a
  // second, thinner one.
  const prompt = buildPrompt({ ...request, rebuttal: 'too sour' }, NOW);
  assert.match(prompt, /"pressure_bar":\[/);
  assert.match(prompt, /ALREADY TRIED/);
  assert.match(prompt, /Flow phases:/);
  assert.match(prompt, /## SCHEMA/);
});

test('whitespace-only pushback is not a rebuttal', () => {
  assert.ok(!buildPrompt({ ...request, rebuttal: '   \n ' }, NOW).includes('RECONSIDER'));
});

// ---- roast date from the batch --------------------------------------------

test('roast age comes from the batch, which is where roast date lives', () => {
  const fresh = buildPrompt({ ...request, bean: { ...request.bean, roastDate: '2026-08-31' } }, NOW);
  assert.match(fresh, /2 days off roast/);

  const old = buildPrompt({ ...request, bean: { ...request.bean, roastDate: '2026-06-02' } }, NOW);
  assert.match(old, /92 days off roast/);
});

test('an undated bag simply omits the age rather than guessing', () => {
  const prompt = buildPrompt({ ...request, bean: { ...request.bean, roastDate: null } }, NOW);
  assert.ok(!prompt.includes('off roast'));
  assert.match(prompt, /Moonwake La Estrella Gesha/, 'the bean is still named');
});
