"""Player tools wrapping one OaklandEnv episode, and the episode's event log. The ship calls of every task are
GENERATED (not real records), and so is the AIS-shaped live feed.

One EpisodeTools is one episode: an OaklandEnv bound to one task. Two logs are kept:
- env.transcript, the env's own {t, call, args, result} list; the extra tools below are appended to the same list.
- the event log, a list of {idx, ts, type, payload, tokens_in, tokens_out, cost_usd, wall_s} events with type
  model_call | tool_call | tool_result | submit | stop. Everything that reaches the model (system prompt with the
  playbook version, tool definitions, every tool call and result, including the steering hint the check hook adds)
  can be rebuilt from it. It is written to JSONL and it is the only thing the coach reads.

The reference solver is never exposed: the only plan the tools hand out is greedy_plan, as `baseline_plan`.

    tools = EpisodeTools(tasks, index=0, playbook="...")
    tools.baseline_plan(); tools.check_plan(plan_json); tools.submit_plan(plan_json)
    tools.langchain_tools()   # the same functions as LangChain tools, for the ReAct player
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Callable

from env import MAX_CHECKS, OaklandEnv
from feed import SyntheticAIS
from oakland_core import PlanError, Task, evaluate, parse_plan, plan_to_list
from oakland_core.check import timeline
from oakland_core.solve import greedy_plan

EVENT_TYPES = ("model_call", "tool_call", "tool_result", "submit", "stop")

# steering hook: a keyword in a violation text -> words that pick the matching playbook rules
STEER_KEYWORDS: dict[str, tuple[str, ...]] = {
    "no-movement": ("no-movement", "no_moves", "no movement"),
    "pool": ("pool",),
    "hoot": ("hoot",),
    "meal": ("meal",),
    "shallow": ("shallow", "draught"),
    "overlaps": ("overlap",),
    "ships move": ("movement limit", "moves per hour", "berthings"),
    "cannot arrive": ("arrival",),
    "missing from the plan": ("every ship",),
    "moved": ("moved", "planned section"),
}
MAX_HINTS = 2


def _parse_json(plan_json: Any) -> Any:
    """A plan as JSON text (a ```json fence is fine) or an already parsed list or dict."""
    if not isinstance(plan_json, str):
        return plan_json
    text = plan_json.strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text)


def playbook_rules(playbook: str) -> list[str]:
    """The rule lines of a playbook: markdown bullets and numbered checklist items, without the marker."""
    out = []
    for line in playbook.splitlines():
        m = re.match(r"\s*(?:[-*]|\d+\.)\s+(.*\S)", line)
        if m:
            out.append(m.group(1))
    return out


def steer_hints(playbook: str, violations: list[str]) -> list[str]:
    """The one or two playbook rules whose keywords match the violation texts, in playbook order."""
    words: list[str] = []
    for v in violations:
        low = v.lower()
        for key, picks in STEER_KEYWORDS.items():
            if key in low:
                words += [w for w in picks if w not in words]
    if not words:
        return []
    hits = [r for r in playbook_rules(playbook) if any(w in r.lower() for w in words)]
    return hits[:MAX_HINTS]


class EventLog:
    """The episode's events, in order. `idx` is the event's position, which coach evidence spans point to."""

    def __init__(self) -> None:
        self.events: list[dict] = []

    def add(self, type_: str, payload: Any, tokens_in: int = 0, tokens_out: int = 0, cost_usd: float = 0.0,
            wall_s: float = 0.0) -> dict:
        if type_ not in EVENT_TYPES:
            raise ValueError(f"unknown event type {type_!r}")
        ev = {"idx": len(self.events), "ts": round(time.time(), 3), "type": type_, "payload": payload,
              "tokens_in": int(tokens_in), "tokens_out": int(tokens_out), "cost_usd": round(float(cost_usd), 6),
              "wall_s": round(float(wall_s), 3)}
        self.events.append(ev)
        return ev

    def totals(self) -> dict:
        return {"tokens_in": sum(e["tokens_in"] for e in self.events),
                "tokens_out": sum(e["tokens_out"] for e in self.events),
                "cost_usd": round(sum(e["cost_usd"] for e in self.events), 6),
                "model_calls": sum(1 for e in self.events if e["type"] == "model_call")}

    def write(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text("".join(json.dumps(e) + "\n" for e in self.events))
        tmp.replace(path)


def read_events(path: str | Path) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


class EpisodeTools:
    """The tools of one episode. `heuristic` is the coach's heuristic(task, plan) -> plan when the playbook has one."""

    def __init__(self, tasks: list[Task] | OaklandEnv, index: int, playbook: str = "", playbook_version: int = 0,
                 heuristic: Callable[[dict, list], list] | None = None, live_feed: bool = True):
        self.env = tasks if isinstance(tasks, OaklandEnv) else OaklandEnv(tasks)
        self.obs = self.env.reset(index=index)
        self.task: Task = self.env.task
        self.playbook = playbook
        self.playbook_version = playbook_version
        self.heuristic = heuristic
        self.live_feed = live_feed
        self.log = EventLog()
        self._feed: SyntheticAIS | None = None
        self.checks: list[dict] = []          # {"n", "plan", "feasible", "cost", "violations"} per check_plan
        self.submit_result: dict | None = None

    # bookkeeping

    def _transcript(self, call: str, args: dict, result: Any) -> None:
        self.env._log(call, args, result)

    def _call(self, name: str, args: dict, fn: Callable[[], Any]) -> str:
        """Run one tool: a tool_call event, the work, a tool_result event; the result goes back as JSON text."""
        self.log.add("tool_call", {"tool": name, "args": args})
        t0 = time.time()
        result = fn()
        text = result if isinstance(result, str) else json.dumps(result)
        self.log.add("tool_result", {"tool": name, "result": text}, wall_s=time.time() - t0)
        return text

    def note(self, text: str) -> None:
        """A harness note, in the transcript (for example: the player never submitted, so the harness did)."""
        self._transcript("harness_note", {}, {"note": text})

    @property
    def transcript(self) -> list[dict]:
        return self.env.transcript

    @property
    def done(self) -> bool:
        return self.env.done

    @property
    def checks_left(self) -> int:
        return MAX_CHECKS - self.env.checks_used

    def first_feasible_check(self) -> int | None:
        return next((c["n"] for c in self.checks if c["feasible"]), None)

    def best_checked_plan(self) -> list | None:
        """The cheapest plan a check found feasible, or None."""
        ok = [c for c in self.checks if c["feasible"]]
        return min(ok, key=lambda c: (c["cost"], c["n"]))["plan"] if ok else None

    def tool_definitions(self) -> list[dict]:
        """Name, description and arguments of every tool the model is offered, as logged in the first model_call."""
        out = []
        for t in self.langchain_tools():
            out.append({"name": t.name, "description": t.description, "args": t.args})
        return out

    # tools

    def get_situation(self) -> str:
        """The rules and the situation of this task: terminal, quay, ships (GENERATED calls), closures, windows."""
        return self._call("get_situation", {}, self.env.get_situation)

    def get_rules(self) -> str:
        """The rules text only: plan format, constraints, cost and the check budget."""
        def run() -> str:
            text = self.obs["rules"]
            self._transcript("get_rules", {}, {"chars": len(text)})
            return text
        return self._call("get_rules", {}, run)

    def read_playbook(self) -> str:
        """The current coach playbook: rules learned from earlier episodes and an ordered checklist."""
        def run() -> str:
            text = self.playbook or "(no playbook yet)"
            self._transcript("read_playbook", {}, {"chars": len(text), "version": self.playbook_version})
            return text
        return self._call("read_playbook", {}, run)

    def baseline_plan(self) -> str:
        """A greedy baseline plan (arrival order, as fast as possible) as plan JSON in this task's format. A start
        point to improve on; it is not the optimum and may be infeasible."""
        def run() -> str:
            plan = plan_to_list(greedy_plan(self.task), self.task.kind)
            self._transcript("baseline_plan", {}, {"plan": plan})
            return json.dumps(plan)
        return self._call("baseline_plan", {}, run)

    def check_plan(self, plan_json: str) -> str:
        """Check a plan without grading it: feasible, cost and the violation texts. At most 10 checks per episode.
        A rejected check also returns the playbook rules that match its violations."""
        def run() -> dict:
            try:
                plan = _parse_json(plan_json)
            except (json.JSONDecodeError, TypeError):
                plan = plan_json if isinstance(plan_json, str) else str(plan_json)
            out = dict(self.env.check_plan(plan))
            if "error" in out:
                return out
            rows: Any = plan
            try:
                parsed, _probs = parse_plan(self.task, plan)
                rows = plan_to_list(parsed, self.task.kind)
            except PlanError:
                pass
            self.checks.append({"n": len(self.checks) + 1, "plan": rows, "feasible": out["feasible"],
                                "cost": out["cost"], "violations": out["violations"],
                                "parse_problems": out.get("parse_problems", [])})
            if not out["feasible"]:
                texts = [v["problem"] for v in out["violations"]] + list(out.get("parse_problems") or [])
                hints = steer_hints(self.playbook, texts)
                if hints:
                    out["playbook_hint"] = hints   # the steering hook, part of the logged tool_result
            return out
        return self._call("check_plan", {"plan_json": plan_json if isinstance(plan_json, str)
                                         else json.dumps(plan_json)}, run)

    def submit_plan(self, plan_json: str) -> str:
        """Submit the final plan: graded once, ends the episode. Submit exactly once."""
        args = {"plan_json": plan_json if isinstance(plan_json, str) else json.dumps(plan_json)}
        self.log.add("tool_call", {"tool": "submit_plan", "args": args})
        try:
            plan = _parse_json(plan_json)
        except (json.JSONDecodeError, TypeError):
            plan = plan_json
        out = self.env.submit_plan(plan)
        if "error" in out:
            text = json.dumps(out)
        else:
            self.submit_result = out
            # the player sees the reward, never the optimum
            text = json.dumps({"reward": out["reward"], "feasible": out["feasible"], "cost": out["cost"],
                               "violations": out["violations"]})
        self.log.add("submit", {"tool": "submit_plan", "result": text})
        return text

    def ship_timeline(self, plan_json: str, ship_id: int) -> str:
        """Hour by hour cranes working and sections occupied for one ship under a plan, with its departure, due
        hour and hours late. Uses no check."""
        args = {"plan_json": plan_json if isinstance(plan_json, str) else json.dumps(plan_json), "ship_id": ship_id}

        def run() -> dict:
            try:
                parsed, _probs = parse_plan(self.task, _parse_json(plan_json))
                sid = int(ship_id)
                ship = self.task.ship(sid)
                res = next(r for r in evaluate(self.task, parsed).ships if r.ship == sid)
                rows = timeline(self.task, parsed).get(sid, [])
                first = res.section
                secs = f"{first}-{first + ship.sections - 1}" if first is not None else None
                out = {"ship": sid, "name": ship.name, "berth_hour": res.berth_hour, "sections": secs,
                       "departure": res.departure, "due": ship.due, "late_h": res.delay_h,
                       "hours": [{"hour": t, "cranes": c, "shift": self.task.shift_of(t)} for t, c in rows],
                       "problems": list(res.problems)}
            except (PlanError, ValueError, KeyError, IndexError, TypeError, StopIteration) as e:
                out = {"error": f"could not build the timeline: {e}"}
            self._transcript("ship_timeline", args, out)
            return out
        return self._call("ship_timeline", args, run)

    def live_ships(self, hour: float) -> str:
        """The live AIS-shaped feed at an hour of the week (hour 0 = Monday 00:00 Pacific): every ship's position,
        speed, nav status and ETA, plus the eta_update events issued by then. Positions are GENERATED."""
        def run() -> dict:
            if self._feed is None:
                self._feed = SyntheticAIS(self.task)
            h = float(hour)
            out = {"hour": h, "positions": self._feed.positions(h), "events": self._feed.events(h)}
            self._transcript("live_ships", {"hour": h}, out)
            return out
        return self._call("live_ships", {"hour": hour}, run)

    def apply_heuristic(self, plan_json: str) -> str:
        """Run the coach's learned heuristic on a plan and return the improved plan JSON. Uses no check."""
        args = {"plan_json": plan_json if isinstance(plan_json, str) else json.dumps(plan_json)}

        def run() -> Any:
            if self.heuristic is None:
                out: Any = {"error": "the current playbook has no heuristic"}
            else:
                try:
                    plan = self.heuristic(self.task.to_dict(public=True), _parse_json(plan_json))
                    parsed, _probs = parse_plan(self.task, plan)
                    out = plan_to_list(parsed, self.task.kind)
                except Exception as e:   # coach code is untrusted: report, never crash the episode
                    out = {"error": f"heuristic failed: {type(e).__name__}: {e}"}
            self._transcript("apply_heuristic", args, out)
            return out
        return self._call("apply_heuristic", args, run)

    # LangChain

    def names(self) -> list[str]:
        out = ["get_situation", "get_rules", "read_playbook", "baseline_plan", "check_plan", "submit_plan",
               "ship_timeline"]
        if self.live_feed:
            out.append("live_ships")
        if self.heuristic is not None:
            out.append("apply_heuristic")
        return out

    def langchain_tools(self) -> list:
        """The tools as LangChain StructuredTools bound to this episode."""
        from langchain_core.tools import StructuredTool

        return [StructuredTool.from_function(getattr(self, n), name=n) for n in self.names()]
