"""The terminal reward, from a submitted plan and the task's stored optimum (PortSim's reward v3, unchanged).

    unreadable or infeasible   0.2 x (ships with no violation / all ships)                      in [0, 0.2)
    feasible                   0.2 + 0.8 x exp(-g / 0.5),
                               g = (cost - optimum) / (optimum - floor + gap_k)                 in (0.2, 1]

`optimum` is the CP-SAT optimum stored with the task, `floor` is check.unavoidable_cost (each ship alone with the most
cranes it can take) and gap_k is 100. Any feasible plan beats any infeasible one.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

from .check import evaluate, unavoidable_cost
from .model import Plan, Task

INFEASIBLE_CAP = 0.2
GAP_TAU = 0.5


@dataclass
class Grade:
    reward: float
    feasible: bool
    clean_fraction: float      # ships with no violation / all ships
    quality: float             # exp(-g / 0.5): 1 at the optimum (0 when infeasible)
    cost: int | None
    delay_cost: int | None
    moves: int | None
    naive_cost: int
    optimal_cost: int
    violations: list[dict]
    parse_problems: list[str]

    def as_dict(self) -> dict:
        return asdict(self)


def score_v3(cost: int | None, feasible: bool, clean_fraction: float, optimum: int, gap_k: int,
             unavoidable: int = 0) -> tuple[float, float]:
    """Reward v3: the gap to the proven optimum, measured against the part of the cost a planner controls (the
    optimum minus a provable floor; check.unavoidable_cost).

        infeasible   0.2 x clean fraction                                                in [0, 0.2)
        feasible     0.2 + 0.8 x exp(-g / 0.5),  g = (cost - optimum) / (optimum - floor + gap_k)   in (0.2, 1]

    At or below the stored optimum scores 1.0. With the optimum 120 above its floor (gap_k 100), a plan 22 above the
    optimum scores 0.86, 110 above 0.49, 220 above 0.31."""
    if not feasible or cost is None:
        return INFEASIBLE_CAP * clean_fraction, 0.0
    g = max(0, cost - optimum) / (max(0, optimum - unavoidable) + gap_k)
    quality = math.exp(-g / GAP_TAU)
    return INFEASIBLE_CAP + (1.0 - INFEASIBLE_CAP) * quality, quality


score = score_v3


def grade(task: Task, plan: Plan, parse_problems: list[str] | None = None) -> Grade:
    """Grade a plan. Without a stored optimum (a task not yet solved) the floor stands in for it."""
    ref = task.reference
    floor = unavoidable_cost(task)
    optimum = int(ref["optimal_cost"]) if ref.get("optimal_cost") is not None else floor
    naive = int(ref["naive_cost"]) if ref.get("naive_cost") is not None else optimum
    res = evaluate(task, plan)
    problems = list(parse_problems or [])
    feasible = res.feasible and not problems
    # entry problems (duplicates, unknown ships, bad values) count as unclean units, so a malformed plan always
    # stays strictly below the 0.2 floor of a feasible one
    clean = sum(1 for r in res.ships if not r.problems) / max(1, len(res.ships) + len(problems))
    reward, quality = score_v3(res.cost, feasible, clean, optimum, int(task.rules.get("gap_k", 100)), floor)
    return Grade(round(reward, 6), feasible, round(clean, 4), round(quality, 6), res.cost if feasible else None,
                 res.delay_cost if feasible else None, res.moves if feasible else None, naive, optimum,
                 res.violations, problems)
