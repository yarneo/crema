/**
 * What we already tried, and how it went.
 *
 * The Tcl advisor sent the shot and the history but never sent its own past
 * recommendations or their outcomes, so every request reasoned from scratch
 * and the model could happily re-suggest a move that had already failed.
 *
 * The trail already pairs each change with the score that followed it, so the
 * attempt log falls straight out of it. This is the cheapest large improvement
 * available to the advisor.
 */

import type { TrailNode } from '../domain/trail.ts';

export interface Attempt {
  /** What changed before that shot, e.g. "grind −0.4". */
  change: string;
  scoreBefore: number | null;
  scoreAfter: number;
  outcome: 'better' | 'worse' | 'no change';
}

/**
 * Pull the rated attempts out of a trail, most recent last.
 *
 * Only nodes that both changed something and earned a score are attempts: a
 * repeat tells the model nothing about a lever, and an unrated shot has no
 * outcome to report. The baseline is excluded for the same reason.
 */
export function extractAttempts(nodes: readonly TrailNode[], limit = 6): Attempt[] {
  const attempts: Attempt[] = [];
  let previousScore: number | null = null;

  for (const node of nodes) {
    const isAttempt = node.changes.length > 0 && node.score !== null;

    if (isAttempt) {
      attempts.push({
        change: node.label,
        scoreBefore: previousScore,
        scoreAfter: node.score!,
        outcome: node.direction === 'up' ? 'better' : node.direction === 'down' ? 'worse' : 'no change'
      });
    }

    if (node.score !== null) previousScore = node.score;
  }

  return attempts.slice(-limit);
}

/** One attempt as a single prompt line. */
export function formatAttempt(attempt: Attempt): string {
  const from = attempt.scoreBefore === null ? '?' : String(attempt.scoreBefore);
  return `${attempt.change} -> score ${from} to ${attempt.scoreAfter} (${attempt.outcome})`;
}

/**
 * The prompt block. Returns an empty string when there is nothing to report,
 * so callers can concatenate without guarding.
 */
export function attemptLogSection(nodes: readonly TrailNode[], limit = 6): string {
  const attempts = extractAttempts(nodes, limit);
  if (attempts.length === 0) return '';

  const lines = attempts.map((a) => `- ${formatAttempt(a)}`).join('\n');
  return [
    'ALREADY TRIED on this bean, oldest first. Do not repeat a change that made',
    'it worse; if a lever moved the score up, consider continuing in that',
    'direction rather than switching levers.',
    lines
  ].join('\n');
}
