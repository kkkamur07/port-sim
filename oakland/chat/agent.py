"""The operator chat agent: a LangGraph ReAct agent (create_react_agent) on the player's Gemini 4 Argon wrapper
(loop.player.make_model, so the ALLOW_MODEL_REQUESTS guard holds) over the RunTools of one run.

    agent = ChatAgent("runs/live")                       # Gemini, needs ALLOW_MODEL_REQUESTS=1 and a key
    agent = ChatAgent("runs/live", model=FakeModel())    # offline, scripted
    agent.ask([{"role": "user", "content": "Are you improving?"}], episode=7)
    -> {answer, steps, links, what_if, tokens_in, tokens_out, cost_usd}
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from loop.player import MODEL_ID, estimate_cost, make_model

from .tools import RunTools

TEMPERATURE = 0.3
RECURSION_LIMIT = 25
MAX_SENTENCES = 4
SYSTEM_PROMPT = (
    "You are the Gemini Argon operator of the Port of Oakland berth plans in this demo. Speak in first person, "
    "plainly, two to four sentences, numbers from tools only, cite episode numbers and playbook versions. Nothing is "
    "trained; only your playbook changes between episodes. If a tool returns no data, say so.\n\n"
    "Always call at least one tool before answering. Ship calls are generated, not real records. For a what-if "
    "question call what_if; for 'right now' call run_status and player_log on the latest episode; for 'are you "
    "improving' call improvement; for the coach call run_status then coach_round.\n\n"
    "For 'optimize my playbook' call optimize_playbook, then verify_proposal with its id, then answer in first "
    "person with the diagnosis and the proposed rule, say that verification is running and to ask 'did it work?' "
    "in about the expected minutes. For 'did it work?' call proposal_status.")


def _text(content: Any) -> str:
    """The text of a message content (a string, or Gemini's list of parts)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return str(content)


def _links(steps: list[dict], episode: int | None) -> list[dict]:
    """Viewer links from tool usage: an episode, a ship in it, an hour."""
    out: list[dict] = []
    for s in steps:
        a = s["args"]
        if "n" not in a:
            continue
        link: dict[str, Any] = {"episode": int(a["n"])}
        sid = a.get("ship_id", a.get("ship_id_or_name"))
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


def cap_sentences(text: str, n: int = MAX_SENTENCES) -> str:
    """The first n sentences of text (split after . ! or ? followed by whitespace)."""
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
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

    def ask(self, messages: list[dict], episode: int | None = None) -> dict:
        from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

        convo: list[Any] = []
        for m in messages:
            content = str(m.get("content", ""))
            convo.append(AIMessage(content=content) if m.get("role") == "assistant" else HumanMessage(content=content))
        if not convo or not isinstance(convo[-1], HumanMessage):
            raise ValueError("the last message must be from the user")
        if episode is not None:
            convo[-1] = HumanMessage(content=f"{convo[-1].content}\n\n(The viewer is showing episode {int(episode)}.)")
        n0 = len(convo)
        out = self.graph.invoke({"messages": convo}, config={"recursion_limit": RECURSION_LIMIT})
        new = out["messages"][n0:]
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
        answer = re.sub(r"\s*[\u2014\u2013]\s*", ", ", answer)   # no dashes as punctuation in the demo
        answer = cap_sentences(answer)
        links = _links(steps, episode)
        return {"answer": answer,
                "steps": [{k: s[k] for k in ("tool", "args", "result_preview")} for s in steps],
                "links": links, "what_if": what_if, "tokens_in": tin, "tokens_out": tout,
                "cost_usd": round(estimate_cost(tin, tout), 6) if self.model_id == MODEL_ID else 0.0}
