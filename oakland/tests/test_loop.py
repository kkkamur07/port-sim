"""The player and coach loop (oakland/loop), offline: scripted player and coach only, no network, and any attempt to
construct the Gemini client raises unless a test turns ALLOW_MODEL_REQUESTS on with a fake model class. The ship
calls in every task are GENERATED (not real records)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from env import load_tasks  # noqa: E402
from oakland_core.pack import build_pack, save_jsonl  # noqa: E402

from loop import coach as coach_mod  # noqa: E402
from loop import player as player_mod  # noqa: E402
from loop.graph import LoopConfig, run_loop, sanity_gates  # noqa: E402
from loop.metrics import summary  # noqa: E402
from loop.playbook import PlaybookStore  # noqa: E402
from loop.tools import EpisodeTools, read_events, steer_hints  # noqa: E402

FIXTURE = ROOT / "viewer" / "fixtures" / "oict-demo.json"
NO_MOVES_RULE = ("Before choosing a berth hour, read the no_moves windows in the rules; never berth inside a "
                 "no-movement window, berth at its end.")


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    monkeypatch.delenv("ALLOW_MODEL_REQUESTS", raising=False)


@pytest.fixture(scope="session")
def packs(tmp_path_factory):
    """The tiny packs of the brief when they exist, else built here (3 berth tasks each)."""
    train, ev = Path("/tmp/oak-loop-train.jsonl"), Path("/tmp/oak-loop-eval.jsonl")
    if train.exists() and ev.exists():
        return str(train), str(ev)
    d = tmp_path_factory.mktemp("packs")
    train, ev = d / "train.jsonl", d / "eval.jsonl"
    save_jsonl(build_pack(3, "train", "berth", time_limit_s=10.0), train)
    save_jsonl(build_pack(3, "eval", "berth", time_limit_s=10.0), ev)
    return str(train), str(ev)


@pytest.fixture(scope="session")
def demo_run(packs, tmp_path_factory):
    runs = tmp_path_factory.mktemp("runs")
    cfg = LoopConfig(run="t", episodes=6, coach_every=3, kind="berth", train_pack=[packs[0]], eval_pack=[packs[1]],
                     player="scripted", coach="scripted", scripted_mistakes=True, runs_dir=str(runs))
    lines: list[str] = []
    final = run_loop(cfg, out=lines.append)
    return runs / "t", lines, final


def test_metrics_parity_with_metrics_js():
    s = summary(json.loads(FIXTURE.read_text()))
    assert s["reward"] == 0.833
    assert s["ships_served"] == 14
    assert s["on_time_pct"] == 85.7
    assert s["occupancy_pct"] == 34
    assert s["crane_util_pct"] == 71
    assert s["avg_wait_h"] == 0.57
    assert set(s["shifts"]) == {"day", "night", "hoot", "meal", "other"}
    assert sum(s["shifts"].values()) == s["crane_hours"]


def test_scripted_run_writes_everything(demo_run):
    run, lines, final = demo_run
    rows = [json.loads(l) for l in (run / "episodes.jsonl").read_text().splitlines()]
    assert len(rows) == 6
    assert all(r["player_version"] and r["playbook_version"] is not None for r in rows)
    for r in rows:
        assert (run / r["replay"]).exists()
        assert (run / r["events"]).exists()
    manifest = json.loads((run / "episodes.json").read_text())
    assert [m["episode"] for m in manifest] == [1, 2, 3, 4, 5, 6]
    assert all(m["replay"].startswith("replays/ep") for m in manifest)
    evals = [json.loads(l) for l in (run / "eval.jsonl").read_text().splitlines()]
    cands = [e for e in evals if e["role"] == "candidate"]
    assert len(cands) == 2
    for e in cands:
        assert e["train_mean"] is not None and e["eval_mean"] is not None
        assert e["verdict"] in ("accepted", "rejected") and e["comparable"] is True
    assert (run / "playbooks" / "v1.md").exists()
    tree = json.loads((run / "playbooks" / "tree.json").read_text())["nodes"]
    assert [n["version"] for n in tree] == [0, 1, 2]
    assert all(n["verdict"] in ("accepted", "rejected") for n in tree)
    assert len([l for l in lines if l.startswith("episode ")]) == 6
    assert len([l for l in lines if l.startswith("coach round")]) == 2
    assert (run / "state.sqlite").exists()
    assert final["episode"] == 6


def test_mistake_mode_teaches_the_highest_impact_rule(demo_run):
    run, _lines, _final = demo_run
    v1 = (run / "playbooks" / "v1.md").read_text()
    assert len(v1.splitlines()) <= 60
    tree = json.loads((run / "playbooks" / "tree.json").read_text())["nodes"]
    node = tree[1]
    assert node["mistakes"] and all(m["evidence"] for m in node["mistakes"])
    impacts = [m["impact"] for m in node["mistakes"]]
    assert impacts == sorted(impacts, reverse=True)
    assert node["mistakes"][0]["rule"] in v1


def test_event_log_reconstructs_what_the_model_saw(demo_run):
    run, _lines, _final = demo_run
    ev = read_events(run / "events" / "ep001.jsonl")
    assert [e["idx"] for e in ev] == list(range(len(ev)))
    first = ev[0]
    assert first["type"] == "model_call"
    assert "Playbook v0" in first["payload"]["system_prompt"]
    assert {t["name"] for t in first["payload"]["tools"]} >= {"check_plan", "submit_plan", "live_ships"}
    assert ev[-1]["type"] == "stop" and ev[-1]["payload"]["reward"] is not None
    assert any(e["type"] == "submit" for e in ev)
    calls = [e for e in ev if e["type"] == "tool_call" and e["payload"]["tool"] != "submit_plan"]
    results = [e for e in ev if e["type"] == "tool_result"]
    assert len(calls) == len(results)
    assert all(e["tokens_in"] == 0 and e["tokens_out"] == 0 and e["cost_usd"] == 0 for e in ev)


def test_steering_hook_appends_matching_rules(packs):
    tasks = load_tasks(packs[0])
    task_i, ship_id, window = next((i, s.id, w) for i, t in enumerate(tasks) for s in t.ships
                                   for w in t.no_move_windows(s) if w[0] >= s.arrival)
    playbook = f"# Playbook v1\n\n## Rules\n- {NO_MOVES_RULE}\n- Keep every ship on its planned section.\n"
    tools = EpisodeTools(tasks, task_i, playbook=playbook, playbook_version=1)
    plan = json.loads(tools.baseline_plan())
    for row in plan:
        if row["ship"] == ship_id:
            row["berth_hour"] = window[0]
    out = json.loads(tools.check_plan(json.dumps(plan)))
    assert out["feasible"] is False
    assert out["playbook_hint"] == [NO_MOVES_RULE]
    assert "playbook_hint" in tools.log.events[-1]["payload"]["result"]
    assert steer_hints(playbook, ["cranes over the pool at hours 4"]) == []


def test_coach_drops_findings_without_evidence():
    logs = [{"episode": 1, "events": [{"idx": 0}, {"idx": 1}]}]
    kept = coach_mod.validate_mistakes([
        {"what": "a", "evidence": [{"episode": 1, "event_idx": 1}], "rule": "Do a."},
        {"what": "b", "evidence": [], "rule": "Do b."},
        {"what": "c", "evidence": [{"episode": 9, "event_idx": 0}], "rule": "Do c."},
        {"what": "d", "evidence": [{"episode": 1, "event_idx": 5}], "rule": "Do d."},
    ], logs)
    assert [m["what"] for m in kept] == ["a"]


def test_playbook_tree_restarts_from_latest_accepted(tmp_path):
    store = PlaybookStore(tmp_path)
    v1 = store.add(0, "# Playbook v1\n## Rules\n- Do x.\n", "diag", "Do x.")
    store.update(v1, verdict="rejected", reason="no eval gain")
    assert store.latest_accepted() == 0
    assert store.rejected_changes() == ["Do x."]
    v2 = store.add(store.latest_accepted(), "# Playbook v2\n", "diag", "Do y.")
    store.update(v2, verdict="accepted", reason="eval +0.01")
    assert store.latest_accepted() == 2 and store.node(2)["parent"] == 0
    assert [n["verdict"] for n in store.nodes()] == ["accepted", "rejected", "accepted"]


def test_sanity_gate_names_a_broken_task(packs):
    tasks = load_tasks(packs[1])
    sanity_gates(tasks)
    bad = tasks[0]
    bad.reference = dict(bad.reference, optimal_plan=[])
    with pytest.raises(SystemExit, match=bad.task_id):
        sanity_gates([bad])


def test_gemini_client_is_guarded_and_uses_argon(monkeypatch):
    with pytest.raises(player_mod.ModelRequestsDisabled):
        player_mod.make_model()
    with pytest.raises(player_mod.ModelRequestsDisabled):
        coach_mod.GeminiCoach().propose([], "", 1, [])

    seen = {}

    class FakeChat:
        def __init__(self, **kwargs):
            seen.update(kwargs)

    monkeypatch.setenv("ALLOW_MODEL_REQUESTS", "1")
    monkeypatch.setattr(player_mod, "ChatGoogleGenerativeAI", FakeChat)
    model = player_mod.make_model()
    assert isinstance(model, FakeChat)
    assert seen["model"] == "gemini-4-argon" and seen["temperature"] == 0.2
    assert player_mod.GeminiPlayer.model_id == "gemini-4-argon"
    assert player_mod.player_version("gemini-4-argon") != player_mod.player_version("scripted")


def _stop_log(episode: int, moved: int, reward: float = 0.9, feasible: bool = True) -> dict:
    events = [
        {"idx": 0, "type": "tool_result",
         "payload": {"tool": "check_plan", "result": json.dumps(
             {"feasible": False, "violations": [{"problem": "ship X inside the no-movement window"}]})}},
        {"idx": 1, "type": "stop", "payload": {"reason": "submitted", "reward": reward, "feasible": feasible,
                                               "metrics": {"moved_ships": moved}, "late_ships": []}},
    ]
    return {"episode": episode, "events": events}


def _finding(key: str) -> dict:
    return next({"key": k, "what": w, "rule": r, "evidence": [{"episode": 1, "event_idx": 0}]}
                for k, w, r, _d in coach_mod.FINDINGS if k == key)


def test_rank_findings_puts_moved_above_no_moves():
    logs = [_stop_log(1, 12), _stop_log(2, 9)]
    ranked = coach_mod.rank_findings([_finding("no_moves"), _finding("moved")], logs)
    assert [f["key"] for f in ranked] == ["moved", "no_moves"]
    assert ranked[0]["impact"] == 105 and ranked[1]["impact"] == 2
    out = coach_mod.ScriptedCoach().propose(logs, "# Playbook v0\n\n## Rules\n- (none yet)\n", 1, [])
    assert "planned section" in out["change"]
    assert "impact 105 = 21 ships x 5" in out["diagnosis"]
    assert out["mistakes"][0]["impact"] == 105


def test_rank_findings_keeps_catalogue_order_on_ties():
    logs = [_stop_log(1, 0)]
    ranked = coach_mod.rank_findings([_finding("feed"), _finding("shallow"), _finding("overlap")], logs)
    assert [f["key"] for f in ranked] == ["overlap", "shallow", "feed"]
    assert all(f["impact"] == 0 for f in ranked)


def test_rank_findings_counts_an_unrepaired_violation_as_a_lost_episode():
    lost = [_stop_log(1, 40, reward=0.1, feasible=False)]
    ranked = coach_mod.rank_findings([_finding("moved"), _finding("no_moves")], lost)
    assert [f["key"] for f in ranked] == ["no_moves", "moved"]
    assert ranked[0]["impact"] == 1001
    recovered = coach_mod.rank_findings([_finding("no_moves")], [_stop_log(1, 40, reward=0.1)])
    assert recovered[0]["impact"] == 1
