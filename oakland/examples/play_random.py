"""Play one OaklandPortEnv task with the naive re-plan and print the grade.

    python examples/play_random.py --tasks tasks/berth-eval.jsonl [--index 0]

The plan comes from oakland_core.naive_plan when the solver module is present; otherwise a hand-written plan is
used: every ship at its published berth (or, for unscheduled calls, section 1 at its arrival), with its standard
crane count. Ship calls are GENERATED (not real records); terminal geometry, fleets, depths and shifts are real.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import oakland_core  # noqa: E402
from env import OaklandEnv  # noqa: E402


def hand_plan(task) -> list[dict]:
    """The published plan as it stands (berth tasks) or the standard cranes in every shift (crane tasks)."""
    out = []
    for s in task.ships:
        c = s.std_cranes if s.std_cranes is not None else 1
        if getattr(task, "kind", "berth") == "crane":
            out.append({"ship": s.id, "cranes": {"day": c, "night": c, "hoot": c}})
        else:
            hour = s.planned_hour if s.planned_hour is not None else s.arrival
            section = s.planned_section if s.planned_section is not None else task.first_section
            out.append({"ship": s.id, "berth_hour": max(hour, s.arrival), "section": section, "cranes": c})
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--tasks", required=True, help="tasks .jsonl")
    ap.add_argument("--index", type=int, default=0)
    a = ap.parse_args()
    env = OaklandEnv(a.tasks)
    obs = env.reset(index=a.index)
    task = env.task
    print(f"task {obs['task_id']} ({obs['kind']}, {obs['terminal']}, {obs['difficulty']}), {len(task.ships)} ships")
    naive = getattr(oakland_core, "naive_plan", None)
    if naive is not None:
        plan, source = oakland_core.plan_to_list(naive(task)), "naive_plan"
    else:
        plan, source = hand_plan(task), "hand-written published plan"
    print(f"plan: {source}")
    chk = env.check_plan(plan)
    print(f"check: feasible={chk['feasible']} cost={chk['cost']} violations={len(chk['violations'])}")
    for v in chk["violations"][:5]:
        print(f"  ship {v['ship']}: {v['problem']}")
    g = env.submit_plan(plan)
    print(json.dumps({k: g[k] for k in ("reward", "feasible", "cost", "optimal_cost", "naive_cost")}, indent=2))


if __name__ == "__main__":
    main()
