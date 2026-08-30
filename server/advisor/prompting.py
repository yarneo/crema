"""Build the dial-in advice prompt from a shot payload and parse constraints."""

import json

MAX_CURVE_POINTS = 60

ADVICE_SCHEMA = """{
  "diagnosis": "<2-3 sentences: what the curves + taste feedback say went right/wrong>",
  "confidence": "low" | "medium" | "high",
  "actions": {
    "grind": {"delta": <float, dial numbers, negative = finer, 0 if no change>,
              "target": <float, absolute dial number to set>},
    "dose_g": <float or null if unchanged>,
    "target_yield_g": <float or null if unchanged>,
    "temperature_c": <float or null if unchanged - the main extraction temp target>
  },
  "profile": {
    "action": "keep" | "switch" | "create",
    "switch_to": <existing profile title, only when action is switch, else null>,
    "created_profile": <only when action is create, else null: {
      "title": "<short name, e.g. 'Guji gentle flow v1'>",
      "notes": "<1-2 sentences on what this profile does and why>",
      "target_weight_g": <float>,
      "steps": [
        {"name": "<step name>", "temperature": <float C>, "seconds": <float max duration>,
         "pump": "pressure" | "flow", "pressure": <float bar, when pump=pressure>,
         "flow": <float mL/s, when pump=flow>, "transition": "fast" | "smooth",
         "exit_type": "pressure_over" | "pressure_under" | "flow_over" | "flow_under" | null,
         "exit_pressure_over": <float>, "exit_pressure_under": <float>,
         "exit_flow_over": <float>, "exit_flow_under": <float>},
        ...2 to 6 steps...
      ]
    }>,
    "reason": "<1 sentence, or empty string>"
  },
  "screen_summary": "<max 160 chars, imperative, what to do next shot, e.g. 'Grind 0.3 finer (to 5.1). Same dose. Sourness should drop.'>"
}"""


def _downsample(values: list, limit: int = MAX_CURVE_POINTS) -> list:
    if not values or len(values) <= limit:
        return values
    step = len(values) / limit
    return [values[int(i * step)] for i in range(limit)]


def _clean(v):
    """Recursively replace NaN/Inf with None (Tcl/BLE data can contain them)."""
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
        return None
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_clean(x) for x in v]
    return v


def sanitize_payload(payload: dict) -> dict:
    return _clean(normalize(payload))


def normalize(payload: dict) -> dict:
    """Accept either the flat internal format or {"shot": <de1 v2 json>, "answers": {}}.

    The skin wraps the app's own ::shot::create v2 JSON; map it to the flat
    fields the prompt builder uses.
    """
    if "shot" not in payload:
        return payload
    shot = payload["shot"]
    meta = shot.get("meta", {})
    bean_meta = meta.get("bean", {})
    grinder_meta = meta.get("grinder", {})
    app_settings = shot.get("app", {}).get("settings", {})
    answers = payload.get("answers", {})

    grind = answers.get("grinder_setting_now") or grinder_meta.get("setting")
    try:
        grind = float(grind)
    except (TypeError, ValueError):
        pass

    def _num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    def _nums(values):
        return [_num(v) for v in (values or [])]

    return {
        "clock": shot.get("clock"),
        "bean": {
            "name": bean_meta.get("type") or bean_meta.get("brand"),
            "roaster": bean_meta.get("brand"),
            "roast_date": bean_meta.get("roast_date"),
            "roast_level": bean_meta.get("roast_level"),
            "notes": bean_meta.get("notes"),
        },
        "grinder": {
            "model": grinder_meta.get("model") or "unknown grinder",
            "setting": grind,
        },
        "dose_g": _num(meta.get("in")),
        "final_yield_g": _num(meta.get("out")),
        "target_yield_g": _num(app_settings.get("final_desired_shot_weight")),
        "profile": {"title": shot.get("profile", {}).get("title"), "json": shot.get("profile")},
        "elapsed": _nums(shot.get("elapsed")),
        "pressure": _nums(shot.get("pressure", {}).get("pressure")),
        "flow": _nums(shot.get("flow", {}).get("flow")),
        "weight_flow": _nums(shot.get("flow", {}).get("by_weight")),
        "basket_temp": _nums(shot.get("temperature", {}).get("basket")),
        "answers": answers,
    }


def shot_stats(payload: dict) -> dict:
    elapsed = [e for e in (payload.get("elapsed") or []) if isinstance(e, (int, float))]
    pressure = [p for p in (payload.get("pressure") or []) if p is not None]
    flow = [f for f in (payload.get("flow") or []) if f is not None]
    stats = {
        "duration_s": round(elapsed[-1], 1) if elapsed else None,
        "peak_pressure_bar": round(max(pressure), 1) if pressure else None,
        "peak_flow_mls": round(max(flow), 1) if flow else None,
    }
    dose = payload.get("dose_g")
    final = payload.get("final_yield_g")
    if dose and final:
        stats["ratio"] = f"1:{round(final / dose, 2)}"
    return stats


def history_lines(previous: list[dict]) -> str:
    """One compact line per prior shot of the same bean, oldest first."""
    lines = []
    for shot in reversed(previous):
        p = shot["payload"]
        a = p.get("answers", {})
        adv = shot.get("advice") or {}
        lines.append(
            f"- {shot['created_at'][:16]} grind={p.get('grinder', {}).get('setting')} "
            f"dose={p.get('dose_g')}g yield={p.get('final_yield_g')}g "
            f"profile={p.get('profile', {}).get('title')!r} "
            f"taste={a.get('taste_balance')} body={a.get('body')} flow={a.get('flow_look')} "
            f"enjoyment={a.get('enjoyment')}/5"
            + (f" | advice given: {adv.get('screen_summary')}" if adv.get("screen_summary") else "")
        )
    return "\n".join(lines) if lines else "(first recorded shot with this bean)"


def build_prompt(payload: dict, previous: list[dict]) -> str:
    bean = payload.get("bean", {})
    grinder = payload.get("grinder", {})
    profile = payload.get("profile", {})
    answers = payload.get("answers", {})

    curves = {
        "elapsed_s": _downsample(payload.get("elapsed") or []),
        "pressure_bar": _downsample(payload.get("pressure") or []),
        "flow_mls": _downsample(payload.get("flow") or []),
        "weight_flow_gs": _downsample(payload.get("weight_flow") or []),
        "basket_temp_c": _downsample(payload.get("basket_temp") or []),
    }

    return f"""You are an expert espresso dial-in advisor for a Decent DE1 espresso machine.
Analyze this shot and tell the barista exactly what to change for the next one.

## Equipment
Grinder: {grinder.get("model") or "unknown grinder"}, current setting {grinder.get("setting")}. Adjustments are in this grinder's own dial units; assume lower numbers = finer unless history suggests otherwise. A typical adjustment is 0.2-0.5 units; 1.0+ is aggressive. Always phrase grind advice in these dial units.

## Bean
{json.dumps(bean, indent=2)}

## This shot
Profile: {profile.get("title")!r}
Dose: {payload.get("dose_g")}g in, target {payload.get("target_yield_g")}g out, actual {payload.get("final_yield_g")}g out.
Summary stats: {json.dumps(shot_stats(payload))}
Curves (downsampled):
{json.dumps(curves)}

## Barista's taste feedback (the highest-signal data — weight it heavily)
Taste: {answers.get("taste_balance")} | Body: {answers.get("body")} | Flow looked: {answers.get("flow_look")} | Finish/aftertaste: {answers.get("aftertaste")} | Enjoyment: {answers.get("enjoyment")}/5
Note: {answers.get("free_note") or "(none)"}
Taste vocabulary: sour = under-extraction (grind finer / hotter). salty = also under-extraction (salts extract first; sweetness hasn't developed) — grind finer / hotter, and if it persists suspect very low-mineral or distilled water. balanced = on target. bitter = over-extraction (grind coarser / cooler). harsh = aggressive over-extraction or a too-high pressure spike (coarser, lower peak pressure, check the curve). Finish: clean = good; short = under-developed (often under-extraction); lingering = usually good unless unpleasant; dry/astringent = over-extraction or channeling (check puck prep first, then coarser).

## Recent shots with this bean (oldest first)
{history_lines(previous)}

## Current profile JSON (for modify actions; return the SAME format)
{json.dumps(profile.get("json")) if profile.get("json") else "(not provided — do not use profile action 'modify')"}

## Rules
- Change ONE primary variable per shot (usually grind) while dialing in. But you have the FULL toolbox and should use it when the situation calls for it:
  - dose_g / target_yield_g: when the ratio is wrong for the style or the puck is clearly too thin/thick (e.g. shots consistently harsh at 1:2.4 -> tighten yield; watery body -> up-dose).
  - temperature_c: sour that persists after grind is dialed -> hotter; harsh/bitter roastiness -> cooler.
  - profile switch: when a saved profile named in history obviously fits better.
  - profile CREATE: when taste problems persist across 3+ shots despite grind/temp moves, or the curves show a structural mismatch (channeling every shot -> longer gentler preinfusion; light roast fighting a classic 9-bar -> a gentle flow-profiled decline in the D-Flow spirit). Steps run on a Decent DE1; keep pressure 0-10 bar, flow 0-8 mL/s, temps 80-98C, 2-6 steps. Created profiles are stored in ONE per-bean slot named "AI · <bean>" (each new creation overwrites the previous version for that bean); your title becomes its notes. To iterate on your own earlier creation, just create again; to return to it unchanged, switch to "AI · <bean>".
- Sour/fast/thin usually means grind finer; bitter/harsh/slow usually means grind coarser or lower temperature. Weigh the actual curves, not just heuristics.
- If flow was uneven (spritzers/channeling), prioritize puck prep advice over grind changes and say so in the diagnosis.
- Be decisive. The barista wants one clear instruction, not a menu. Everything you put in actions/profile is applied by a single Apply button, so only include changes you mean, and phrase the summary as what WILL happen ("try the gentle flow profile"), never as already done ("profile applied").

Respond with ONLY a valid JSON object in exactly this schema, no prose before or after and no markdown code fences. Keep every string value plain text with NO double-quote characters inside it (use plain words, not quoted phrases), so the JSON always parses:
{ADVICE_SCHEMA}"""
