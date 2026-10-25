"""Grade a model's text against a task with the PortSimEnv checker. No solver, no judge."""
from __future__ import annotations

import json
from typing import Any

import portsim  # noqa: F401  (sys.path shim)
from berth_core import PlanError, Task, grade, parse_plan


def load_task(task_json: str | dict) -> Task:
    d = json.loads(task_json) if isinstance(task_json, str) else task_json
    return Task.from_dict(d)


def grade_text(task: Task, text: str) -> dict[str, Any]:
    """Parse whatever the model wrote and grade it. Unparseable -> reward 0 with the parse error."""
    text = (text or "").strip()
    # drop a <think>...</think> block if one slipped through
    if "</think>" in text:
        text = text.split("</think>", 1)[1].strip()
    try:
        plan, problems = parse_plan(task, text)
    except PlanError as e:
        return {"reward": 0.0, "feasible": False, "submitted": False, "cost": None, "quality": 0.0,
                "clean_fraction": 0.0, "violations": [], "parse_problems": [str(e)],
                "naive_cost": task.reference["naive_cost"], "optimal_cost": task.reference["optimal_cost"]}
    g = grade(task, plan, problems).as_dict()
    g["submitted"] = True
    return g


def grade_plan(task: Task, plan_rows: list[dict]) -> dict[str, Any]:
    return grade_text(task, json.dumps(plan_rows))
