"""Chat-driven playbook optimization (chat/optimize.py), offline: a stub coach, the scripted player for scoring and
the FakeModel for the chat, on a copy of a real run. Ship calls are GENERATED (not real records)."""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from chat.agent import ChatAgent, FakeModel  # noqa: E402
from chat.optimize import Optimizer  # noqa: E402
from chat.tools import RunTools  # noqa: E402
from loop.coach import current_rules, render_playbook  # noqa: E402
from loop.graph import ACCEPT_MARGIN  # noqa: E402
from loop.player import ScriptedPlayer  # noqa: E402

SOURCE = ROOT / "runs" / "real-berth-gepa"
DEMO_PACK = [str(ROOT / "tasks" / "berth-eval-demo.jsonl")]
pytestmark = pytest.mark.skipif(not (SOURCE / "events" / "ep016.jsonl").exists(),
                                reason="copy runs/real-berth-gepa into oakland/runs to run the optimize tests")


@pytest.fixture()
def run_dir(tmp_path: Path) -> Path:
    dst = tmp_path / "runs" / "real-berth-gepa"
    shutil.copytree(SOURCE, dst, ignore=shutil.ignore_patterns("state.sqlite*"))
    return dst


def _digest(d: Path) -> str:
    """Every file of the run except proposals/."""
    h = hashlib.sha256()
    for p in sorted(d.rglob("*")):
        if p.is_file() and "proposals" not in p.relative_to(d).parts:
            h.update(str(p.relative_to(d)).encode())
            h.update(p.read_bytes())
    return h.hexdigest()


class StubCoach:
    """Adds one fixed rule, citing the first event of each episode it is shown."""

    model_id = "stub-coach"
    RULE = "Give every ship at least its minimum crane count before each check."

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def propose(self, logs, playbook, version, rejected, lessons=None, exclude=None):   # noqa: ANN001
        self.calls.append({"episodes": [l["episode"] for l in logs], "rejected": rejected, "lessons": lessons,
                           "exclude": exclude, "version": version})
        mistakes = [{"what": "ships under their crane minimum", "rule": self.RULE,
                     "evidence": [{"episode": l["episode"], "event_idx": 0} for l in logs]
                     + [{"episode": 999, "event_idx": 0}]}]
        return {"diagnosis": "checks were spent on crane range violations", "mistakes": mistakes,
                "playbook_md": render_playbook(version, current_rules(playbook) + [self.RULE]),
                "heuristic_code": None, "change": self.RULE, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.01,
                "wall_s": 0.0, "model": self.model_id}


def _opt(run_dir: Path, **kw) -> Optimizer:
    return Optimizer(run_dir, coach=StubCoach(), player=ScriptedPlayer(), **kw)


def test_optimize_writes_a_proposal_and_nothing_else(run_dir):
    before = _digest(run_dir)
    opt = _opt(run_dir)
    out = opt.optimize(episodes=3)
    assert _digest(run_dir) == before
    assert out["id"] == 1 and out["status"] == "proposed" and out["episodes"] == [14, 15, 16]
    assert out["from_version"] == 2 and out["change"] == StubCoach.RULE
    assert out["mistakes"] == [{"what": "ships under their crane minimum", "evidence": 3}]   # episode 999 dropped
    call = opt.coach.calls[0]
    assert call["version"] == 5 and call["lessons"] and set(call["rejected"]) <= set(call["exclude"])
    row = opt.get(1)
    for k in ("id", "created", "from_version", "status", "diagnosis", "mistakes", "change", "playbook_md",
              "verification", "baseline_eval_mean", "verdict_reason", "cost_usd"):
        assert k in row
    assert (run_dir / "proposals" / "p1.md").read_text() == row["playbook_md"]
    assert opt.optimize(episodes=1)["id"] == 2


def test_verify_sets_the_verdict_by_the_margin(run_dir):
    before = _digest(run_dir)
    opt = _opt(run_dir)
    pid = opt.optimize()["id"]
    started = opt.verify(pid, wait=True)
    assert started["tasks"] == 12 and started["expected_minutes"] == 0.0
    row = opt.get(pid)
    assert row["status"] in ("accepted", "rejected")
    v = row["verification"]
    assert len(v["per_task"]) == 12 and row["baseline_from"] == "run"   # the run was played by the scripted player
    node = next(n for n in json.loads((run_dir / "playbooks" / "tree.json").read_text())["nodes"]
                if n["version"] == 2)
    assert row["baseline_eval_mean"] == round(sum(node["eval_per_task"].values()) / 12, 4)
    gain = round(v["eval_mean"] - row["baseline_eval_mean"], 4)
    assert row["status"] == ("accepted" if gain >= ACCEPT_MARGIN else "rejected")
    assert f"{gain:+.3f}" in row["verdict_reason"] or f"+{gain:.3f}" in row["verdict_reason"]
    assert (run_dir / "proposals" / f"p{pid}" / "proposal").is_dir()
    assert _digest(run_dir) == before
    assert opt.verify(pid)["note"] == "already verified"


def test_verify_pack_and_status_round_trip(run_dir):
    tools = RunTools(run_dir, _opt(run_dir, verify_pack=DEMO_PACK))
    assert json.loads(tools.proposal_status()) == {"error": "no proposal yet"}
    pid = json.loads(tools.optimize_playbook(2))["id"]
    st = json.loads(tools.verify_proposal(pid))
    assert st["status"] == "verifying" and st["tasks"] == 4
    tools.optimizer.threads[pid].join()
    got = json.loads(tools.proposal_status())
    assert got["id"] == pid and got["status"] in ("accepted", "rejected") and got["tasks"] == 4
    assert got["verification_mean"] is not None and got["baseline_mean"] is not None
    assert json.loads(tools.proposal_status(pid)) == got
    assert "error" in json.loads(tools.verify_proposal(42))


def test_agent_optimizes_through_both_tools(run_dir):
    model = FakeModel(answer="I found crane range violations and propose one rule; verification is running.",
                      tool="optimize_playbook", args={"episodes": 3},
                      then=[("verify_proposal", lambda prev: {"id": prev["id"]})])
    agent = ChatAgent(run_dir, model=model, optimizer=_opt(run_dir, verify_pack=DEMO_PACK))
    out = agent.ask([{"role": "user", "content": "Optimize my playbook"}])
    assert [s["tool"] for s in out["steps"]] == ["optimize_playbook", "verify_proposal"]
    assert out["steps"][1]["args"] == {"id": 1}
    assert "verification is running" in out["answer"]
    agent.tools.optimizer.threads[1].join()
    later = ChatAgent(run_dir, model=FakeModel(answer="It was verified.", tool="proposal_status"),
                      optimizer=agent.tools.optimizer).ask([{"role": "user", "content": "Did it work?"}])
    assert later["steps"][0]["tool"] == "proposal_status"
    assert '"status":"accepted"' in later["steps"][0]["result_preview"] or \
        '"status":"rejected"' in later["steps"][0]["result_preview"]
