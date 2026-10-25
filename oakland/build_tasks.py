"""Build a pack of OaklandPortEnv tasks (generated ship calls, real terminals) with CP-SAT reference plans.

    python build_tasks.py --kind berth --split eval --n 12 --time-limit 20 --out tasks/berth-eval.jsonl

Prints kept / tried, the median solve time of kept tasks and the naive and greedy reward ranges.
"""

from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from oakland_core.pack import SEED0, build_pack, save_jsonl  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kind", choices=["berth", "crane"], required=True)
    ap.add_argument("--split", choices=sorted(SEED0), required=True)
    ap.add_argument("--n", type=int, required=True)
    ap.add_argument("--time-limit", type=float, default=30.0, help="CP-SAT seconds per task")
    ap.add_argument("--seed0", type=int, default=None, help="first seed (default: 0 for train, 100000 for eval)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    t0 = time.time()
    tasks = build_pack(args.n, args.split, args.kind, args.seed0, args.time_limit)
    stats = build_pack.last_stats
    save_jsonl(tasks, args.out)
    kept = [c for c in stats["candidates"] if c["kept"]]
    for c in stats["candidates"]:
        print(f"  seed {c['seed']:>6} {c['tier']:<8} {'kept' if c['kept'] else 'drop'}  {c['seconds']:5.1f}s  "
              f"opt {c.get('optimal')}  naive {c.get('naive')}  greedy {c.get('greedy')}  {c.get('reason', '')}")
    print(f"kept {stats['kept']} / tried {stats['tried']} -> {args.out} ({time.time() - t0:.0f}s)")
    if kept:
        print(f"median solve {statistics.median(c['seconds'] for c in kept):.1f}s")
        nr = [c["naive_reward"] for c in kept]
        gr = [c["greedy_reward"] for c in kept]
        print(f"naive reward {min(nr):.3f}-{max(nr):.3f}, greedy reward {min(gr):.3f}-{max(gr):.3f}")
    return 0 if stats["kept"] == args.n else 1


if __name__ == "__main__":
    raise SystemExit(main())
