"""The operator chat agent: a LangGraph ReAct agent (create_react_agent) on the player's Gemini 4 Argon wrapper
(loop.player.make_model, so the ALLOW_MODEL_REQUESTS guard holds) over the RunTools of one run.

    agent = ChatAgent("runs/live")                       # Gemini, needs ALLOW_MODEL_REQUESTS=1 and a key
    agent = ChatAgent("runs/live", model=FakeModel())    # offline, scripted
    agent.ask([{"role": "user", "content": "Are you improving?"}], episode=7, hour=40)
    -> {answer, steps, links, what_if, tokens_in, tokens_out, cost_usd} (+ proposal, + plan after make_plan or
       route_ship: {replay, cost, optimum, feasible, violations}, the replay path relative to the run directory)
"""

from __future__ import annotations

import contextvars
import json
import re
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, TimeoutError as FutureTimeout, wait
from pathlib import Path
from typing import Any

from loop.player import MODEL_ID, estimate_cost, make_model

from .tools import RunTools

TEMPERATURE = 0.3
SHORT_PROMPT = ("You are the operator of the Port of Oakland berth plans in this demo (generated ship calls). Answer the "
                "question in two to four plain sentences in first person, using only the numbers in the data. Never "
                "write 'I cannot' or 'I do not have': say what the data shows and the nearest thing it answers. The "
                "first sentence answers the question itself. Nothing is trained: only the playbook text changes. For a "
                "what-if, compare the hour asked with the ship's arrival and berth and say whether it could work.")
RECURSION_LIMIT = 25
DEADLINE_S = 25   # past this the agent stops calling tools and answers from what it has
RACE_S = 25       # past this a one-shot backup answer (no tools) races the agent; the first to finish is used
HARD_S = 40       # past this (both stalled) the answer is built in code from the overview digest
MAX_SENTENCES = 4
ROUTES = [   # (pattern on the question, the tools that answer it), first match wins; a hint, the model may differ
    (r"optimi[sz]e (my |the )?playbook", ["optimize_playbook"]),
    (r"did it work|^result\b", ["proposal_status"]),
    (r"\broute\b|\bmove\b.*\bto section\b", ["route_ship"]),
    (r"\b(make|create|build|optimi[sz]e)\b.*\b(schedule|plan)\b|best schedule", ["make_plan"]),
    (r"what would happen|what if", ["what_if"]),
    (r"\bwhy is\b.*\blate\b|which ships are late|\blate ships\b", ["late_ships"]),
    (r"how much does an? episode cost|\bcost\b.*\b(dollar|usd|money|model)\b", ["run_status", "episode"]),
    (r"cost against the best|plan cost|how is the port|happening|right now|cranes are working|next ship|"
     r"which terminal", ["port_status"]),
    (r"\bcoach\b", ["coach_round"]),
    (r"changed last|what changed", ["coach_round"]),
    (r"\bimprov", ["improvement"]),
    (r"\btrained\b|\btraining\b", ["improvement"]),
    (r"crane assignment|rules do you follow|\bcrane rules?\b", ["playbook", "reward_rules"]),
    (r"\bplaybook\b", ["playbook"]),
    (r"\breward\b|\boptimum\b", ["reward_rules"]),
    (r"compare episode", ["episode"]),
    (r"\bepisode \d+\b", ["episode"]),
    (r"differently|next time|lesson", ["episode", "coach_round"]),
    (r"how many ships", ["episode"]),
]
SYSTEM_PROMPT = (
    "You are the Gemini Argon operator of the Port of Oakland berth plans in this demo. Speak in first person, "
    "plainly, two to four sentences, numbers from tools only, cite episode numbers and playbook versions. Nothing is "
    "trained; only your playbook changes between episodes. If a tool returns no data, say so.\n\n"
    "Always call at least one tool before answering. Ship calls are generated, not real records. For 'how is the "
    "port doing', 'what is happening' or 'right now' call port_status (it defaults to the episode and hour on "
    "screen), then late_ships if a ship is late; for 'which ships are late' or 'why is X late' call late_ships. "
    "Answer those as an operator at the quay: who is alongside, who waits, who is late and by how much, cranes in "
    "use of the pool, plan cost against the best possible. Talk about the run (episodes, rewards, playbooks) only "
    "when asked about the run, learning or improvement, and never quote model cost in dollars unless asked. For a "
    "what-if question call what_if; for 'are you improving' call improvement; for the coach call coach_round (no "
    "version: the latest round).\n\n"
    "You can make schedules. For 'route ship X to section Y (at hour H)' call route_ship; for 'create', 'optimize' "
    "or 'plan' a schedule call make_plan (pins for any ship the user fixes). Answer as the operator: what the new "
    "schedule costs against the plan I played and against the best possible, whether it is feasible (name the first "
    "violation if not), one sentence on what moved, and that it can be shown in 3D. Never say you cannot create a "
    "schedule.\n\n"
    "When no specific tool fits the question, call overview first and answer from it. If the question is about "
    "something the twin does not model (weather forecasts, real vessel names, money the port earns), say in one "
    "sentence what the twin does not model and answer the nearest thing it does. For 'this ship', 'it' or 'here' "
    "with no ship named, call ship with no arguments: it uses the ship selected in the viewer, else the most late "
    "ship, and then say which ship you picked. Never write 'I cannot', 'I don't have' or 'I only': say what you can "
    "and do it.\n\n"
    "For 'optimize my playbook' call optimize_playbook once and answer in exactly two sentences: \"Okay, I optimized "
    "this: <the rule in plain words, under 20 words>.\" and \"I am checking it on the held-out tasks now; the result "
    "will appear here.\" No diagnosis essay, no ids, no minutes unless asked. For 'did it work?' or 'result?' call "
    "proposal_status and answer in one sentence with the before and after numbers and the verdict word.\n\n"
    "Be quick: one or two tool calls answer almost every question; the message may name the tools to use, call those "
    "first (several in one turn when they are independent) and add another only if they return nothing useful. Keep "
    "each sentence under 35 words and give at most three numbers per sentence. A ship name the line reuses (two "
    "MAUNA HALE calls) means the selected ship, else the most late one: say its id. For 'how much does an episode "
    "cost' give both: the plan cost of the episode on screen against the best possible, and the model cost per "
    "episode in dollars from run_status. For 'what would you do differently' name one concrete change from the "
    "episode's mistakes and the coach's diagnosis, without new tools beyond those.")
PROPOSAL_TOOLS = ("optimize_playbook", "verify_proposal", "proposal_status")
PROPOSAL_KEYS = ("id", "status", "change", "baseline_eval_mean", "eval_mean", "verdict_reason")


def route(question: str) -> list[str]:
    """The tools that answer a question, by ROUTES (empty: no route, the model picks, overview first)."""
    q = question.lower()
    return next((tools for pat, tools in ROUTES if re.search(pat, q)), [])


def _text(content: Any) -> str:
    """The text of a message content (a string, or Gemini's list of parts)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return str(content)


PORT_TOOLS = ("port_status", "late_ships")
PLAN_TOOLS = ("make_plan", "route_ship")
PLAN_KEYS = ("replay", "cost", "optimum", "feasible", "violations")


def _port_links(step: dict) -> list[dict]:
    """One link per ship a port_status or late_ships result names (at the status hour, or at the ship's berth hour),
    or per ship a make_plan or route_ship result pinned (at its berth hour in the new schedule)."""
    try:
        r = json.loads(step["result"])
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(r, dict) or r.get("episode") is None:
        return []
    if step["tool"] in PLAN_TOOLS:
        return [{"episode": int(r["episode"]), "ship_id": p["ship"], "hour": p["berth_hour"]}
                for p in r.get("pinned") or []]
    out = []
    for key in ("alongside", "waiting", "late", "late_ships"):
        for x in r.get(key) or []:
            hour = r.get("hour") if step["tool"] == "port_status" else x.get("berth_hour")
            link = {"episode": int(r["episode"]), "ship_id": x["ship"]}
            if hour is not None:
                link["hour"] = int(hour)
            out.append(link)
    return out


def _links(steps: list[dict], episode: int | None) -> list[dict]:
    """Viewer links from tool usage: an episode, a ship in it, an hour."""
    out: list[dict] = []
    for s in steps:
        a = s["args"]
        if s["tool"] in PORT_TOOLS + PLAN_TOOLS:
            out.extend(x for x in _port_links(s) if x not in out)
            continue
        try:
            res = json.loads(s["result"]) if s["tool"] == "ship" else {}
        except (json.JSONDecodeError, TypeError):
            res = {}
        res = res if isinstance(res, dict) else {}
        n = a.get("n", res.get("episode"))   # ship() with no arguments: the episode and ship come back in the result
        if n is None:
            continue
        link: dict[str, Any] = {"episode": int(n)}
        sid = a.get("ship_id", a.get("ship_id_or_name"))
        if sid is None:
            sid = res.get("ship")
        if sid is not None:
            try:
                link["ship_id"] = int(sid)
            except (TypeError, ValueError):
                try:
                    link["ship_id"] = json.loads(s["result"]).get("ship")
                except (json.JSONDecodeError, AttributeError):
                    pass
        if a.get("berth_hour") is not None:
            link["hour"] = int(a["berth_hour"])
        elif s["tool"] == "ship":
            try:
                hour = json.loads(s["result"]).get("berth_hour")
            except (json.JSONDecodeError, AttributeError):
                hour = None
            if hour is not None:
                link["hour"] = int(hour)
        if link not in out:
            out.append(link)
    if not out and episode is not None:
        out.append({"episode": int(episode)})
    return out


def _undash(text: str) -> str:
    """No dashes as punctuation in the demo: a range like 4\u20136 keeps a hyphen, any other dash becomes a comma."""
    text = re.sub(r"(\d)[\u2013\u2014](\d)", r"\1-\2", text)
    return re.sub(r"\s*[\u2014\u2013]\s*", ", ", text)


def _unthought(text: str) -> str:
    """Drop a thinking marker Gemini sometimes leaks at the start of its text ("hthoughtIn episode 9 ...")."""
    return re.sub(r"^\s*[a-z]{0,3}thought(?=[A-Z])", "", text)


def digest_sentence(d: dict) -> str:
    """An operator answer built in code from the overview digest, for when the model fails."""
    now, ep = d.get("port_now"), d.get("latest_episode")
    if not now or not ep:
        return f"Run {d.get('note') or 'has no episode replay yet'}; I have played {d['run']['episodes_played']} episodes."
    pool = f"{now['cranes_in_use']} of {now['crane_pool']} cranes working"
    cost = "" if ep.get("cost") is None else f", plan cost {ep['cost']:,} against {ep['optimum']:,} best possible"
    return (f"Right now at {now['terminal']}, hour {now['hour']} of episode {ep['episode']}: {len(now['alongside'])} "
            f"ships alongside, {len(now['waiting'])} waiting, {ep['late_ship_count']} late, {pool}{cost}.")


def cap_sentences(text: str, n: int = MAX_SENTENCES) -> str:
    """The first n sentences of text (split after . ! or ? followed by whitespace)."""
    parts = re.split(r"(?<!\bvs\.)(?<!\be\.g\.)(?<!\bi\.e\.)(?<=[.!?])\s+", text.strip())
    return " ".join(parts[:n])


class FakeModel:
    """A scripted chat model for tests: the first turn calls `tool` (default run_status) with `args`, each entry of
    `then` [(tool, args or a function of the previous tool result)] is one more call, and the last turn answers
    from the last result."""

    def __new__(cls, answer: str | None = None, tool: str = "run_status", args: dict | None = None,
                then: list | None = None):
        from langchain_core.language_models.chat_models import BaseChatModel
        from langchain_core.messages import AIMessage, ToolMessage
        from langchain_core.outputs import ChatGeneration, ChatResult

        class _Fake(BaseChatModel):
            answer: str | None = None
            tool: str = "run_status"
            args: dict = {}
            then: list = []

            @property
            def _llm_type(self) -> str:
                return "fake-operator"

            def bind_tools(self, tools, **kwargs):   # noqa: ANN001
                return self

            def _generate(self, messages, stop=None, run_manager=None, **kwargs):   # noqa: ANN001
                usage = {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}
                tool_msgs = [m for m in messages if isinstance(m, ToolMessage)]
                calls = [(self.tool, self.args)] + list(self.then)
                if len(tool_msgs) < len(calls):
                    name, args = calls[len(tool_msgs)]
                    if callable(args):
                        args = args(json.loads(tool_msgs[-1].content))
                    msg = AIMessage(content="", tool_calls=[{"name": name, "args": args,
                                                             "id": f"call-{len(tool_msgs) + 1}"}],
                                    usage_metadata=usage)
                else:
                    data = json.loads(tool_msgs[-1].content)
                    msg = AIMessage(content=self.answer or (
                        f"I have played {data.get('episodes_done')} episodes and I am on playbook "
                        f"v{data.get('current_playbook_version')}."), usage_metadata=usage)
                return ChatResult(generations=[ChatGeneration(message=msg)])

        return _Fake(answer=answer, tool=tool, args=args or {}, then=then or [])


class ChatAgent:
    """One operator agent per run. Stateless: the conversation is the messages list the client sends."""

    def __init__(self, run_dir: str | Path, model: Any = None, optimizer: Any = None):
        from langgraph.prebuilt import create_react_agent

        self.run_dir = Path(run_dir)
        self.tools = RunTools(self.run_dir, optimizer)
        self.model = model if model is not None else make_model(TEMPERATURE)
        self.model_id = MODEL_ID if model is None else getattr(model, "_llm_type", "fake")
        self.graph = create_react_agent(self.model, self.tools.langchain_tools(), prompt=SYSTEM_PROMPT)
        self._pool = ThreadPoolExecutor(max_workers=8)   # agent runs, so a stalled one can be abandoned at HARD_S

    def _digest_answer(self, question: str, error: Exception | None, tools: list[str] = ()) -> dict:
        """The fallback when the agent run fails or is slow: once more with no tools, on the results of the routed
        `tools` that need no arguments (computed here) else the overview digest, and if the model fails again an
        answer built in code from the digest, flagged degraded."""
        from langchain_core.messages import HumanMessage, SystemMessage

        calls: list[tuple[str, dict]] = []
        for name in tools:
            if name == "episode":   # the episodes the question names, else the one on screen
                nums = [int(x) for x in re.findall(r"episode\s+(\d+)", question.lower())] or [None]
                calls += [("episode", {"n": x}) for x in nums if x is not None] or [("late_ships", {})]
            elif name == "what_if":   # what_if needs the change spelled out: the ship facts it would start from
                calls += [("ship", {}), ("late_ships", {})]
            elif name not in PROPOSAL_TOOLS + PLAN_TOOLS:
                calls.append((name, {}))
        steps = []
        for name, args in calls:
            try:
                res = getattr(self.tools, name)(**args)
            except TypeError:   # a tool that needs arguments not known here
                continue
            steps.append({"tool": name, "args": args, "result_preview": res[:200], "result": res})
        digest = self.tools.overview()
        if not steps:
            steps = [{"tool": "overview", "args": {}, "result_preview": digest[:200], "result": digest}]
        data = "\n".join(f"{st['tool']}: {st.pop('result')}" for st in steps)
        base = {"steps": steps, "links": [], "what_if": None, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0}
        try:
            msg = self.model.invoke([SystemMessage(content=SHORT_PROMPT),
                                     HumanMessage(content=f"Data:\n{data}\n\nQuestion: {question}")])
            text = _text(msg.content).strip()
            if text:
                usage = getattr(msg, "usage_metadata", None) or {}
                tin, tout = int(usage.get("input_tokens", 0)), int(usage.get("output_tokens", 0))
                return {**base, "answer": cap_sentences(_undash(text)), "tokens_in": tin, "tokens_out": tout,
                        "cost_usd": round(estimate_cost(tin, tout), 6) if self.model_id == MODEL_ID else 0.0,
                        "retried": "slow" if error is None else type(error).__name__}
        except Exception:   # noqa: BLE001, fall through to the answer built in code
            pass
        return {**base, "answer": digest_sentence(json.loads(digest)), "degraded": True}

    def _code_answer(self, episode: int | None) -> dict:
        """The answer built in code from the overview digest, when every model call stalled."""
        digest = self.tools.overview()
        return {"answer": digest_sentence(json.loads(digest)), "degraded": True,
                "steps": [{"tool": "overview", "args": {}, "result_preview": digest[:200]}],
                "links": _links([], episode), "what_if": None, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0}

    def _run(self, convo: list) -> list:
        """The agent's messages for the conversation. Past DEADLINE_S it stops calling tools: a pending tool call is
        dropped and the model answers once, without tools, from the tool results so far."""
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

        t0, state = time.monotonic(), None
        for state in self.graph.stream({"messages": convo}, config={"recursion_limit": RECURSION_LIMIT},
                                       stream_mode="values"):
            if time.monotonic() - t0 > DEADLINE_S:
                break
        else:
            return state["messages"]
        msgs = list(state["messages"])
        if msgs and isinstance(msgs[-1], AIMessage) and msgs[-1].tool_calls:
            msgs.pop()
        if msgs and isinstance(msgs[-1], AIMessage) and _text(msgs[-1].content).strip():
            return msgs
        final = self.model.invoke([SystemMessage(content=SYSTEM_PROMPT), *msgs, HumanMessage(
            content="Answer the question now from the tool results above, two to four sentences, no more tools.")])
        return [*msgs, AIMessage(content=_text(final.content), usage_metadata=getattr(final, "usage_metadata", None))]

    def ask(self, messages: list[dict], episode: int | None = None, hour: int | None = None,
            ship_id: int | None = None) -> dict:
        from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

        convo: list[Any] = []
        for m in messages:
            content = str(m.get("content", ""))
            convo.append(AIMessage(content=content) if m.get("role") == "assistant" else HumanMessage(content=content))
        if not convo or not isinstance(convo[-1], HumanMessage):
            raise ValueError("the last message must be from the user")
        question = str(convo[-1].content)
        if episode is not None:
            at = "" if hour is None else f" at hour {int(hour)}"
            sel = "" if ship_id is None else f", ship {int(ship_id)} selected"
            convo[-1] = HumanMessage(
                content=f"{convo[-1].content}\n\n(The viewer is showing episode {int(episode)}{at}{sel}.)")
        hint = route(question)
        if hint:
            convo[-1] = HumanMessage(content=f"{convo[-1].content}\n\n(Tools for this: {', '.join(hint)}.)")
        n0 = len(convo)
        view = [None if x is None else int(x) for x in (episode, hour, ship_id)]
        with self.tools.viewing(*view):
            t0 = time.monotonic()
            fut = self._pool.submit(contextvars.copy_context().run, self._run, convo)
            try:
                new = fut.result(timeout=RACE_S)[n0:]
            except FutureTimeout:   # a slow or stalled model call: race a one-shot answer on the routed tools
                backup = self._pool.submit(contextvars.copy_context().run, self._digest_answer, question, None, hint)
                done, _ = wait([fut, backup], timeout=HARD_S - RACE_S, return_when=FIRST_COMPLETED)
                if fut in done and fut.exception() is None:
                    new = fut.result()[n0:]
                else:   # the backup finished first, or the agent failed: the backup's answer once it is in
                    left = HARD_S - (time.monotonic() - t0)
                    try:
                        return {**backup.result(timeout=max(0.0, left)), "links": _links([], episode)}
                    except FutureTimeout:
                        return self._code_answer(episode)
            except Exception as e:   # noqa: BLE001, a model or tool failure (or the recursion limit) never fails a turn
                return self._digest_answer(question, e)
        steps, calls, what_if = [], {}, None
        tin = tout = 0
        for m in new:
            if isinstance(m, AIMessage):
                usage = getattr(m, "usage_metadata", None) or {}
                tin += int(usage.get("input_tokens", 0))
                tout += int(usage.get("output_tokens", 0))
                for tc in m.tool_calls or []:
                    calls[tc["id"]] = tc
            elif isinstance(m, ToolMessage):
                tc = calls.get(m.tool_call_id, {"name": m.name, "args": {}})
                result = _text(m.content)
                steps.append({"tool": tc["name"], "args": tc.get("args", {}), "result": result,
                              "result_preview": result[:200]})
                if tc["name"] == "what_if":
                    try:
                        what_if = json.loads(result)
                    except json.JSONDecodeError:
                        what_if = {"raw": result}
        final = next((m for m in reversed(new) if isinstance(m, AIMessage) and _text(m.content).strip()), None)
        answer = _text(final.content).strip() if final is not None else "I could not produce an answer."
        answer = cap_sentences(_undash(_unthought(answer)))
        links = _links(steps, episode)
        extra: dict[str, Any] = {}
        touched = [st for st in steps if st["tool"] in PROPOSAL_TOOLS]
        if touched:
            try:
                pid = json.loads(touched[-1]["result"]).get("id")
            except (json.JSONDecodeError, AttributeError):
                pid = None
            got = self.tools.optimizer.status(pid)
            if "error" not in got:
                extra["proposal"] = {k: got.get(k) for k in PROPOSAL_KEYS}
        planned = [st for st in steps if st["tool"] in PLAN_TOOLS]
        if planned:
            try:
                made = json.loads(planned[-1]["result"])
            except json.JSONDecodeError:
                made = {}
            if isinstance(made, dict) and "replay" in made:
                extra["plan"] = {k: made.get(k) for k in PLAN_KEYS}
        return {**extra, "answer": answer,
                "steps": [{k: s[k] for k in ("tool", "args", "result_preview")} for s in steps],
                "links": links, "what_if": what_if, "tokens_in": tin, "tokens_out": tout,
                "cost_usd": round(estimate_cost(tin, tout), 6) if self.model_id == MODEL_ID else 0.0}
