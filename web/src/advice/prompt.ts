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

export interface StarterRequest {
  bean: BeanContext;
  grinder: GrinderContext;
  recipe: Recipe;
  /** Exact installed titles, so a switch never invents a profile name. */
  profileTitles: readonly string[];
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

/**
 * The grinder, for a first shot.
 *
 * `grinderLine` speaks of sizing a *move*, which is right after a shot and
 * wrong before one: there is nothing to move from. This asks for an absolute
 * choice instead, and is explicit that the range is user-entered — it is
 * frequently rough or plain wrong, so a model that knows the actual grinder
 * should not be talked out of its own number by a bad range.
 */
function starterGrinderLine(grinder: GrinderContext): string {
  const name = grinder.name?.trim();
  const range = grinder.range?.trim();

  const who = name
    ? `Grinder: ${name}. Look up this grinder's dial and its usual espresso window if you are not certain of them — you have web search, so do not guess and do not hedge.`
    : 'Grinder: not named, so assume a common espresso grinder and keep the number conservative.';

  const window = range
    ? ` The user typed its range as roughly ${range}. That is their own estimate; if what you find for this grinder disagrees, use what you find.`
    : '';

  return `${who}${window} Give the grind as an absolute setting in its dial units.`;
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

/** Build a first-shot recommendation when a new bag has no evidence yet. */
export function buildStarterPrompt(request: StarterRequest, now = Date.now()): string {
  const current = request.recipe;
  return [
    'You are an expert espresso barista helping choose a safe FIRST shot on a Decent DE1.',
    'There is NO shot data for this bag. Do not pretend there is. Give a starting point to dial in from, not a final diagnosis.',
    '',
    beanLine(request.bean, now),
    starterGrinderLine(request.grinder),
    // Deliberately without the current grind. Whatever is on the dial is left
    // over from another coffee — often a number typed to see what happened —
    // and naming it as a "default" anchored the model to it instead of
    // choosing a setting for this grinder. Dose, yield and temperature are
    // real machine settings and stay.
    `Current machine settings (context only): profile ${current.profileTitle ?? 'unknown'}, dose ${current.doseG ?? '?'}g, target ${current.targetYieldG ?? '?'}g, temperature ${current.temperatureC ?? '?'}C.`,
    'The grind currently on the dial is left over from whatever was brewed before and carries no information about this coffee. Ignore it and choose from the grinder itself.',
    `Installed profile titles (switch_to must match one exactly): ${JSON.stringify(request.profileTitles)}.`,
    '',
    'Use roast level and freshness as the strongest evidence. Light roasts usually want more heat, a longer ratio, and gentle preinfusion; dark roasts usually want less heat and a shorter ratio.',
    'For the grind, give an absolute setting on this grinder\u2019s own scale, reasoned from the grinder itself: what you know of that model\u2019s dial, where espresso normally falls on it, and the stated range. Espresso usually sits in the finer part of a grinder\u2019s overall travel, well below the midpoint of a range that also covers filter.',
    'Choose a forgiving, slightly-fine setting rather than a gushing one.',
    // The Tcl wording: switching is preferred, but creating is a real
    // alternative rather than a last resort, and the roast picks the shape.
    'Fill an absolute grind target, dose, target yield, and temperature.',
    'For the profile: prefer SWITCHING to an installed profile that fits the roast — a balanced pressure profile for a medium, a gentle bloom or higher temperature for a light, a lower-temperature or declining one for a dark — OR create a simple 2-4 step profile if that serves this bean better.',
    'Evidence must be an empty array because no shot exists. Confidence should reflect how little is known.',
    'Every reason is read by a barista standing at the machine as the justification for a number. State what the setting is based on — the grinder, the roast, the age of the bag. Do not write about your own uncertainty there; that is what the confidence field is for.',
    'Respond with ONLY one valid JSON object, no prose or markdown.',
    '',
    '## SCHEMA',
    ADVICE_SCHEMA_TEXT
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
