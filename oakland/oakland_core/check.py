"""Feasibility and cost of a plan. Pure Python: the server grades with this and needs no solver.

Hour by hour: a ship berths at its berth hour and occupies its sections until it departs. Cranes work it in every hour
that is not a meal hour, at the count the plan gives for that hour's shift; the work advances only in hours with
cranes > 0 (26 moves per crane-hour). When the moves are done the ship leaves, unless that hour is inside a
no-movement window (fog, bar closure), when it waits alongside with its cranes free until the window ends.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .model import MOVE_PENALTY, SHIFT_NAMES, CraneEntry, Plan, Ship, Task

MAX_WORK_HOURS = 24 * 7 * 8   # no ship works longer than this; bounds grading of hostile plans


@dataclass
class ShipResult:
    ship: int
    berth_hour: int | None
    section: int | None
    departure: int | None
    delay_h: int
    moved: bool
    cost: int
    problems: list[str] = field(default_factory=list)
    cranes: int | tuple | None = None   # berth tasks: one count; crane tasks: (day, night, hoot)
    gang_cost: int = 0                  # crane tasks: hoot gang cost of this ship


@dataclass
class PlanResult:
    feasible: bool
    ships: list[ShipResult]
    cost: int | None           # None when the plan is infeasible
    delay_cost: int | None
    moves: int | None
    gang_cost: int | None = None

    @property
    def clean_fraction(self) -> float:
        return sum(1 for s in self.ships if not s.problems) / max(1, len(self.ships))

    @property
    def violations(self) -> list[dict]:
        return [{"ship": s.ship, "problem": p} for s in self.ships for p in s.problems]


def _span(a0: int, a1: int) -> str:
    return f"{a0}" if a0 == a1 else f"{a0}-{a1}"


def _hours(hs: list[int]) -> str:
    """[3, 4, 5, 9] -> '3-5, 9'"""
    out, run = [], []
    for h in sorted(set(hs)):
        if run and h == run[-1] + 1:
            run.append(h)
        else:
            if run:
                out.append(_span(run[0], run[-1]))
            run = [h]
    if run:
        out.append(_span(run[0], run[-1]))
    return ", ".join(out[:4]) + (" ..." if len(out) > 4 else "")


def work(task: Task, ship: Ship, berth_hour: int, counts: dict[str, int]) -> tuple[int, list[tuple[int, int]]]:
    """(finish hour, [(hour, cranes working)]) for a ship berthing at `berth_hour` with `counts` cranes per shift.
    Meal hours and hours with 0 cranes do not advance the work; finish is the hour after the last working hour."""
    remaining = int(ship.workload or 0)
    rate = task.rate
    rows: list[tuple[int, int]] = []
    t = berth_hour
    while remaining > 0 and t < berth_hour + MAX_WORK_HOURS:
        sh = task.shift_of(t)
        c = counts.get(sh, 0) if sh != "meal" else 0
        if c > 0:
            rows.append((t, c))
            remaining -= rate * c
        t += 1
    return (t if rows or remaining > 0 else berth_hour), rows


def _valid_count(s: Ship, c: int, shift: str, fixed: bool) -> bool:
    if fixed and shift == "hoot" and c == 0:
        return True
    return s.min_cranes <= c <= s.max_cranes


def _place(task: Task, s: Ship, entry) -> tuple[int, int, object, dict[str, int], list[str]] | str:
    """(berth hour, section, cranes as given, counts used for the work, crane problems) or an unreadable-entry text."""
    try:
        if task.kind == "crane":
            if s.planned_hour is None or s.planned_section is None:
                return "has no fixed berth in this task"
            if len(entry) != 3 or any(isinstance(x, bool) or int(x) != x for x in entry):
                return "plan entry must give whole crane counts for day, night and hoot"
            given = CraneEntry(int(entry[0]), int(entry[1]), int(entry[2]))
            counts, probs = {}, []
            for name, c in zip(SHIFT_NAMES, given):
                if _valid_count(s, c, name, True):
                    counts[name] = c
                else:
                    counts[name] = s.std_cranes   # never work with a zero or negative count
                    allowed = f"0 or {s.min_cranes}-{s.max_cranes}" if name == "hoot" else f"{s.min_cranes}-{s.max_cranes}"
                    probs.append(f"gets {c} cranes in {name} hours but can be worked by {allowed}")
            return int(s.planned_hour), int(s.planned_section), given, counts, probs
        if len(entry) < 2 or any(isinstance(x, bool) or int(x) != x for x in entry):
            return "plan entry must give a whole berth_hour, section and cranes"
        h, sec = int(entry[0]), int(entry[1])
        c = int(entry[2]) if len(entry) > 2 and entry[2] is not None else s.std_cranes
    except (TypeError, ValueError, OverflowError):
        return "plan entry could not be read"
    probs = []
    if not s.min_cranes <= c <= s.max_cranes:
        probs.append(f"gets {c} cranes but can be worked by {s.min_cranes}-{s.max_cranes}")
        used = s.std_cranes
    else:
        used = c
    return h, sec, c, {name: used for name in SHIFT_NAMES}, probs


def evaluate(task: Task, plan: Plan) -> PlanResult:
    """Check every ship of `plan` against the task's rules and price it.

    Rules: berth at or after arrival and not inside a no-movement window; stay within the quay; never share a
    section-hour with another ship, a ship already alongside, a closed section, or a section too shallow for the
    ship's draught; cranes within the ship's range (crane tasks: 0 also allowed in hoot hours); cranes working in every
    hour within that hour's pool (fewer in hoot hours, less any outage); at most max_moves_per_hour berthings +
    departures per hour. On crane tasks the berth hour and section are the ship's fixed planned ones.
    Cost: sum over ships of sections x hours late against the planned departure (x weight), plus emergency penalties,
    plus MOVE_PENALTY for each scheduled ship placed on different sections than planned (berth tasks), plus
    rules["hoot_gang_cost"] per crane-hour worked in hoot hours (crane tasks)."""
    lo, hi = task.first_section, task.last_section
    crane_kind = task.kind == "crane"
    gang_rate = int(task.rules.get("hoot_gang_cost", 2)) if crane_kind else 0
    out: list[ShipResult] = []
    rects: dict[int, tuple[int, int, int, int, list[tuple[int, int]]]] = {}
    for s in task.ships:
        if s.id not in plan:
            out.append(ShipResult(s.id, None, None, None, 0, False, 0, ["missing from the plan"]))
            continue
        placed = _place(task, s, plan[s.id])
        if isinstance(placed, str):
            out.append(ShipResult(s.id, None, None, None, 0, False, 0, [placed]))
            continue
        h, sec, given, counts, crane_probs = placed
        finish, rows = work(task, s, h, counts)
        dep = task.departure(s, finish)
        moved = (not crane_kind) and s.planned_section is not None and sec != s.planned_section
        r = ShipResult(s.id, h, sec, dep, max(0, dep - s.due), moved, 0, cranes=given)
        for a, b in task.no_move_windows(s):
            if a <= h < b:
                r.problems.append(f"berths at hour {h}, inside the no-movement window {a}-{b}")
        r.problems += crane_probs
        if h < s.arrival:
            r.problems.append(f"berths at hour {h} but cannot arrive before hour {s.arrival}")
        last = sec + s.sections - 1
        if sec < lo or last > hi:
            r.problems.append(f"needs sections {_span(sec, last)} but the quay has sections {lo}-{hi}")
        for b in task.blocks:
            if not b.applies_to(s):
                continue
            if sec <= b.last and b.first <= last and h < b.end and b.start < dep:
                if b.kind == "shallow":
                    r.problems.append(f"draws {s.draught_m:.1f} m but sections {_span(b.first, b.last)} are too "
                                      f"shallow (max draught {b.max_draught_m:.1f} m)")
                else:
                    what = f"{b.label} (alongside)" if b.kind == "alongside" else "closed sections"
                    r.problems.append(f"overlaps {what} {_span(b.first, b.last)} during hours {b.start}-{b.end}")
        if crane_kind:
            r.gang_cost = gang_rate * sum(c for t, c in rows if task.shift_of(t) == "hoot")
        rects[s.id] = (h, dep, sec, last, rows)
        out.append(r)
    ids = sorted(rects)
    for i, a in enumerate(ids):
        t0, t1, m0, m1 = rects[a][:4]
        for b in ids[i + 1:]:
            u0, u1, n0, n1 = rects[b][:4]
            if t0 < u1 and u0 < t1 and m0 <= n1 and n0 <= m1:
                hrs, secs = f"{max(t0, u0)}-{min(t1, u1)}", _span(max(m0, n0), min(m1, n1))
                out[a].problems.append(f"overlaps ship {b} ({task.ships[b].name}) in sections {secs} during hours {hrs}")
                out[b].problems.append(f"overlaps ship {a} ({task.ships[a].name}) in sections {secs} during hours {hrs}")
    if task.cranes:
        _crane_and_move_limits(task, out, rects)
    feasible = not any(r.problems for r in out)
    for r in out:
        if r.berth_hour is not None:
            r.cost = (ship_delay_cost(task.ships[r.ship], r.berth_hour, r.delay_h)
                      + (MOVE_PENALTY if r.moved else 0) + r.gang_cost)
    if not feasible:
        return PlanResult(False, out, None, None, None, None)
    delay = sum(ship_delay_cost(task.ships[r.ship], r.berth_hour, r.delay_h) for r in out)
    moves = sum(r.moved for r in out)
    gang = sum(r.gang_cost for r in out)
    return PlanResult(True, out, delay + MOVE_PENALTY * moves + gang, delay, moves, gang)


def ship_delay_cost(s, berth_hour: int, delay_h: int) -> int:
    """sections x hours late x weight, plus the emergency penalty for berthing after a deadline."""
    cost = s.sections * delay_h * s.weight
    if s.berth_deadline is not None and berth_hour > s.berth_deadline:
        cost += s.deadline_penalty * (berth_hour - s.berth_deadline)
    return cost


def block_crane_hours(task: Task, b) -> list[int]:
    """Hours in which the cranes of a ship already alongside work (its stay, less meal hours)."""
    return [t for t in range(b.start, b.end) if task.shift_of(t) != "meal"] if b.kind == "alongside" and b.cranes else []


def _crane_and_move_limits(task: Task, out: list[ShipResult], rects: dict) -> None:
    """Crane pool and movement limit, hour by hour; a ship involved in an over-limit hour gets one problem line."""
    use: dict[int, int] = {}
    moves: dict[int, list[int]] = {}
    fixed_moves: dict[int, int] = {}
    for b in task.blocks:
        if b.kind == "alongside":
            for t in block_crane_hours(task, b):
                use[t] = use.get(t, 0) + b.cranes
            fixed_moves[b.end] = fixed_moves.get(b.end, 0) + 1
    for sid, (t0, t1, _, _, rows) in rects.items():
        for t, c in rows:
            use[t] = use.get(t, 0) + c
        moves.setdefault(t0, []).append(sid)
        moves.setdefault(t1, []).append(sid)
    over = {t for t, u in use.items() if u > task.crane_pool_at(t)}
    if over:
        for sid, (_, _, _, _, rows) in rects.items():
            hs = [t for t, _ in rows if t in over]
            if hs:
                worst = max(hs, key=lambda t: use[t] - task.crane_pool_at(t))
                out[sid].problems.append(
                    f"cranes over the pool at hours {_hours(hs)} (e.g. hour {worst}, a {task.shift_of(worst)} hour: "
                    f"{use[worst]} in use, {task.crane_pool_at(worst)} available)")
    cap = task.rules.get("max_moves_per_hour")
    if cap:
        for t, ids in sorted(moves.items()):
            n = len(ids) + fixed_moves.get(t, 0)
            if n > cap:
                for sid in ids:
                    kind = "berths" if rects[sid][0] == t else "leaves"
                    out[sid].problems.append(f"{kind} at hour {t}, when {n} ships move (limit {cap} per hour)")


def timeline(task: Task, plan: Plan) -> dict[int, list[tuple[int, int]]]:
    """Each planned ship's (hour, cranes working) list, as evaluate computes it (unreadable entries are left out)."""
    out: dict[int, list[tuple[int, int]]] = {}
    for s in task.ships:
        if s.id not in plan:
            continue
        placed = _place(task, s, plan[s.id])
        if isinstance(placed, str):
            continue
        out[s.id] = work(task, s, placed[0], placed[3])[1]
    return out


def plan_cost(task: Task, plan: Plan) -> int:
    res = evaluate(task, plan)
    if not res.feasible:
        raise ValueError("plan is infeasible: " + "; ".join(v["problem"] for v in res.violations[:3]))
    return res.cost


def unavoidable_cost(task: Task) -> int:
    """A lower bound on any plan's cost: each ship on its own with the most cranes it can take in every shift and no
    pool limit, berthing at its earliest legal hour (berth tasks: its arrival, or the end of a no-movement window it
    arrives in; crane tasks: its fixed berth hour). Starting later or with fewer cranes never leaves earlier, and the
    hoot gang cost is at least 0, so the sum is a floor under the optimum."""
    total = 0
    for s in task.ships:
        if task.kind == "crane" and s.planned_hour is not None:
            h = int(s.planned_hour)
        else:
            h = s.arrival
            for a, b in task.no_move_windows(s):
                if a <= h < b:
                    h = b
        finish, _ = work(task, s, h, {name: int(s.max_cranes or 1) for name in SHIFT_NAMES})
        dep = task.departure(s, finish)
        total += ship_delay_cost(s, h, max(0, dep - s.due))
    return total
