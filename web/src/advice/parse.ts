/**
 * Turning whatever the model actually said into advice we can render.
 *
 * The parser is deliberately forgiving. Crema runs against everything from a
 * frontier model to a small local one, and the weaker the model the more
 * creative the envelope: markdown fences, a sentence of preamble, numbers as
 * strings, a Unicode minus, a bare number where an object was asked for. None
 * of that is a reason to show the user an error, so we recover what we can and
 * record what we had to fix.
 *
 * What we will not do is invent. A field we cannot read becomes null, which
 * downstream means "leave it alone" — never a guessed change to the machine.
 */

import {
  CONFIDENCES,
  MAX_EVIDENCE_LABEL,
  MAX_EVIDENCE_WINDOWS,
  PROFILE_ACTIONS,
  type Actions,
  type Advice,
  type Confidence,
  type CreatedProfile,
  type EvidenceWindow,
  type GrindAdvice,
  type ProfileAdvice,
  type ProfileActionKind,
  type ValueAdvice
} from './schema.ts';
import { readProfileStep, type ProfileStep } from '../domain/profile.ts';

export interface ParseContext {
  /** Shot length in seconds, used to keep evidence windows on the chart. */
  shotDurationS?: number;
}

export type ParseResult =
  | { ok: true; advice: Advice; warnings: string[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Pull the first balanced JSON object out of arbitrary reply text.
 *
 * Ported from the Tcl `extract_json`: scan from the first brace tracking depth,
 * while ignoring braces inside strings and honouring backslash escapes. This
 * handles markdown fences, leading prose and trailing chatter without needing
 * to special-case any of them.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read a number from whatever shape it arrived in.
 *
 * Accepts a real number, or a string carrying one. Unicode minus and en-dash
 * are normalised because models emit them in place of ASCII "-", and a stray
 * unit suffix ("18g", "93 C") is tolerated. Anything else is null.
 */
export function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const normalised = value.trim().replace(/[−–—]/g, '-');
  const match = /^[+-]?\d*\.?\d+/.exec(normalised);
  if (!match) return null;

  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function coerceString(value: unknown, maxLength = Infinity): string {
  if (typeof value === 'string') return value.trim().slice(0, maxLength);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** A value field may be `{value, reason}`, a bare number, or a numeric string. */
function readValueAdvice(raw: unknown): ValueAdvice {
  if (isRecord(raw)) {
    return { value: coerceNumber(raw['value']), reason: coerceString(raw['reason']) };
  }
  return { value: coerceNumber(raw), reason: '' };
}

function readGrindAdvice(raw: unknown): GrindAdvice {
  if (!isRecord(raw)) {
    // Some models collapse the whole object to a single number. Read it as an
    // absolute dial, which is the commoner intent.
    return { target: coerceNumber(raw), delta: null, reason: '' };
  }
  return {
    target: coerceNumber(raw['target']),
    delta: coerceNumber(raw['delta']),
    reason: coerceString(raw['reason'])
  };
}

function readConfidence(raw: unknown): Confidence {
  const text = coerceString(raw).toLowerCase();
  return (CONFIDENCES as readonly string[]).includes(text) ? (text as Confidence) : 'low';
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Keep only evidence windows that can actually be drawn.
 *
 * A window must be ordered and non-empty. When we know the shot duration, a
 * window is clamped into it and dropped if it lands entirely outside — a model
 * citing 40s of a 29s shot is pointing at nothing, and shading the wrong span
 * is worse than shading none.
 */
export function readEvidence(raw: unknown, durationS?: number): { windows: EvidenceWindow[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!Array.isArray(raw)) return { windows: [], warnings };

  const windows: EvidenceWindow[] = [];

  for (const entry of raw) {
    if (!isRecord(entry)) continue;

    let fromS = coerceNumber(entry['from_s'] ?? entry['fromS']);
    let toS = coerceNumber(entry['to_s'] ?? entry['toS']);
    const label = coerceString(entry['label'], MAX_EVIDENCE_LABEL);

    if (fromS === null || toS === null) continue;
    if (toS < fromS) [fromS, toS] = [toS, fromS];

    if (typeof durationS === 'number' && durationS > 0) {
      if (fromS >= durationS || toS <= 0) {
        warnings.push(`dropped evidence window ${fromS}-${toS}s outside a ${durationS}s shot`);
        continue;
      }
      fromS = Math.max(0, fromS);
      toS = Math.min(durationS, toS);
    } else {
      fromS = Math.max(0, fromS);
    }

    if (toS <= fromS) continue;

    windows.push({ fromS, toS, label });
    if (windows.length === MAX_EVIDENCE_WINDOWS) break;
  }

  return { windows, warnings };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function readCreatedProfile(raw: unknown): CreatedProfile | null {
  if (!isRecord(raw)) return null;

  const title = coerceString(raw['title']);
  const steps = Array.isArray(raw['steps'])
    ? raw['steps'].map(readProfileStep).filter((s): s is ProfileStep => s !== null)
    : [];

  // A profile with no title or no steps cannot be written to the machine.
  if (title === '' || steps.length === 0) return null;

  return {
    title,
    notes: coerceString(raw['notes']),
    targetWeightG: coerceNumber(raw['target_weight_g']),
    steps
  };
}

function readProfile(raw: unknown): { profile: ProfileAdvice; warnings: string[] } {
  const warnings: string[] = [];
  const source = isRecord(raw) ? raw : {};

  const requested = coerceString(source['action']).toLowerCase();
  let action: ProfileActionKind = (PROFILE_ACTIONS as readonly string[]).includes(requested)
    ? (requested as ProfileActionKind)
    : 'keep';

  const switchTo = coerceString(source['switch_to'] ?? source['switchTo']) || null;
  const createdProfile = readCreatedProfile(source['created_profile'] ?? source['createdProfile']);

  // Downgrade an action the payload cannot actually support, rather than
  // letting the UI offer a switch to nothing or a create with no steps.
  if (action === 'switch' && switchTo === null) {
    warnings.push('profile action was "switch" with no target; keeping the current profile');
    action = 'keep';
  }
  if (action === 'create' && createdProfile === null) {
    warnings.push('profile action was "create" with no usable profile; keeping the current profile');
    action = 'keep';
  }

  return {
    profile: { action, switchTo, createdProfile, reason: coerceString(source['reason']) },
    warnings
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse a model reply into advice. Never throws: a failure comes back as
 * `{ ok: false }` so the caller can show the reply verbatim instead of a stack
 * trace.
 */
export function parseAdvice(replyText: string, context: ParseContext = {}): ParseResult {
  const json = extractJsonObject(replyText ?? '');
  if (json === null) {
    return { ok: false, error: 'No JSON object in the model reply.' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    return { ok: false, error: `The model reply was not valid JSON: ${(cause as Error).message}` };
  }

  if (!isRecord(raw)) {
    return { ok: false, error: 'The model reply was not a JSON object.' };
  }

  const warnings: string[] = [];

  const rawActions = isRecord(raw['actions']) ? raw['actions'] : {};
  const actions: Actions = {
    grind: readGrindAdvice(rawActions['grind']),
    doseG: readValueAdvice(rawActions['dose_g'] ?? rawActions['doseG']),
    targetYieldG: readValueAdvice(rawActions['target_yield_g'] ?? rawActions['targetYieldG']),
    temperatureC: readValueAdvice(rawActions['temperature_c'] ?? rawActions['temperatureC'])
  };

  const evidence = readEvidence(raw['evidence'], context.shotDurationS);
  warnings.push(...evidence.warnings);

  const profile = readProfile(raw['profile']);
  warnings.push(...profile.warnings);

  const diagnosis = coerceString(raw['diagnosis']);
  const screenSummary = coerceString(raw['screen_summary'] ?? raw['screenSummary'], 160);

  if (diagnosis === '' && screenSummary === '') {
    return { ok: false, error: 'The model reply had neither a diagnosis nor a summary.' };
  }

  return {
    ok: true,
    warnings,
    advice: {
      diagnosis,
      confidence: readConfidence(raw['confidence']),
      actions,
      profile: profile.profile,
      screenSummary,
      evidence: evidence.windows
    }
  };
}
