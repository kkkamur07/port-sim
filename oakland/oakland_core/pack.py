"""Task packs: generated OaklandPortEnv tasks with their reference plans, saved as JSON lines.

Ship calls are GENERATED, not real records. A candidate task is kept only when CP-SAT proves its optimum within the
time limit, the naive re-plan scores at most 0.6 and the greedy heuristic at most 0.85 (reward.grade), so a lazy
policy cannot score well. Seeds: train from 0, eval from 100000, so the splits never share a task.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from .check import evaluate
from .generate import TIERS, generate_task
from .model import Task, plan_to_list
from .reward import grade
from .solve import greedy_plan, naive_plan, solve

SEED0 = {"train": 0, "eval": 100000}
NAIVE_MAX, GREEDY_MAX = 0.6, 0.85


def reference(task: Task, time_limit_s: float) -> tuple[dict | None, dict]:
    """The task's reference block and build stats; the reference is None when the task fails the keep rule."""
    naive, greedy = naive_plan(task), greedy_plan(task)
    rn, rg = evaluate(task, naive), evaluate(task, greedy)
    t0 = time.time()
    try:
        plan, cost, proven = solve(task, time_limit_s=time_limit_s)
    except RuntimeError as e:
        return None, {"reason": f"solver: {e}", "seconds": time.time() - t0}
    stats = {"seconds": time.time() - t0, "optimal": cost, "naive": rn.cost, "greedy": rg.cost, "proven": proven}
    if not proven:
        return None, {**stats, "reason": "optimum not proven"}
    if not rn.feasible:
        return None, {**stats, "reason": "naive re-plan infeasible"}
    ref = {"optimal_plan": plan_to_list(plan), "optimal_cost": cost, "naive_plan": plan_to_list(naive),
           "naive_cost": rn.cost, "greedy_cost": rg.cost if rg.feasible else None, "proven_optimal": True,
           "solver": "ortools-cpsat"}
    task.reference = ref
    stats["naive_reward"] = grade(task, naive).reward
    stats["greedy_reward"] = grade(task, greedy).reward
    task.reference = {}
    if stats["naive_reward"] > NAIVE_MAX:
        return None, {**stats, "reason": "naive re-plan scores too well"}
    if stats["greedy_reward"] > GREEDY_MAX:
        return None, {**stats, "reason": "greedy plan scores too well"}
    return ref, stats


def build_pack(n: int, split: str, kind: str, seed0: int | None = None, time_limit_s: float = 30.0) -> list[Task]:
    """`n` kept tasks of one kind, seeds from `seed0` (default: the split's first seed), tiers in rotation. Stops
    after 4n candidates. Build stats of the last call are in `build_pack.last_stats`."""
    seed0 = SEED0[split] if seed0 is None else seed0
    if split == "eval" and seed0 < SEED0["eval"]:
        raise ValueError(f"eval seeds start at {SEED0['eval']}")
    if split == "train" and seed0 + 4 * n > SEED0["eval"]:
        raise ValueError(f"train seeds must stay below {SEED0['eval']}")
    tiers = list(TIERS)
    kept: list[Task] = []
    stats: list[dict] = []
    tried = 0
    while len(kept) < n and tried < 4 * n:
        seed = seed0 + tried
        tier = tiers[tried % len(tiers)]
        tried += 1
        task = generate_task(seed, tier, kind)
        task.split = split
        ref, st = reference(task, time_limit_s)
        stats.append({"seed": seed, "tier": tier, "task_id": task.task_id, "kept": ref is not None, **st})
        if ref is not None:
            task.reference = ref
            kept.append(task)
    build_pack.last_stats = {"kept": len(kept), "tried": tried, "candidates": stats}
    return kept


build_pack.last_stats = {}


def save_jsonl(tasks: list[Task], path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        for t in tasks:
            f.write(json.dumps(t.to_dict()) + "\n")


def load_jsonl(path: str | Path) -> list[Task]:
    return [Task.from_dict(json.loads(line)) for line in Path(path).read_text().splitlines() if line.strip()]


__all__ = ["build_pack", "save_jsonl", "load_jsonl", "reference", "SEED0"]
