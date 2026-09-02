/**
 * Assembling the request.
 *
 * This is where everything else meets: the shot's curves, the phase analysis,
 * what the bean is and how old it is, the grinder and its units, the recipe
 * that was actually pulled, the taste answers, and — the part the Tcl skin
 * never sent — what we already tried on this bean and how it went.
 *
 * Ordering is deliberate. The rules and the schema go last, because that is
 * what the model is most likely to still be following by the time it starts
 * writing.
 */

import { formatGrind } from '../domain/grind.ts';
import type { Recipe } from '../domain/recipe.ts';
import type { Rating } from '../domain/rating.ts';
import { describeRating } from '../domain/rating.ts';
import type { TrailNode } from '../domain/trail.ts';
import { attemptLogSection } from './attempts.ts';
import { brewRatio, buildCurvePayload, shotDuration, type ShotCurves } from './curves.ts';
import { analyseFlowPhases, describeFlowPhases } from './phases.ts';
import { ADVICE_RULES, ADVICE_SCHEMA_TEXT } from './schema.ts';

export interface BeanContext {
  name: string | null;
  roaster: string | null;
  /** ISO date, used for days off roast. Freshness changes the advice. */
  roastDate: string | null;
  roastLevel: string | null;
}

export interface GrinderContext {
  name: string | null;
  /** e.g. "0.1-0.5". Used to size a move, never to clamp one. */
  range: string | null;
}

export interface AdviceRequest {
  bean: BeanContext;
  grinder: GrinderContext;
  /** The recipe the shot was actually pulled with. */
  recipe: Recipe;
  curves: ShotCurves;
  rating: Rating;
  /** Actual liquid out, which may differ from the target. */
  finalYieldG: number | null;
  /** This bean's history, for the attempt log. */
  trail: readonly TrailNode[];
  /** Set when the barista pushed back on advice we just gave. */
  rebuttal?: string;
  priorSummary?: string;
  priorDiagnosis?: string;
}

/** Whole days since roast, or null when unknown or implausible. */
export function daysOffRoast(roastDate: string | null, now = Date.now()): number | null {
  if (!roastDate) return null;
  const parsed = Date.parse(roastDate);
  if (Number.isNaN(parsed)) return null;
  const days = Math.floor((now - parsed) / 86_400_000);
  return days >= 0 && days < 3650 ? days : null;
}

function beanLine(bean: BeanContext, now: number): string {
  const bits = [bean.roaster, bean.name].filter(Boolean).join(' ');
  const age = daysOffRoast(bean.roastDate, now);
  const parts = [bits || 'an unnamed bean'];
  if (bean.roastLevel) parts.push(bean.roastLevel);
  if (age !== null) parts.push(`${age} days off roast`);
  return `Bean: ${parts.join(', ')}.`;
}

function grinderLine(grinder: GrinderContext): string {
  const name = grinder.name?.trim() || 'an unspecified grinder';
  const range = grinder.range?.trim()
    ? ` Its usable espresso range is roughly ${grinder.range.trim()}, so size your move to that window.`
    : '';
  return `Grinder: ${name}. Express any grind change in ITS dial units.${range}`;
}

function recipeLine(recipe: Recipe, finalYieldG: number | null, durationS: number | null): string {
  const ratio = brewRatio(recipe.doseG, finalYieldG ?? recipe.targetYieldG);
  return [
    `Profile: ${recipe.profileTitle ?? 'unknown'}.`,
    `Dose ${recipe.doseG ?? '?'}g in.`,
    `Target ${recipe.targetYieldG ?? '?'}g out, actually ${finalYieldG ?? '?'}g.`,
    ratio ? `Ratio ${ratio}.` : '',
    `Brew temperature ${recipe.temperatureC ?? '?'}C.`,
    recipe.grind === null ? 'Grind not recorded.' : `Grind ${formatGrind(recipe.grind)}.`,
    durationS === null ? '' : `Shot ran ${durationS}s.`
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The reconsider turn.
 *
 * Wording carried over from the Tcl on purpose. Both failure modes are named:
 * caving reflexively because someone pushed back, and repeating the original
 * advice verbatim without engaging with the objection.
 */
function rebuttalSection(request: AdviceRequest): string {
  const rebuttal = request.rebuttal?.trim();
  if (!rebuttal) return '';

  return [
    '## RECONSIDER - the barista disagrees with the advice you just gave',
    `Your previous advice for THIS shot: "${request.priorSummary ?? ''}" (${request.priorDiagnosis ?? ''})`,
    `Their pushback: "${rebuttal}"`,
    'Take it seriously - they know their palate, grinder and machine, and may have context the numbers do not show.',
    'Re-examine the curves, time and taste with their point in mind. If they are right, CHANGE your recommendation.',
    'If your original still holds, keep it but explain plainly why their concern does not change it - never just',
    'repeat the same words, and never cave reflexively just because they pushed back. Address their point directly.'
  ].join('\n');
}

/** Build the full prompt for one advice request. */
export function buildPrompt(request: AdviceRequest, now = Date.now()): string {
  const durationS = shotDuration(request.curves.elapsedS);
  const phases = analyseFlowPhases({
    elapsedS: request.curves.elapsedS,
    pressureBar: request.curves.pressureBar,
    flowMlS: request.curves.flowMlS,
    weightFlow: request.curves.weightFlow ?? null
  });

  const tasted = describeRating(request.rating);

  const sections = [
    'You are an expert espresso barista helping dial in a Decent DE1.',
    'You are given one shot: what was set, what the machine actually did, and how it tasted.',
    '',
    beanLine(request.bean, now),
    grinderLine(request.grinder),
    recipeLine(request.recipe, request.finalYieldG, durationS),
    tasted ? `Tasted: ${tasted}.` : 'Tasted: not rated.',
    '',
    `Shot curves (downsampled, seconds from first drop):\n${JSON.stringify(buildCurvePayload(request.curves))}`,
    phases ? `\n${describeFlowPhases(phases)}` : '',
    '',
    attemptLogSection(request.trail),
    '',
    rebuttalSection(request),
    '',
    '## RULES',
    ADVICE_RULES,
    '',
    '## SCHEMA',
    ADVICE_SCHEMA_TEXT
  ];

  // Collapse the blank-line padding rather than emitting runs of them, which
  // waste tokens and make the prompt harder to read when debugging.
  return sections
    .filter((section, index) => section !== '' || sections[index - 1] !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
