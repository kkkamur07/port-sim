"""Kernel tests: generated calls, the checker against an independent occupancy grid, hostile plans, the floor, plan
round trips, the replay dict and the prompts."""

from __future__ import annotations

import json
import math
import random

import pytest

import oakland_core as o
from oakland_core.world import TERMINALS, make_task

KINDS = ("berth", "crane")


# (a) generated calls --------------------------------------------------------------------------------------------

@pytest.mark.parametrize("terminal", list(TERMINALS))
@pytest.mark.parametrize("weeks", [1, 2])
@pytest.mark.parametrize("kind", KINDS)
def test_published_plan_feasible_and_deterministic(terminal, weeks, kind):
    t = make_task(7, terminal, weeks, kind)
    assert 8 * weeks - 2 <= len(t.ships) <= 24 * weeks
    assert any(b.kind == "alongside" for b in t.blocks)
    res = o.evaluate(t, t.planned())
    assert res.feasible, res.violations[:3]
    again = make_task(7, terminal, weeks, kind)
    assert json.dumps(t.to_dict(), sort_keys=True) == json.dumps(again.to_dict(), sort_keys=True)
    assert o.Task.from_dict(json.loads(json.dumps(t.to_dict()))).to_dict() == t.to_dict()
    for s in t.ships:
        assert s.draught_m is not None and s.line
        assert s.min_cranes <= s.std_cranes <= s.max_cranes


def test_generate_calls_is_seeded():
    a = o.generate_calls(random.Random(3), "TraPac", 1)
    b = o.generate_calls(random.Random(3), "TraPac", 1)
    assert [s.name for s in a[0]] == [s.name for s in b[0]]
    assert [(s.planned_hour, s.planned_section) for s in a[0]] == [(s.planned_hour, s.planned_section) for s in b[0]]


# (b) an independent hour-by-section grid ---------------------------------------------------------------------------

def shift(t: o.Task, hour: int) -> str:
    hod = hour % 24
    if hod == 17:
        return "meal"
    if 8 <= hod < 17:
        return "day"
    if 3 <= hod < 8:
        return "hoot"
    return "night"


def pool(t: o.Task, hour: int) -> int:
    p = t.rules["crane_pool"] - sum(x["cranes"] for x in t.rules["crane_outages"] if x["start"] <= hour < x["end"])
    if shift(t, hour) == "hoot":
        p = min(p, t.rules["hoot_pool"])
    return p


def fog(t: o.Task, hour: int) -> bool:
    return any(w["start"] <= hour < w["end"] for w in t.rules["no_moves"])


def grid_check(t: o.Task, plan: dict) -> tuple[bool, int | None]:
    """Feasibility and cost, written separately from check.py: walk hours, fill a (hour, section) grid."""
    ok = True
    grid: dict[tuple[int, int], int] = {}
    use: dict[int, int] = {}
    mv: dict[int, int] = {}
    cost = 0
    for b in t.blocks:
        if b.kind == "alongside":
            for hr in range(b.start, b.end):
                if shift(t, hr) != "meal":
                    use[hr] = use.get(hr, 0) + b.cranes
            mv[b.end] = mv.get(b.end, 0) + 1
    for s in t.ships:
        if s.id not in plan:
            return False, None
        e = plan[s.id]
        if t.kind == "crane":
            h, sec = s.planned_hour, s.planned_section
            prof = {"day": e[0], "night": e[1], "hoot": e[2]}
            for k, c in prof.items():
                if not (s.min_cranes <= c <= s.max_cranes or (k == "hoot" and c == 0)):
                    ok = False
                    prof[k] = s.std_cranes
        else:
            h, sec, c = e
            if not s.min_cranes <= c <= s.max_cranes:
                ok = False
                c = s.std_cranes
            prof = {"day": c, "night": c, "hoot": c}
            if sec != s.planned_section:
                cost += 5
        if h < s.arrival or fog(t, h):
            ok = False
        left, hr, gang = s.workload, h, 0
        while left > 0:
            sh = shift(t, hr)
            c = 0 if sh == "meal" else prof[sh]
            if c:
                use[hr] = use.get(hr, 0) + c
                left -= 26 * c
                if sh == "hoot" and t.kind == "crane":
                    gang += 2 * c
            hr += 1
        while fog(t, hr):
            hr += 1
        dep = hr
        mv[h] = mv.get(h, 0) + 1
        mv[dep] = mv.get(dep, 0) + 1
        for x in range(h, dep):
            for y in range(sec, sec + s.sections):
                if not 1 <= y <= t.last_section:
                    ok = False
                if (x, y) in grid:
                    ok = False
                grid[(x, y)] = s.id
                for b in t.blocks:
                    if b.first <= y <= b.last and b.start <= x < b.end:
                        if b.kind != "shallow" or s.draught_m > b.max_draught_m:
                            ok = False
        cost += s.sections * max(0, dep - s.due) * s.weight + gang
        if s.berth_deadline is not None and h > s.berth_deadline:
            cost += s.deadline_penalty * (h - s.berth_deadline)
    if any(u > pool(t, hr) for hr, u in use.items()):
        ok = False
    if any(n > 2 for n in mv.values()):
        ok = False
    return ok, (cost if ok else None)


def perturb(t: o.Task, rng: random.Random) -> dict:
    plan = dict(t.planned())
    for sid in rng.sample(sorted(plan), k=min(len(plan), rng.randint(1, 3))):
        s = t.ships[sid]
        if t.kind == "crane":
            plan[sid] = o.CraneEntry(rng.randint(s.min_cranes, s.max_cranes), rng.randint(s.min_cranes - 1, s.max_cranes),
                                     rng.choice([0, s.min_cranes, s.max_cranes, s.max_cranes + 1]))
        else:
            h, sec, c = plan[sid]
            plan[sid] = (h + rng.randint(-1, 8), sec + rng.randint(-3, 3), rng.randint(s.min_cranes, s.max_cranes + 1))
    return plan


def disrupted(seed: int, terminal: str, kind: str) -> o.Task:
    t = make_task(seed, terminal, 1, kind)
    t.rules["no_moves"] = [{"start": 30, "end": 36, "min_length": 0, "reason": "fog, bar closed", "label": "fog"}]
    t.rules["crane_outages"] = [{"start": 50, "end": 70, "cranes": 1}]
    return t


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("terminal,seed", [("TraPac", 1), ("Matson", 2)])
def test_checker_matches_grid(kind, terminal, seed):
    rng = random.Random(seed * 31 + len(kind))
    for t in (make_task(seed, terminal, 1, kind), disrupted(seed, terminal, kind)):
        n_feasible = 0
        for _ in range(40):
            plan = perturb(t, rng)
            res = o.evaluate(t, plan)
            ok, cost = grid_check(t, plan)
            assert res.feasible == ok, (plan, res.violations[:3])
            assert res.cost == cost
            n_feasible += ok
        assert n_feasible < 40


# (c) hostile plans ------------------------------------------------------------------------------------------------

def hostile(t: o.Task) -> list:
    s0 = t.ships[0]
    if t.kind == "crane":
        good = {"day": s0.std_cranes, "night": s0.std_cranes, "hoot": 0}
        rows = [{"ship": s.id, "cranes": {"day": s.std_cranes, "night": s.std_cranes, "hoot": s.std_cranes}}
                for s in t.ships]
        bad_vals = [{"day": True, "night": 1, "hoot": 0}, {"day": float("nan"), "night": 1, "hoot": 0},
                    {"day": 1e18, "night": 1, "hoot": 0}, {"day": -3, "night": 1, "hoot": 0},
                    {"day": 0, "night": 0, "hoot": 0}, {"day": "two", "night": 1, "hoot": 0}, {"day": 1}, 3, None]
        with_bad = [[dict(r, cranes=v) if r["ship"] == 0 else r for r in rows] for v in bad_vals]
        extra = [{"ship": 0, "cranes": good}]
    else:
        rows = [{"ship": s.id, "berth_hour": s.planned_hour, "section": s.planned_section, "cranes": s.std_cranes}
                for s in t.ships]
        bad = [("berth_hour", True), ("berth_hour", float("nan")), ("berth_hour", 1e18), ("berth_hour", -5),
               ("section", -40), ("cranes", 0), ("cranes", True), ("cranes", "3 cranes"), ("section", float("inf")),
               ("cranes", 1e18)]
        with_bad = [[dict(r, **{k: v}) if r["ship"] == 0 else r for r in rows] for k, v in bad]
        extra = [{"ship": 0, "berth_hour": s0.planned_hour, "section": s0.planned_section}]
    return [
        rows + extra,                                   # duplicate
        rows + [dict(rows[0], ship=999)],               # unknown ship
        rows + [dict(rows[0], ship=True)],              # boolean id
        rows[1:],                                       # missing ship
        rows[:1] * 50 * len(t.ships),                   # 50x repeated entries
        rows[:1] * (len(t.ships) + 2),
        *with_bad,
        "here is my plan: " + json.dumps(rows),         # text around JSON
        "not json at all",
        json.dumps(rows)[:-3],
        "```json\n" + json.dumps(rows + extra) + "\n```",
        {"plan": rows + extra},
        [1, 2, 3],
        42,
        None,
        {"0": "nonsense"},
        "[" * 5000 + "]" * 5000,
    ]


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("terminal", ["OICT", "Everport"])
def test_hostile_plans(kind, terminal):
    t = make_task(4, terminal, 1, kind)
    t.reference = {"optimal_cost": o.evaluate(t, t.planned()).cost, "naive_cost": 999}
    for raw in hostile(t):
        try:
            plan, problems = o.parse_plan(t, raw)
        except o.PlanError:
            continue
        g = o.grade(t, plan, problems)
        assert not g.feasible, raw if not isinstance(raw, str) else raw[:80]
        assert g.reward < 0.2
    good = o.plan_to_list(t.planned(), kind)
    plan, problems = o.parse_plan(t, json.dumps(good))
    assert not problems and o.grade(t, plan, problems).reward == 1.0


def test_evaluate_survives_raw_tuples():
    for kind in KINDS:
        t = make_task(5, "Matson", 1, kind)
        plan = {0: ("a", None), 1: (1e18, 2, 3), 2: (float("nan"),) * 3, 3: (), 4: (True, 1, 1)}
        res = o.evaluate(t, plan)
        assert not res.feasible


# (d) the floor ----------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("terminal", list(TERMINALS))
def test_floor_below_published(kind, terminal):
    for t in (make_task(2, terminal, 1, kind), disrupted(2, terminal, kind)):
        res = o.evaluate(t, t.planned())
        floor = o.unavoidable_cost(t)
        assert floor >= 0
        if res.feasible:
            assert floor <= res.cost
        rng = random.Random(9)
        for _ in range(20):
            r = o.evaluate(t, perturb(t, rng))
            if r.feasible:
                assert floor <= r.cost


# (e) round trip ---------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("kind", KINDS)
def test_round_trip(kind):
    t = make_task(3, "TraPac", 1, kind)
    plan = t.planned()
    rows = o.plan_to_list(plan, kind)
    assert o.plan_from_list(rows) == plan
    back, problems = o.parse_plan(t, json.dumps(rows))
    assert not problems and back == plan
    assert o.plan_to_list(back) == rows        # CraneEntry is recognised without the kind
    if kind == "crane":
        assert set(rows[0]) == {"ship", "cranes"} and set(rows[0]["cranes"]) == {"day", "night", "hoot"}
    else:
        assert set(rows[0]) == {"ship", "berth_hour", "section", "cranes"}


# (f) replay -------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("kind", KINDS)
def test_replay_schema(kind):
    t = disrupted(1, "OICT", kind)
    t.reference = {"optimal_cost": 0, "naive_cost": 100}
    rep = o.replay(t, t.planned())
    json.dumps(rep)
    assert set(rep) == {"task", "plan", "grade", "horizon_h", "ships", "blocks", "no_moves", "crane_pool_by_hour"}
    assert set(rep["grade"]) >= {"reward", "feasible", "cost", "optimal_cost", "violations"}
    assert "reference" not in rep["task"]
    assert rep["horizon_h"] == 168 and len(rep["crane_pool_by_hour"]) == 168
    keys = {"id", "name", "line", "length_m", "sections", "first_section", "arrival", "berth_hour", "departure", "due",
            "late_h", "cranes_by_hour", "problems"}
    for s in rep["ships"]:
        assert set(s) == keys
        assert s["cranes_by_hour"]
        for hour, c in s["cranes_by_hour"]:
            assert hour % 24 != 17 and c > 0
            assert s["berth_hour"] <= hour < s["departure"]
    for b in rep["blocks"]:
        assert {"first", "last", "start", "end", "kind", "label"} <= set(b)
    assert rep["no_moves"] == [{"start": 30, "end": 36, "label": "fog"}]


# (g) prompts ------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("terminal", list(TERMINALS))
def test_prompts(kind, terminal):
    t = disrupted(1, terminal, kind)
    r, s = o.rules(t), o.situation(t)
    fmt = o.CRANE_PLAN_FORMAT if kind == "crane" else o.BERTH_PLAN_FORMAT
    assert fmt in r
    other = o.BERTH_PLAN_FORMAT if kind == "crane" else o.CRANE_PLAN_FORMAT
    assert other not in r
    assert "generated calls at the real terminal" in s
    assert "hoot" in s and "meal" in s and "17:00-18:00" in s
    assert "fog" in s and str(t.rules["hoot_pool"]) in s
    assert "—" not in r + s and "–" not in r + s
    for ship in t.ships:
        assert ship.name in s
    if terminal in ("OICT", "Matson"):
        assert "max draught 12.8 m" in s


def test_api_names():
    for name in ("Task", "Ship", "Block", "Plan", "PlanError", "parse_plan", "plan_to_list", "plan_from_list",
                 "evaluate", "grade", "unavoidable_cost", "rules", "situation", "replay", "timeline"):
        assert hasattr(o, name)
    assert math.isclose(o.hoot_pool("OICT"), 6) and o.hoot_pool("Matson") == 2
    assert o.crane_class(400, 6) == (1, 6, 3) and o.crane_class(180, 4)[1] == 3
