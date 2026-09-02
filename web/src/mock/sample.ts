/**
 * Sample data, for designing and reviewing the screen before there are real
 * shots to show.
 *
 * Two rules, borrowed from hard experience on this kind of app: sample data is
 * always visibly labelled as sample, and it never becomes something the
 * machine acts on. The recipe on screen is always the live one from the
 * gateway; only the shot curves, the trail and one worked advice payload come
 * from here.
 */

import type { BeanModel } from '../ui/views.ts';
import type { PhaseInput } from '../advice/phases.ts';
import type { Recipe } from '../domain/recipe.ts';
import type { TrailShot } from '../domain/trail.ts';

export const SAMPLE_BEAN: BeanModel = {
  name: 'Moonwake La Estrella Gesha',
  roastDate: new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10)
};

/**
 * A shot that ran away: a low-pressure bloom, then flow more than doubling
 * between 10 and 14 seconds as the puck opens up. Exactly the case the
 * evidence band exists to point at.
 */
export function sampleShot(): PhaseInput & { elapsedS: number[]; pressureBar: number[]; flowMlS: number[] } {
  const elapsedS: number[] = [];
  const pressureBar: number[] = [];
  const flowMlS: number[] = [];

  for (let t = 0; t <= 29; t += 0.5) {
    elapsedS.push(Number(t.toFixed(1)));

    // 0-8s bloom at low pressure, ramp to 9 bar, then a gentle decline.
    const pressure = t < 8 ? 1.8 + t * 0.12 : t < 12 ? 2.8 + (t - 8) * 1.55 : Math.max(6.2, 9 - (t - 12) * 0.16);
    pressureBar.push(Number(pressure.toFixed(2)));

    // Almost nothing until the puck opens at ~10s, then it runs away.
    const flow = t < 9 ? 0.15 + t * 0.02 : t < 14 ? 0.35 + (t - 9) * 0.95 : Math.max(2.6, 5.1 - (t - 14) * 0.11);
    flowMlS.push(Number(flow.toFixed(2)));
  }

  return { elapsedS, pressureBar, flowMlS, weightFlow: null };
}

/** The advice for that shot, as a model would return it, fences and all. */
export const SAMPLE_ADVICE_JSON = `\`\`\`json
{
  "diagnosis": "Flow more than doubled between 10 and 14 seconds and the shot gushed. The puck opened up under the ramp rather than resisting it.",
  "confidence": "high",
  "evidence": [
    {"from_s": 10, "to_s": 14, "label": "flow ran away"}
  ],
  "actions": {
    "grind": {"delta": -0.4, "target": 12.0, "reason": "28g out in 19s is well ahead of target. This is the whole fix."},
    "dose_g": {"value": null, "reason": ""},
    "target_yield_g": {"value": 36, "reason": "Pull it shorter while the grind settles, then walk it back out."},
    "temperature_c": {"value": null, "reason": ""}
  },
  "profile": {"action": "keep", "switch_to": null, "created_profile": null, "reason": ""},
  "screen_summary": "Grind finer to 12.0 and pull to 36g."
}
\`\`\``;

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  profileTitle: 'Gentle Decline',
  grind: 12.4,
  doseG: 18,
  targetYieldG: 40,
  temperatureC: 92,
  ...over
});

/** A week of dialling in: a thrash on temperature, then convergence. */
export function sampleTrailShots(): TrailShot[] {
  const day = 86_400_000;
  const start = Date.now() - 7 * day;

  return [
    { id: 's1', at: start + 0 * day, score: 2, recipe: recipe() },
    { id: 's2', at: start + 1 * day, score: 3, recipe: recipe({ grind: 12.0 }) },
    { id: 's3', at: start + 2 * day, score: 2, recipe: recipe({ grind: 12.0, temperatureC: 93 }) },
    { id: 's4', at: start + 3 * day, score: 3, recipe: recipe({ grind: 11.7, temperatureC: 93 }) },
    { id: 's5', at: start + 4 * day, score: 4, recipe: recipe({ grind: 11.7, temperatureC: 93, targetYieldG: 36 }) },
    { id: 's6', at: start + 5 * day, score: 4, recipe: recipe({ grind: 11.7, temperatureC: 93, targetYieldG: 36 }) },
    { id: 's7', at: start + 6 * day, score: 5, recipe: recipe({ grind: 11.5, temperatureC: 93, targetYieldG: 36 }) }
  ];
}
