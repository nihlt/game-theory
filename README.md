# LS20 Lab

A replica of ARC-AGI-3 public task **ls20** ("Locksmith") built as an agent–human
experiment arena: humans and local LLMs (via Ollama) play the same game, every run
is logged as a JSON action trace, and all runs land on a shared leaderboard.

## Structure

```
ls20-lab/
├── src/
│   ├── server.py        # Flask: static hosting, SQLite, level packs, Ollama proxy
│   ├── ls20.db          # created on first run
│   └── static/
│       ├── index.html   # arena: board, manual, leaderboard, LLM panel
│       ├── editor.html  # level editor
│       ├── shapes.js    # shared key-shape defs (used by engine + editor)
│       ├── engine.js    # game core: mechanics, rich move logging, run recording
│       ├── client.js    # server sync + Ollama autonomous player loop
│       ├── editor.js    # editor logic: paint grid, attrs, import/export
│       └── style.css
├── data/
│   ├── run_<id>.json      # one file per finished run (full trace)
│   ├── session_<id>.json  # session bundle (all runs)
│   └── levels/<pack>.json # custom level packs from the editor
├── requirements.txt
└── README.md
```

## Run

```bash
pip install -r requirements.txt
python src/server.py            # → http://localhost:8000
```

For LLM runs, have Ollama running locally with at least one model:

```bash
ollama serve                    # usually already running
ollama pull llama3.2
```

Env vars: `PORT` (default 8000), `OLLAMA_URL` (default `http://localhost:11434`).

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
| `GET /api/ollama/models` | list local Ollama models |
| `POST /api/ollama/act` `{model, state, history}` | one action from the LLM |

Browser-side, `window.LS20` exposes `startRun(name, type, model)`, `step(action)`,
`getState()` — so you can also drive the game from the devtools console or an
external harness (Playwright etc.).
