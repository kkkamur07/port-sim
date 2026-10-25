"""OaklandEnv and its HTTP server: the episode flow on a task from the eval parquet.

Ship calls are GENERATED (not real records); the tasks here are PortSim-shaped, which the episode flow accepts
unchanged."""

from __future__ import annotations

import http.client
import json
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from env import MAX_CHECKS, OaklandEnv  # noqa: E402
from oakland_core import Task  # noqa: E402
from server import make_server  # noqa: E402

PARQUET_CANDIDATES = [
    ROOT.parent / "data" / "raw" / "tasks" / "eval.parquet",
    Path("/Users/krishuagarwal/Desktop/Programming/leibler/port-sim/data/raw/tasks/eval.parquet"),
]


def _tasks(n: int = 2) -> list[Task]:
    pq = pytest.importorskip("pyarrow.parquet")
    path = next((p for p in PARQUET_CANDIDATES if p.is_file()), None)
    if path is None:
        pytest.skip("no eval.parquet found")
    col = pq.read_table(path, columns=["task"]).column("task")
    return [Task.from_dict(json.loads(col[i].as_py())) for i in range(n)]


@pytest.fixture(scope="module")
def tasks() -> list[Task]:
    return _tasks()


@pytest.fixture()
def env(tasks) -> OaklandEnv:
    return OaklandEnv(tasks)


def _optimal(task: Task) -> list[dict]:
    return task.reference["optimal_plan"]


def test_reset_keys(env, tasks):
    obs = env.reset(index=0)
    for k in ("task_id", "kind", "terminal", "difficulty", "rules", "situation", "checks_left"):
        assert k in obs
    assert obs["task_id"] == tasks[0].task_id
    assert obs["checks_left"] == MAX_CHECKS
    assert isinstance(obs["rules"], str) and isinstance(obs["situation"], str)
    text = env.get_situation()
    assert obs["rules"] in text and obs["situation"] in text
    assert env.reset(task_id=tasks[1].task_id)["task_id"] == tasks[1].task_id
    assert env.reset(split=tasks[0].split, index=1)["task_id"] == tasks[1].task_id


def test_check_optimal_is_feasible_without_reward(env, tasks):
    env.reset(index=0)
    out = env.check_plan(_optimal(tasks[0]))
    assert out["feasible"] is True
    assert out["cost"] == tasks[0].reference["optimal_cost"]
    assert out["violations"] == [] and out["parse_problems"] == []
    assert out["checks_left"] == MAX_CHECKS - 1
    assert "reward" not in out
    for k in ("optimal_cost", "naive_cost", "optimal_plan", "quality"):
        assert k not in out
    # the plan as a JSON string in a fence works the same
    fenced = "```json\n" + json.dumps(_optimal(tasks[0])) + "\n```"
    assert env.check_plan(fenced)["feasible"] is True


def test_check_limit(env, tasks):
    env.reset(index=0)
    plan = json.dumps(_optimal(tasks[0]))
    for i in range(MAX_CHECKS):
        out = env.check_plan(plan)
        assert "error" not in out and out["checks_left"] == MAX_CHECKS - 1 - i
    out = env.check_plan(plan)
    assert "error" in out and out["checks_left"] == 0
    assert "reward" not in out
    # submitting still works after the checks run out
    assert env.submit_plan(plan)["reward"] == 1.0


def test_submit_optimal_scores_one_and_ends(env, tasks):
    env.reset(index=0)
    g = env.submit_plan(_optimal(tasks[0]))
    assert g["reward"] == 1.0 and g["feasible"] is True
    assert g["cost"] == g["optimal_cost"] == tasks[0].reference["optimal_cost"]
    for k in ("naive_cost", "violations", "parse_problems"):
        assert k in g
    assert "error" in env.check_plan(_optimal(tasks[0]))
    assert "error" in env.submit_plan(_optimal(tasks[0]))
    calls = [e["call"] for e in env.transcript]
    assert calls == ["reset", "submit_plan", "check_plan", "submit_plan"]
    assert all("t" in e and "result" in e for e in env.transcript)
    # a new episode starts clean
    obs = env.reset(index=0)
    assert obs["checks_left"] == MAX_CHECKS and env.transcript[-1]["call"] == "reset"


def test_malformed_plan(env):
    env.reset(index=0)
    out = env.check_plan("[{ship: 0, berth_hour")
    assert out["feasible"] is False and out["parse_problems"] and out["cost"] is None
    g = env.submit_plan("this is not a plan")
    assert g["reward"] == 0 and g["feasible"] is False and g["parse_problems"]


def test_calls_before_reset_error(tasks):
    env = OaklandEnv(tasks)
    assert "error" in env.check_plan([])
    assert "error" in env.submit_plan([])
    assert "error" in env.replay()
    with pytest.raises(RuntimeError):
        env.get_situation()


def test_deterministic(tasks):
    a, b = OaklandEnv(tasks), OaklandEnv(tasks)
    plan = _optimal(tasks[0])[:-1]
    for e in (a, b):
        e.reset(index=0)
    assert a.check_plan(plan) == b.check_plan(plan)
    assert a.submit_plan(plan) == b.submit_plan(plan)


def test_load_from_jsonl(tasks, tmp_path):
    p = tmp_path / "tasks.jsonl"
    p.write_text("".join(json.dumps(t.to_dict()) + "\n" for t in tasks))
    env = OaklandEnv(str(p))
    assert [t["task_id"] for t in env.task_list()] == [t.task_id for t in tasks]


def _call(port: int, method: str, path: str, body: dict | None = None) -> tuple[int, dict | list]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    data = json.dumps(body).encode() if body is not None else None
    conn.request(method, path, body=data, headers={"Content-Type": "application/json"})
    r = conn.getresponse()
    status, payload = r.status, json.loads(r.read().decode() or "null")
    assert r.getheader("Access-Control-Allow-Origin") == "*"
    conn.close()
    return status, payload


def test_server_round_trip(tasks):
    srv = make_server(OaklandEnv(tasks), "127.0.0.1", 0)
    port = srv.server_address[1]
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    try:
        st, listing = _call(port, "GET", "/tasks")
        assert st == 200 and listing[0]["task_id"] == tasks[0].task_id
        assert all("reference" not in t for t in listing)
        st, obs = _call(port, "POST", "/reset", {"index": 0})
        assert st == 200 and obs["task_id"] == tasks[0].task_id
        st, sit = _call(port, "GET", "/situation")
        assert st == 200 and obs["situation"] in sit["situation"]
        st, chk = _call(port, "POST", "/check", {"plan": _optimal(tasks[0])})
        assert st == 200 and chk["feasible"] is True and "reward" not in chk
        st, g = _call(port, "POST", "/submit", {"plan": json.dumps(_optimal(tasks[0]))})
        assert st == 200 and g["reward"] == 1.0
        st, again = _call(port, "POST", "/submit", {"plan": _optimal(tasks[0])})
        assert st == 400 and "error" in again
        st, _ = _call(port, "POST", "/reset", {"task_id": "no-such-task"})
        assert st == 400
    finally:
        srv.shutdown()
        srv.server_close()
