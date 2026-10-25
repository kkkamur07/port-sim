"""Build OaklandPortEnv tasks: one or two weeks at one Port of Oakland terminal, then seeded disruptions.

Ship calls are GENERATED from services that call Oakland (world.generate_calls), not real records; the terminal
geometry, crane fleets, depths and ILWU shifts are real. A tier picks the disruptions a planner meets there:

    late       transpacific weather: ships arrive 4-20 h late, on busy tiers several bunched into one window
    outage     1-2 quay cranes out of service for 12-48 h (gantry or spreader repair)
    fog        summer-morning fog closes the bar (no ship berths or leaves), or a storm closes it for 10-20 h
    closed     a run of sections closed for 18-48 h (crane rail repair or a labor stoppage)
    divert     ships diverted from Los Angeles / Long Beach ask for a berth (no planned section)
    extra      an unscheduled call
    emergency  a reefer failure on an export ag cargo: dock by a deadline or pay per hour
    priority   priority cargo: lateness counts triple

    standard   1 week   late, fog, priority
    busy       1 week   late (bunched), outage, extra, emergency, priority
    storm      2 weeks  late (bunched), storm, closed, outage, divert, emergency
    extreme    2 weeks  everything

On crane tasks the berths are then FIXED by a packer that leaves room for the slowest crane profile of every ship,
so the agent only chooses crane profiles.
"""

from __future__ import annotations

import random

from .model import Block, Ship, Task
from .solve import Ledger, positions, slow_profile
from .world import TERMINALS, generate_calls, make_task

TIERS = {
    "standard": ("late", "fog", "priority"),
    "busy": ("late", "bunched", "outage", "extra", "emergency", "priority"),
    "storm": ("late", "bunched", "storm", "closed", "outage", "divert", "emergency"),
    "extreme": ("late", "bunched", "fog", "storm", "closed", "outage", "divert", "extra", "emergency", "priority"),
}
WEEKS = {"standard": 1, "busy": 1, "storm": 2, "extreme": 2}
MIN_SHIPS, MAX_SHIPS, MAX_BERTH_SHIPS = 8, 24, 20
CLOSURE_REASONS = ("crane rail repair", "fender repair", "labor stoppage on the berth", "wharf deck repair")
OUTAGE_REASONS = ("gantry repair", "spreader failure", "boom hoist repair")
DIVERT_FROM = ("Los Angeles", "Long Beach")


def _new_ship(src: Ship, sid: int, arrival: int, rng: random.Random) -> Ship:
    """A generated ship as an unplanned call arriving at `arrival` (diverted or unscheduled)."""
    s = Ship(**{**src.__dict__})
    s.id = sid
    s.arrival = arrival
    s.planned_hour = s.planned_section = None
    s.due = arrival + s.handling + rng.randint(4, 10)
    return s


def disrupt(task: Task, kinds, rng: random.Random, horizon: int) -> None:
    ships, rules, notices, events = task.ships, task.rules, task.notices, task.disruptions
    n_sec = task.last_section
    pool = rules["crane_pool"]
    if "fog" in kinds:
        days = rng.sample(range(horizon // 24), rng.randint(1, 3))
        for d in sorted(days):
            a = 24 * d + rng.randint(3, 6)
            b = a + rng.randint(4, 7)
            rules["no_moves"].append({"start": a, "end": b, "min_length": 0, "label": "fog, bar closed"})
            notices.append(f"Fog forecast: the Bar Pilots close the Golden Gate bar from hour {a} to hour {b}. "
                           f"No ship may berth or leave in that window; a ship that finishes inside it waits alongside.")
            events.append({"type": "fog", "start": a, "end": b})
    if "storm" in kinds:
        a = rng.randint(24, horizon - 48)
        b = a + rng.randint(10, 20)
        rules["no_moves"].append({"start": a, "end": b, "min_length": 0, "label": "storm, bar closed"})
        notices.append(f"Storm warning: the bar is closed from hour {a} to hour {b}. No ship may berth or leave; cranes "
                       f"keep working and a ship that finishes inside the window waits alongside.")
        events.append({"type": "storm", "start": a, "end": b})
    scheduled = [s for s in ships if s.planned_section is not None]
    if "late" in kinds:
        late = rng.sample(scheduled, min(len(scheduled), rng.randint(1, 3)))
        if "bunched" in kinds:
            pick = rng.choice(scheduled)
            late += [s for s in scheduled if s not in late and 0 < s.planned_hour - pick.planned_hour <= 36][:3]
            if pick not in late:
                late.append(pick)
            target = pick.planned_hour + rng.randint(12, 24)
        for s in late:
            if "bunched" in kinds:
                d = max(4, target + rng.randint(0, 3) - s.arrival)
            else:
                d = rng.randint(4, 20)
            s.arrival += d
            notices.append(f"Ship {s.id} {s.name} was delayed by weather on the Pacific crossing: it now arrives at hour "
                           f"{s.arrival} (planned berthing hour {s.planned_hour}). Its planned departure stays hour {s.due}.")
            events.append({"type": "late", "ship": s.id, "hours": d})
    if "outage" in kinds:
        a, dur, k = rng.randint(0, horizon - 48), rng.randint(12, 48), rng.randint(1, max(1, min(2, pool // 4)))
        reason = rng.choice(OUTAGE_REASONS)
        rules["crane_outages"].append({"start": a, "end": a + dur, "cranes": k})
        notices.append(f"{k} of the terminal's {pool} quay cranes are out of service from hour {a} to hour {a + dur} "
                       f"({reason}): {pool - k} cranes in day and night shifts, {max(0, rules['hoot_pool'] - k)} in hoot "
                       f"shifts during that window.")
        events.append({"type": "crane_outage", "start": a, "end": a + dur, "cranes": k, "reason": reason})
    if "closed" in kinds:
        target = rng.choice(sorted(scheduled, key=lambda s: -s.sections * s.handling)[:5])
        span = min(n_sec, rng.randint(3, 8))
        first = max(1, min(n_sec - span + 1, target.planned_section + rng.randint(-2, 2)))
        start = max(0, target.planned_hour - rng.randint(0, 12))
        dur = rng.randint(18, 48)
        reason = rng.choice(CLOSURE_REASONS)
        task.blocks.append(Block(first, first + span - 1, start, start + dur, "closed", reason))
        notices.append(f"Sections {first}-{first + span - 1} are closed from hour {start} to hour {start + dur} ({reason}).")
        events.append({"type": "closure", "first": first, "last": first + span - 1, "start": start,
                       "end": start + dur, "reason": reason})
    pool_ships, _ = generate_calls(rng, task.terminal, 1)
    pool_ships = [p for p in pool_ships if positions(task, p)]
    if "divert" in kinds and pool_ships:
        port = rng.choice(DIVERT_FROM)
        a0 = rng.randint(12, horizon - 72)
        moved = []
        for p in rng.sample(pool_ships, min(len(pool_ships), rng.randint(1, 3))):
            pool_ships.remove(p)
            s = _new_ship(p, len(ships), a0 + rng.randint(0, 24), rng)
            ships.append(s)
            moved.append(s.id)
        notices.append(f"Congestion at {port}: ships {', '.join(map(str, moved))} are diverted here and arrive from hour "
                       f"{a0}. They have no planned berth, so placing them costs no move penalty.")
        events.append({"type": "divert", "from": port, "ships": moved})
    if "extra" in kinds and pool_ships:
        s = _new_ship(rng.choice(pool_ships), len(ships), rng.randint(12, horizon - 36), rng)
        ships.append(s)
        notices.append(f"Unscheduled call: ship {s.id} {s.name} ({s.length_m:.0f} m, {s.sections} sections, "
                       f"{s.workload} moves) arrives at hour {s.arrival} and asks to sail by hour {s.due}. It has no planned "
                       f"berth, so placing it anywhere costs no move penalty.")
        events.append({"type": "extra", "ship": s.id})
    if "emergency" in kinds:
        s = rng.choice(ships)
        s.berth_deadline = s.arrival + rng.randint(2, 6)
        s.deadline_penalty = rng.choice((20, 30, 40))
        notices.append(f"Emergency: reefer plant failure on ship {s.id} {s.name}, which carries export agricultural cargo. "
                       f"It must be berthed by hour {s.berth_deadline} or the terminal pays {s.deadline_penalty} per hour "
                       f"it berths later.")
        events.append({"type": "emergency", "ship": s.id, "deadline": s.berth_deadline, "penalty": s.deadline_penalty})
    if "priority" in kinds:
        for s in rng.sample(ships, min(len(ships), rng.randint(1, 2))):
            s.weight = 3
            notices.append(f"Priority cargo: ship {s.id} {s.name} carries time-critical cargo; each hour it leaves late "
                           f"counts three times.")
            events.append({"type": "priority", "ship": s.id})


def fix_berths(task: Task) -> None:
    """Crane tasks: give every ship a FIXED berth (hour, section) that stays clear of every other ship even with its
    slowest crane profile (min cranes, no hoot gang), never inside a no-movement window, so that all ships on their
    slowest profiles fit the crane pool and the movement limit. Then any choice of profiles is clear on the quay and
    a feasible choice always exists. The published section is kept when it fits."""
    led = Ledger(task)
    for s in sorted(task.ships, key=lambda s: (s.arrival, s.id)):
        slow = slow_profile(s)
        pos = positions(task, s)
        if s.planned_section in pos:
            pos = [s.planned_section] + [p for p in pos if p != s.planned_section]
        h = s.arrival
        while True:
            sec = next((p for p in pos if led.fits(s, h, p, slow)), None)
            if sec is not None:
                break
            h += 1
        led.add(s, h, sec, slow)
        s.planned_hour, s.planned_section = h, sec
    task.rules["fixed_berths"] = True
    task.notices.append("Berths and berthing hours are fixed (see the ship table). Choose each ship's crane profile: "
                        "cranes per day, night and hoot shift (hoot 0 hires no hoot gang).")


def _trim(ships: list[Ship], cap: int) -> list[Ship]:
    ships = sorted(ships, key=lambda s: (s.arrival, s.id))[:cap]
    for i, s in enumerate(ships):
        s.id = i
    return ships


def generate_task(seed: int, tier: str, kind: str, terminal: str | None = None) -> Task:
    """One task, deterministic from (seed, tier, kind, terminal)."""
    if tier not in TIERS:
        raise ValueError(f"unknown tier {tier!r}: use one of {', '.join(TIERS)}")
    if kind not in ("berth", "crane"):
        raise ValueError(f"unknown kind {kind!r}: use berth or crane")
    rng = random.Random(f"oakland-{kind}-{tier}-{seed}-{terminal}")
    terminal = terminal or rng.choice(sorted(TERMINALS))
    weeks = WEEKS[tier]
    horizon = 168 * weeks
    cap = MAX_BERTH_SHIPS if kind == "berth" else MAX_SHIPS
    task = make_task(seed, terminal, weeks=weeks, kind=kind)
    task.ships = _trim(task.ships, cap - 4)       # room for diverted and unscheduled calls
    task.task_id = f"oak-{terminal.lower()}-{kind}-{tier}-{seed}"
    task.difficulty = tier
    task.notices.append(f"Generated calls (not real records) at {terminal}, berths {task.quay}, over {weeks} week(s). "
                        f"Hour 0 is Monday 00:00 Pacific.")
    disrupt(task, TIERS[tier], rng, horizon)
    if kind == "crane":
        fix_berths(task)
    return task


__all__ = ["generate_task", "disrupt", "fix_berths", "TIERS", "WEEKS"]
