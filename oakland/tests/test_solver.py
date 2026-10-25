"""Generator, solver, baselines, packs and renderer of OaklandPortEnv (generated ship calls, real terminals)."""

from __future__ import annotations

import copy
import itertools
import json
import random

import pytest

from oakland_core import (build_pack, evaluate, generate_task, grade, greedy_plan, naive_plan, plan_from_list,
                          plan_to_list, render, solve)
from oakland_core.generate import fix_berths

KINDS = ("berth", "crane")
SEEDS = (0, 1, 2, 3)


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("seed", SEEDS)
def test_generate_is_deterministic(kind, seed):
    a = generate_task(seed, "standard", kind)
    b = generate_task(seed, "standard", kind)
    assert json.dumps(a.to_dict(), sort_keys=True) == json.dumps(b.to_dict(), sort_keys=True)
    assert a.kind == kind and 8 <= len(a.ships) <= (20 if kind == "berth" else 24)
    if kind == "crane":
        assert a.rules["fixed_berths"] is True


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("seed", SEEDS)
def test_baselines_feasible_and_solve_beats_greedy(kind, seed):
    task = generate_task(seed, "standard", kind)
    naive, greedy = evaluate(task, naive_plan(task)), evaluate(task, greedy_plan(task))
    assert naive.feasible, naive.violations[:3]
    assert greedy.feasible, greedy.violations[:3]
    plan, cost, _ = solve(task, time_limit_s=10)
    res = evaluate(task, plan)
    assert res.feasible and res.cost == cost
    assert cost <= greedy.cost and cost <= naive.cost


def _tiny(kind: str, seed: int):
    """A 3-ship task inside 48 hours at Matson, with at most 2 cranes per ship so brute force stays small."""
    rng = random.Random(seed)
    task = generate_task(seed, "standard", kind, terminal="Matson")
    ships = []
    for i, s in enumerate(task.ships[:3]):
        s = copy.deepcopy(s)
        s.id = i
        s.arrival = rng.randint(0, 12)
        s.planned_hour = s.arrival + rng.randint(0, 2)
        s.moves = rng.randint(150, 400)
        s.min_cranes, s.max_cranes, s.std_cranes = 1, 2, 1
        s.due = s.planned_hour + rng.randint(4, 10)
        s.weight, s.berth_deadline, s.deadline_penalty = 1, None, 0
        ships.append(s)
    task.ships = ships
    task.rules["no_moves"] = [{"start": 14, "end": 17, "min_length": 0, "label": "fog, bar closed"}]
    task.rules["crane_outages"] = []
    task.rules["crane_pool"], task.rules["hoot_pool"] = 3, 2
    task.blocks = [b for b in task.blocks if b.kind == "shallow"]
    task.notices, task.disruptions = [], []
    if kind == "crane":
        fix_berths(task)
    return task


def _alone(task, s, row):
    """Cost of one ship priced by the checker on a copy of the task holding only that ship (None if infeasible)."""
    t1 = copy.deepcopy(task)
    one = copy.deepcopy(s)
    one.id = 0
    t1.ships = [one]
    res = evaluate(t1, plan_from_list([{**row, "ship": 0}]))
    return res.cost if res.feasible else None


def _rows(task, s):
    if task.kind == "crane":
        cs = range(s.min_cranes, s.max_cranes + 1)
        return [{"ship": s.id, "cranes": {"day": d, "night": n, "hoot": h}} for d in cs for n in cs for h in [0, *cs]]
    return [{"ship": s.id, "berth_hour": h, "section": sec, "cranes": c} for h in range(48)
            for sec in range(task.first_section, task.last_section - s.sections + 2)
            for c in range(s.min_cranes, s.max_cranes + 1)]


def _brute(task) -> int:
    """Exhaustive search over every option of every ship, priced and checked by the checker alone. Ships' costs add
    up, so a branch whose cheapest completion is no better than the best plan found is cut."""
    opts = []
    for s in task.ships:
        priced = [(c, r) for r in _rows(task, s) if (c := _alone(task, s, r)) is not None]
        opts.append(sorted(priced, key=lambda x: x[0]))
    floor = [o[0][0] for o in opts]
    best = [None]

    def dfs(i, acc, rows):
        if best[0] is not None and acc + sum(floor[i:]) >= best[0]:
            return
        if i == len(opts):
            res = evaluate(task, plan_from_list(rows))
            if res.feasible:
                best[0] = res.cost
            return
        for c, r in opts[i]:
            if best[0] is not None and acc + c + sum(floor[i + 1:]) >= best[0]:
                break
            dfs(i + 1, acc + c, rows + [r])

    dfs(0, 0, [])
    return best[0]


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("seed", SEEDS)
def test_solve_matches_brute_force(kind, seed):
    task = _tiny(kind, seed)
    _, cost, proven = solve(task, time_limit_s=10)
    assert proven
    assert cost == _brute(task)


@pytest.mark.parametrize("kind", KINDS)
def test_render_writes_png(kind, tmp_path):
    task = generate_task(0, "busy", kind)
    path = tmp_path / f"{kind}.png"
    render(task, greedy_plan(task), path)
    assert path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


@pytest.mark.parametrize("kind", KINDS)
def test_build_pack_references_grade_one(kind):
    tasks = build_pack(2, "eval", kind, 100000, 10)
    assert len(tasks) == 2
    for t in tasks:
        ref = t.reference
        assert ref["proven_optimal"] and t.split == "eval"
        assert set(ref) >= {"optimal_plan", "optimal_cost", "naive_plan", "naive_cost", "greedy_cost"}
        assert grade(t, plan_from_list(ref["optimal_plan"])).reward == 1.0
        assert grade(t, plan_from_list(ref["naive_plan"])).reward <= 0.6
        assert plan_to_list(plan_from_list(ref["optimal_plan"])) == ref["optimal_plan"]
