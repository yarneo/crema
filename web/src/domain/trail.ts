/**
 * The convergence trail.
 *
 * Every skin has a shot list, which tells you what happened. None of them can
 * tell you whether it is *working*, because none of them record the change
 * alongside its outcome. Crema does, so it can plot the dial-in as a
 * trajectory: one node per shot, positioned by taste score, labelled with the
 * single thing that changed before it, and coloured by which way the score
 * then moved.
 *
 * Pure: feed it shots, get nodes. No rendering decisions live here beyond the
 * label text.
 */

import { diffRecipe, formatValue, type FieldChange, type Recipe } from './recipe.ts';

export interface TrailShot {
  id: string;
  /** Epoch millis the shot was pulled. */
  at: number;
  /** 1–5 taste score, or null when the shot was never rated. */
  score: number | null;
  /** The recipe this shot was actually pulled with. */
  recipe: Recipe;
}

export type TrailDirection = 'up' | 'down' | 'flat' | 'unknown';

export interface TrailNode {
  id: string;
  at: number;
  score: number | null;
  /** Which way the score moved against the previous *rated* shot. */
  direction: TrailDirection;
  /** Every recipe field that moved since the previous shot. */
  changes: FieldChange[];
  /** Short label for the node, e.g. "grind −0.4", "2 changes", "repeat". */
  label: string;
  /** True once the score reaches the dialled-in threshold. */
  dialedIn: boolean;
}

/** A score at or above this counts as dialled in. */
export const DIALED_IN_SCORE = 4;

/** Minus sign, not a hyphen: it lines up in tabular figures. */
const MINUS = '−';

function signed(value: number, decimals = 1): string {
  const rounded = Number(value.toFixed(decimals));
  if (rounded === 0) return '0';
  return rounded > 0 ? `+${rounded.toFixed(decimals)}` : `${MINUS}${Math.abs(rounded).toFixed(decimals)}`;
}

/**
 * Label one change the way a barista would say it out loud: grind and temp as
 * a delta (a move), dose and yield as the new absolute (a target), profile by
 * name.
 */
export function labelChange(change: FieldChange): string {
  const { field, from, to } = change;

  if (field === 'profileTitle') return typeof to === 'string' && to ? to : 'profile';

  if (typeof from === 'number' && typeof to === 'number' && (field === 'grind' || field === 'temperatureC')) {
    const noun = field === 'grind' ? 'grind' : 'temp';
    return `${noun} ${signed(to - from)}`;
  }

  const noun = field === 'doseG' ? 'dose' : field === 'targetYieldG' ? 'yield' : change.label.toLowerCase();
  return `${noun} ${formatValue(field, to)}`;
}

function labelNode(changes: FieldChange[], isFirst: boolean): string {
  if (isFirst) return 'baseline';
  if (changes.length === 0) return 'repeat';
  if (changes.length === 1) return labelChange(changes[0]!);
  return `${changes.length} changes`;
}

function direction(score: number | null, previousScore: number | null): TrailDirection {
  if (score === null || previousScore === null) return 'unknown';
  if (score > previousScore) return 'up';
  if (score < previousScore) return 'down';
  return 'flat';
}

/**
 * Build the trail from a bean's shots.
 *
 * `shots` may arrive in any order; they are sorted oldest-first so the trail
 * always reads left to right in time. Unrated shots stay on the trail — they
 * still changed something — but they neither carry a direction nor break the
 * comparison chain for the next rated shot.
 */
export function buildTrail(shots: readonly TrailShot[]): TrailNode[] {
  const ordered = [...shots].sort((a, b) => a.at - b.at);
  const nodes: TrailNode[] = [];

  let previousRecipe: Recipe | null = null;
  let previousScore: number | null = null;

  for (const shot of ordered) {
    const changes = previousRecipe ? diffRecipe(previousRecipe, shot.recipe).changes : [];
    const isFirst = previousRecipe === null;

    nodes.push({
      id: shot.id,
      at: shot.at,
      score: shot.score,
      direction: direction(shot.score, previousScore),
      changes,
      label: labelNode(changes, isFirst),
      dialedIn: shot.score !== null && shot.score >= DIALED_IN_SCORE
    });

    previousRecipe = shot.recipe;
    if (shot.score !== null) previousScore = shot.score;
  }

  return nodes;
}

/**
 * Whether the trail is trending the right way, over the last `window` rated
 * shots. Used to decide whether to say "getting closer" or stay quiet; we do
 * not claim a trend from fewer than three rated shots.
 */
export function isConverging(nodes: readonly TrailNode[], window = 4): boolean | null {
  const rated = nodes.filter((n) => n.score !== null).slice(-window);
  if (rated.length < 3) return null;
  const first = rated[0]!.score!;
  const last = rated[rated.length - 1]!.score!;
  return last > first;
}
