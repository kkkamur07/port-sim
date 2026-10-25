"""The Player: plays one OaklandPortEnv episode through the tools in loop/tools.py. The ship calls of every task are
GENERATED (not real records).

Two players share one tool protocol, so their event logs have the same shape:
- GeminiPlayer: a LangGraph ReAct agent (create_react_agent) on ChatGoogleGenerativeAI(model="gemini-4-argon").
  Every model call is logged as a model_call event with the messages it saw, its tokens, wall time and an estimated
  cost. Constructing the client needs ALLOW_MODEL_REQUESTS=1 (tests leave it off, so any attempt raises).
- ScriptedPlayer: deterministic, no network. It reads the situation and the playbook, takes the greedy baseline,
  applies the playbook rules it recognises, checks, repairs from the violation texts, and submits once. With
  `mistakes=True` it berths one ship inside a no-movement window on its first check, unless the playbook already has
  the no-movement rule, so the coach has something to fix.

run_episode() is the harness around either player: it builds the tools, logs the system prompt and the tool
definitions, runs the player, submits for it when it never did (best feasible checked plan, else the baseline, and
says so), then grades, writes the replay and closes the event log with a stop event that carries the grade and the
port metrics (the coach reads those; the player never sees the optimum).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Callable

from env import MAX_CHECKS
from oakland_core import Task

from .metrics import summary
from .tools import EpisodeTools

MODEL_ID = "gemini-4-argon"
TEMPERATURE = 0.2
# estimated prices in USD per million tokens (override with OAK_PRICE_IN / OAK_PRICE_OUT)
PRICE_IN_PER_M = float(os.environ.get("OAK_PRICE_IN", "1.25"))
PRICE_OUT_PER_M = float(os.environ.get("OAK_PRICE_OUT", "10.0"))
RECURSION_LIMIT = 4 * (MAX_CHECKS + 6) + 1   # two graph steps per tool round, room for reading tools

NO_MOVES_RULE_WORDS = ("no-movement", "no_moves", "no movement")
PLANNED_RULE_WORDS = ("planned section",)


class ModelRequestsDisabled(RuntimeError):
    """Raised when a Gemini client is constructed while ALLOW_MODEL_REQUESTS is off."""


def api_key() -> str | None:
    """The Google API key from the environment (never printed or logged)."""
    return os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY") or None


def model_requests_allowed() -> bool:
    return os.environ.get("ALLOW_MODEL_REQUESTS", "0").strip().lower() in ("1", "true", "yes", "on")


def ChatGoogleGenerativeAI(*args: Any, **kwargs: Any) -> Any:   # noqa: N802, replaced by the real class on first use
    from langchain_google_genai import ChatGoogleGenerativeAI as real

    return real(*args, **kwargs)


def make_model(temperature: float = TEMPERATURE) -> Any:
    """The Gemini 4 Argon chat model. Raises ModelRequestsDisabled unless ALLOW_MODEL_REQUESTS is on."""
    if not model_requests_allowed():
        raise ModelRequestsDisabled("ALLOW_MODEL_REQUESTS is off: no Gemini client may be constructed")
    kwargs: dict[str, Any] = {"model": MODEL_ID, "temperature": temperature}
    key = api_key()
    if key:
        kwargs["google_api_key"] = key
    return ChatGoogleGenerativeAI(**kwargs)


def estimate_cost(tokens_in: int, tokens_out: int) -> float:
    return tokens_in / 1e6 * PRICE_IN_PER_M + tokens_out / 1e6 * PRICE_OUT_PER_M


def player_version(model_id: str) -> str:
    """Hash over player.py, tools.py and the model id: the player is frozen while playbooks are compared."""
    here = Path(__file__).parent
    h = hashlib.sha256()
    for name in ("player.py", "tools.py"):
        h.update((here / name).read_bytes())
    h.update(model_id.encode())
    return h.hexdigest()[:12]


def system_prompt(tools: EpisodeTools) -> str:
    """The task's rules text, the playbook (with its version) and the episode budget."""
    playbook = tools.playbook.strip() or "(no playbook yet)"
    return (f"{tools.obs['rules']}\n\n"
            f"## Playbook v{tools.playbook_version} (rules learned from earlier episodes)\n\n{playbook}\n\n"
            f"You have at most {MAX_CHECKS} checks (check_plan); submit exactly once (submit_plan). Call "
            f"get_situation first. The ship calls are GENERATED, not real records.")


def _has_rule(playbook: str, words: tuple[str, ...]) -> bool:
    low = playbook.lower()
    return any(w in low for w in words)


# ---------------------------------------------------------------- scripted player

class ScriptedPlayer:
    """Deterministic tool calls: situation, playbook, live feed, baseline, playbook rules, check, repair, submit."""

    model_id = "scripted"

    def __init__(self, mistakes: bool = False):
        self.mistakes = mistakes

    def _mistake(self, task: Task, rows: list[dict]) -> list[dict]:
        """Berth one ship at the start of a no-movement window it could otherwise use."""
        for row in rows:
            s = task.ship(row["ship"])
            for a, b in task.no_move_windows(s):
                if a >= s.arrival and a < task.horizon_h:
                    out = [dict(r) for r in rows]
                    out[rows.index(row)]["berth_hour"] = a
                    return out
        return rows

    def _planned_sections(self, tools: EpisodeTools, rows: list[dict]) -> list[dict]:
        """Move scheduled ships back to their planned section one at a time, keeping a move only when
        ship_timeline reports no problem for that ship (no check used)."""
        task = tools.task
        rows = [dict(r) for r in rows]
        for i, row in enumerate(rows):
            s = task.ship(row["ship"])
            if s.planned_section is None or row["section"] == s.planned_section:
                continue
            trial = [dict(r) for r in rows]
            trial[i]["section"] = s.planned_section
            res = json.loads(tools.ship_timeline(json.dumps(trial), s.id))
            if not res.get("error") and not res.get("problems"):
                rows = trial
        return rows

    @staticmethod
    def _repair(task: Task, rows: list[dict], violations: list[dict]) -> list[dict] | None:
        """Fix the violations the scripted player knows how to read: a berth inside a no-movement window moves to
        the window's end. None when nothing could be repaired."""
        out = [dict(r) for r in rows]
        changed = False
        for v in violations:
            m = re.search(r"inside the no-movement window (\d+)-(\d+)", v.get("problem", ""))
            if m and v.get("ship") is not None:
                for r in out:
                    if r["ship"] == v["ship"]:
                        r["berth_hour"] = int(m.group(2))
                        changed = True
        return out if changed else None

    def play(self, tools: EpisodeTools) -> None:
        tools.get_situation()
        tools.read_playbook()
        if tools.live_feed:
            tools.live_ships(0)
        rows = json.loads(tools.baseline_plan())
        if tools.heuristic is not None:
            got = json.loads(tools.apply_heuristic(json.dumps(rows)))
            if isinstance(got, list):
                rows = got
        task = tools.task
        if task.kind == "berth" and _has_rule(tools.playbook, PLANNED_RULE_WORDS):
            rows = self._planned_sections(tools, rows)
        clean = rows
        if self.mistakes and task.kind == "berth" and not _has_rule(tools.playbook, NO_MOVES_RULE_WORDS):
            rows = self._mistake(task, rows)
        res = json.loads(tools.check_plan(json.dumps(rows)))
        if not res.get("feasible") and tools.checks_left > 0:
            fixed = self._repair(task, rows, res.get("violations") or [])
            if fixed is not None:
                res = json.loads(tools.check_plan(json.dumps(fixed)))
            if not res.get("feasible") and clean is not rows and tools.checks_left > 0:
                tools.check_plan(json.dumps(clean))
        best = tools.best_checked_plan()
        tools.submit_plan(json.dumps(best if best is not None else clean))


# ---------------------------------------------------------------- Gemini player

def model_call_logger(tools: EpisodeTools, model_id: str) -> Any:
    """A LangChain callback handler: one model_call event per chat model call (messages, tokens, wall, cost)."""
    from langchain_core.callbacks import BaseCallbackHandler
    from langchain_core.messages import messages_to_dict

    class Handler(BaseCallbackHandler):
        def __init__(self) -> None:
            self.starts: dict[Any, tuple[float, list]] = {}

        def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):   # noqa: ANN001
            flat = [m for batch in messages for m in batch]
            self.starts[run_id] = (time.time(), messages_to_dict(flat))

        def on_llm_end(self, response, *, run_id, **kwargs):   # noqa: ANN001
            t0, msgs = self.starts.pop(run_id, (time.time(), []))
            tin = tout = 0
            reply: Any = None
            for gen in response.generations:
                for g in gen:
                    msg = getattr(g, "message", None)
                    usage = getattr(msg, "usage_metadata", None) or {}
                    tin += int(usage.get("input_tokens", 0))
                    tout += int(usage.get("output_tokens", 0))
                    if msg is not None:
                        reply = messages_to_dict([msg])[0]
            tools.log.add("model_call", {"model": model_id, "messages": msgs, "reply": reply},
                          tokens_in=tin, tokens_out=tout, cost_usd=estimate_cost(tin, tout),
                          wall_s=time.time() - t0)

    return Handler()


class GeminiPlayer:
    """A ReAct agent on Gemini 4 Argon over the episode tools."""

    model_id = MODEL_ID

    def __init__(self, temperature: float = TEMPERATURE):
        self.temperature = temperature

    def play(self, tools: EpisodeTools) -> None:
        from langgraph.errors import GraphRecursionError
        from langgraph.prebuilt import create_react_agent

        model = make_model(self.temperature)
        agent = create_react_agent(model, tools.langchain_tools(), prompt=system_prompt(tools))
        handler = model_call_logger(tools, self.model_id)
        try:
            agent.invoke({"messages": [("user", "Plan this task: read the situation, check plans, submit once.")]},
                         config={"recursion_limit": RECURSION_LIMIT, "callbacks": [handler]})
        except GraphRecursionError:
            tools.note(f"the player hit the recursion limit ({RECURSION_LIMIT} steps)")


# ---------------------------------------------------------------- harness

def run_episode(tasks: list[Task], index: int, player: Any, playbook: str, playbook_version: int,
                heuristic: Callable | None = None, live_feed: bool = True,
                events_path: str | Path | None = None, replay_path: str | Path | None = None) -> dict:
    """Play one episode, submit for the player if it never did, grade, write the replay and the event log."""
    tools = EpisodeTools(tasks, index, playbook=playbook, playbook_version=playbook_version, heuristic=heuristic,
                         live_feed=live_feed)
    tools.log.add("model_call", {"model": player.model_id, "role": "system", "playbook_version": playbook_version,
                                 "system_prompt": system_prompt(tools), "tools": tools.tool_definitions()})
    t0 = time.time()
    submitted_by = "player"
    try:
        player.play(tools)
    except Exception as e:   # a failed model call must not lose the episode
        tools.note(f"the player stopped with {type(e).__name__}: {e}")
        if isinstance(e, ModelRequestsDisabled):
            raise
    if not tools.done:
        best = tools.best_checked_plan()
        if best is not None:
            why, plan = "the player never submitted: the harness submits its best feasible checked plan", best
        else:
            why, plan = ("the player never submitted and no check was feasible: the harness submits the baseline",
                         json.loads(tools.baseline_plan()))
        tools.note(why)
        submitted_by = "harness"
        tools.submit_plan(json.dumps(plan))
    grade = tools.env.result
    replay = tools.env.replay()
    metrics = summary(replay)
    totals = tools.log.totals()
    wall = time.time() - t0
    tools.log.add("stop", {"reason": "submitted" if submitted_by == "player" else "harness_submit",
                           "task_id": tools.task.task_id, "kind": tools.task.kind,
                           "reward": grade["reward"], "feasible": grade["feasible"], "cost": grade["cost"],
                           "optimal_cost": grade["optimal_cost"], "gap_pct": metrics["gap_pct"],
                           "checks_used": tools.env.checks_used, "first_feasible_check": tools.first_feasible_check(),
                           "violations": grade["violations"], "metrics": metrics,
                           "late_ships": [{"ship": s["id"], "name": s["name"], "late_h": s["late_h"],
                                           "departure": s["departure"], "due": s["due"]}
                                          for s in replay["ships"] if (s.get("late_h") or 0) > 0]},
                  wall_s=wall)
    if events_path is not None:
        tools.log.write(events_path)
    if replay_path is not None:
        p = Path(replay_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(replay))
    return {"task_id": tools.task.task_id, "kind": tools.task.kind, "task_index": index,
            "reward": grade["reward"], "feasible": grade["feasible"], "cost": grade["cost"],
            "optimal_cost": grade["optimal_cost"], "gap_pct": metrics["gap_pct"],
            "checks_used": tools.env.checks_used, "first_feasible_check": tools.first_feasible_check(),
            "submitted_by": submitted_by, "metrics": metrics, "wall_s": round(wall, 3), **totals,
            "events": tools.log.events}
