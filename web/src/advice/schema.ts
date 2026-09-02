/**
 * The advice contract: what we ask the model for, and what we accept back.
 *
 * Carried over from the Tcl skin, with two additions that the new UI needs:
 *
 * - `evidence`, time windows on the shot the model is pointing at, so the
 *   advice card can shade the curve instead of asserting at the user.
 * - a per-action `reason`, so the diff card can put one line under each row
 *   rather than one paragraph above all of them.
 *
 * Both are optional on the wire. A model that ignores them still produces
 * usable advice, which matters because people run this against everything from
 * a frontier model to a small local one.
 */

import type { ProfileStep } from '../domain/profile.ts';

export type Confidence = 'low' | 'medium' | 'high';

export type ProfileActionKind = 'keep' | 'switch' | 'create';

/** A span of the shot the diagnosis is citing, in seconds from first drop. */
export interface EvidenceWindow {
  fromS: number;
  toS: number;
  /** Short caption drawn on the chart, e.g. "flow ran away". */
  label: string;
}

/** One proposed numeric move, with the reason it is being made. */
export interface ValueAdvice {
  value: number | null;
  reason: string;
}

export interface GrindAdvice {
  /** Absolute dial setting. Preferred when present and sane. */
  target: number | null;
  /** Dial units, negative is finer. Fallback when there is no target. */
  delta: number | null;
  reason: string;
}

export interface Actions {
  grind: GrindAdvice;
  doseG: ValueAdvice;
  targetYieldG: ValueAdvice;
  temperatureC: ValueAdvice;
}

export interface CreatedProfile {
  title: string;
  notes: string;
  targetWeightG: number | null;
  steps: ProfileStep[];
}

export interface ProfileAdvice {
  action: ProfileActionKind;
  /** Title of an existing profile, when action is "switch". */
  switchTo: string | null;
  /** A whole authored profile, when action is "create". */
  createdProfile: CreatedProfile | null;
  reason: string;
}

export interface Advice {
  diagnosis: string;
  confidence: Confidence;
  actions: Actions;
  profile: ProfileAdvice;
  screenSummary: string;
  evidence: EvidenceWindow[];
}

export const CONFIDENCES: readonly Confidence[] = ['low', 'medium', 'high'];
export const PROFILE_ACTIONS: readonly ProfileActionKind[] = ['keep', 'switch', 'create'];

/** Longest evidence caption we will draw before it stops fitting the chart. */
export const MAX_EVIDENCE_LABEL = 40;

/** More than this many bands and the chart stops meaning anything. */
export const MAX_EVIDENCE_WINDOWS = 3;

/**
 * The schema text handed to the model. Kept as one string so the prompt and
 * the parser sit next to each other and drift is obvious in review.
 */
export const ADVICE_SCHEMA_TEXT = `{
  "diagnosis": "<the KEY reason in at most 2 short sentences, MAX 45 words - it shows in a small card, so be terse; no preamble>",
  "confidence": "low" | "medium" | "high",
  "evidence": [
    {"from_s": <float, seconds from first drop>, "to_s": <float>, "label": "<max 40 chars, what happens in this window, e.g. flow ran away>"}
  ],
  "actions": {
    "grind": {"delta": <float, dial units, negative=finer, 0 if none>, "target": <float absolute dial>, "reason": "<1 short line or empty>"},
    "dose_g": {"value": <float or null>, "reason": "<1 short line or empty>"},
    "target_yield_g": {"value": <float or null>, "reason": "<1 short line or empty>"},
    "temperature_c": {"value": <float or null>, "reason": "<1 short line or empty>"}
  },
  "profile": {
    "action": "keep" | "switch" | "create",
    "switch_to": <existing profile title or null>,
    "created_profile": <null, or {"title","notes","target_weight_g","steps":[{"name","pump":"pressure"|"flow","transition":"fast"|"smooth","temperature":<C>,"seconds":<float>,"volume":<ml or 0>,"weight":<g or 0>,"sensor":"coffee","pressure":<bar, only when pump is pressure>,"flow":<ml/s, only when pump is flow>,"exit":<null or {"type":"pressure"|"flow","condition":"over"|"under","value":<float>}>}]}>,
    "reason": "<1 sentence or empty>"
  },
  "screen_summary": "<max 160 chars, imperative, what to do>"
}`;

/**
 * Guidance that travels with the schema. Change one change at a time is not a
 * style preference: it is what makes the attempt log worth anything, because a
 * shot that moved three levers teaches us nothing about any of them.
 */
export const ADVICE_RULES = [
  'Change ONE thing unless the shot is badly off. Everything you fill in is applied together by one button, so only include what you mean.',
  'Put every field you deliberately leave alone at its current value or null - do not restate it as a change.',
  'Use evidence to point at the part of the curve your diagnosis is about. Give at most 3 windows, inside the shot duration. Omit it entirely rather than guessing.',
  'Respond with ONLY a valid JSON object in exactly the schema given, no prose and no markdown fences.',
  'Keep every string value plain text with NO double-quote characters inside it, so the JSON always parses.'
].join('\n');
