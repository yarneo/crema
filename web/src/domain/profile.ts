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

// ---------------------------------------------------------------------------
// What a profile intends to do
// ---------------------------------------------------------------------------

/** One moment in a profile's plan. A step targets pressure or flow, never both. */
export interface PlanPoint {
  t: number;
  pressure: number | null;
  flow: number | null;
}

/** The target a step holds, and which axis it belongs on. */
function stepTarget(step: ProfileStep): { pressure: number | null; flow: number | null } {
  if (step.pump === 'flow') {
    return { pressure: null, flow: typeof step.flow === 'number' ? step.flow : 0 };
  }
  return { pressure: typeof step.pressure === 'number' ? step.pressure : 0, flow: null };
}

/**
 * The shape a profile intends to draw, before any coffee is involved.
 *
 * This is the profile's own plan — what the machine is told to do — not a
 * recording of what happened. It is what makes a list of profile names
 * legible: "Adaptive v3" says nothing, a nine-bar block followed by a decline
 * says everything.
 *
 * A `fast` transition jumps to the step's target at the step's start; a
 * `smooth` one ramps to it from wherever the previous step left off, which is
 * exactly how the machine reads them.
 */
export function profilePlan(profile: Profile): { points: PlanPoint[]; totalS: number } {
  const points: PlanPoint[] = [];
  let t = 0;
  let lastPressure = 0;
  let lastFlow = 0;

  for (const step of profile.steps ?? []) {
    const seconds = typeof step.seconds === 'number' && step.seconds > 0 ? step.seconds : 0;
    const target = stepTarget(step);

    const entryPressure = step.transition === 'smooth' ? lastPressure : target.pressure ?? lastPressure;
    const entryFlow = step.transition === 'smooth' ? lastFlow : target.flow ?? lastFlow;

    points.push({ t, pressure: entryPressure, flow: entryFlow });

    lastPressure = target.pressure ?? lastPressure;
    lastFlow = target.flow ?? lastFlow;
    t += seconds;
    points.push({ t, pressure: lastPressure, flow: lastFlow });
  }

  return { points, totalS: t };
}

/** A one-line description of the plan, for a row that has no room for a chart. */
export function describePlan(profile: Profile): string {
  const steps = profile.steps ?? [];
  if (steps.length === 0) return 'no steps';

  const modes = new Set(steps.map((step) => step.pump));
  const shape = modes.size > 1 ? 'pressure and flow' : modes.has('flow') ? 'flow' : 'pressure';
  const { totalS } = profilePlan(profile);
  const seconds = totalS > 0 ? `${Math.round(totalS)}s` : 'open-ended';
  return `${steps.length} steps · ${shape} · ${seconds}`;
}
