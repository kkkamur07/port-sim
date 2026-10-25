"""CLI for the self-improving player and coach loop. The ship calls of every task are GENERATED (not real records).

    cd oakland
    ../.venv/bin/python -m loop.run --run demo --episodes 6 --coach-every 3 --kind berth \\
        --train-pack /tmp/oak-loop-train.jsonl --eval-pack /tmp/oak-loop-eval.jsonl \\
        --player scripted --coach scripted --scripted-mistakes

Prints one line per episode (episode, task, reward, checks used, first feasible check, playbook version) and one
line per coach round (accept or reject, with the eval and train means side by side). Writes runs/<run>/:
episodes.jsonl, episodes.json (the dashboard manifest), eval.jsonl, playbooks/ (v<k>.md, tree.json,
changelog.json), replays/ep<k>.json, events/ep<k>.jsonl, eval/ (event logs of the eval episodes), state.sqlite.

--player and --coach default to "auto": gemini when GOOGLE_API_KEY or GEMINI_API_KEY is set, else scripted.
Choosing gemini turns ALLOW_MODEL_REQUESTS on for this process.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

from .graph import RUNS, LoopConfig, run_loop
from .player import api_key


def _pick(choice: str, what: str) -> str:
    if choice == "auto":
        return "gemini" if api_key() else "scripted"
    if choice == "gemini" and not api_key():
        raise SystemExit(f"--{what} gemini needs GOOGLE_API_KEY or GEMINI_API_KEY in the environment")
    return choice


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m loop.run", description=__doc__.split("\n")[0])
    ap.add_argument("--run", default="demo", help="run name: outputs go to runs/<run>/")
    ap.add_argument("--episodes", type=int, default=30)
    ap.add_argument("--coach-every", type=int, default=4)
    ap.add_argument("--kind", choices=["berth", "crane", "both"], default="berth")
    ap.add_argument("--train-pack", action="append", default=[], help="train pack .jsonl (repeatable)")
    ap.add_argument("--eval-pack", action="append", default=[], help="eval pack .jsonl (repeatable)")
    ap.add_argument("--player", choices=["auto", "gemini", "scripted"], default="auto")
    ap.add_argument("--coach", choices=["auto", "gemini", "scripted"], default="auto")
    ap.add_argument("--live-feed", choices=["on", "off"], default="on")
    ap.add_argument("--scripted-mistakes", action="store_true",
                    help="scripted player berths one ship inside a no-movement window on its first check")
    ap.add_argument("--runs-dir", default=str(RUNS))
    ap.add_argument("--resume", action="store_true", help="continue runs/<run> from its checkpoint")
    ap.add_argument("--quiet", action="store_true", help="do not print the [graph] node events")
    a = ap.parse_args(argv)
    if a.episodes < 1 or a.coach_every < 1:
        ap.error("--episodes and --coach-every must be at least 1")

    player, coach = _pick(a.player, "player"), _pick(a.coach, "coach")
    if "gemini" in (player, coach):
        os.environ["ALLOW_MODEL_REQUESTS"] = "1"
    run_dir = Path(a.runs_dir) / a.run
    if run_dir.exists() and not a.resume:
        shutil.rmtree(run_dir)
    cfg = LoopConfig(run=a.run, episodes=a.episodes, coach_every=a.coach_every, kind=a.kind,
                     train_pack=a.train_pack, eval_pack=a.eval_pack, player=player, coach=coach,
                     live_feed=a.live_feed == "on", scripted_mistakes=a.scripted_mistakes, runs_dir=a.runs_dir,
                     trace=not a.quiet)
    print(f"run {a.run} | player {player} | coach {coach} | kind {a.kind} | episodes {a.episodes} | "
          f"coach every {a.coach_every} | live feed {a.live_feed}", flush=True)
    run_loop(cfg, out=lambda s: print(s, flush=True), resume=a.resume)
    print(f"outputs in {run_dir}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
