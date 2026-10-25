"""The operator chat (oakland/chat), offline: RunTools on a copy of a real run, the ChatAgent and the HTTP server on
the scripted FakeModel. No network. Ship calls are GENERATED (not real records)."""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import threading
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from chat.agent import ChatAgent, FakeModel  # noqa: E402
from chat.server import make_server  # noqa: E402
from chat.tools import MAX_CHARS, RunTools  # noqa: E402

SOURCE = ROOT / "runs" / "real-berth-gepa"
pytestmark = pytest.mark.skipif(not (SOURCE / "replays" / "ep007.json").exists(),
                                reason="copy runs/real-berth-gepa into oakland/runs to run the chat tests")


@pytest.fixture()
def run_dir(tmp_path: Path) -> Path:
    dst = tmp_path / "runs" / "real-berth-gepa"
    shutil.copytree(SOURCE, dst, ignore=shutil.ignore_patterns("state.sqlite*"))
    return dst


def _digest(d: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(d.rglob("*")):
        if p.is_file():
            h.update(str(p.relative_to(d)).encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def test_run_status(run_dir):
    st = json.loads(RunTools(run_dir).run_status())
    assert st["episodes_done"] == 16
    assert st["current_playbook_version"] == 2
    assert st["verification_mean_by_accepted_version"] == {"v0": 0.3596, "v2": 0.4288}
    assert [r["version"] for r in st["last_rounds"]] == [2, 3, 4]
    assert st["last_rounds"][-1]["verdict"] == "rejected"


def test_improvement_deltas(run_dir):
    imp = json.loads(RunTools(run_dir).improvement())
    by_v = {v["version"]: v for v in imp["versions"]}
    assert by_v[0]["delta_vs_v0"] == 0
    assert by_v[2]["delta_vs_v0"] == pytest.approx(0.0692, abs=1e-4)
    assert imp["best_accepted"]["version"] == 2
    assert set(imp["episode_reward_mean_by_playbook"]) == {"v0", "v2"}


def test_episode_late_ships(run_dir):
    ep = json.loads(RunTools(run_dir).episode(7))
    assert ep["task_id"] == "oak-trapac-berth-busy-9" and ep["tier"] == "busy"
    assert ep["cost"] == 2576 and ep["optimal_cost"] == 2390
    late = {s["ship"]: s["late_h"] for s in ep["late_ships"]}
    assert late[0] == 149 and late[3] == 148
    assert ep["late_ship_count"] == 4
    assert ep["moved_count"] > 0


def test_tools_are_compact(run_dir):
    t = RunTools(run_dir)
    for text in (t.run_status(), t.improvement(), t.coach_round(2), t.playbook(), t.episode(7), t.player_log(4),
                 t.ship(7, "ONE LYRA"), t.what_if(7, 0, 30, 4, 3), t.reward_rules()):
        assert len(text) <= MAX_CHARS
        json.loads(text)
    assert "error" in json.loads(t.episode(99))
    assert "error" in json.loads(t.coach_round(42))


def test_what_if_runs_the_checker_and_writes_nothing(run_dir):
    t = RunTools(run_dir)
    before = _digest(run_dir)
    same = json.loads(t.what_if(7, 13))   # no change: the submitted plan regraded
    assert same["feasible"] and same["cost"] == 2576 and same["delta_cost"] == 0
    assert same["reward"] == pytest.approx(0.4179, abs=1e-4)
    bad = json.loads(t.what_if(7, 0, berth_hour=30, section=4, cranes=3))
    assert not bad["feasible"] and bad["cost"] is None
    assert any("cannot arrive before hour 157" in v for v in bad["violations"])
    assert bad["after"] == {"ship": 0, "berth_hour": 30, "section": 4, "cranes": 3}
    rep = json.loads((run_dir / "replays" / "ep007.json").read_text())
    s13 = next(r for r in rep["plan"] if r["ship"] == 13)
    moved = json.loads(t.what_if(7, 13, section=s13["section"] + 1))
    assert moved["cost"] != 2576 or not moved["feasible"]
    assert _digest(run_dir) == before


def test_agent_with_fake_model(run_dir):
    out = ChatAgent(run_dir, model=FakeModel()).ask([{"role": "user", "content": "What are you doing right now?"}],
                                                    episode=7)
    assert out["answer"] == "I have played 16 episodes and I am on playbook v2."
    assert [s["tool"] for s in out["steps"]] == ["run_status"]
    assert len(out["steps"][0]["result_preview"]) <= 200
    assert out["links"] == [{"episode": 7}]
    assert out["what_if"] is None
    assert out["tokens_in"] == 200 and out["cost_usd"] == 0.0


def test_server_round_trip(run_dir):
    srv = make_server(run_dir.parent, port=0, make_agent=lambda p: ChatAgent(p, model=FakeModel()))
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        body = json.dumps({"run": "../runs/real-berth-gepa", "episode": None,
                           "messages": [{"role": "user", "content": "Are you improving?"}]}).encode()
        req = urllib.request.Request(f"{base}/chat", data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            assert r.headers["Access-Control-Allow-Origin"] == "*"
            out = json.loads(r.read())
        assert "16 episodes" in out["answer"] and out["steps"][0]["tool"] == "run_status"
        with urllib.request.urlopen(f"{base}/runs", timeout=10) as r:
            assert r.headers["Access-Control-Allow-Origin"] == "*"
            assert json.loads(r.read()) == [{"run": "real-berth-gepa", "episodes": 16}]
        with urllib.request.urlopen(f"{base}/health", timeout=10) as r:
            assert json.loads(r.read())["ok"] is True
        bad = urllib.request.Request(f"{base}/chat", data=json.dumps({"run": "nope", "messages": [
            {"role": "user", "content": "hi"}]}).encode(), method="POST")
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(bad, timeout=10)
        assert e.value.code == 400 and "error" in json.loads(e.value.read())
    finally:
        srv.shutdown()
        srv.server_close()
