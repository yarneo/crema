"""Decent DE1 advisor server — runs on the Mac, called by the tablet skin over LAN.

    uv run uvicorn advisor.main:app --host 0.0.0.0 --port 8877
"""

import logging

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import claude_client, prompting, store

log = logging.getLogger("advisor")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="decent-advisor")

# The Decent.app version of the skin is a web page, so it reaches this server
# through the browser's fetch and is subject to CORS. Without this the request
# is refused before it is sent, and the skin can only report "unreachable".
#
# Allowing any origin is deliberate and safe here: this server binds to a LAN
# address, holds no credentials a page could steal (the Claude token is used
# server-side and never returned), and has no cookie or session auth for a
# hostile page to ride on. It is the tablet-and-laptop equivalent of a local
# development server.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

store.init_db()


def _generate_advice(shot_id: int) -> None:
    shot = store.get_shot(shot_id)
    if not shot:
        return
    payload = shot["payload"]
    bean_name = payload.get("bean", {}).get("name")
    previous = [s for s in store.recent_shots(limit=8, bean=bean_name) if s["id"] != shot_id]
    try:
        prompt = prompting.build_prompt(payload, previous)
        advice = claude_client.ask_json(prompt)
        store.set_advice(shot_id, advice)
        log.info("shot %s advice: %s", shot_id, advice.get("screen_summary"))
    except Exception as exc:  # noqa: BLE001 — tablet must see the failure, not a hang
        log.exception("advice generation failed for shot %s", shot_id)
        store.set_error(shot_id, str(exc))


@app.post("/shot")
def post_shot(payload: dict, background: BackgroundTasks):
    payload = prompting.sanitize_payload(payload)
    shot_id = store.insert_shot(payload)
    background.add_task(_generate_advice, shot_id)
    return {"shot_id": shot_id, "status": "pending"}


@app.get("/advice/{shot_id}")
def get_advice(shot_id: int):
    shot = store.get_shot(shot_id)
    if not shot:
        raise HTTPException(404, "unknown shot")
    return {"shot_id": shot_id, "status": shot["status"],
            "advice": shot["advice"], "error": shot["error"]}


@app.get("/shot/{shot_id}")
def get_shot_full(shot_id: int):
    """Full stored shot including curve arrays, for the detail page."""
    shot = store.get_shot(shot_id)
    if not shot:
        raise HTTPException(404, "unknown shot")
    return {"shot": shot}


@app.get("/shots")
def list_shots(limit: int = 50):
    shots = store.recent_shots(limit=limit)
    for s in shots:
        elapsed = [e for e in (s["payload"].get("elapsed") or []) if isinstance(e, (int, float))]
        if elapsed:
            s["payload"]["duration_s"] = round(elapsed[-1], 1)
        # keep the listing light: drop curve arrays
        for k in ("elapsed", "pressure", "flow", "weight_flow", "basket_temp"):
            s["payload"].pop(k, None)
    return {"shots": shots}


@app.get("/health")
def health():
    return {"ok": True, "claude": claude_client.find_claude()}


# --- Anthropic-shaped MOCK, backed by claude -p ----------------------------
# Lets the tablet's direct-provider Tcl code path (llm.tcl) be tested against
# the real Anthropic wire format without a metered API key: point the skin's
# provider base_url at http://<mac>:8877 and it speaks /v1/messages.
@app.post("/v1/messages")
def anthropic_messages(body: dict):
    try:
        prompt = ""
        for m in body.get("messages", []):
            if m.get("role") == "user":
                c = m.get("content")
                prompt = c if isinstance(c, str) else " ".join(
                    b.get("text", "") for b in c if isinstance(b, dict))
        text = claude_client.ask_text(prompt)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, str(exc))
    return {
        "id": "msg_mock", "type": "message", "role": "assistant",
        "model": body.get("model", "mock"),
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
    }


# --- OpenAI-shaped MOCK, backed by claude -p -------------------------------
@app.post("/v1/chat/completions")
def openai_chat(body: dict):
    try:
        prompt = ""
        for m in body.get("messages", []):
            if m.get("role") == "user":
                prompt = m.get("content", "")
        text = claude_client.ask_text(prompt)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, str(exc))
    return {
        "id": "chatcmpl-mock", "object": "chat.completion",
        "model": body.get("model", "mock"),
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                     "finish_reason": "stop"}],
    }
