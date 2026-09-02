/**
 * Flow-phase analysis: splitting a shot into its pre-pour stall and its pour,
 * and handing the model plain numbers instead of making it eyeball arrays.
 *
 * This is the densest piece of espresso knowledge in Crema, and the reason it
 * exists is one specific misdiagnosis. A shot where flow stalls early looks
 * identical in outline whether the puck is choking or the profile is simply
 * holding low on purpose — and the two have opposite fixes. The disambiguator
 * is the *pressure* during the stall:
 *
 *   high stall pressure + no flow  -> the puck is choking, grind coarser
 *   low stall pressure  + no flow  -> a designed bloom or a slow ramp; the
 *                                     puck is fine, fix the PROFILE, keep the grind
 *
 * Getting that backwards sends someone chasing their grind for days, so the
 * numbers and the guidance are both stated explicitly for the model.
 */

/** Output must reach this to count as the pour beginning. */
const POUR_START_RATE = 0.8;

/** ...and must not drop back below this within the hold window. */
const POUR_HOLD_FLOOR = 0.3;

/** How many following samples must hold before we call it a real pour. */
const POUR_HOLD_SAMPLES = 2;

/** Below this peak, the scale's weight curve is not usable and we use flow. */
const WEIGHT_USABLE_PEAK = 0.3;

/** Fewer samples than this and there is no shot to analyse. */
const MIN_SAMPLES = 4;

/** Stall pressure at or above this means the puck is choking. */
export const HIGH_STALL_BAR = 6;

/** Stall pressure at or below this means the profile is holding low. */
export const LOW_STALL_BAR = 4;

export interface PhaseInput {
  elapsedS: readonly number[];
  pressureBar: readonly number[];
  flowMlS: readonly number[];
  weightFlow?: readonly number[] | null;
}

export interface FlowPhases {
  /** Which curve the pour was measured from. */
  source: 'weight' | 'flow';
  unit: 'g/s' | 'mL/s';
  /** True when the puck never reached a normal pour rate at all. */
  choked: boolean;
  /** Seconds to first real flow. The whole shot when choked. */
  preinfusionS: number;
  pourDurationS: number;
  pourAvg: number;
  pourPeak: number;
  /** Average and peak pressure during the pre-pour stall. The disambiguator. */
  stallAvgBar: number;
  stallPeakBar: number;
}

const round1 = (v: number) => Number(v.toFixed(1));

function stats(values: readonly number[], from: number, to: number): { avg: number; peak: number } {
  let sum = 0;
  let count = 0;
  let peak = 0;

  for (let i = from; i < to && i < values.length; i++) {
    const v = values[i];
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      count++;
      if (v > peak) peak = v;
    }
  }

  return { avg: count > 0 ? sum / count : 0, peak };
}

/**
 * Find the first sample where output starts and *stays* started.
 *
 * The hold check matters: a single spike as the first drops hit the cup is not
 * the pour beginning, and treating it as one would report a preinfusion far
 * shorter than what actually happened.
 */
function findPourStart(output: readonly number[], count: number): number {
  for (let i = 0; i < count; i++) {
    if ((output[i] ?? 0) <= POUR_START_RATE) continue;

    const until = Math.min(i + POUR_HOLD_SAMPLES, count - 1);
    let held = true;
    for (let j = i; j <= until; j++) {
      if ((output[j] ?? 0) <= POUR_HOLD_FLOOR) {
        held = false;
        break;
      }
    }
    if (held) return i;
  }
  return -1;
}

/**
 * Analyse the shot, or return null when there is not enough of one.
 *
 * The pour is measured from the scale when it recorded something plausible,
 * because grams in the cup is the number that matters; otherwise we fall back
 * to the machine's own flow.
 */
export function analyseFlowPhases(shot: PhaseInput): FlowPhases | null {
  const weight = shot.weightFlow ?? [];
  const weightPeak = weight.length > 0 ? Math.max(0, ...weight.filter((v) => Number.isFinite(v))) : 0;
  const useWeight = weightPeak > WEIGHT_USABLE_PEAK;

  const output = useWeight ? weight : shot.flowMlS;
  const source = useWeight ? 'weight' : 'flow';
  const unit = useWeight ? 'g/s' : 'mL/s';

  const count = Math.min(output.length, shot.elapsedS.length);
  if (count < MIN_SAMPLES) return null;

  const endS = shot.elapsedS[count - 1];
  if (typeof endS !== 'number' || !Number.isFinite(endS)) return null;

  const pourStart = findPourStart(output, count);
  const stallEnd = pourStart < 0 ? count : pourStart;
  const stall = stats(shot.pressureBar, 0, stallEnd);

  if (pourStart < 0) {
    return {
      source,
      unit,
      choked: true,
      preinfusionS: Math.round(endS),
      pourDurationS: 0,
      pourAvg: 0,
      pourPeak: 0,
      stallAvgBar: round1(stall.avg),
      stallPeakBar: round1(stall.peak)
    };
  }

  const preinfusionS = shot.elapsedS[pourStart] ?? 0;
  const pour = stats(output, pourStart, count);

  return {
    source,
    unit,
    choked: false,
    preinfusionS: Math.round(preinfusionS),
    pourDurationS: Math.round(endS - preinfusionS),
    pourAvg: round1(pour.avg),
    pourPeak: round1(pour.peak),
    stallAvgBar: round1(stall.avg),
    stallPeakBar: round1(stall.peak)
  };
}

/**
 * The prompt paragraph. Wording is carried over deliberately: it tells the
 * model how to read the stall pressure rather than leaving it to infer the
 * rule, and it names the trap where a long stall makes a shot fall short of
 * yield and invites a grind change that then gushes the pour.
 */
export function describeFlowPhases(phases: FlowPhases): string {
  const { stallAvgBar, stallPeakBar } = phases;

  if (phases.choked) {
    return (
      `Flow phases: the puck NEVER reached a normal pour rate in ${phases.preinfusionS}s; ` +
      `that stall sat at avg ${stallAvgBar} bar (peak ${stallPeakBar} bar). ` +
      `Read the pressure: if the stall pressure is HIGH (say >~${HIGH_STALL_BAR} bar) the puck is CHOKING under ` +
      `full pressure and the grind is too fine (coarsen); if it is LOW the profile never applied enough ` +
      `pressure to drive flow - raise/steepen it (a profile change), keep the grind.`
    );
  }

  return (
    `Flow phases: time-to-first-real-flow was ~${phases.preinfusionS}s (that pre-pour stall sat at avg ` +
    `${stallAvgBar} bar, peak ${stallPeakBar} bar), then the pour ran ~${phases.pourDurationS}s at avg ` +
    `${phases.pourAvg} ${phases.unit} (peak ${phases.pourPeak} ${phases.unit}). ` +
    `Diagnose from the STALL PRESSURE, not just its length: if the stall pressure was LOW (a designed ` +
    `bloom/preinfusion or a slow pressure ramp, say <~${LOW_STALL_BAR} bar) the puck is fine but ` +
    `under-pressured - the fix is the PROFILE (raise that hold pressure, ramp faster, or shorten it) and ` +
    `you can KEEP the grind; if it was HIGH (>~${HIGH_STALL_BAR} bar) yet flow still stalled, the puck is ` +
    `choking and the grind is too fine (coarsen). A long stall eating most of the shot while the pour ` +
    `itself flows fine is why yield falls short - do not just grind coarser, which would gush the already-fine pour.`
  );
}

/**
 * A one-word read of the stall, for the UI rather than the prompt. Null when
 * the stall pressure sits between the two thresholds and says nothing certain.
 */
export function stallVerdict(phases: FlowPhases): 'choking' | 'under-pressured' | null {
  if (phases.stallAvgBar >= HIGH_STALL_BAR) return 'choking';
  if (phases.stallAvgBar <= LOW_STALL_BAR) return 'under-pressured';
  return null;
}
