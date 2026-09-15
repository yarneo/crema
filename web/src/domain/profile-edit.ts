/**
 * Building and editing a profile by hand.
 *
 * Every function here returns a new profile rather than mutating one: the
 * editor is driven by re-rendering from state, and an in-place edit would make
 * "what is on screen" and "what will be saved" drift apart.
 *
 * Kept deliberately narrow. A DE1 step carries exit conditions, limiters,
 * volume and weight triggers; this edits the four things that decide the shape
 * of a shot — what the step holds, at what value, for how long, and how hot —
 * and preserves everything else it was given. Duplicating a profile and
 * adjusting it therefore keeps the parts this editor does not show.
 */

import type { Profile, ProfileStep, PumpMode, Transition } from './profile.ts';

/** The fields the editor exposes. Everything else on a step is carried through. */
export interface StepEdit {
  name?: string;
  pump?: PumpMode;
  transition?: Transition;
  target?: number;
  seconds?: number;
  temperature?: number;
}

const DEFAULT_TEMPERATURE_C = 92;

/** A plausible espresso step, used for a new profile and for "add step". */
export function blankStep(over: StepEdit = {}): ProfileStep {
  const pump: PumpMode = over.pump ?? 'pressure';
  const target = over.target ?? (pump === 'pressure' ? 9 : 2);
  return {
    name: over.name ?? (pump === 'pressure' ? 'pressure' : 'flow'),
    pump,
    transition: over.transition ?? 'fast',
    exit: null,
    volume: 0,
    seconds: over.seconds ?? 10,
    weight: 0,
    temperature: over.temperature ?? DEFAULT_TEMPERATURE_C,
    sensor: 'coffee',
    limiter: null,
    ...(pump === 'pressure' ? { pressure: target } : { flow: target })
  };
}

/**
 * A new profile: preinfuse, then extract.
 *
 * Not a blank canvas. A profile with no steps cannot be reasoned about or
 * pulled, and the first thing anyone would build is this shape anyway.
 */
export function newProfile(title = 'My profile'): Profile {
  return {
    title,
    author: 'Crema',
    notes: '',
    beverage_type: 'espresso',
    target_weight: 36,
    // The wire fills the rest of what Decaid demands (see `createProfile`);
    // version is set here so a profile reads as v2 before it is ever saved.
    version: '2',
    steps: [
      blankStep({ name: 'preinfuse', pump: 'flow', target: 4, seconds: 8, transition: 'fast' }),
      blankStep({ name: 'extract', pump: 'pressure', target: 9, seconds: 25, transition: 'smooth' })
    ]
  };
}

/**
 * A copy, under its own name.
 *
 * Decaid identifies a profile by the hash of its content, so a duplicate with
 * an unchanged title would collide with the original rather than sit beside
 * it. The rename is what makes it a separate profile.
 */
export function duplicateProfile(profile: Profile, title: string): Profile {
  return {
    ...profile,
    title,
    author: 'Crema',
    steps: (profile.steps ?? []).map((step) => ({ ...step }))
  };
}

/** What a step currently holds, whichever axis it is on. */
export function stepTargetOf(step: ProfileStep): number {
  const value = step.pump === 'flow' ? step.flow : step.pressure;
  return typeof value === 'number' ? value : 0;
}

/**
 * Apply one field change to one step.
 *
 * Switching pump mode moves the target onto the other axis rather than
 * carrying the number across: nine bar and nine mL/s are not the same shot,
 * and silently reinterpreting the number is how a profile ends up gushing.
 */
export function editStep(profile: Profile, index: number, edit: StepEdit): Profile {
  const steps = [...(profile.steps ?? [])];
  const step = steps[index];
  if (!step) return profile;

  const pump = edit.pump ?? step.pump;
  const switched = pump !== step.pump;
  const target = edit.target ?? (switched ? (pump === 'pressure' ? 9 : 2) : stepTargetOf(step));

  const next: ProfileStep = {
    ...step,
    name: edit.name ?? step.name,
    pump,
    transition: edit.transition ?? step.transition,
    seconds: edit.seconds ?? step.seconds,
    temperature: edit.temperature ?? step.temperature
  };

  // Only the axis in use carries a value, matching how the machine reads it.
  delete (next as Partial<ProfileStep>).pressure;
  delete (next as Partial<ProfileStep>).flow;
  if (pump === 'pressure') next.pressure = target;
  else next.flow = target;

  steps[index] = next;
  return { ...profile, steps };
}

export function addStep(profile: Profile): Profile {
  const steps = [...(profile.steps ?? [])];
  const last = steps[steps.length - 1];
  steps.push(blankStep(last ? { pump: last.pump, temperature: last.temperature ?? undefined } : {}));
  return { ...profile, steps };
}

/** A profile with no steps cannot be pulled, so the last one will not go. */
export function removeStep(profile: Profile, index: number): Profile {
  const steps = [...(profile.steps ?? [])];
  if (steps.length <= 1 || index < 0 || index >= steps.length) return profile;
  steps.splice(index, 1);
  return { ...profile, steps };
}

export function moveStep(profile: Profile, index: number, by: -1 | 1): Profile {
  const steps = [...(profile.steps ?? [])];
  const to = index + by;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) return profile;
  const [moved] = steps.splice(index, 1);
  steps.splice(to, 0, moved!);
  return { ...profile, steps };
}

/** Why this profile cannot be saved yet, or null when it can. */
export function profileProblem(profile: Profile, existingTitles: readonly string[]): string | null {
  const title = (profile.title ?? '').trim();
  if (title === '') return 'Give the profile a name.';
  if (existingTitles.some((other) => other.trim().toLowerCase() === title.toLowerCase())) {
    return `A profile called “${title}” already exists. Pick another name.`;
  }
  const steps = profile.steps ?? [];
  if (steps.length === 0) return 'A profile needs at least one step.';
  if (steps.every((step) => (step.seconds ?? 0) <= 0)) return 'At least one step needs a duration.';
  return null;
}
