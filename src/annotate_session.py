"""annotate_session.py — post-process LS20 run JSON files.

What it does:
  1. Reads every run_*.json from data/
  2. Re-annotates each trace entry with gap + action_quality
     (useful for runs recorded before the engine update)
  3. Extracts high-quality move sequences from successful human runs
     and writes data/examples.json  — the server uses this for few-shot prompts

Usage:
  python src/annotate_session.py            # process all runs in data/
  python src/annotate_session.py --dry-run  # show output, don't write files
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DATA   = Path(__file__).resolve().parent.parent / "data"
N_SHAPES, N_COLORS, N_ROTS = 4, 4, 4

# ── gap & quality (mirrors engine.js logic) ─────────────────────────────────

def compute_gap(key: dict, door: dict) -> dict:
    rv = (door["r"] - key["r"] + N_ROTS)   % N_ROTS
    cv = (door["c"] - key["c"] + N_COLORS) % N_COLORS
    sv = (door["s"] - key["s"] + N_SHAPES) % N_SHAPES
    total = rv + cv + sv
    parts = []
    if rv: parts.append(f"rotation: have {key['r']*90}°→need {door['r']*90}° ({rv} visit{'s' if rv>1 else ''})")
    if cv: parts.append(f"color: have {key['c']}→need {door['c']} ({cv} visit{'s' if cv>1 else ''})")
    if sv: parts.append(f"shape: have {key['s']}→need {door['s']} ({sv} visit{'s' if sv>1 else ''})")
    return {
        "rot_visits":   rv,
        "color_visits": cv,
        "shape_visits": sv,
        "total":        total,
        "solved":       total == 0,
        "description":  "key matches door — go directly to door" if total == 0 else "; ".join(parts),
    }


def assess_quality(result: list[str], gap_before: dict, gap_after: dict) -> dict:
    if "door_opened"   in result: return {"quality": "perfect", "reason": "door opened — level complete"}
    if "door_rejected" in result: return {"quality": "mistake",  "reason": "tried door before key was ready"}
    if "blocked"       in result: return {"quality": "wasted",   "reason": "walked into wall — no progress"}
    changed = any(r in result for r in ("rotated", "shape_changed", "color_changed"))
    delta   = gap_after["total"] - gap_before["total"]
    if changed:
        if delta < 0: return {"quality": "good",    "reason": f"changer used — gap {gap_before['total']}→{gap_after['total']}"}
        if delta > 0: return {"quality": "bad",     "reason": f"over-cycled — gap INCREASED {gap_before['total']}→{gap_after['total']}"}
        return              {"quality": "neutral", "reason": "changer stepped, net gap unchanged"}
    if "pellet_collected" in result: return {"quality": "good", "reason": "energy refilled"}
    if "teleported"       in result: return {"quality": "good", "reason": "portal used"}
    if gap_before["solved"]:         return {"quality": "good", "reason": "key ready, navigating to door"}
    return                                  {"quality": "neutral", "reason": f"floor movement — gap still {gap_after['total']}"}


# ── annotate a single trace entry that may be missing gap / quality ──────────

def annotate_entry(entry: dict) -> dict:
    """Add gap + action_quality if not already present."""
    if "gap" in entry and "action_quality" in entry:
        return entry                               # already annotated by new engine

    key      = entry.get("key", {})
    door_req = entry.get("door_req", {})
    result   = entry.get("result", [])

    if not key or not door_req:
        return entry                               # not enough data, skip

    # we need the key BEFORE this action — approximate from key_changes
    key_before = dict(key)
    for change in entry.get("key_changes", []):
        # format: "rotation 180°→270°"  |  "shape 0→1"  |  "color 2→3"
        if change.startswith("rotation"):
            parts = change.split()
            try:   key_before["r"] = int(parts[1].replace("°","")) // 90
            except: pass
        elif change.startswith("shape"):
            parts = change.split()
            try:   key_before["s"] = int(parts[1].split("→")[0])
            except: pass
        elif change.startswith("color"):
            parts = change.split()
            try:   key_before["c"] = int(parts[1].split("→")[0])
            except: pass

    gap_before = compute_gap(key_before, door_req)
    gap_after  = compute_gap(key,        door_req)
    quality    = assess_quality(result, gap_before, gap_after)

    return {**entry, "gap": gap_after, "gap_before": gap_before, "action_quality": quality}


# ── few-shot example extraction ──────────────────────────────────────────────

QUALITY_SCORE = {"perfect": 5, "good": 3, "neutral": 1, "bad": -2, "mistake": -3, "wasted": -1}

def score_window(window: list[dict]) -> float:
    """Average quality score of a sequence of annotated entries."""
    if not window:
        return 0.0
    return sum(QUALITY_SCORE.get(e.get("action_quality", {}).get("quality", "neutral"), 1)
               for e in window) / len(window)


def extract_examples(run: dict, window: int = 6, top_n: int = 3) -> list[dict]:
    """
    Slide a window over the trace and return the top_n highest-quality sequences.
    Filters: only from completed runs, only windows with avg score > 1.5.
    """
    if run.get("outcome") != "completed":
        return []

    trace = [annotate_entry(e) for e in run.get("action_trace", [])]
    windows = []
    for i in range(len(trace) - window + 1):
        w = trace[i:i + window]
        # skip windows with any walls/mistakes
        if any(e.get("action_quality", {}).get("quality") in ("mistake", "wasted") for e in w):
            continue
        s = score_window(w)
        if s > 1.5:
            windows.append((s, i, w))

    windows.sort(key=lambda x: -x[0])
    seen_levels: set[int] = set()
    examples = []
    for score, idx, w in windows[:top_n * 3]:
        lvl = w[0].get("level")
        if lvl in seen_levels:
            continue
        seen_levels.add(lvl)
        examples.append({
            "score":        round(score, 2),
            "run_id":       run.get("run_id", "?"),
            "player":       run.get("player_name", "?"),
            "level":        lvl,
            "start_step":   idx,
            "window":       w,
            "prompt_text":  _format_example(w, run),
        })
        if len(examples) >= top_n:
            break
    return examples


def _format_example(window: list[dict], run: dict) -> str:
    lines = [
        f"Human player '{run.get('player_name','?')}' solving level {window[0].get('level')}:",
    ]
    icons = {"perfect":"🏆","good":"✓","neutral":"·","bad":"⚠","mistake":"✗","wasted":"—"}
    for e in window:
        q    = e.get("action_quality",{}).get("quality","?")
        icon = icons.get(q,"?")
        gap  = e.get("gap",{})
        gap_str = f"  [gap={gap.get('total','?')}: {gap.get('description','')}]" if gap else ""
        lines.append(
            f"  {icon} {e['action']}: {e.get('explain','')}{gap_str}"
        )
    return "\n".join(lines)


# ── main ─────────────────────────────────────────────────────────────────────

def process_file(path: Path, dry_run: bool) -> dict | None:
    try:
        run = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        print(f"  skip {path.name}: {e}", file=sys.stderr)
        return None

    original_len = len(run.get("action_trace", []))
    run["action_trace"] = [annotate_entry(e) for e in run.get("action_trace", [])]

    new_gaps = sum(1 for e in run["action_trace"] if "gap" in e)
    print(f"  {path.name}: {original_len} steps → {new_gaps} annotated")

    if not dry_run:
        path.write_text(json.dumps(run, indent=2))

    return run


def main():
    ap = argparse.ArgumentParser(description="Annotate LS20 run files and extract few-shot examples.")
    ap.add_argument("--dry-run", action="store_true", help="print results without writing files")
    ap.add_argument("--data", default=str(DATA), help="path to data/ directory")
    args = ap.parse_args()

    data_dir = Path(args.data)
    run_files = sorted(data_dir.glob("run_*.json"))

    if not run_files:
        print("No run_*.json files found in", data_dir)
        print("Play some games first, then run this script.")
        return

    print(f"Found {len(run_files)} run file(s) in {data_dir}\n")
    all_runs = []
    for p in run_files:
        run = process_file(p, args.dry_run)
        if run:
            all_runs.append(run)

    # extract best few-shot examples across all runs
    all_examples: list[dict] = []
    for run in all_runs:
        all_examples.extend(extract_examples(run, window=6, top_n=2))

    # sort by score, keep best 10
    all_examples.sort(key=lambda x: -x["score"])
    all_examples = all_examples[:10]

    out = {
        "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "n_runs":        len(all_runs),
        "n_examples":    len(all_examples),
        "examples":      all_examples,
    }

    if args.dry_run:
        print("\n── FEW-SHOT EXAMPLES (dry run, not saved) ──")
        for ex in all_examples:
            print(f"\n[level {ex['level']}  score={ex['score']}  run={ex['run_id']}]")
            print(ex["prompt_text"])
    else:
        out_path = data_dir / "examples.json"
        out_path.write_text(json.dumps(out, indent=2))
        print(f"\nWrote {out_path}  ({len(all_examples)} examples from {len(all_runs)} run(s))")
        print("The server will automatically use these examples in LLM prompts.")

    # summary table
    print("\n── QUALITY DISTRIBUTION ──")
    from collections import Counter
    counts: Counter = Counter()
    for run in all_runs:
        for e in run.get("action_trace", []):
            q = e.get("action_quality", {}).get("quality", "unannotated")
            counts[q] += 1
    for q, n in counts.most_common():
        print(f"  {q:<12} {n:>5}")


if __name__ == "__main__":
    main()