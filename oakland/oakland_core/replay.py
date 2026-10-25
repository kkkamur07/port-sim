"""The replay JSON the 3D viewer loads (docs/replay_schema.md): the task, the plan, its grade and every ship's
hour-by-hour crane use, so the viewer never recomputes rules. The ship calls in it are GENERATED, not real records."""

from __future__ import annotations

from .check import block_crane_hours, evaluate, timeline
from .model import Plan, Task, plan_to_list
from .reward import grade


def replay(task: Task, plan: Plan, parse_problems: list[str] | None = None) -> dict:
    g = grade(task, plan, parse_problems)
    res = evaluate(task, plan)
    tl = timeline(task, plan)
    ships = []
    for s, r in zip(task.ships, res.ships):
        ships.append({
            "id": s.id, "name": s.name, "line": s.line, "length_m": s.length_m, "sections": s.sections,
            "first_section": r.section, "arrival": s.arrival, "berth_hour": r.berth_hour, "departure": r.departure,
            "due": s.due, "late_h": r.delay_h if r.berth_hour is not None else None,
            "cranes_by_hour": [[t, c] for t, c in tl.get(s.id, [])],
            "problems": list(r.problems),
        })
    blocks = []
    for b in task.blocks:
        row = {"first": b.first, "last": b.last, "start": b.start, "end": b.end, "kind": b.kind, "label": b.label}
        if b.kind == "alongside":
            row["cranes"] = b.cranes
            row["cranes_by_hour"] = [[t, b.cranes] for t in block_crane_hours(task, b)]
        if b.max_draught_m is not None:
            row["max_draught_m"] = b.max_draught_m
        blocks.append(row)
    no_moves = [{"start": w["start"], "end": w["end"], "label": w.get("label", w.get("reason", "no movement"))}
                for w in task.rules.get("no_moves", [])]
    horizon = task.horizon_h
    return {
        "task": task.to_dict(public=True),
        "plan": plan_to_list(plan, task.kind),
        "grade": {"reward": g.reward, "feasible": g.feasible, "cost": g.cost, "optimal_cost": g.optimal_cost,
                  "violations": g.violations + [{"ship": None, "problem": p} for p in g.parse_problems]},
        "horizon_h": horizon,
        "ships": ships,
        "blocks": blocks,
        "no_moves": no_moves,
        "crane_pool_by_hour": [[t, task.crane_pool_at(t)] for t in range(horizon)],
    }
