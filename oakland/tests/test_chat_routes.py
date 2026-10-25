"""Demo questions (docs/demo-questions.md) routed to their tools, offline with FakeModel on the committed dashboard
fixture run: route() names the tools, the agent runs them with no tool error, the answer stays short and dash free,
a stalled model falls back to an answer built in code. Ship calls are GENERATED (not real records)."""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import chat.agent as agent_mod  # noqa: E402
from chat.agent import ChatAgent, FakeModel, _undash, route  # noqa: E402
from chat.tools import RunTools  # noqa: E402

SOURCE = ROOT / "dashboard" / "fixtures" / "run-demo"

# (question, the tools route() names, the arguments FakeModel passes to each)
DEMO = [
    ("How is the port doing?", ["port_status"], [{}]),
    ("Which ships are late and why?", ["late_ships"], [{}]),
    ("Are you improving?", ["improvement"], [{}]),
    ("What is in your playbook?", ["playbook"], [{}]),
    ("How much does an episode cost?", ["run_status", "episode"], [{}, {"n": 7}]),
    ("Show me episode 7", ["episode"], [{"n": 7}]),
]


@pytest.fixture()
def run_dir(tmp_path: Path) -> Path:
    dst = tmp_path / "runs" / "run-demo"
    shutil.copytree(SOURCE, dst)
    return dst


@pytest.mark.parametrize("question,tools,args", DEMO, ids=[q for q, _, _ in DEMO])
def test_demo_question_routes(run_dir, question, tools, args):
    assert route(question) == tools
    model = FakeModel(answer="At hour 160 of episode 7 \u2014 two ships wait, sections 4\u20136.", tool=tools[0],
                      args=args[0], then=list(zip(tools[1:], args[1:])))
    out = ChatAgent(run_dir, model=model).ask([{"role": "user", "content": question}], episode=7, hour=160)
    assert [s["tool"] for s in out["steps"]] == tools
    assert all('"error"' not in s["result_preview"] for s in out["steps"])
    assert out["answer"] == "At hour 160 of episode 7, two ships wait, sections 4-6."
    assert out["links"] and out["links"][0]["episode"] == 7


def test_unrouted_question_has_no_hint():
    assert route("Tell me about the port of Oakland.") == []


def test_undash_keeps_ranges_and_spaced_dashes_become_commas():
    assert _undash("hour 292 \u2014 49 hours late, sections 4\u20136") == "hour 292, 49 hours late, sections 4-6"


def test_reused_name_picks_the_selected_ship_else_the_most_late(run_dir):
    tools = RunTools(run_dir)
    rep = tools.replay(7)
    a, b = rep["task"]["ships"][0], rep["task"]["ships"][1]
    b["name"] = a["name"]
    with tools.viewing(7, None, b["id"]):
        assert tools._find_ship(rep, a["name"])["id"] == b["id"]
    late = {x["id"]: x.get("late_h") or 0 for x in rep["ships"]}
    want = max((a, b), key=lambda s: (late.get(s["id"], 0), -s["id"]))
    assert tools._find_ship(rep, a["name"])["id"] == want["id"]


def _stall(agent, monkeypatch, attr):
    real = getattr(agent, attr)
    monkeypatch.setattr(agent, attr, lambda *a: (time.sleep(2), real(*a))[1])


def test_slow_agent_loses_to_the_backup_answer(run_dir, monkeypatch):
    monkeypatch.setattr(agent_mod, "RACE_S", 0.2)
    monkeypatch.setattr(agent_mod, "HARD_S", 1.0)
    from langchain_core.messages import AIMessage

    class OneShot:   # the backup's model call, no tools: answers at once
        def invoke(self, messages):
            assert "port_status:" in messages[-1].content
            return AIMessage(content="Two ships wait at hour 160.")

    agent = ChatAgent(run_dir, model=FakeModel(tool="port_status"))
    _stall(agent, monkeypatch, "_run")
    agent.model = OneShot()
    t0 = time.monotonic()
    out = agent.ask([{"role": "user", "content": "How is the port doing?"}], episode=7, hour=160)
    assert time.monotonic() - t0 < 1.5
    assert out["answer"] == "Two ships wait at hour 160." and out["retried"] == "slow"
    assert [s["tool"] for s in out["steps"]] == ["port_status"]


def test_stalled_model_answers_from_the_digest(run_dir, monkeypatch):
    monkeypatch.setattr(agent_mod, "RACE_S", 0.2)
    monkeypatch.setattr(agent_mod, "HARD_S", 0.5)
    agent = ChatAgent(run_dir, model=FakeModel(tool="run_status"))
    _stall(agent, monkeypatch, "_run")
    _stall(agent, monkeypatch, "_digest_answer")
    t0 = time.monotonic()
    out = agent.ask([{"role": "user", "content": "How is the port doing?"}], episode=7, hour=160)
    assert time.monotonic() - t0 < 1.5
    assert out["degraded"] and "cranes working" in out["answer"]
    assert json.loads(agent.tools.overview())["latest_episode"]
