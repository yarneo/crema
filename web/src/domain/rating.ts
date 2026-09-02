/**
 * The post-shot questionnaire.
 *
 * Four taps and a score, because anything longer does not get filled in while
 * you are holding a cup. Every question is a small closed set rather than free
 * text: it makes the answers comparable across shots, which is what lets the
 * attempt log say "that lever made it worse".
 */

export interface RatingQuestion {
  key: RatingKey;
  label: string;
  options: readonly string[];
}

export type RatingKey = 'taste' | 'body' | 'flow' | 'finish';

export const RATING_QUESTIONS: readonly RatingQuestion[] = [
  { key: 'taste', label: 'Taste', options: ['sour', 'balanced', 'bitter'] },
  { key: 'body', label: 'Body', options: ['thin', 'good', 'heavy'] },
  { key: 'flow', label: 'Flow', options: ['gushed', 'even', 'choked'] },
  { key: 'finish', label: 'Finish', options: ['short', 'clean', 'harsh', 'astringent'] }
] as const;

/** 1 is undrinkable, 5 is the one you would serve. */
export const SCORES = [1, 2, 3, 4, 5] as const;

export interface Rating {
  taste: string | null;
  body: string | null;
  flow: string | null;
  finish: string | null;
  score: number | null;
}

export const EMPTY_RATING: Rating = { taste: null, body: null, flow: null, finish: null, score: null };

/**
 * A score is the only thing the trail and the attempt log actually need, so
 * that alone makes a rating worth sending. The descriptors sharpen the advice
 * but are not required.
 */
export function isRated(rating: Rating): boolean {
  return rating.score !== null;
}

/** How much of the questionnaire is filled in, for a progress hint. */
export function ratingCompleteness(rating: Rating): number {
  const parts = [rating.taste, rating.body, rating.flow, rating.finish, rating.score];
  return parts.filter((p) => p !== null).length / parts.length;
}

/** The answers as a prompt line. Empty when nothing was answered. */
export function describeRating(rating: Rating): string {
  const parts: string[] = [];
  for (const question of RATING_QUESTIONS) {
    const value = rating[question.key];
    if (value) parts.push(`${question.key}=${value}`);
  }
  if (rating.score !== null) parts.push(`score=${rating.score}/5`);
  return parts.join(', ');
}
