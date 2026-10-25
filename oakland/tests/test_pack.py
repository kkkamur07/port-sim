"""Shipped task packs, solver replay fixtures and the package exports of OaklandPortEnv (generated ship calls, real
terminals)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import oakland_core
from oakland_core import evaluate, plan_from_list
from oakland_core.generate import TIERS
from oakland_core.pack import SEED0, load_jsonl

ROOT = Path(__file__).resolve().parent.parent
TASKS = ROOT / "tasks"
FIXTURES = ROOT / "viewer" / "fixtures"
PACKS = {"berth-eval": 12, "berth-train": 24, "crane-eval": 12, "crane-train": 24}
SOLVER_FIXTURES = {"oict-solver": ("berth", "OICT"), "trapac-solver": ("berth", "TraPac"),
                   "matson-crane": ("crane", "Matson")}
REPLAY_KEYS = ("task", "plan", "grade", "horizon_h", "ships", "blocks", "no_moves", "crane_pool_by_hour")


def _pack(name: str):
    return load_jsonl(TASKS / f"{name}.jsonl")


@pytest.mark.parametrize("name,n", sorted(PACKS.items()))
def test_pack_count_kind_split_and_tiers(name, n):
    tasks = _pack(name)
    kind, split = name.split("-")
    assert len(tasks) == n
    assert all(t.kind == kind and t.split == split for t in tasks)
    assert len({t.task_id for t in tasks}) == n
    assert {t.difficulty for t in tasks} == set(TIERS)


@pytest.mark.parametrize("kind", ["berth", "crane"])
def test_splits_never_share_a_task(kind):
    ev, tr = _pack(f"{kind}-eval"), _pack(f"{kind}-train")
    assert not {t.task_id for t in ev} & {t.task_id for t in tr}
    seed = lambda t: int(t.task_id.rsplit("-", 1)[1])  # noqa: E731
    assert all(seed(t) >= SEED0["eval"] for t in ev) and all(seed(t) < SEED0["eval"] for t in tr)


@pytest.mark.parametrize("name", sorted(PACKS))
def test_reference_plan_is_feasible_at_optimal_cost(name):
    for t in _pack(name):
        ref = t.reference
        assert ref.get("proven_optimal") is True and isinstance(ref.get("optimal_cost"), int)
        res = evaluate(t, plan_from_list(ref["optimal_plan"]))
        assert res.feasible, (t.task_id, res.violations)
        assert res.cost == ref["optimal_cost"], t.task_id


@pytest.mark.parametrize("name", sorted(SOLVER_FIXTURES))
def test_solver_fixture_replay(name):
    kind, terminal = SOLVER_FIXTURES[name]
    rp = json.loads((FIXTURES / f"{name}.json").read_text())
    for k in REPLAY_KEYS:
        assert k in rp, f"{name} lacks {k}"
    assert rp["task"]["kind"] == kind and rp["task"]["terminal"] == terminal
    assert rp["grade"]["reward"] == 1.0 and rp["grade"]["feasible"] is True
    assert rp["grade"]["cost"] == rp["grade"]["optimal_cost"]


def test_demo_fixtures_js_embeds_every_scenario():
    """demo-fixtures.js is a classic script so the viewer works from file://: every curated scenario it declares has
    optimal, greedy and naive plans, and its replay JSON sits next to it; the solver fixtures are fetched when served."""
    js = (FIXTURES / "demo-fixtures.js").read_text()
    prefix = "window.PORTSIM_SCENARIOS = "
    line = next(ln for ln in js.splitlines() if ln.startswith(prefix))
    scenarios = json.loads(line[len(prefix):].rstrip().rstrip(";"))
    assert len(scenarios) >= 6
    for key, sc in scenarios.items():
        assert sc["id"] == key and set(sc["plans"]) >= {"optimal", "greedy", "naive"}, key
        assert (FIXTURES / f"{key}.json").exists(), key
    for name in SOLVER_FIXTURES:
        assert (FIXTURES / f"{name}.json").exists(), name


def test_dashboard_manifest_lists_solver_replays():
    """The static manifest numbers its episodes 1..n and ends with the three solver reference replays."""
    eps = json.loads((ROOT / "dashboard" / "episodes.json").read_text())
    assert [e["episode"] for e in eps] == list(range(1, len(eps) + 1))
    solver = [e for e in eps if "solver reference" in e["label"]]
    assert [Path(e["replay"]).stem for e in solver] == list(SOLVER_FIXTURES)
    assert all(e["reward"] == 1.0 for e in solver)
    for e in eps:
        assert (ROOT / "dashboard" / e["replay"]).resolve().exists(), e["replay"]


@pytest.mark.parametrize("name", ["solve", "naive_plan", "greedy_plan", "generate_task", "build_pack", "render"])
def test_package_exports_are_functions(name):
    import oakland_core.render  # noqa: F401  (importing the submodules must not shadow the functions)
    import oakland_core.solve  # noqa: F401

    assert callable(getattr(oakland_core, name))
