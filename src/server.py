"""LS20 Lab server.

- Serves the game frontend (src/static/)
- Persists runs to SQLite (src/ls20.db)
- Writes session/run JSON exports to data/
- Proxies a local Ollama instance so the browser can let an LLM play
  (avoids CORS and keeps one integration point).
- Proxies Vertex AI Gemini (auth via ADC — no API key) for the same reason.

Run:  python src/server.py  →  http://localhost:8000
Env:  OLLAMA_URL (default http://localhost:11434), PORT (default 8000),
      GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, GEMINI_MODEL (see .env)
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, send_from_directory
from google.auth import default as google_auth_default
from google.auth.exceptions import DefaultCredentialsError
from google.auth.transport.requests import Request as GoogleAuthRequest

ROOT = Path(__file__).resolve().parent          # src/
DATA_DIR = ROOT.parent / "data"                 # data/
DB_PATH = ROOT / "ls20.db"
load_dotenv(ROOT.parent / ".env")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
GCP_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT")
GCP_LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite")
VALID_ACTIONS = ("UP", "DOWN", "LEFT", "RIGHT")

# Vertex AI on-demand pricing, gemini-2.5-flash-lite, $/1M tokens
# https://cloud.google.com/vertex-ai/generative-ai/pricing (verified 2026-08-06)
GEMINI_PRICE_INPUT_PER_M = 0.10
GEMINI_PRICE_OUTPUT_PER_M = 0.40
LLM_LOG_PATH = DATA_DIR / "llm_calls.jsonl"

DATA_DIR.mkdir(exist_ok=True)
app = Flask(__name__, static_folder=str(ROOT / "static"), static_url_path="")


# ---------------------------------------------------------------- database
SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id            TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    player_name       TEXT NOT NULL,
    player_type       TEXT NOT NULL CHECK (player_type IN ('human','llm')),
    model             TEXT,
    outcome           TEXT NOT NULL,
    levels_completed  INTEGER NOT NULL,
    total_actions     INTEGER NOT NULL,
    total_time_ms     INTEGER NOT NULL,
    started_at        TEXT NOT NULL,
    ended_at          TEXT,
    levels_json       TEXT NOT NULL,
    trace_json        TEXT NOT NULL,
    created_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs (session_id);

CREATE TABLE IF NOT EXISTS llm_calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                TEXT DEFAULT (datetime('now')),
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    context           TEXT,
    session_id        TEXT,
    prompt_tokens     INTEGER,
    response_tokens   INTEGER,
    total_tokens      INTEGER,
    latency_ms        INTEGER,
    cost_usd          REAL,
    action            TEXT,
    status            TEXT NOT NULL,
    error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_session ON llm_calls (session_id);
"""


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.executescript(SCHEMA)
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


# ---------------------------------------------------------------- frontend
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# ---------------------------------------------------------------- runs API
@app.post("/api/runs")
def save_run():
    """Persist a finished run (posted by the frontend) and dump it to data/."""
    r = request.get_json(force=True)
    required = ("run_id", "session_id", "player", "outcome", "levels",
                "action_trace", "levels_completed", "total_actions",
                "total_time_ms", "started_at")
    missing = [k for k in required if k not in r]
    if missing:
        return jsonify(error=f"missing fields: {missing}"), 400

    db = get_db()
    db.execute(
        """INSERT OR REPLACE INTO runs
           (run_id, session_id, player_name, player_type, model, outcome,
            levels_completed, total_actions, total_time_ms,
            started_at, ended_at, levels_json, trace_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (r["run_id"], r["session_id"],
         r["player"].get("name", "anon"), r["player"].get("type", "human"),
         r["player"].get("model"), r["outcome"],
         r["levels_completed"], r["total_actions"], r["total_time_ms"],
         r["started_at"], r.get("ended_at"),
         json.dumps(r["levels"]), json.dumps(r["action_trace"])),
    )
    db.commit()

    out = DATA_DIR / f"run_{r['run_id']}.json"
    out.write_text(json.dumps(r, indent=2))
    return jsonify(ok=True, saved=str(out.name))


@app.get("/api/leaderboard")
def leaderboard():
    """Global (all-sessions) or per-session leaderboard, ARC-AGI-3 ordering."""
    session_id = request.args.get("session_id")
    q = ("SELECT run_id, session_id, player_name, player_type, model, outcome,"
         " levels_completed, total_actions, total_time_ms, started_at FROM runs")
    args: tuple = ()
    if session_id:
        q += " WHERE session_id = ?"
        args = (session_id,)
    q += " ORDER BY levels_completed DESC, total_actions ASC, total_time_ms ASC"
    rows = [dict(row) for row in get_db().execute(q, args)]
    for i, row in enumerate(rows):
        row["rank"] = i + 1
    return jsonify(rows)


@app.get("/api/runs/<run_id>")
def get_run(run_id: str):
    row = get_db().execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
    if not row:
        return jsonify(error="not found"), 404
    d = dict(row)
    d["levels"] = json.loads(d.pop("levels_json"))
    d["action_trace"] = json.loads(d.pop("trace_json"))
    return jsonify(d)


@app.post("/api/export")
def export_session():
    """Write a full session bundle (all runs of one session_id) to data/."""
    session_id = request.get_json(force=True).get("session_id")
    if not session_id:
        return jsonify(error="session_id required"), 400
    runs = []
    for row in get_db().execute("SELECT * FROM runs WHERE session_id=?", (session_id,)):
        d = dict(row)
        d["levels"] = json.loads(d.pop("levels_json"))
        d["action_trace"] = json.loads(d.pop("trace_json"))
        runs.append(d)
    bundle = {
        "session_id": session_id,
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "game": "ls20-lab-replica",
        "runs": runs,
    }
    out = DATA_DIR / f"session_{session_id}.json"
    out.write_text(json.dumps(bundle, indent=2))
    return jsonify(ok=True, saved=out.name, n_runs=len(runs))


# ---------------------------------------------------------------- levels
LEVELS_DIR = DATA_DIR / "levels"
LEVELS_DIR.mkdir(exist_ok=True)
_SAFE = re.compile(r"[^A-Za-z0-9_-]")


def _validate_level(L: dict, i: int) -> str | None:
    for f in ("name", "energy", "key", "door", "map"):
        if f not in L:
            return f"level {i+1} missing field: {f}"
    rows = L["map"]
    if not rows or not isinstance(rows, list):
        return f"level {i+1} map empty"
    w = len(rows[0])
    if any(len(r) != w for r in rows):
        return f"level {i+1} map not rectangular"
    flat = "".join(rows)
    if flat.count("P") != 1:
        return f"level {i+1} needs exactly one P (player start)"
    if flat.count("D") != 1:
        return f"level {i+1} needs exactly one D (door)"
    for p in ("a", "b"):
        n = flat.count(p) + flat.count(p.upper())
        if n not in (0, 2):
            return f"level {i+1} portal '{p}' must appear 0 or 2 times (got {n})"
    return None


@app.post("/api/levels")
def save_levels():
    body = request.get_json(force=True)
    name = _SAFE.sub("_", (body.get("name") or "").strip()) or "untitled"
    levels = body.get("levels")
    if not isinstance(levels, list) or not levels:
        return jsonify(error="levels must be a non-empty array"), 400
    for i, L in enumerate(levels):
        err = _validate_level(L, i)
        if err:
            return jsonify(error=err), 400
    pack = {"name": name, "n_levels": len(levels), "levels": levels,
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    (LEVELS_DIR / f"{name}.json").write_text(json.dumps(pack, indent=2))
    return jsonify(ok=True, name=name, n_levels=len(levels))


@app.get("/api/levels")
def list_levels():
    out = []
    for p in sorted(LEVELS_DIR.glob("*.json")):
        try:
            d = json.loads(p.read_text())
            out.append({"name": p.stem, "n_levels": d.get("n_levels", len(d.get("levels", [])))})
        except (OSError, json.JSONDecodeError):
            continue
    return jsonify(out)


@app.get("/api/levels/<name>")
def get_levels(name: str):
    p = LEVELS_DIR / f"{_SAFE.sub('_', name)}.json"
    if not p.exists():
        return jsonify(error="not found"), 404
    return jsonify(json.loads(p.read_text()))


# ---------------------------------------------------------------- prompt presets
_REPLY_FORMAT = """
Reply in EXACTLY this two-line format (no markdown, no extra lines):
THOUGHT: <your reasoning, one short sentence>
ACTION: <ONE WORD: UP, DOWN, LEFT, or RIGHT>"""

# "official" mirrors the reference ARC-AGI-3 agent's approach (see
# https://github.com/arcprize/ARC-AGI-3-Agents — reasoning_agent.py): a
# minimal, exploratory instruction with no rules explained up front, paired
# with a raw symbol grid + current/previous screenshots instead of a
# semantic tile-name description. This is the default now — the point of
# the benchmark is to see what the model figures out on its own, not to
# grade it on following a tutorial we wrote.
#
# The other three are *starting points* the operator can load into the
# fully-editable prompt box instead, for comparison — they differ only in
# how much of the game's mechanics/edge cases they spell out. Deliberately
# no strategy coaching (no "check the gap, then plan a route" steps): this is a
# benchmark of raw play, not a tutorial, so the model gets the rules and the
# data and is left to figure out tactics itself.
PROMPT_PRESETS = {
    "official": """You are playing a video game. Your goal is to win.

You are not told the rules in advance. Explore: take actions, watch how the
game reacts (what changes on screen, in the grid, in your energy), and use
what you learn to figure out the rules and reach the goal.

You will be given a raw grid of symbols for the current screen, an image of
the current screen, and (after your first move) an image of the previous
screen so you can compare what changed.
""" + _REPLY_FORMAT,

    "minimal": """You play Locksmith, a grid puzzle. Move onto the DOOR to win — it opens
only when your key's shape/color/rotation all match the door.
Changers (SHAPE_CHANGER, COLOR_CHANGER, ROTATOR) cycle the matching attribute
by 1 each time you step on them.
""" + _REPLY_FORMAT,

    "standard": """You are playing a grid puzzle game called Locksmith (ARC-AGI-3 ls20 replica).

OBJECTIVE: move your PLAYER onto the DOOR tile.
The door only opens when all three key attributes match the door requirement:
  • shape    (0-3, cycles with SHAPE_CHANGER)
  • color    (0-3, cycles with COLOR_CHANGER)
  • rotation (0-3 = 0°/90°/180°/270°, cycles with ROTATOR)

TILE GUIDE:
  FLOOR         — passable, nothing happens
  WALL          — impassable, do not try to enter
  ROTATOR       — entering adds 1 to rotation (cycles 0→1→2→3→0)
  SHAPE_CHANGER — entering adds 1 to shape
  COLOR_CHANGER — entering adds 1 to color
  PELLET        — collecting refills energy to max (single-use)
  PISTON_<DIR>  — shoves you in that direction until a wall
  PORTAL_a/b    — teleports to the partner portal of the same letter
  DOOR          — only opens if ALL attributes match requirement

KEY RULE: changers trigger every time you step ON them.
Attributes wrap around (e.g. shape 3 + 1 → shape 0).
""" + _REPLY_FORMAT,

    "detailed": """You are playing a grid puzzle game called Locksmith (ARC-AGI-3 ls20 replica).

OBJECTIVE: move your PLAYER onto the DOOR tile.
The door only opens when all three key attributes match the door requirement:
  • shape    (0-3, cycles with SHAPE_CHANGER)
  • color    (0-3, cycles with COLOR_CHANGER)
  • rotation (0-3 = 0°/90°/180°/270°, cycles with ROTATOR)

TILE GUIDE:
  FLOOR         — passable, nothing happens
  WALL          — impassable, do not try to enter
  ROTATOR       — entering adds 1 to rotation (cycles 0→1→2→3→0)
  SHAPE_CHANGER — entering adds 1 to shape
  COLOR_CHANGER — entering adds 1 to color
  PELLET        — collecting refills energy to max (single-use)
  PISTON_<DIR>  — shoves you in that direction until a wall, possibly crossing
                  several tiles and re-triggering changers along the way
  PORTAL_a/b    — teleports to the partner portal of the same letter; the exit
                  tile is your new position
  DOOR          — only opens if ALL attributes (shape, color, rotation) match
                  the requirement simultaneously; a partial match does nothing

KEY RULE: changers trigger every time you step ON them, including re-entering
a tile you already used. Attributes wrap around (e.g. shape 3 + 1 → shape 0).
Every action costs 1 energy; at 0 the level resets (key and pellets restore).
""" + _REPLY_FORMAT,
}
DEFAULT_PRESET = "official"


def _compute_gap_server(key: dict, door: dict, n_shapes: int, n_colors: int, n_rots: int) -> dict:
    rot_v   = (door["r"] - key["r"] + n_rots)   % n_rots
    color_v = (door["c"] - key["c"] + n_colors) % n_colors
    shape_v = (door["s"] - key["s"] + n_shapes) % n_shapes
    total   = rot_v + color_v + shape_v
    parts   = []
    if rot_v:   parts.append(f"rotation: have {key['r']*90}°→need {door['r']*90}° ({rot_v} rotator visit{'s' if rot_v>1 else ''})")
    if color_v: parts.append(f"color: have {key['c']}→need {door['c']} ({color_v} color-changer visit{'s' if color_v>1 else ''})")
    if shape_v: parts.append(f"shape: have {key['s']}→need {door['s']} ({shape_v} shape-changer visit{'s' if shape_v>1 else ''})")
    return {
        "total": total,
        "description": "KEY MATCHES DOOR — go directly to door NOW" if total == 0 else "; ".join(parts),
    }


def _format_history(history: list) -> str:
    if not history:
        return "  (no moves yet)"
    lines = []
    quality_icons = {"perfect":"🏆","good":"✓","neutral":"·","bad":"⚠","mistake":"✗","wasted":"—","unknown":"?"}
    for h in history:
        icon    = quality_icons.get(h.get("quality","unknown"), "?")
        explain = h.get("explain") or str(h.get("result",""))
        gap_str = f" | gap remaining: {h['gap']}" if h.get("gap") is not None else ""
        lines.append(f"  {icon} {h['action']}: {explain}{gap_str}")
    return "\n".join(lines)


def _build_messages(model: str, state: dict, history: list,
                    temperature: float, examples: str | None = None,
                    system_prompt: str | None = None, official: bool = True,
                    preset: str = DEFAULT_PRESET, custom_instructions: str | None = None) -> dict:
    """Build the {system, user} messages sent to the model.

    `system_prompt`, if given, is used verbatim — this is the full-control
    path the UI's editable prompt box uses. `preset`/`custom_instructions`
    are a fallback for callers that don't send a full override (e.g. a
    script hitting the API directly).

    `official` picks the *data format*, independent of the prompt text: the
    bare-symbol `raw_grid` (paired with screenshots, no tile names) when
    True, or the semantic tile-name grid + key/door/gap restatement when
    False. `state` always carries `raw_grid` (it's cheap to compute), but it
    is only used here when `official` is set — the semantic presets name
    tiles like ROTATOR/DOOR that don't exist in the anonymized grid, so
    mixing the two would leave the model unable to act on rules it was told.
    """
    if system_prompt is not None:
        sys = system_prompt
    else:
        sys = PROMPT_PRESETS.get(preset, PROMPT_PRESETS[DEFAULT_PRESET])
        if custom_instructions:
            sys += "\n\nOPERATOR INSTRUCTIONS (follow these in addition to the above):\n" + custom_instructions.strip()

    raw_grid = state.get("raw_grid") if official else None
    if raw_grid is not None:
        # "official" mode: no tile names, no key/door/gap restatement — just
        # the bare symbol grid + environment metadata. Whatever the symbols
        # mean is for the model to work out from how the game reacts, same
        # as the real game state is opaque to a human until they look at
        # the (attached) screenshot.
        user_parts = [
            f"LEVEL {state['level']}  |  ENERGY {state['energy']}/{state['energy_max']}  |  "
            f"AVAILABLE ACTIONS: {', '.join(state.get('actions', []))}",
            "",
            "RAW GRID (row-major, top-left is (0,0); each character is one cell — "
            "figure out what each symbol means from how the game responds to your moves):",
            "\n".join(raw_grid),
        ]
        return {"model": model, "stream": True,
                "messages": [{"role": "system", "content": sys},
                             {"role": "user",   "content": "\n".join(user_parts)}],
                "options": {"temperature": temperature}}

    ns = state.get("n_shapes", 4)
    nc = state.get("n_colors", 4)
    nr = state.get("n_rotations", 4)

    key  = state["key"]
    door = state["door_requirement"]
    gap  = _compute_gap_server(key, door, ns, nc, nr)

    grid_txt = "\n".join(
        "  " + " ".join(f"{c[:14]:<14}" for c in row)
        for row in state["grid"]
    )

    user_parts = [
        f"=== LEVEL {state['level']} — {state.get('level_name','')} ===",
        "",
        f"YOUR KEY:       shape={key['s']}  color={key['c']}  rotation={key['r']*90}°",
        f"DOOR REQUIRES:  shape={door['s']}  color={door['c']}  rotation={door['r']*90}°",
        f"GAP:            {gap['description']}",
        "",
        f"ENERGY:  {state['energy']} / {state['energy_max']}",
        f"PLAYER:  x={state['player']['x']}, y={state['player']['y']}  (x=column, y=row, 0=top-left)",
        "",
        "GRID:",
        grid_txt,
    ]

    if history:
        user_parts += ["", "RECENT MOVES (newest last):", _format_history(history)]

    if examples:
        user_parts += ["", "── WORKED EXAMPLE FROM A SUCCESSFUL HUMAN RUN ──", examples, "── END EXAMPLE ──"]

    if gap["total"] == 0:
        user_parts += ["", "⚑  KEY IS READY — your only goal now is to reach the DOOR."]
    else:
        user_parts += ["", f"⚑  You still need {gap['total']} changer visit(s) before attempting the door."]

    user_parts.append("\nYour move:")

    return {"model": model, "stream": True,
            "messages": [{"role": "system", "content": sys},
                         {"role": "user",   "content": "\n".join(user_parts)}],
            "options": {"temperature": temperature}}


@app.get("/api/ollama/models")
def ollama_models():
    try:
        resp = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        resp.raise_for_status()
        models = [m["name"] for m in resp.json().get("models", [])]
        return jsonify(ok=True, models=models)
    except requests.RequestException as e:
        return jsonify(ok=False, error=f"Ollama unreachable at {OLLAMA_URL}: {e}"), 502


_examples_cache: dict = {"mtime": None, "data": {}}


def _load_examples() -> dict:
    """Load data/examples.json generated by annotate_session.py (best-effort).

    Cached in memory keyed on the file's mtime — this is read on every
    ollama/gemini act call and the file can be tens of MB, so re-parsing it
    per request would dominate request latency.
    """
    p = DATA_DIR / "examples.json"
    try:
        mtime = p.stat().st_mtime if p.exists() else None
    except OSError:
        mtime = None
    if mtime != _examples_cache["mtime"]:
        try:
            _examples_cache["data"] = json.loads(p.read_text()) if mtime is not None else {}
        except (OSError, json.JSONDecodeError):
            _examples_cache["data"] = {}
        _examples_cache["mtime"] = mtime
    return _examples_cache["data"]


def _pick_example(level: int) -> str | None:
    """Return the prompt_text of the best example for this level, if any."""
    data = _load_examples()
    best = None
    for ex in data.get("examples", []):
        if ex.get("level") == level:
            if best is None or ex.get("score", 0) > best.get("score", 0):
                best = ex
    return best["prompt_text"] if best else None


@app.get("/api/prompt/templates")
def prompt_templates():
    """Starting-point system prompts the UI's prompt box can load, plus which is default."""
    return jsonify(templates=PROMPT_PRESETS, default=DEFAULT_PRESET)


@app.post("/api/ollama/act")
def ollama_act():
    """Stream the model's reply, emit SSE events, close with {action, raw}."""
    body = request.get_json(force=True)
    model   = body.get("model")
    state   = body.get("state")
    history = body.get("history", [])
    if not model or not state:
        return jsonify(error="model and state required"), 400

    examples_str = _pick_example(state.get("level", 1)) if body.get("include_example") else None
    payload = _build_messages(model, state, history,
                              body.get("temperature", 0.6), examples_str,
                              system_prompt=body.get("system_prompt"),
                              official=body.get("official", True),
                              preset=body.get("preset", DEFAULT_PRESET),
                              custom_instructions=body.get("custom_instructions"))

    def generate():
        raw = ""
        try:
            with requests.post(f"{OLLAMA_URL}/api/chat", json=payload,
                               stream=True, timeout=180) as r:
                r.raise_for_status()
                for line in r.iter_lines():
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    token = chunk.get("message", {}).get("content", "")
                    raw += token
                    # stream each token to the browser
                    yield f"data: {json.dumps({'token': token, 'raw': raw})}\n\n"
                    if chunk.get("done"):
                        break
        except requests.RequestException as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            return
        action, thought = parse_reply(raw)
        yield f"data: {json.dumps({'done': True, 'action': action, 'thought': thought, 'raw': raw.strip()[:800]})}\n\n"

    return app.response_class(generate(), mimetype="text/event-stream",
                              headers={"Cache-Control": "no-cache",
                                       "X-Accel-Buffering": "no"})


def parse_reply(raw: str) -> tuple[str | None, str]:
    """Split a model reply into (action, thought).

    Prefers the structured "ACTION: <word>" / "THOUGHT: ..." format we ask
    for in the prompt presets; falls back to scanning for a bare direction
    word so older/uncooperative models still work.
    """
    cleaned = re.sub(r"<think>.*?</think>", "", raw, flags=re.S)

    thought_m = re.search(r"THOUGHT:\s*(.+)", cleaned, flags=re.I)
    thought = thought_m.group(1).strip() if thought_m else ""

    action_m = re.search(r"ACTION:\s*\b(UP|DOWN|LEFT|RIGHT)\b", cleaned, flags=re.I)
    if action_m:
        return action_m.group(1).upper(), thought

    matches = re.findall(r"\b(UP|DOWN|LEFT|RIGHT)\b", cleaned.upper())
    return (matches[-1] if matches else None), thought


def parse_action(raw: str) -> str | None:
    """Back-compat wrapper — action only, no thought."""
    return parse_reply(raw)[0]


# --------------------------------------------------------------- Vertex AI
_gcp_credentials = None


def _get_gcp_token() -> str:
    """Return a fresh ADC access token, refreshing/re-loading as needed.

    No API key involved — this is the same Application Default Credentials
    flow set up via `gcloud auth application-default login`.
    """
    global _gcp_credentials
    if _gcp_credentials is None:
        _gcp_credentials, _ = google_auth_default()
    if not _gcp_credentials.valid:
        _gcp_credentials.refresh(GoogleAuthRequest())
    return _gcp_credentials.token


@app.get("/api/gemini/status")
def gemini_status():
    """Report whether Vertex AI is reachable right now (used by the demo page)."""
    if not GCP_PROJECT:
        return jsonify(ok=False, error="GOOGLE_CLOUD_PROJECT not set in .env"), 400
    try:
        _get_gcp_token()
        return jsonify(ok=True, project=GCP_PROJECT, location=GCP_LOCATION, model=GEMINI_MODEL)
    except DefaultCredentialsError as e:
        return jsonify(ok=False, error=f"ADC not configured: {e}"), 500


def _log_llm_call(*, context: str, session_id: str | None, prompt_tokens: int | None,
                   response_tokens: int | None, latency_ms: int, action: str | None,
                   status: str, error: str | None = None) -> float | None:
    """Persist one Gemini call to SQLite + append to data/llm_calls.jsonl. Returns cost_usd."""
    cost_usd = None
    total_tokens = None
    if prompt_tokens is not None and response_tokens is not None:
        cost_usd = (prompt_tokens / 1_000_000 * GEMINI_PRICE_INPUT_PER_M
                    + response_tokens / 1_000_000 * GEMINI_PRICE_OUTPUT_PER_M)
        total_tokens = prompt_tokens + response_tokens

    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        db = get_db()
        db.execute(
            """INSERT INTO llm_calls (ts, provider, model, context, session_id, prompt_tokens,
               response_tokens, total_tokens, latency_ms, cost_usd, action, status, error)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (ts, "vertex-ai", GEMINI_MODEL, context, session_id, prompt_tokens,
             response_tokens, total_tokens, latency_ms, cost_usd, action, status, error))
        db.commit()
    except sqlite3.Error:
        pass

    try:
        with LLM_LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": ts, "provider": "vertex-ai", "model": GEMINI_MODEL, "context": context,
                "session_id": session_id, "prompt_tokens": prompt_tokens,
                "response_tokens": response_tokens, "total_tokens": total_tokens,
                "latency_ms": latency_ms, "cost_usd": cost_usd, "action": action,
                "status": status, "error": error,
            }) + "\n")
    except OSError:
        pass
    return cost_usd


def _strip_data_url(b64: str) -> str:
    """Strip a 'data:image/png;base64,' prefix if present, else return as-is."""
    if "," in b64[:40]:
        return b64.split(",", 1)[1]
    return b64


def _vertex_generate(system_text: str | None, user_text: str,
                      images: list[str] | None = None) -> tuple[str, dict]:
    """Call Vertex AI generateContent. Returns (text, {latency_ms, usage, raw}). Raises on transport/HTTP error.

    `images`, if given, are base64 PNG strings (with or without a data-URL
    prefix) sent as inline image parts ahead of the text — this is how the
    "official" ARC-AGI-3-style mode attaches the current/previous screenshot.
    """
    token = _get_gcp_token()
    url = (f"https://{GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/{GCP_PROJECT}"
           f"/locations/{GCP_LOCATION}/publishers/google/models/{GEMINI_MODEL}:generateContent")
    parts = [{"inlineData": {"mimeType": "image/png", "data": _strip_data_url(img)}}
             for img in (images or [])]
    parts.append({"text": user_text})
    payload = {"contents": [{"role": "user", "parts": parts}]}
    if system_text:
        payload["systemInstruction"] = {"parts": [{"text": system_text}]}

    t0 = time.monotonic()
    resp = requests.post(url, json=payload, timeout=30,
                          headers={"Authorization": f"Bearer {token}",
                                   "Content-Type": "application/json"})
    latency_ms = round((time.monotonic() - t0) * 1000)
    resp.raise_for_status()

    data = resp.json()
    text = ""
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        pass
    return text, {"latency_ms": latency_ms, "usage": data.get("usageMetadata", {}), "raw": data}


@app.post("/api/gemini/generate")
def gemini_generate():
    """Forward a prompt to Vertex AI Gemini and return the raw API response.

    Returns the untouched response body (modelVersion, responseId, createTime,
    usageMetadata, etc.) plus server-measured latency, so the caller can see
    this is a live network round trip and not a canned reply.
    """
    if not GCP_PROJECT:
        return jsonify(error="GOOGLE_CLOUD_PROJECT not set in .env"), 400
    body = request.get_json(force=True) or {}
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return jsonify(error="prompt required"), 400

    try:
        text, meta = _vertex_generate(None, prompt)
    except DefaultCredentialsError as e:
        return jsonify(error=f"ADC not configured: {e}"), 500
    except requests.HTTPError as e:
        _log_llm_call(context="demo", session_id=None, prompt_tokens=None, response_tokens=None,
                       latency_ms=0, action=None, status="error", error=e.response.text[:500])
        return jsonify(error=e.response.text, http_status=e.response.status_code), 502
    except requests.RequestException as e:
        _log_llm_call(context="demo", session_id=None, prompt_tokens=None, response_tokens=None,
                       latency_ms=0, action=None, status="error", error=str(e))
        return jsonify(error=f"Vertex AI unreachable: {e}"), 502

    usage = meta["usage"]
    cost_usd = _log_llm_call(context="demo", session_id=None,
                              prompt_tokens=usage.get("promptTokenCount"),
                              response_tokens=usage.get("candidatesTokenCount"),
                              latency_ms=meta["latency_ms"], action=None, status="ok")

    return jsonify(ok=True, text=text, latency_ms=meta["latency_ms"], cost_usd=cost_usd,
                    model=GEMINI_MODEL, project=GCP_PROJECT, location=GCP_LOCATION,
                    raw=meta["raw"])


@app.post("/api/gemini/act")
def gemini_act():
    """One game action from Gemini — replaces the Ollama /api/ollama/act path.

    In the default "official" mode, `state` carries a `raw_grid` (bare
    symbols, no tile names) and the request also attaches `current_image` /
    `previous_image` (base64 PNG screenshots) so the request matches the
    reference ARC-AGI-3 agent's format. Every call is logged with tokens/cost.
    """
    if not GCP_PROJECT:
        return jsonify(error="GOOGLE_CLOUD_PROJECT not set in .env"), 400
    body = request.get_json(force=True) or {}
    state = body.get("state")
    if not state:
        return jsonify(error="state required"), 400
    history = body.get("history", [])
    session_id = body.get("session_id")

    official = body.get("official", True)
    examples_str = _pick_example(state.get("level", 1)) if body.get("include_example") else None
    msg_payload = _build_messages(GEMINI_MODEL, state, history,
                                   body.get("temperature", 0.6), examples_str,
                                   system_prompt=body.get("system_prompt"), official=official,
                                   preset=body.get("preset", DEFAULT_PRESET),
                                   custom_instructions=body.get("custom_instructions"))
    sys_text = msg_payload["messages"][0]["content"]
    user_text = msg_payload["messages"][1]["content"]

    images = [img for img in (body.get("current_image"), body.get("previous_image")) if img] if official else []

    try:
        text, meta = _vertex_generate(sys_text, user_text, images or None)
    except DefaultCredentialsError as e:
        return jsonify(error=f"ADC not configured: {e}"), 500
    except requests.HTTPError as e:
        _log_llm_call(context="game", session_id=session_id, prompt_tokens=None,
                       response_tokens=None, latency_ms=0, action=None,
                       status="error", error=e.response.text[:500])
        return jsonify(error=e.response.text, http_status=e.response.status_code), 502
    except requests.RequestException as e:
        _log_llm_call(context="game", session_id=session_id, prompt_tokens=None,
                       response_tokens=None, latency_ms=0, action=None,
                       status="error", error=str(e))
        return jsonify(error=f"Vertex AI unreachable: {e}"), 502

    action, thought = parse_reply(text)
    usage = meta["usage"]
    cost_usd = _log_llm_call(context="game", session_id=session_id,
                              prompt_tokens=usage.get("promptTokenCount"),
                              response_tokens=usage.get("candidatesTokenCount"),
                              latency_ms=meta["latency_ms"], action=action, status="ok")

    return jsonify(action=action, thought=thought, raw=text.strip()[:800],
                    latency_ms=meta["latency_ms"], cost_usd=cost_usd, usage=usage,
                    system_prompt_used=sys_text, user_prompt_used=user_text,
                    images_attached=len(images))


@app.get("/api/llm/usage")
def llm_usage():
    """Aggregate cost/token totals + recent calls, for the usage widget in the UI."""
    session_id = request.args.get("session_id")
    db = get_db()
    q = "SELECT COUNT(*) n, COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(cost_usd),0) cost FROM llm_calls WHERE status='ok'"
    args: tuple = ()
    if session_id:
        q += " AND session_id = ?"
        args = (session_id,)
    totals = dict(db.execute(q, args).fetchone())

    rq = "SELECT ts, context, prompt_tokens, response_tokens, latency_ms, cost_usd, action, status FROM llm_calls"
    rargs: tuple = ()
    if session_id:
        rq += " WHERE session_id = ?"
        rargs = (session_id,)
    rq += " ORDER BY id DESC LIMIT 20"
    recent = [dict(row) for row in db.execute(rq, rargs)]

    return jsonify(calls=totals["n"], total_tokens=totals["tok"], total_cost_usd=totals["cost"],
                    recent=recent)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"LS20 Lab → http://localhost:{port}   (Ollama proxy → {OLLAMA_URL})")
    app.run(host="0.0.0.0", port=port, debug=False)