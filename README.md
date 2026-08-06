# LS20 Lab

A replica of ARC-AGI-3 public task **ls20** ("Locksmith") built as an agent–human
experiment arena: humans and an LLM (Gemini via Vertex AI) play the same game,
every run is logged as a JSON action trace, and all runs land on a shared
leaderboard.

## Why this project

ARC-AGI-3-style tasks are designed to probe general reasoning rather than
memorized patterns — a good fit for asking a very concrete question: **how
well does an LLM track and plan around a small piece of changing state**
(a key with three cyclic attributes) **compared to a human**, using nothing
but a text description of the board?

What we're trying to get out of it:

- **A fair, repeatable comparison.** Human and LLM play the exact same levels
  (each pre-verified solvable by BFS), and every run is scored the same way
  (levels completed, then actions, then time) on one leaderboard.
- **A lever on prompting, not just the model.** The LLM panel exposes prompt
  detail (minimal / standard / detailed presets) and free-text operator
  instructions, so we can see how much of the result is "the model" vs.
  "how we asked it" — without touching code.
- **Visibility into *why* a move happened.** Every action — human or LLM —
  produces a structured explanation (which attributes matched, what the gap
  to the door still is). For the LLM specifically, its reasoning is shown
  live (not just the final action), so a bad move is diagnosable instead of
  a black box.
- **A growing dataset.** Every finished run is saved as a full JSON trace.
  `annotate_session.py` mines these into worked examples (`data/examples.json`)
  that get fed back into the prompt for later runs — the arena is meant to
  bootstrap its own few-shot examples over time, not stay static.

## Structure

```
ls20-lab/
├── src/
│   ├── server.py        # Flask: static hosting, SQLite, level packs, Gemini/Ollama proxy
│   ├── annotate_session.py  # mines finished runs into worked-example prompts
│   ├── ls20.db          # created on first run
│   └── static/
│       ├── index.html   # arena: board, manual, leaderboard, LLM panel
│       ├── editor.html  # level editor
│       ├── shapes.js    # shared key-shape defs (used by engine + editor)
│       ├── engine.js    # game core: mechanics, rich move logging, run recording
│       ├── client.js    # server sync + Gemini autonomous player loop
│       ├── editor.js    # editor logic: paint grid, attrs, import/export
│       └── style.css
├── data/
│   ├── run_<id>.json      # one file per finished run (full trace)
│   ├── session_<id>.json  # session bundle (all runs)
│   ├── examples.json      # worked examples mined from good runs (fed into prompts)
│   ├── llm_calls.jsonl    # per-call token/cost/latency log
│   └── levels/<pack>.json # custom level packs from the editor
├── requirements.txt
└── README.md
```

## Run

```bash
pip install -r requirements.txt
python src/server.py            # → http://localhost:8000
```

Env vars (in `.env`, project root): `PORT` (default 8000), `OLLAMA_URL`
(default `http://localhost:11434`).

### LLM player setup (Gemini via Vertex AI)

The arena's LLM panel calls Gemini through Vertex AI using Application
Default Credentials — no API key (disallowed by org policy). One-time setup:

```bash
gcloud auth application-default login
```

Then in `.env`:

```
GEMINI_MODEL=gemini-2.5-flash-lite
GOOGLE_CLOUD_PROJECT=<your project id>
GOOGLE_CLOUD_LOCATION=us-central1
```

If ADC lookup fails at runtime (`DefaultCredentialsError` even though you're
logged in — some AV/EDR setups block reading `%APPDATA%\gcloud\...` from a
terminal-spawned process), copy the credentials file into the project and
point at it explicitly:

```
GOOGLE_APPLICATION_CREDENTIALS=<absolute path to application_default_credentials.json>
```

(Keep that file out of git — it already matches `.secrets/` in `.gitignore`
if you put it there.)

An **Ollama** path also exists server-side (`/api/ollama/act`, same prompt
logic) for running local models instead, but the arena UI currently only
wires up Gemini.

## Game mechanics (mirrors ls20)

You carry a **key** with three cyclic attributes — shape (4), color (4), rotation (4).
The level's **door** opens only on a full match. Tiles:

| Tile | Effect on entry |
|---|---|
| ✚ Rotator | key rotation +90° |
| ◇ Shape changer | key shape +1 |
| ▦ Color changer | key color +1 |
| ● Energy pellet | refills energy (single-use) |
| ⇥ Piston | shoves you until a wall/special tile |
| ◎ Portal | teleports to its pair |

Every action costs 1 energy; at 0 the level resets. Changers re-trigger on each
entry — bounce on/off to cycle. 6 levels with the original's progressive-mechanics
curve; each verified solvable by BFS within its energy budget
(min actions: 18 / 24 / 26 / 11 / 31 / 25).

## LLM player panel

- **Prompt detail presets** — `minimal` (bare rules), `standard` (rules +
  strategy, default), `detailed` (full strategy + edge cases). Changes how
  much the system prompt tells the model about tactics, not the game rules
  themselves.
- **Custom instructions** — free-text box appended to the system prompt as
  operator guidance (e.g. "prioritize energy pellets over speed"). Persisted
  in `localStorage`.
- **Thought log** — the model is asked to reply as `THOUGHT: ...` /
  `ACTION: <word>`; both are parsed server-side (`parse_reply` in
  `server.py`) and the thought is shown per-step in a scrolling log, so
  reasoning stays readable across a whole run instead of being overwritten
  by the next step.

## Level editor

Open **`/editor.html`** (link in the arena header). Paint tiles from the palette
(left-click paint, right-click = floor), set the start key and door requirement with
live previews, adjust size/energy, and build a multi-level pack via the tabs.

- **Export .json** downloads the pack.
- **Import** loads a pack back for editing.
- **Save to data/levels/** persists it server-side.
- **Test in arena** saves the pack and jumps to `index.html?levels=<pack>`, which
  loads it via `LS20.loadCustomLevels()` — new runs then use your levels.

Server-side validation enforces exactly one player start, one door, and paired portals.

## Per-move logging

Every action produces a structured explanation, shown live in the arena log and stored
in the trace. Each trace entry:

```json
{ "t": 25, "level": 1, "action": "UP",
  "result": ["moved","door_opened"],
  "explain": "moved UP into the DOOR — key s0/c1/0° matches the requirement → OPENED",
  "key_changes": [], "target_tile": "DOOR",
  "match": {"color": true, "shape": true, "rotation": true, "silhouette": true, "all": true},
  "energy": 6, "key": {"s":0,"c":1,"r":0}, "pos": {"x":1,"y":1} }
```

`match` records exactly which attributes line up with the door, so a rejected door move
tells you *why* it failed (e.g. "mismatch on silhouette (shape+rotation)").

## Data & experiments

- Each finished run → SQLite (`src/ls20.db`) + `data/run_<id>.json`
- "Export session" → `data/session_<id>.json` (all runs of the browser session)
- Every Gemini/Ollama call → SQLite (`llm_calls` table) + `data/llm_calls.jsonl`
  (tokens, latency, cost, action, status)
- Trace format per action:
  `{t, level, action, result[], energy, key{s,c,r}, pos{x,y}}`
- Leaderboard ordering follows ARC-AGI-3: levels completed ↓, total actions ↑, time ↑.

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/runs` | persist a finished run |
| `GET /api/leaderboard[?session_id=]` | ranked runs (global or per session) |
| `GET /api/runs/<run_id>` | full run incl. trace |
| `POST /api/export` `{session_id}` | write session bundle to `data/` |
| `POST /api/levels` `{name, levels}` | save & validate a level pack to `data/levels/` |
| `GET /api/levels` | list saved level packs |
| `GET /api/levels/<name>` | fetch a level pack |
| `GET /api/gemini/status` | check Vertex AI/ADC reachability |
| `POST /api/gemini/act` `{state, history, preset, custom_instructions, session_id}` | one action + thought from Gemini |
| `GET /api/llm/usage[?session_id=]` | token/cost totals for this session |
| `GET /api/ollama/models` | list local Ollama models |
| `POST /api/ollama/act` `{model, state, history, preset, custom_instructions}` | one action from a local Ollama model (SSE stream) |

Browser-side, `window.LS20` exposes `startRun(name, type, model)`, `step(action)`,
`getState()` — so you can also drive the game from the devtools console or an
external harness (Playwright etc.).
