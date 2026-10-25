"""Port operations metrics from replay JSON, a line-by-line port of oakland/dashboard/metrics.js summary() and
shifts(), so the loop's logs and the dashboard quote identical numbers. The ship calls in every replay are
GENERATED (not real records).

    from loop.metrics import summary
    summary(replay)   # reward, cost, optimal_cost, gap_pct, feasible, ships_served, on_time_pct, avg_wait_h, ...
"""

from __future__ import annotations

import math
from typing import Any

DEFAULT_SHIFTS = {"day": [8, 17], "night": [18, 27], "hoot": [3, 8]}


def _num(v: Any, d: Any) -> Any:
    """JS num(): v when it is a finite number (not a bool), else the default."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return d
    return v


def _round(v: Any, digits: int = 1) -> float | None:
    """JS round(): Math.round(v * 10^digits) / 10^digits, half up like Math.round."""
    if v is None or not math.isfinite(v):
        return None
    f = 10 ** digits
    return math.floor(v * f + 0.5) / f


def horizon_of(r: dict) -> int:
    return _num(r.get("horizon_h"), len(r.get("crane_pool_by_hour") or []) or 168)


def section_range(r: dict) -> dict:
    t = r.get("task") or {}
    first = _num(t.get("first_section"), 1)
    last = _num(t.get("last_section"), first)
    for s in r.get("ships") or []:
        last = max(last, _num(s.get("first_section"), first) + _num(s.get("sections"), 1) - 1)
    return {"first": first, "last": last, "count": last - first + 1}


def _pool_array(r: dict) -> list[int]:
    H = horizon_of(r)
    base = _num(((r.get("task") or {}).get("rules") or {}).get("crane_pool"), 0)
    pool = [base] * H
    for p in r.get("crane_pool_by_hour") or []:
        if 0 <= p[0] < H:
            pool[p[0]] = p[1]
    return pool


def _ship_cranes(s: dict) -> tuple[int, int]:
    total = mx = 0
    for c in s.get("cranes_by_hour") or []:
        total += c[1]
        mx = max(mx, c[1])
    return total, mx


def _task_ship(r: dict, sid: Any) -> dict | None:
    for s in (r.get("task") or {}).get("ships") or []:
        if s.get("id") == sid:
            return s
    return None


def _closed_blocks(r: dict) -> list[dict]:
    return [b for b in r.get("blocks") or [] if b.get("kind") != "shallow"]


def _moved_from_plan(r: dict, s: dict) -> bool:
    t = _task_ship(r, s.get("id"))
    if not t or t.get("planned_section") is None:
        return False
    return t["planned_section"] != s.get("first_section")


def shift_of(r: dict, h: int) -> str:
    """Shift of an hour of the week. Night 18..27 wraps past midnight; the meal hour is its own slot."""
    rules = (r.get("task") or {}).get("rules") or {}
    sh = rules.get("shifts") or DEFAULT_SHIFTS
    meal = rules.get("meal_hours") or [17]
    hd = h % 24
    if hd in meal:
        return "meal"
    for name in ("day", "night", "hoot"):
        w = sh.get(name)
        if not w:
            continue
        if w[0] <= hd < w[1] or w[0] <= hd + 24 < w[1]:
            return name
    return "other"


def shifts(r: dict) -> dict[str, int]:
    """Crane-hours worked by shift: day, night, hoot, meal, other."""
    out = {"day": 0, "night": 0, "hoot": 0, "meal": 0, "other": 0}
    for s in r.get("ships") or []:
        for c in s.get("cranes_by_hour") or []:
            out[shift_of(r, c[0])] += c[1]
    return out


def summary(r: dict) -> dict:
    """KPI numbers for one replay, the same keys and definitions as metrics.js summary()."""
    g = r.get("grade") or {}
    H = horizon_of(r)
    ships = r.get("ships") or []
    sec = section_range(r)
    pool = _pool_array(r)

    on_time = wait_sum = wait_max = late_sum = late_ships = moved = problems = 0
    used_sec_h = crane_h = 0
    for s in ships:
        wait = max(0, _num(s.get("berth_hour"), 0) - _num(s.get("arrival"), 0))
        wait_sum += wait
        wait_max = max(wait_max, wait)
        late = max(0, _num(s.get("late_h"), 0))
        late_sum += late
        if late > 0:
            late_ships += 1
        else:
            on_time += 1
        if _moved_from_plan(r, s):
            moved += 1
        problems += len(s.get("problems") or [])
        a = max(0, _num(s.get("berth_hour"), 0))
        b = min(H, _num(s.get("departure"), a))
        if b > a:
            used_sec_h += (b - a) * _num(s.get("sections"), 1)
        crane_h += _ship_cranes(s)[0]
    problems += len(g.get("violations") or [])

    closed_sec_h = 0
    for b in _closed_blocks(r):
        w = min(sec["last"], b["last"]) - max(sec["first"], b["first"]) + 1
        d = min(H, b["end"]) - max(0, b["start"])
        if w > 0 and d > 0:
            closed_sec_h += w * d
    avail_sec_h = sec["count"] * H - closed_sec_h
    pool_h = sum(pool)

    cost = _num(g.get("cost"), None)
    opt = _num(g.get("optimal_cost"), None)
    n = len(ships)
    task = r.get("task") or {}
    return {
        "reward": _num(g.get("reward"), None),
        "feasible": None if "feasible" not in g else bool(g["feasible"]),
        "cost": cost,
        "optimal_cost": opt,
        "gap_pct": _round((cost - opt) / opt * 100, 1) if cost is not None and opt else None,
        "ships_served": n,
        "on_time": on_time,
        "on_time_pct": _round(on_time / n * 100, 1) if n else None,
        "late_ships": late_ships,
        "avg_wait_h": _round(wait_sum / n, 2) if n else None,
        "max_wait_h": wait_max,
        "avg_late_h": _round(late_sum / n, 2) if n else None,
        "total_late_h": late_sum,
        "late_ship_hours": late_sum,
        "occupancy_pct": _round(used_sec_h / avail_sec_h * 100, 1) if avail_sec_h > 0 else None,
        "section_hours_used": used_sec_h,
        "section_hours_available": avail_sec_h,
        "crane_util_pct": _round(crane_h / pool_h * 100, 1) if pool_h > 0 else None,
        "crane_hours": crane_h,
        "crane_hours_available": pool_h,
        "moved_ships": moved,
        "problems": problems,
        "horizon_h": H,
        "sections": sec["count"],
        "terminal": task.get("terminal") or "",
        "task_id": task.get("task_id") or "",
        "shifts": shifts(r),
    }
