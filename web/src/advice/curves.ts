/**
 * Preparing the shot's curves for the prompt.
 *
 * Two pieces of hard-won judgement from the Tcl skin live here, and both are
 * about *not* sending the model data that would mislead it.
 */

/**
 * How many points of each curve we send. A DE1 shot samples far more often
 * than the model needs; past roughly this many points the extra resolution
 * buys nothing and just costs tokens and latency.
 */
export const MAX_CURVE_POINTS = 60;

/**
 * Even-stride downsample, matching the Tcl. Deliberately picks existing
 * samples rather than averaging: a peak that gets averaged away is exactly the
 * feature the diagnosis needs to see.
 */
export function downsample(values: readonly number[], limit = MAX_CURVE_POINTS): number[] {
  if (values.length <= limit || limit <= 0) return [...values];

  const step = values.length / limit;
  const out: number[] = [];
  for (let i = 0; i < limit; i++) {
    out.push(values[Math.floor(i * step)]!);
  }
  return out;
}

/**
 * Whether the scale's weight-flow curve is trustworthy enough to send.
 *
 * A missing, asleep or mis-parsed scale produces a curve that looks like data
 * but is not, and a garbage weight curve produces confidently wrong advice.
 * The Tcl gate: the peak must be positive but physically plausible for
 * espresso. Below the floor there was effectively no flow recorded; above the
 * ceiling it is not weight-per-second from a shot.
 */
export const MIN_PLAUSIBLE_WEIGHT_FLOW = 0.3;
export const MAX_PLAUSIBLE_WEIGHT_FLOW = 6;

export function isWeightCurveTrustworthy(weightFlow: readonly number[] | null | undefined): boolean {
  if (!weightFlow || weightFlow.length === 0) return false;

  const finite = weightFlow.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (finite.length === 0) return false;

  const peak = Math.max(...finite);
  return peak > MIN_PLAUSIBLE_WEIGHT_FLOW && peak < MAX_PLAUSIBLE_WEIGHT_FLOW;
}

/** Read-only, because every consumer only reads: it lets a live shot, a
 *  stored shot and the sample all satisfy the same type without copying. */
export interface ShotCurves {
  elapsedS: readonly number[];
  pressureBar: readonly number[];
  flowMlS: readonly number[];
  weightFlow?: readonly number[] | null;
  /** What the profile intended. Absent on shots captured before we stored it. */
  pressureGoal?: readonly number[] | null;
  flowGoal?: readonly number[] | null;
}

/**
 * The curves object embedded in the prompt.
 *
 * Note what is *not* here: `basket_temp`. On the DE1 that is a metal-sensor
 * reading that runs around 20°C cooler than the water, and including it drags
 * the model towards wrong temperature advice. The real brew temperature is
 * stated explicitly elsewhere in the prompt instead.
 */
export function buildCurvePayload(curves: ShotCurves): Record<string, number[]> {
  const payload: Record<string, number[]> = {
    elapsed_s: downsample(curves.elapsedS),
    pressure_bar: downsample(curves.pressureBar),
    flow_mls: downsample(curves.flowMlS)
  };

  if (isWeightCurveTrustworthy(curves.weightFlow)) {
    payload['weight_out_gs'] = downsample(curves.weightFlow!);
  }

  const hasGoals = (curves.pressureGoal?.length ?? 0) > 0 || (curves.flowGoal?.length ?? 0) > 0;
  if (hasGoals) {
    payload['pressure_target_bar'] = downsample(curves.pressureGoal ?? []);
    payload['flow_target_mls'] = downsample(curves.flowGoal ?? []);
  }

  return payload;
}

/** Shot duration in seconds, or null when there is no usable elapsed curve. */
export function shotDuration(elapsedS: readonly number[]): number | null {
  const last = elapsedS.at(-1);
  return typeof last === 'number' && Number.isFinite(last) ? Number(last.toFixed(1)) : null;
}

/** Brew ratio as the familiar "1:2.2", or null when it cannot be computed. */
export function brewRatio(doseG: number | null, yieldG: number | null): string | null {
  if (doseG === null || yieldG === null || !(doseG > 0) || !Number.isFinite(yieldG)) return null;
  return `1:${(yieldG / doseG).toFixed(1)}`;
}
