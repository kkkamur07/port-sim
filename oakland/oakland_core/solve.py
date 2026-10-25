"""Reference plans for OaklandPortEnv tasks: the CP-SAT optimum, the naive re-plan and the greedy heuristic.

Ship calls are GENERATED (built from services that call Oakland, not real records); terminal geometry, crane fleets,
depths and ILWU shifts are real. Both task kinds are handled:

    berth   every ship gets a berthing hour, a first section and one crane count
    crane   berths are fixed; every ship gets a crane profile {"day": c, "night": c, "hoot": c}

The CP-SAT models are time-indexed: one Bool per (ship, berthing hour, crane count) on berth tasks and one per
(ship, crane profile) on crane tasks. Every option's finish hour, departure, cost and cranes in use per hour are
computed up front by `run`, which reads only the rules in `task.rules` (shifts, meal hours, moves per crane-hour,
no-movement windows), so the solver prices a plan exactly as the checker does. Options whose own cost already
exceeds the best baseline plan cannot be in an optimum and are left out, which keeps the models small and exact.
"""

from __future__ import annotations

import re
import time

from .check import evaluate
from .model import Plan, Task, plan_from_list

MOVE_PENALTY = 5          # cost of moving a scheduled ship off its planned section (berth tasks)
SHIFT_NAMES = ("day", "night", "hoot")
_SEARCH_H = 24 * 7 * 4    # the furthest the baselines look past a ship's arrival for a free slot


# ---------------------------------------------------------------- rules, read from task.rules

def shift_of(task: Task, hour: int) -> str | None:
    """The ILWU shift of an hour ("day", "night", "hoot"), or None in a meal hour (no crane work)."""
    hd = hour % 24
    if hd in task.rules.get("meal_hours", [17]):
        return None
    for name, (a, b) in task.rules["shifts"].items():
        if a <= hd < b or a <= hd + 24 < b:
            return name
    return None


def pool_at(task: Task, hour: int) -> int:
    """Cranes available in an hour: the hoot pool in hoot hours, the full pool otherwise, less any outage."""
    pool = int(task.rules["hoot_pool"] if shift_of(task, hour) == "hoot" else task.rules["crane_pool"])
    for o in task.rules.get("crane_outages", []):
        if o["start"] <= hour < o["end"]:
            pool -= int(o["cranes"])
    return max(0, pool)


def no_move_windows(task: Task, s) -> list[tuple[int, int]]:
    """Merged [start, end) windows in which this ship may not berth or leave (fog, bar closures)."""
    ws = sorted((w["start"], w["end"]) for w in task.rules.get("no_moves", []) if s.length_m >= w.get("min_length", 0))
    out: list[list[int]] = []
    for a, b in ws:
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def in_window(task: Task, s, hour: int) -> bool:
    return any(a <= hour < b for a, b in no_move_windows(task, s))


def run(task: Task, s, h: int, counts: dict) -> tuple[int, int, list[tuple[int, int]]]:
    """(finish hour, departure hour, [(hour, cranes working)]) for ship `s` berthing at `h` with crane counts per
    shift. Cranes work every hour but meal hours at the count of that hour's shift (a hoot count of 0 hires no hoot
    gang: the ship waits); the ship finishes when its moves are done and leaves at the finish hour, or at the end of a
    no-movement window the finish falls in."""
    rate = int(task.rules.get("moves_per_crane_hour", 26))
    if max(counts.values()) <= 0:
        raise ValueError(f"ship {s.id}: a crane profile with no cranes never finishes")
    done, t, use = 0, h, []
    while done < s.moves:
        sh = shift_of(task, t)
        c = counts[sh] if sh else 0
        if c > 0:
            use.append((t, c))
            done += c * rate
        t += 1
    dep = t
    for a, b in no_move_windows(task, s):
        if a <= t < b:
            dep = b
    return t, dep, use


def uniform(c: int) -> dict:
    return {k: c for k in SHIFT_NAMES}


def delay_cost(s, berth_hour: int, departure: int) -> int:
    """sections x hours late x weight, plus the emergency penalty for berthing after a deadline."""
    cost = s.sections * max(0, departure - s.due) * s.weight
    if s.berth_deadline is not None and berth_hour > s.berth_deadline:
        cost += s.deadline_penalty * (berth_hour - s.berth_deadline)
    return cost


def hoot_hours(task: Task, use: list[tuple[int, int]]) -> int:
    return sum(c for t, c in use if shift_of(task, t) == "hoot")


def max_draught(b) -> float:
    """A shallow block's draught limit: its `max_draught_m` attribute or the "max draught 12.8 m" in its label."""
    v = getattr(b, "max_draught_m", None)
    if v is not None:
        return float(v)
    m = re.search(r"max draught ([0-9.]+)", b.label or "")
    return float(m.group(1)) if m else 0.0


def positions(task: Task, s) -> list[int]:
    """First sections where the ship fits on the quay and in deep enough water."""
    out = []
    for sec in range(task.first_section, task.last_section - s.sections + 2):
        last = sec + s.sections - 1
        if any(b.kind == "shallow" and sec <= b.last and b.first <= last and (s.draught_m or 0) > max_draught(b)
               for b in task.blocks):
            continue
        out.append(sec)
    return out


def options(task: Task, s) -> list[dict]:
    """The crane choices of a ship: one count for every shift (berth) or every profile with hoot 0 allowed (crane)."""
    cs = range(s.min_cranes, s.max_cranes + 1)
    if task.kind == "berth":
        return [uniform(c) for c in cs]
    return [{"day": d, "night": n, "hoot": ho} for d in cs for n in cs for ho in [0, *cs]]


def _rows(task: Task, chosen: dict[int, tuple[int, int, dict]]) -> list[dict]:
    if task.kind == "crane":
        return [{"ship": sid, "cranes": dict(c)} for sid, (_, _, c) in sorted(chosen.items())]
    return [{"ship": sid, "berth_hour": h, "section": sec, "cranes": c["day"]} for sid, (h, sec, c) in sorted(chosen.items())]


# ---------------------------------------------------------------- greedy placement

class Ledger:
    """Occupied rectangles, cranes in use per hour and movements per hour, for sequential placement."""

    def __init__(self, task: Task):
        self.task = task
        self.rects = [(b.start, b.end, b.first, b.last) for b in task.blocks if b.kind in ("closed", "alongside")]
        self.use: dict[int, int] = {}
        self.moves: dict[int, int] = {}
        for b in task.blocks:
            if b.kind == "alongside":
                for t in range(b.start, b.end):
                    if shift_of(task, t):
                        self.use[t] = self.use.get(t, 0) + b.cranes
                self.moves[b.end] = self.moves.get(b.end, 0) + 1
        self.cap = int(task.rules.get("max_moves_per_hour") or 10 ** 6)

    def fits(self, s, h: int, sec: int, counts: dict) -> bool:
        if h < s.arrival or in_window(self.task, s, h):
            return False
        _, dep, use = run(self.task, s, h, counts)
        last = sec + s.sections - 1
        if any(h < r[1] and r[0] < dep and sec <= r[3] and r[2] <= last for r in self.rects):
            return False
        if any(self.use.get(t, 0) + c > pool_at(self.task, t) for t, c in use):
            return False
        if self.moves.get(h, 0) + 1 > self.cap or self.moves.get(dep, 0) + 1 > self.cap:
            return False
        return True

    def add(self, s, h: int, sec: int, counts: dict) -> None:
        _, dep, use = run(self.task, s, h, counts)
        self.rects.append((h, dep, sec, sec + s.sections - 1))
        for t, c in use:
            self.use[t] = self.use.get(t, 0) + c
        self.moves[h] = self.moves.get(h, 0) + 1
        self.moves[dep] = self.moves.get(dep, 0) + 1

    def remove(self, s, h: int, sec: int, counts: dict) -> None:
        _, dep, use = run(self.task, s, h, counts)
        self.rects.remove((h, dep, sec, sec + s.sections - 1))
        for t, c in use:
            self.use[t] -= c
        self.moves[h] -= 1
        self.moves[dep] -= 1


def _place_berth(led: Ledger, s, tries) -> tuple[int, int, dict] | None:
    """The first (hour, section, counts) from `tries(h)` that fits, scanning hours from the ship's arrival."""
    for h in range(s.arrival, s.arrival + _SEARCH_H):
        for sec, counts in tries(h):
            if led.fits(s, h, sec, counts):
                return h, sec, counts
    return None


def _berth_order(task: Task) -> list:
    return sorted(task.ships, key=lambda s: (s.planned_hour if s.planned_hour is not None else s.arrival, s.id))


def _greedy_berth(task: Task, led: Ledger, s) -> tuple[int, int, dict] | None:
    pos = positions(task, s)
    cs = range(s.max_cranes, s.min_cranes - 1, -1)
    return _place_berth(led, s, lambda h: ((sec, uniform(c)) for c in cs for sec in pos))


def _crane_fallback(task: Task, led: Ledger, s, first: dict) -> dict | None:
    """`first` if it fits at the fixed berth, else the profile with the most cranes that does."""
    h, sec = s.planned_hour, s.planned_section

    def ok(counts: dict) -> bool:
        return led.fits(s, h, sec, counts) and _crane_option_clear(task, s, run(task, s, h, counts)[1])

    if ok(first):
        return first
    for counts in sorted(options(task, s), key=lambda c: (-(c["day"] + c["night"] + c["hoot"]), -c["hoot"])):
        if ok(counts):
            return counts
    return None


def slow_profile(s) -> dict:
    """The slowest crane profile of a ship on a crane task: min cranes by day and night, no hoot gang."""
    return {"day": s.min_cranes, "night": s.min_cranes, "hoot": 0}


def _crane_baseline(task: Task, want) -> Plan:
    """Crane tasks, in berthing order: profile `want(s)` if it fits, else the one with the most cranes that does.
    Every ship not yet chosen holds its slowest profile in the ledger, so an early ship never takes the cranes a
    later ship needs to stay feasible."""
    led = Ledger(task)
    for s in task.ships:
        led.add(s, s.planned_hour, s.planned_section, slow_profile(s))
    chosen: dict[int, tuple[int, int, dict]] = {}
    for s in sorted(task.ships, key=lambda s: (s.planned_hour, s.id)):
        led.remove(s, s.planned_hour, s.planned_section, slow_profile(s))
        counts = _crane_fallback(task, led, s, want(s)) or slow_profile(s)
        led.add(s, s.planned_hour, s.planned_section, counts)
        chosen[s.id] = (s.planned_hour, s.planned_section, counts)
    return plan_from_list(_rows(task, chosen))


def naive_plan(task: Task) -> Plan:
    """The hurried re-plan. Berth tasks: in published order, keep each ship's published slot if it still fits, else
    the next free hour at the same section, with its standard cranes (unscheduled calls take the earliest hour and
    lowest section). Crane tasks: standard cranes in day and night shifts, no hoot gang. A ship that cannot be placed
    that way takes the greedy choice, so the plan is feasible whenever sequential placement can make it so."""
    if task.kind == "crane":
        return _crane_baseline(task, lambda s: {"day": s.std_cranes, "night": s.std_cranes, "hoot": 0})
    led = Ledger(task)
    chosen: dict[int, tuple[int, int, dict]] = {}
    for s in _berth_order(task):
        std = uniform(s.std_cranes)
        if s.planned_section is not None:
            got = _place_berth(led, s, lambda h: [(s.planned_section, std)])
        else:
            pos = positions(task, s)
            got = _place_berth(led, s, lambda h: ((sec, std) for sec in pos))
        got = got or _greedy_berth(task, led, s)
        if got is None:
            got = (s.arrival, s.planned_section or task.first_section, std)
        else:
            led.add(s, *got)
        chosen[s.id] = got
    return plan_from_list(_rows(task, chosen))


def greedy_plan(task: Task) -> Plan:
    """Arrival order, as fast as possible. Berth tasks: the earliest hour, then the most cranes, then the lowest
    section that fits. Crane tasks: the most cranes in every shift, hoot included (fewer where the pool runs out)."""
    if task.kind == "crane":
        return _crane_baseline(task, lambda s: uniform(s.max_cranes))
    led = Ledger(task)
    chosen: dict[int, tuple[int, int, dict]] = {}
    for s in sorted(task.ships, key=lambda s: (s.arrival, s.id)):
        got = _greedy_berth(task, led, s)
        if got is None:
            got = (s.arrival, task.first_section, uniform(s.std_cranes))
        else:
            led.add(s, *got)
        chosen[s.id] = got
    return plan_from_list(_rows(task, chosen))


# ---------------------------------------------------------------- CP-SAT

def _upper_bound(task: Task) -> tuple[Plan | None, int | None]:
    best, best_cost = None, None
    for f in (naive_plan, greedy_plan):
        p = f(task)
        res = evaluate(task, p)
        if res.feasible and (best_cost is None or res.cost < best_cost):
            best, best_cost = p, res.cost
    return best, best_cost


def _fixed_load(task: Task) -> tuple[dict[int, int], dict[int, int]]:
    """Cranes in use and movements per hour from ships already alongside at hour 0."""
    use: dict[int, int] = {}
    moves: dict[int, int] = {}
    for b in task.blocks:
        if b.kind == "alongside":
            for t in range(b.start, b.end):
                if shift_of(task, t):
                    use[t] = use.get(t, 0) + b.cranes
            moves[b.end] = moves.get(b.end, 0) + 1
    return use, moves


def _options(task: Task, s, ub: int | None, fixed_use: dict[int, int]) -> tuple[list, list]:
    """Every (berth hour, counts, departure, cost) of a ship whose own cost is at most `ub`, with its crane use."""
    crane_kind = task.kind == "crane"
    gang = int(task.rules.get("hoot_gang_cost", 2))
    opts: list[tuple[int, dict, int, int]] = []
    uses: list[list[tuple[int, int]]] = []
    hours = [s.planned_hour] if crane_kind else range(s.arrival, s.arrival + _SEARCH_H)
    for h in hours:
        if in_window(task, s, h) and not crane_kind:
            continue
        any_cheap = False
        for counts in options(task, s):
            _, dep, use = run(task, s, h, counts)
            cost = delay_cost(s, h, dep) + (gang * hoot_hours(task, use) if crane_kind else 0)
            if ub is not None and cost > ub:
                continue
            any_cheap = True
            if any(c + fixed_use.get(t, 0) > pool_at(task, t) for t, c in use):
                continue
            if crane_kind and not _crane_option_clear(task, s, dep):
                continue
            opts.append((h, counts, dep, cost))
            uses.append(use)
        if not any_cheap and not crane_kind:
            break   # cost never falls with a later berthing hour: every later hour is dearer still
    return opts, uses


def _model(task: Task, ub: int | None, hint: Plan | None):
    """The time-indexed CP-SAT model with options priced at most `ub`. Returns (model, X, M)."""
    from ortools.sat.python import cp_model

    fixed_use, fixed_moves = _fixed_load(task)
    cap = int(task.rules.get("max_moves_per_hour") or 10 ** 6)
    crane_kind = task.kind == "crane"
    md = cp_model.CpModel()
    hour_use: dict[int, list] = {}
    hour_moves: dict[int, list] = {}
    terms, X, M = [], {}, {}
    xs, ys = [], []
    per_ship = {s.id: _options(task, s, ub, fixed_use) for s in task.ships}
    for sid, (opts, _) in per_ship.items():
        if not opts:
            raise RuntimeError(f"ship {sid}: no feasible option within cost {ub}")
    floor = {sid: min(o[3] for o in opts) for sid, (opts, _) in per_ship.items()}
    for s in task.ships:
        opts, uses = per_ship[s.id]
        if ub is not None:   # every other ship pays at least its own cheapest option
            room = ub - (sum(floor.values()) - floor[s.id])
            keep = [i for i, o in enumerate(opts) if o[3] <= room]
            opts, uses = [opts[i] for i in keep], [uses[i] for i in keep]
        xv = [md.NewBoolVar(f"x{s.id}_{i}") for i in range(len(opts))]
        md.AddExactlyOne(xv)
        X[s.id] = (xv, opts)
        for v, (h, counts, dep, cost), use in zip(xv, opts, uses):
            if cost:
                terms.append(cost * v)
            for t, c in use:
                hour_use.setdefault(t, []).append(c * v)
            hour_moves.setdefault(dep, []).append(v)
            if not crane_kind:
                hour_moves.setdefault(h, []).append(v)
        if crane_kind:
            fixed_moves[s.planned_hour] = fixed_moves.get(s.planned_hour, 0) + 1
            continue
        pos = positions(task, s)
        t = md.NewIntVar(min(o[0] for o in opts), max(o[0] for o in opts), f"t{s.id}")
        end = md.NewIntVar(min(o[2] for o in opts), max(o[2] for o in opts), f"e{s.id}")
        md.Add(t == sum(o[0] * v for v, o in zip(xv, opts)))
        md.Add(end == sum(o[2] * v for v, o in zip(xv, opts)))
        m = md.NewIntVarFromDomain(cp_model.Domain.FromValues(pos), f"m{s.id}")
        size = md.NewIntVar(1, max(o[2] - o[0] for o in opts), f"sz{s.id}")
        md.Add(size == end - t)
        xs.append(md.NewIntervalVar(t, size, end, f"ix{s.id}"))
        ys.append(md.NewIntervalVar(m, s.sections, m + s.sections, f"iy{s.id}"))
        M[s.id] = m
        if s.planned_section is not None:
            moved = md.NewBoolVar(f"moved{s.id}")
            md.Add(m == s.planned_section).OnlyEnforceIf(moved.Not())
            terms.append(MOVE_PENALTY * moved)
    if not crane_kind:
        for k, b in enumerate(task.blocks):
            if b.kind in ("closed", "alongside") and b.end > b.start:
                xs.append(md.NewFixedSizeIntervalVar(b.start, b.end - b.start, f"bx{k}"))
                ys.append(md.NewFixedSizeIntervalVar(b.first, b.last - b.first + 1, f"by{k}"))
        md.AddNoOverlap2D(xs, ys)
    for t, vs in hour_use.items():
        md.Add(sum(vs) <= pool_at(task, t) - fixed_use.get(t, 0))
    for t, vs in hour_moves.items():
        md.Add(sum(vs) <= cap - fixed_moves.get(t, 0))
    md.Minimize(sum(terms))
    if hint is not None:
        for row in plan_to_rows(task, hint):
            sid = row["ship"]
            xv, opts = X[sid]
            want = counts_of(task, row)
            h, sec = berth_of(task, row)
            for v, o in zip(xv, opts):
                md.AddHint(v, int(o[1] == want and o[0] == h))
            if not crane_kind:
                md.AddHint(M[sid], sec)
    return md, X, M


def _extract(task: Task, solver, X, M) -> Plan:
    chosen: dict[int, tuple[int, int, dict]] = {}
    for s in task.ships:
        xv, opts = X[s.id]
        h, counts, _, _ = next(o for v, o in zip(xv, opts) if solver.Value(v))
        sec = s.planned_section if task.kind == "crane" else solver.Value(M[s.id])
        chosen[s.id] = (h, sec, counts)
    return plan_from_list(_rows(task, chosen))


def solve(task: Task, time_limit_s: float = 30.0, workers: int = 8) -> tuple[Plan, int, bool]:
    """Minimum-cost plan by CP-SAT. Returns (plan, cost, proven) where proven means CP-SAT proved the optimum.

    Rounds: solve the model whose options cost at most the best plan known so far, briefly; if the round improves
    the plan but does not prove it, rebuild with the lower bound (fewer options, a tighter model) and go on. Each
    model only drops options no optimum can use, so a proof in any round is a proof for the task. Falls back to the
    best baseline plan when CP-SAT finds nothing better in the time limit."""
    from ortools.sat.python import cp_model

    t0 = time.time()
    best, ub = _upper_bound(task)
    proven = False
    round_s = max(1.0, time_limit_s / 6)
    while True:
        left = time_limit_s - (time.time() - t0)
        if left <= 0.05:
            break
        md, X, M = _model(task, ub, best)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = min(left, round_s)
        solver.parameters.num_workers = workers
        status = solver.StatusName(solver.Solve(md))
        if status in ("OPTIMAL", "FEASIBLE"):
            cost = int(round(solver.ObjectiveValue()))
            if ub is None or cost <= ub:
                improved = ub is None or cost < ub
                best, ub = _extract(task, solver, X, M), cost
                if status == "OPTIMAL":
                    proven = True
                    break
                if not improved:
                    round_s *= 2
                continue
        elif status == "INFEASIBLE":
            proven = best is not None   # nothing at or below the best known cost but (pruned) itself: it is optimal
            break
        round_s *= 2
    solve.last_seconds = time.time() - t0
    if best is None:
        raise RuntimeError("CP-SAT found no plan and no baseline plan is feasible")
    res = evaluate(task, best)
    if not res.feasible or res.cost != ub:
        raise RuntimeError(f"CP-SAT plan disagrees with the checker: feasible {res.feasible}, cost {res.cost} vs {ub}: "
                           + "; ".join(v["problem"] for v in res.violations[:3]))
    return best, ub, proven


solve.last_seconds = 0.0


def _crane_option_clear(task: Task, s, dep: int) -> bool:
    """On crane tasks the berth is fixed: a profile is usable only if the stay ends before any other ship (or block)
    takes one of its sections."""
    h, sec = s.planned_hour, s.planned_section
    last = sec + s.sections - 1
    for o in task.ships:
        if o.id != s.id and sec <= o.planned_section + o.sections - 1 and o.planned_section <= last:
            if o.planned_hour >= h and o.planned_hour < dep:
                return False
    for b in task.blocks:
        if b.kind in ("closed", "alongside") and sec <= b.last and b.first <= last and h < b.end and b.start < dep:
            return False
    return True


def plan_to_rows(task: Task, plan: Plan) -> list[dict]:
    """A plan in the list form of the schema (through the kernel's plan_to_list)."""
    from .model import plan_to_list
    return plan_to_list(plan)


def counts_of(task: Task, row: dict) -> dict:
    """The per-shift crane counts of one plan row."""
    c = row["cranes"]
    return {k: int(c[k]) for k in SHIFT_NAMES} if isinstance(c, dict) else uniform(int(c))


def berth_of(task: Task, row: dict) -> tuple[int, int]:
    """(berth hour, first section) of one plan row: the fixed berth on crane tasks."""
    s = task.ships[int(row["ship"])]
    if task.kind == "crane":
        return s.planned_hour, s.planned_section
    return int(row["berth_hour"]), int(row["section"])


__all__ = ["solve", "naive_plan", "greedy_plan", "run", "shift_of", "pool_at", "positions", "options", "Ledger"]
