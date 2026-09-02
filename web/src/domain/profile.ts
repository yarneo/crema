/**
 * The DE1 profile, in the shape Decaid actually uses.
 *
 * Verified against a live Decaid 0.8.4 rather than taken from documentation:
 * the skins guide abbreviates steps as `steps: [...]`, and the flat
 * `exit_type` / `exit_pressure_over` / `exit_flow_under` fields that the Tcl
 * skin used are *not* what this platform speaks. A step's exit is a nested
 * object:
 *
 *   "exit": { "type": "pressure", "condition": "over", "value": 3.0 }
 *
 * This matters beyond typing. Crema asks the model to author whole profiles,
 * so the schema we hand it has to be the shape the gateway will accept, or
 * every created profile fails to install.
 */

export type PumpMode = 'pressure' | 'flow';
export type Transition = 'fast' | 'smooth';
export type ExitType = 'pressure' | 'flow';
export type ExitCondition = 'over' | 'under';
export type StepSensor = 'coffee' | 'water';

/** Advance to the next step when this condition is met. */
export interface ProfileExit {
  type: ExitType;
  condition: ExitCondition;
  value: number;
}

/** Caps the driven variable around `value` within +/- `range`. */
export interface ProfileLimiter {
  value: number;
  range: number;
}

export interface ProfileStep {
  name: string;
  pump: PumpMode;
  transition: Transition;
  exit: ProfileExit | null;
  volume: number | null;
  seconds: number | null;
  weight: number | null;
  temperature: number | null;
  sensor: StepSensor;
  /** Present when pump is "pressure". */
  pressure?: number | null;
  /** Present when pump is "flow". */
  flow?: number | null;
  limiter: ProfileLimiter | null;
}

export interface Profile {
  version?: string;
  title?: string;
  author?: string;
  notes?: string;
  beverage_type?: string;
  steps?: ProfileStep[];
  target_volume?: number | null;
  target_weight?: number | null;
  target_volume_count_start?: number;
  tank_temperature?: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim().replace(/[−–—]/g, '-'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (allowed as readonly string[]).includes(text) ? (text as T) : fallback;
}

/**
 * Read an exit condition.
 *
 * Also accepts the Tcl skin's flat form, because a model that has seen a lot
 * of de1app profiles will sometimes emit it, and translating is cheaper than
 * throwing away an otherwise good profile.
 */
export function readExit(raw: unknown, flat?: Record<string, unknown>): ProfileExit | null {
  if (isRecord(raw)) {
    const value = num(raw['value']);
    if (value === null) return null;
    return {
      type: oneOf(raw['type'], ['pressure', 'flow'] as const, 'pressure'),
      condition: oneOf(raw['condition'], ['over', 'under'] as const, 'over'),
      value
    };
  }

  if (flat) {
    const legacy: [string, ExitType, ExitCondition][] = [
      ['exit_pressure_over', 'pressure', 'over'],
      ['exit_pressure_under', 'pressure', 'under'],
      ['exit_flow_over', 'flow', 'over'],
      ['exit_flow_under', 'flow', 'under']
    ];
    for (const [key, type, condition] of legacy) {
      const value = num(flat[key]);
      if (value !== null && value !== 0) return { type, condition, value };
    }
  }

  return null;
}

function readLimiter(raw: unknown): ProfileLimiter | null {
  if (!isRecord(raw)) return null;
  const value = num(raw['value']);
  const range = num(raw['range']);
  if (value === null || range === null) return null;
  return { value, range };
}

/**
 * Normalise a step from the gateway or from a model into the canonical shape.
 * Returns null for anything unusable, since a nameless step cannot be shown or
 * installed.
 */
export function readProfileStep(raw: unknown): ProfileStep | null {
  if (!isRecord(raw)) return null;

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (name === '') return null;

  const pump = oneOf(raw['pump'], ['pressure', 'flow'] as const, 'pressure');

  const step: ProfileStep = {
    name,
    pump,
    transition: oneOf(raw['transition'], ['fast', 'smooth'] as const, 'fast'),
    exit: readExit(raw['exit'], raw),
    volume: num(raw['volume']),
    seconds: num(raw['seconds']),
    weight: num(raw['weight']),
    temperature: num(raw['temperature']),
    sensor: oneOf(raw['sensor'], ['coffee', 'water'] as const, 'coffee'),
    limiter: readLimiter(raw['limiter'])
  };

  // Only the driven variable is carried, so a flow step cannot smuggle in a
  // pressure target the machine would ignore.
  if (pump === 'pressure') step.pressure = num(raw['pressure']);
  else step.flow = num(raw['flow']);

  return step;
}

/** The hottest step, which is what a barista means by "brew temperature". */
export function profileTemperature(profile: Profile | undefined): number | null {
  const temps = (profile?.steps ?? [])
    .map((step) => step.temperature)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));

  return temps.length === 0 ? null : Math.max(...temps);
}

/**
 * Shift every step by `deltaC`, preserving the profile's internal shape: a
 * bloom running 3° under extraction still runs 3° under. Returns a new
 * profile; the input is not mutated.
 */
export function shiftProfileTemperature(profile: Profile, deltaC: number): Profile {
  if (!Number.isFinite(deltaC) || deltaC === 0) return profile;

  return {
    ...profile,
    steps: (profile.steps ?? []).map((step) =>
      typeof step.temperature === 'number' && Number.isFinite(step.temperature)
        ? { ...step, temperature: Number((step.temperature + deltaC).toFixed(1)) }
        : step
    )
  };
}
