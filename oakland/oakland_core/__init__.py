"""OaklandPortEnv: berth and crane planning at the Port of Oakland. Terminal geometry, crane fleets, depths and ILWU
shifts are real; the ship calls are GENERATED from the services that call Oakland, not real records.

The solver-side names (generate_task, solve, naive_plan, greedy_plan, build_pack, render) live in modules built
separately; they are imported lazily so the kernel imports cleanly without them."""

from importlib import import_module

from .check import PlanResult, ShipResult, evaluate, plan_cost, timeline, unavoidable_cost
from .model import (MEAL_HOURS, MOVE_PENALTY, SHIFTS, Block, CraneEntry, Plan, PlanError, Ship, Task, parse_plan,
                    plan_from_list, plan_to_list)
from .prompts import BERTH_PLAN_FORMAT, CRANE_PLAN_FORMAT, PROMPT_VERSION, brief, rules, situation
from .replay import replay
from .reward import Grade, grade, score_v3
from .world import SERVICES, TERMINALS, crane_class, generate_calls, hoot_pool, make_task

_LAZY = {
    "generate_task": "generate",
    "solve": "solve",
    "naive_plan": "solve",
    "greedy_plan": "solve",
    "build_pack": "pack",
    "render": "render",
}


def __getattr__(name: str):
    mod = _LAZY.get(name)
    if mod is None:
        raise AttributeError(f"module 'oakland_core' has no attribute {name!r}")
    try:
        return getattr(import_module(f".{mod}", __name__), name)
    except ImportError as e:
        raise AttributeError(f"oakland_core.{name} is not available: {e}") from e


__all__ = ["BERTH_PLAN_FORMAT", "Block", "CRANE_PLAN_FORMAT", "CraneEntry", "Grade", "MEAL_HOURS", "MOVE_PENALTY",
           "PROMPT_VERSION", "Plan", "PlanError", "PlanResult", "SERVICES", "SHIFTS", "Ship", "ShipResult", "TERMINALS",
           "Task", "brief", "build_pack", "crane_class", "evaluate", "generate_calls", "generate_task", "grade",
           "greedy_plan", "hoot_pool", "make_task", "naive_plan", "parse_plan", "plan_cost", "plan_from_list",
           "plan_to_list", "render", "replay", "rules", "score_v3", "situation", "solve", "timeline",
           "unavoidable_cost"]
