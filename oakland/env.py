"""OaklandEnv: play one OaklandPortEnv task at a time through the three agent tools.

An episode is one task (one Port of Oakland terminal over one or two weeks). The agent reads the rules and the
situation, may check up to MAX_CHECKS plans (violations and cost, never a reward), then submits one plan, which is
graded once and ends the episode. Ship calls in every task are GENERATED (not real records); the terminal geometry,
crane fleets, berth depths and ILWU shifts are real.

    from env import OaklandEnv
    env = OaklandEnv("tasks/berth-eval.jsonl")
    obs = env.reset(index=0)
    print(obs["rules"], obs["situation"])
    env.check_plan('[{"ship": 0, "berth_hour": 12, "section": 7, "cranes": 3}]')
    grade = env.submit_plan(plan)

Plans are accepted as a JSON string (a ```json fence is fine) or as an already parsed list or dict, in the plan
format of the task's kind (see the rules text). Standard library only, apart from the oakland_core package.
"""

from __future__ import annotations

import dataclasses
import gzip
import json
import time
from pathlib import Path
from typing import Any

import oakland_core
from oakland_core import PlanError, Task, evaluate, grade, parse_plan, plan_to_list, rules, situation

MAX_CHECKS = 10


def load_tasks(path: str | Path) -> list[Task]:
    """Tasks from a .jsonl (or .jsonl.gz) file, one Task.to_dict() per line."""
    path = Path(path)
    raw = path.read_bytes()
    body = gzip.decompress(raw) if path.suffix == ".gz" else raw
    return [Task.from_dict(json.loads(line)) for line in body.decode().splitlines() if line.strip()]


def _rules_text(task: Task) -> str:
    try:
        return rules(task, MAX_CHECKS)
    except TypeError:
        return rules(task)


def _as_dict(obj: Any) -> dict:
    if hasattr(obj, "as_dict"):
        return obj.as_dict()
    if dataclasses.is_dataclass(obj):
        return dataclasses.asdict(obj)
    return dict(obj)


def _jsonable(raw: Any) -> Any:
    """The plan as sent, kept for the transcript and the replay (strings stay strings)."""
    try:
        json.dumps(raw)
        return raw
    except (TypeError, ValueError):
        return repr(raw)


class OaklandEnv:
    """One episode at a time over a fixed list of tasks. Deterministic: the same calls give the same results, and
    nothing carries over from one episode to the next except the task list."""

    def __init__(self, tasks: list[Task] | list[dict] | str | Path):
        if isinstance(tasks, (str, Path)):
            tasks = load_tasks(tasks)
        self.tasks: list[Task] = [t if isinstance(t, Task) else Task.from_dict(t) for t in tasks]
        if not self.tasks:
            raise ValueError("OaklandEnv needs at least one task")
        self._by_id = {t.task_id: t for t in self.tasks}
        self.task: Task | None = None
        self.checks_used = 0
        self.done = False
        self.result: dict | None = None
        self.submitted_plan: Any = None
        self.transcript: list[dict] = []
        self._plan = None

    # task list

    def task_list(self) -> list[dict]:
        """What GET /tasks shows: no references, no plans."""
        return [{"task_id": t.task_id, "kind": getattr(t, "kind", "berth"), "difficulty": t.difficulty,
                 "terminal": t.terminal, "split": t.split, "ships": len(t.ships)} for t in self.tasks]

    def _pick(self, task_id: str | None, index: int | None, split: str | None) -> Task:
        if task_id is not None:
            if task_id not in self._by_id:
                raise KeyError(f"unknown task_id {task_id!r}")
            return self._by_id[task_id]
        pool = [t for t in self.tasks if t.split == split] if split is not None else self.tasks
        if not pool:
            raise KeyError(f"no tasks in split {split!r}")
        i = 0 if index is None else int(index)
        if not 0 <= i < len(pool):
            raise IndexError(f"index {i} out of range (0-{len(pool) - 1})")
        return pool[i]

    # episode

    def _log(self, call: str, args: dict, result: Any) -> None:
        self.transcript.append({"t": round(time.time(), 3), "call": call, "args": args, "result": result})

    def reset(self, task_id: str | None = None, index: int | None = None, split: str | None = None) -> dict:
        """Start an episode. Pick the task by id, or by index (within `split` when given); default the first."""
        self.task = self._pick(task_id, index, split)
        self.checks_used = 0
        self.done = False
        self.result = None
        self.submitted_plan = None
        self._plan = None
        self.transcript = []
        obs = {
            "task_id": self.task.task_id,
            "kind": getattr(self.task, "kind", "berth"),
            "terminal": self.task.terminal,
            "difficulty": self.task.difficulty,
            "rules": _rules_text(self.task),
            "situation": situation(self.task),
            "checks_left": MAX_CHECKS,
        }
        self._log("reset", {"task_id": task_id, "index": index, "split": split}, {"task_id": self.task.task_id})
        return obs

    def _error(self, call: str, args: dict, message: str) -> dict:
        out = {"error": message, "checks_left": MAX_CHECKS - self.checks_used}
        self._log(call, args, out)
        return out

    def _closed(self) -> str | None:
        if self.task is None:
            return "no episode: call reset() first"
        if self.done:
            return "the episode has ended (a plan was submitted): call reset() to start another"
        return None

    def get_situation(self) -> str:
        """The rules text and the situation text, the same the agent got at reset."""
        if self.task is None:
            raise RuntimeError("no episode: call reset() first")
        text = _rules_text(self.task) + "\n\n" + situation(self.task)
        self._log("get_situation", {}, {"chars": len(text)})
        return text

    def check_plan(self, plan: Any) -> dict:
        """Violations and cost of a plan, without grading it. At most MAX_CHECKS per episode; never a reward."""
        args = {"plan": _jsonable(plan)}
        closed = self._closed()
        if closed:
            return self._error("check_plan", args, closed)
        if self.checks_used >= MAX_CHECKS:
            return self._error("check_plan", args, f"no checks left ({MAX_CHECKS} per episode): submit_plan now")
        self.checks_used += 1
        try:
            parsed, problems = parse_plan(self.task, plan)
        except PlanError as e:
            out = {"feasible": False, "cost": None, "violations": [], "parse_problems": [str(e)],
                   "checks_left": MAX_CHECKS - self.checks_used}
            self._log("check_plan", args, out)
            return out
        res = evaluate(self.task, parsed)
        feasible = bool(res.feasible) and not problems
        out = {"feasible": feasible, "cost": res.cost if feasible else None,
               "violations": [{"ship": v["ship"], "problem": v["problem"]} for v in res.violations],
               "parse_problems": list(problems), "checks_left": MAX_CHECKS - self.checks_used}
        self._log("check_plan", args, out)
        return out

    def submit_plan(self, plan: Any) -> dict:
        """Grade the plan once and end the episode. A plan that cannot be read scores 0."""
        args = {"plan": _jsonable(plan)}
        closed = self._closed()
        if closed:
            return self._error("submit_plan", args, closed)
        try:
            parsed, problems = parse_plan(self.task, plan)
        except PlanError as e:
            parsed, problems = {}, [str(e)]
        g = _as_dict(grade(self.task, parsed, problems))
        out = {
            "task_id": self.task.task_id,
            "reward": g["reward"],
            "feasible": g["feasible"],
            "cost": g["cost"],
            "optimal_cost": g["optimal_cost"],
            "naive_cost": g["naive_cost"],
            "violations": g["violations"],
            "parse_problems": g["parse_problems"],
            "checks_used": self.checks_used,
        }
        for k, v in g.items():
            out.setdefault(k, v)
        self.done = True
        self.result = out
        self.submitted_plan = plan_to_list(parsed) if parsed else args["plan"]
        self._plan = parsed
        self._log("submit_plan", args, out)
        return out

    def replay(self) -> dict:
        """The replay JSON of the submitted plan (oakland_core.replay), what the 3D viewer loads."""
        if self.task is None or not self.done:
            return {"error": "nothing submitted yet: replay is available after submit_plan"}
        fn = getattr(oakland_core, "replay", None)
        if fn is None:
            return {"error": "this oakland_core has no replay()"}
        return fn(self.task, self._plan)
