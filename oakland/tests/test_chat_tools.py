"""port_status and late_ships (oakland/chat) on the committed dashboard fixture run, offline with FakeModel: the
quay at one hour, the late ships with reasons, the viewer's hour as the default, and viewer links for every ship
named. Ship calls are GENERATED (not real records)."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from chat.agent import ChatAgent, FakeModel  # noqa: E402
from chat.tools import PORT_CHARS, RunTools  # noqa: E402

SOURCE = ROOT / "dashboard" / "fixtures" / "run-demo"


@pytest.fixture()
def run_dir(tmp_path: Path) -> Path:
    dst = tmp_path / "runs" / "run-demo"
    shutil.copytree(SOURCE, dst)
    return dst


def test_port_status_at_an_hour(run_dir):
    st = json.loads(RunTools(run_dir).port_status(7, 160))
    assert st["episode"] == 7 and st["hour"] == 160
    assert {"alongside", "waiting", "late", "cranes_in_use", "crane_pool", "next_arrivals", "plan"} <= set(st)
    assert [x["name"] for x in st["waiting"]] == ["ONE LYRA", "ONE ORION"]
    assert st["waiting"][0] == {"ship": 0, "name": "ONE LYRA", "arrived_hour": 157, "waited_hours": 3,
                                "berth_hour": 166}
    assert [x["name"] for x in st["alongside"]] == ["YM AMBER", "ALAMEDA EXPRESS"]
    assert all(x["started_hour"] <= 160 < x["done_hour"] for x in st["alongside"])
    assert st["cranes_in_use"] == st["crane_pool"] == 7
    assert [x["late_hours"] for x in st["late"]] == sorted((x["late_hours"] for x in st["late"]), reverse=True)
    assert st["plan"]["late_ship_hours_total"] == 316
    assert st["plan"]["gap_pct"] == pytest.approx(
        100 * (st["plan"]["cost"] - st["plan"]["optimum"]) / st["plan"]["optimum"], abs=0.1)
    assert len(RunTools(run_dir).port_status(7, 160)) <= PORT_CHARS


def test_port_status_defaults(run_dir):
    tools = RunTools(run_dir)
    st = json.loads(tools.port_status())
    assert st["episode"] == 16                       # the latest episode, at its last berthing
    assert st["hour"] == max(s["berth_hour"] for s in tools.replay(16)["ships"])
    with tools.viewing(7, 160):
        assert json.loads(tools.port_status())["hour"] == 160
        assert json.loads(tools.port_status(7))["hour"] == 160
        assert json.loads(tools.late_ships())["episode"] == 7
    assert json.loads(tools.port_status(99)) == {"error": "no replay for episode 99"}


def test_late_ships_with_reasons(run_dir):
    late = json.loads(RunTools(run_dir).late_ships(7))
    assert late["late_ship_count"] == 4 and late["late_ship_hours_total"] == 316
    first = late["late_ships"][0]
    assert first["name"] == "ONE LYRA" and first["late_hours"] == 149
    assert {"due", "arrival", "berth_hour", "section", "cranes"} <= set(first)
    assert "arrived 148 h late" in first["reason"] and "waited 9 h for sections 1-9" in first["reason"]
    assert [x["late_hours"] for x in late["late_ships"]] == [149, 148, 14, 5]


def test_agent_uses_the_viewer_hour_and_links_every_ship(run_dir):
    model = FakeModel(answer="ONE LYRA and ONE ORION wait at anchor.", tool="port_status", args={})
    out = ChatAgent(run_dir, model=model).ask([{"role": "user", "content": "How is the port doing?"}],
                                              episode=7, hour=160)
    assert out["steps"][0]["tool"] == "port_status"
    st = json.loads(RunTools(run_dir).port_status(7, 160))
    named = {x["ship"] for k in ("alongside", "waiting", "late") for x in st[k]}
    assert {x["ship_id"] for x in out["links"]} == named
    assert all(x["episode"] == 7 and x["hour"] == 160 for x in out["links"])
    assert {"episode": 7, "ship_id": 0, "hour": 160} in out["links"]


def test_late_ships_links_carry_berth_hours(run_dir):
    model = FakeModel(answer="Four ships are late.", tool="late_ships", args={"episode": 7})
    out = ChatAgent(run_dir, model=model).ask([{"role": "user", "content": "Which ships are late?"}])
    assert out["links"] == [{"episode": 7, "ship_id": 0, "hour": 166}, {"episode": 7, "ship_id": 3, "hour": 169},
                            {"episode": 7, "ship_id": 13, "hour": 156}, {"episode": 7, "ship_id": 14, "hour": 156}]


REPLAY_KEYS = {"task", "plan", "grade", "horizon_h", "ships", "blocks", "no_moves", "crane_pool_by_hour"}


def test_make_plan_reaches_the_optimum(run_dir):
    made = json.loads(RunTools(run_dir).make_plan(1))
    assert made["feasible"] and made["cost"] == made["optimum"] == 104 and made["gap_pct"] == 0
    assert made["pinned"] == [] and made["vs_played"] == {"played_cost": 171, "delta": -67}
    assert made["replay"] == "proposals/plans/plan1.json"
    assert set(json.loads((run_dir / made["replay"]).read_text())) == REPLAY_KEYS


def test_route_ship_pins_and_the_agent_returns_the_plan(run_dir):
    model = FakeModel(answer="Done.", tool="route_ship", args={"episode": 1, "ship": "EVER LOYAL", "section": 3})
    out = ChatAgent(run_dir, model=model).ask([{"role": "user", "content": "Route EVER LOYAL to section 3"}])
    made = json.loads(RunTools(run_dir).route_ship(1, 4, section=3))
    assert made["pinned"][0]["ship"] == 4 and made["pinned"][0]["section"] == 3
    assert set(out["plan"]) == {"replay", "cost", "optimum", "feasible", "violations"}
    assert out["plan"]["replay"] == "proposals/plans/plan1.json"
    assert set(json.loads((run_dir / out["plan"]["replay"]).read_text())) == REPLAY_KEYS
    assert out["links"] == [{"episode": 1, "ship_id": 4, "hour": made["pinned"][0]["berth_hour"]}]


def test_overview_is_compact_and_needs_no_model(run_dir):
    text = RunTools(run_dir).overview()
    ov = json.loads(text)
    assert len(text) <= 2500
    assert ov["latest_episode"]["episode"] == 16 and ov["port_now"]["terminal"] == "OICT"
    assert ov["run"]["episodes_played"] == 16 and ov["playbook_rules"]


def test_model_failure_falls_back_to_a_code_built_answer(run_dir):
    from langchain_core.language_models.chat_models import BaseChatModel

    class Broken(BaseChatModel):
        @property
        def _llm_type(self) -> str:
            return "broken"

        def bind_tools(self, tools, **kwargs):   # noqa: ANN001
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):   # noqa: ANN001
            raise RuntimeError("503 model overloaded")

    out = ChatAgent(run_dir, model=Broken()).ask([{"role": "user", "content": "How is the port doing?"}])
    assert out["degraded"] is True and out["steps"][0]["tool"] == "overview"
    assert out["answer"].startswith("Right now at OICT, hour 113 of episode 16:")
    assert "plan cost 433 against 256 best possible." in out["answer"]


def test_this_ship_defaults_to_the_selected_ship(run_dir):
    model = FakeModel(answer="That is ONE ORION.", tool="ship", args={})
    out = ChatAgent(run_dir, model=model).ask([{"role": "user", "content": "Why is this ship late?"}],
                                              episode=7, hour=160, ship_id=3)
    assert out["links"] == [{"episode": 7, "ship_id": 3, "hour": 169}]
    tools = RunTools(run_dir)
    with tools.viewing(7, 160, 3):
        assert json.loads(tools.ship())["picked"] == "the ship selected in the viewer"
    assert json.loads(tools.ship(7))["name"] == "ONE LYRA"   # nothing selected: the most late ship


def test_range_dashes_survive(run_dir):
    model = FakeModel(answer="Sections 4\u20136 are busy \u2014 hours 52\u201354.", tool="port_status", args={})
    out = ChatAgent(run_dir, model=model).ask([{"role": "user", "content": "How is the port doing?"}])
    assert out["answer"] == "Sections 4-6 are busy, hours 52-54."
