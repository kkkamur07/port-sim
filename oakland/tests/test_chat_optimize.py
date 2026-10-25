"""Chat-driven playbook optimization (chat/optimize.py), offline: a stub coach, the scripted player for scoring and
the FakeModel for the chat, on a copy of a real run. Ship calls are GENERATED (not real records)."""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from chat.agent import ChatAgent, FakeModel  # noqa: E402
from chat.optimize import Optimizer  # noqa: E402
from chat.server import make_server  # noqa: E402
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
    shutil.copytree(SOURCE, dst, ignore=shutil.ignore_patterns("state.sqlite*", "proposals"))
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
    out = opt.optimize(episodes=3, verify=False)
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
    assert opt.optimize(episodes=1, verify=False)["id"] == 2


def test_verify_sets_the_verdict_by_the_margin(run_dir):
    before = _digest(run_dir)
    opt = _opt(run_dir)
    pid = opt.optimize(verify=False)["id"]
    started = opt.verify(pid, wait=True)
    assert started["tasks"] == 12 and 0 <= started["expected_minutes"] < 1   # scripted baseline wall times
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


def test_optimize_starts_verification_and_status_reads_it(run_dir):
    tools = RunTools(run_dir, _opt(run_dir, verify_pack=DEMO_PACK))
    assert json.loads(tools.proposal_status()) == {"error": "no proposal yet"}
    got = json.loads(tools.optimize_playbook(2))
    pid = got["id"]
    assert got["status"] == "verifying" and got["change"] == StubCoach.RULE and got["from_version"] == 2
    assert got["baseline_eval_mean"] is not None and got["expected_minutes"] is not None   # demo tasks are eval tasks
    tools.optimizer.threads[pid].join()
    st = json.loads(tools.proposal_status())
    assert st["id"] == pid and st["status"] in ("accepted", "rejected") and st["tasks"] == 4
    assert st["eval_mean"] is not None and st["baseline_eval_mean"] is not None
    assert json.loads(tools.proposal_status(pid)) == st
    assert json.loads(tools.verify_proposal(pid))["note"] == "already verified"
    assert "error" in json.loads(tools.verify_proposal(42))


KEYS = {"id", "status", "change", "baseline_eval_mean", "eval_mean", "verdict_reason"}


def test_agent_optimize_turn_returns_the_proposal(run_dir):
    model = FakeModel(answer="Okay, I optimized this: give every ship its minimum cranes. I am checking it on the "
                             "held-out tasks now; the result will appear here.",
                      tool="optimize_playbook", args={"episodes": 3})
    agent = ChatAgent(run_dir, model=model, optimizer=_opt(run_dir, verify_pack=DEMO_PACK))
    out = agent.ask([{"role": "user", "content": "Optimize my playbook"}])
    assert [s["tool"] for s in out["steps"]] == ["optimize_playbook"]
    assert out["answer"].startswith("Okay, I optimized this")
    assert set(out["proposal"]) == KEYS and out["proposal"]["id"] == 1 and out["proposal"]["change"]
    agent.tools.optimizer.threads[1].join()
    later = ChatAgent(run_dir, model=FakeModel(answer="It was verified.", tool="proposal_status"),
                      optimizer=agent.tools.optimizer).ask([{"role": "user", "content": "Did it work?"}])
    assert later["steps"][0]["tool"] == "proposal_status"
    assert later["proposal"]["status"] in ("accepted", "rejected") and later["proposal"]["eval_mean"] is not None
    plain = ChatAgent(run_dir, model=FakeModel()).ask([{"role": "user", "content": "Status?"}])
    assert "proposal" not in plain


def test_server_get_proposal(run_dir):
    opt = _opt(run_dir, verify_pack=DEMO_PACK)
    srv = make_server(run_dir.parent, port=0, make_agent=lambda p: ChatAgent(p, model=FakeModel(), optimizer=opt))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    def get(path):
        try:
            with urllib.request.urlopen(base + path) as r:
                return r.status, json.loads(r.read()), r.headers.get("Access-Control-Allow-Origin")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read()), e.headers.get("Access-Control-Allow-Origin")

    try:
        assert get("/proposal?run=real-berth-gepa")[0] == 404
        pid = opt.optimize()["id"]
        opt.threads[pid].join()
        code, body, cors = get("/proposal?run=real-berth-gepa")
        assert code == 200 and cors == "*" and set(body) == KEYS and body["id"] == pid
        assert get(f"/proposal?run=real-berth-gepa&id={pid}")[1] == body
        assert get("/proposal?run=real-berth-gepa&id=9")[0] == 404
        assert get("/proposal?run=nope")[0] == 404
    finally:
        srv.shutdown()
        srv.server_close()
