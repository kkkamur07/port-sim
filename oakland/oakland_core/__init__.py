"""OaklandPortEnv: berth and crane planning at the Port of Oakland. Terminal geometry, crane fleets, depths and ILWU
shifts are real; the ship calls are GENERATED from the services that call Oakland, not real records.

The solver-side names (generate_task, solve, naive_plan, greedy_plan, build_pack, render) live in modules built
separately; they are imported eagerly when their dependencies (ortools, matplotlib) are installed, and lazily
otherwise, so the kernel imports cleanly without them. The module attributes are always the functions, never the
submodules of the same name."""

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


for _name, _mod in _LAZY.items():
    try:
        globals()[_name] = getattr(import_module(f".{_mod}", __name__), _name)
    except ImportError:
        # Importing a sibling may have bound the submodule under a function's name; drop it so the lazy
        # __getattr__ below reports the missing dependency instead.
        if not callable(globals().get(_name)):
            globals().pop(_name, None)
del _name, _mod


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
