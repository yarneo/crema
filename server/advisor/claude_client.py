"""Invoke Claude via the `claude -p` CLI (Max subscription — never the metered API)."""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # CLAUDE_CODE_OAUTH_TOKEN when running headless (cron/LaunchAgent)

# LaunchAgent/cron PATH lacks ~/.local/bin, so probe known install locations.
_CLAUDE_CANDIDATES = [
    Path.home() / ".local/bin/claude",
    Path("/opt/homebrew/bin/claude"),
    Path("/usr/local/bin/claude"),
]


# Which model `claude -p` should use. Opus is the smartest for espresso dial-in
# reasoning; override with CREMA_MODEL if ever needed. Routed through the Max
# subscription, so model choice costs nothing extra.
_MODEL = os.environ.get("CREMA_MODEL", "opus")


def find_claude() -> str | None:
    found = shutil.which("claude")
    if found:
        return found
    for candidate in _CLAUDE_CANDIDATES:
        if candidate.exists():
            return str(candidate)
    return None


class ClaudeError(RuntimeError):
    pass


def _describe_failure(returncode: int, stderr: str, stdout: str) -> str:
    """Explain why the CLI failed, in a way that names the likely fix.

    A non-zero exit with *nothing* on either stream is almost always missing
    headless auth: run under launchd there is no login session and, on macOS,
    no Keychain access either, so `claude` cannot find its credentials and
    gives up silently. Saying "exited 1:" and nothing else sends people
    looking in the wrong place, so the hint is spelled out.
    """
    detail = (stderr or "").strip()

    # A failure that still emitted the JSON envelope has a readable story in it,
    # and dumping the whole envelope hides it. Zero tokens in and out means the
    # CLI never actually reached the model — usually a usage limit or expired
    # auth, not a problem with the prompt.
    if not detail and stdout:
        try:
            envelope = json.loads(stdout)
        except json.JSONDecodeError:
            envelope = None

        if isinstance(envelope, dict):
            usage = envelope.get("usage") or {}
            if not usage.get("input_tokens") and not usage.get("output_tokens"):
                return (
                    f"claude exited {returncode} without reaching the model "
                    "(zero tokens used). Check `claude -p 'hi'` in a terminal: "
                    "the usual causes are a usage limit or expired credentials. "
                    "For headless use run `claude setup-token` and put "
                    "CLAUDE_CODE_OAUTH_TOKEN=... in server/.env."
                )
            if envelope.get("result"):
                return f"claude exited {returncode}: {str(envelope['result'])[:400]}"

        detail = stdout.strip()

    if detail:
        return f"claude exited {returncode}: {detail[:500]}"

    return (
        f"claude exited {returncode} with no output. It is probably not "
        "authenticated for headless use: run `claude setup-token` and put "
        "CLAUDE_CODE_OAUTH_TOKEN=... in server/.env, then restart the service."
    )


def ask_text(prompt: str, timeout: int = 240) -> str:
    """Run claude -p and return its raw text reply (for the provider mocks)."""
    claude = find_claude()
    if not claude:
        raise ClaudeError("claude CLI not found on this machine")
    result = subprocess.run(
        [claude, "-p", "--model", _MODEL, "--output-format", "json", prompt],
        capture_output=True, text=True, timeout=timeout,
        env={**os.environ, "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "8000"},
    )
    if result.returncode != 0:
        raise ClaudeError(_describe_failure(result.returncode, result.stderr, result.stdout))
    try:
        return json.loads(result.stdout).get("result", "")
    except json.JSONDecodeError:
        return result.stdout


def ask_json(prompt: str, timeout: int = 240) -> dict:
    """Run claude -p and parse a JSON object out of its reply."""
    claude = find_claude()
    if not claude:
        raise ClaudeError("claude CLI not found on this machine")

    result = subprocess.run(
        [claude, "-p", "--model", _MODEL, "--output-format", "json", prompt],
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "8000"},
    )
    if result.returncode != 0:
        raise ClaudeError(_describe_failure(result.returncode, result.stderr, result.stdout))

    try:
        envelope = json.loads(result.stdout)
        text = envelope.get("result", "")
    except json.JSONDecodeError:
        text = result.stdout

    return _extract_json(text)


def _extract_json(text: str) -> dict:
    """Pull the first JSON object from text that may include prose or code fences.

    Brace matching is STRING-AWARE (tracks quotes + escapes) so a `{` or `}` inside
    a string value - a diagnosis sentence, a profile note - doesn't miscount depth
    and slice the object mid-string. (The tablet-side Tcl parser does the same.)
    """
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    start = text.find("{")
    if start == -1:
        raise ClaudeError(f"no JSON object in Claude reply: {text[:300]}")
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start : i + 1])
    raise ClaudeError("unbalanced JSON in Claude reply")
