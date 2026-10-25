"""The Oakland world: four container terminals, the ILWU shifts, the services that call, and a ship generator.

Real (Port of Oakland facilities pages): terminal berths, quay lengths, crane fleets, depths (50 ft, 42 ft at OICT
berth 60 and at Matson) and the ILWU shift pattern. GENERATED: every ship call. The services below are modelled on
the transpacific loops and Matson's Hawaii and Guam services that call Oakland (carriers, typical ship lengths, move
counts, weekly patterns), but the ship names, IMO numbers and calls are made up, not real records.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass

from .check import work
from .model import MEAL_HOURS, SHIFT_NAMES, SHIFTS, Block, Ship, Task

SECTION_M = 42.0
MOVES_PER_CRANE_HOUR = 26
DEEP_M = 15.2      # 50 ft
SHALLOW_M = 12.8   # 42 ft
MAX_DRAUGHT_M = 15.0


@dataclass(frozen=True)
class Terminal:
    name: str
    operator: str
    berths: str
    quay_m: float
    sections: int
    crane_pool: int
    max_cranes_per_ship: int
    depth_m: tuple[float, ...]   # depth of each section, section 1 first
    cranes_note: str


def _depths(n: int, shallow_tail: int = 0, all_shallow: bool = False) -> tuple[float, ...]:
    if all_shallow:
        return tuple(SHALLOW_M for _ in range(n))
    return tuple(DEEP_M if i < n - shallow_tail else SHALLOW_M for i in range(n))


# Section counts are the spec table's (about 42 m each).
TERMINALS: dict[str, Terminal] = {
    "OICT": Terminal("OICT", "SSA Marine", "55-60", 2089.0, 50, 10, 6, _depths(50, shallow_tail=4),
                     "10 super post-Panamax"),
    "TraPac": Terminal("TraPac", "TraPac", "25-33", 1300.0, 31, 7, 4, _depths(31),
                       "7 (5 post-Panamax, 2 super post-Panamax)"),
    "Everport": Terminal("Everport", "Everport", "35-38", 657.0, 15, 4, 4, _depths(15), "4 super post-Panamax"),
    "Matson": Terminal("Matson", "Matson", "61-63", 575.0, 13, 4, 4, _depths(13, all_shallow=True),
                       "4 post-Panamax"),
}


def hoot_pool(terminal: str) -> int:
    """Cranes with a gang in hoot hours (03:00-08:00): about 60 % of the fleet, rounded down."""
    return int(math.floor(0.6 * TERMINALS[terminal].crane_pool))


def crane_class(length_m: float, cap: int = 4) -> tuple[int, int, int]:
    """(min, max, std) cranes for a ship: max one per 55 m of length (capped), std about half of it."""
    mx = max(1, min(cap, int(length_m // 55)))
    std = max(1, (mx + 1) // 2)
    return 1, mx, std


def draught_for(length_m: float, rng: random.Random) -> float:
    """A plausible loaded draught for a container ship of this length (generated)."""
    d = 9.5 + (length_m - 180.0) * 0.025 + rng.uniform(-0.4, 0.4)
    return round(min(MAX_DRAUGHT_M, max(8.5, d)), 1)


@dataclass(frozen=True)
class Service:
    code: str
    carrier: str
    names: tuple[str, ...]       # generated ship names of the rotation
    length_m: tuple[int, int]
    moves: tuple[int, int]
    weekdays: tuple[int, ...]    # 0 = Monday
    hour: int                    # usual arrival hour of the day
    terminals: tuple[str, ...]
    from_port: str
    to_port: str


SERVICES: tuple[Service, ...] = (
    Service("PS3", "ONE", ("ONE AQUILA", "ONE CYGNUS", "ONE LYRA", "ONE DRACO"), (330, 364), (1600, 2600),
            (0, 3), 6, ("OICT", "TraPac"), "Tokyo", "Busan"),
    Service("TP6", "Maersk", ("MAERSK KOLDING", "MAERSK ESBJERG", "MAERSK HORSENS"), (300, 367), (1500, 2500),
            (1, 4), 14, ("OICT",), "Yantian", "Ningbo"),
    Service("PEARL", "MSC", ("MSC ARIELLA", "MSC FIORELLA", "MSC CAMILLA", "MSC ORNELLA"), (330, 400), (1800, 2800),
            (2, 5), 10, ("OICT", "TraPac"), "Long Beach", "Shanghai"),
    Service("PEX3", "CMA CGM", ("CMA CGM SIRIUS", "CMA CGM VEGA", "CMA CGM ALTAIR"), (300, 366), (1400, 2400),
            (0, 4), 20, ("OICT", "Everport"), "Xiamen", "Kaohsiung"),
    Service("CPS", "Evergreen", ("EVER LUCENT", "EVER LIVELY", "EVER LOYAL", "EVER LEGEND"), (290, 335), (1200, 2200),
            (1, 3, 6), 8, ("Everport", "OICT"), "Kaohsiung", "Tokyo"),
    Service("PN2", "Hapag-Lloyd", ("ALAMEDA EXPRESS", "SONOMA EXPRESS", "MARIN EXPRESS"), (280, 335), (1100, 2000),
            (2, 6), 16, ("TraPac", "OICT"), "Seattle", "Qingdao"),
    Service("PCC1", "OOCL", ("OOCL FRESNO", "OOCL MODESTO", "OOCL STOCKTON"), (300, 366), (1300, 2300),
            (0, 5), 12, ("OICT", "TraPac"), "Hong Kong", "Yokohama"),
    Service("AAC", "COSCO", ("COSCO JADE", "COSCO PEARL", "COSCO CORAL"), (300, 366), (1400, 2400),
            (3, 6), 4, ("OICT", "Everport"), "Shanghai", "Xiamen"),
    Service("PS5", "Yang Ming", ("YM TOPAZ", "YM GARNET", "YM AMBER"), (280, 334), (1100, 2000),
            (1, 5), 18, ("Everport", "TraPac"), "Kaohsiung", "Busan"),
    Service("AA7", "Wan Hai", ("WAN HAI 371", "WAN HAI 372", "WAN HAI 373"), (180, 270), (600, 1300),
            (2, 4, 6), 9, ("TraPac", "OICT", "Everport"), "Ho Chi Minh City", "Laem Chabang"),
    Service("EC1", "ONE", ("ONE ORION", "ONE PERSEUS", "ONE ANDROMEDA"), (260, 340), (1000, 1900),
            (1, 4), 2, ("TraPac",), "Manzanillo", "Tokyo"),
    Service("HAW", "Matson", ("KANALOA", "MANULANI", "KAUAI SKY", "MAUNA HALE"), (200, 260), (700, 1400),
            (0, 2, 4), 7, ("Matson",), "Honolulu", "Long Beach"),
    Service("GUAM", "Matson", ("NANI KAI", "MOANA ALOHA", "LAHAINA SUN"), (190, 245), (600, 1200),
            (3, 5), 11, ("Matson",), "Guam", "Honolulu"),
)


def calls_per_week(terminal: str) -> int:
    """8 ships per week at the shortest terminal up to 24 at the longest, scaled to the quay."""
    n = TERMINALS[terminal].sections
    lo, hi = min(t.sections for t in TERMINALS.values()), max(t.sections for t in TERMINALS.values())
    return int(round(8 + 16 * (n - lo) / (hi - lo)))


def base_rules(terminal: str) -> dict:
    """The rules of an undisturbed task at this terminal (generate.py adds outages and no-movement windows)."""
    return {
        "crane_pool": TERMINALS[terminal].crane_pool,
        "crane_outages": [],
        "max_moves_per_hour": 2,
        "no_moves": [],
        "reward": 3,
        "gap_k": 100,
        "moves_per_crane_hour": MOVES_PER_CRANE_HOUR,
        "shifts": {k: list(v) for k, v in SHIFTS.items()},
        "meal_hours": list(MEAL_HOURS),
        "hoot_pool": hoot_pool(terminal),
        "hoot_gang_cost": 2,
    }


def shallow_blocks(terminal: str, horizon: int) -> list[Block]:
    """Runs of sections shallower than 15.2 m, as blocks over the whole horizon."""
    depths = TERMINALS[terminal].depth_m
    out: list[Block] = []
    i = 0
    while i < len(depths):
        if depths[i] < DEEP_M:
            j = i
            while j + 1 < len(depths) and depths[j + 1] == depths[i]:
                j += 1
            out.append(Block(i + 1, j + 1, 0, horizon, "shallow", f"max draught {depths[i]:.1f} m",
                             max_draught_m=depths[i]))
            i = j + 1
        else:
            i += 1
    return out


def moves_scale(terminal: str, services: list[Service], utilisation: float = 0.45) -> float:
    """Scale the services' move counts so a week of calls uses about `utilisation` of the terminal's crane-hours
    (the small terminals have small fleets, and the hoot shift has fewer gangs)."""
    t = TERMINALS[terminal]
    hp = hoot_pool(terminal)
    crane_hours = 7 * (t.crane_pool * 18 + hp * 5)
    mean = sum(sum(s.moves) / 2 for s in services) / max(1, len(services))
    return min(1.0, utilisation * crane_hours * MOVES_PER_CRANE_HOUR / (calls_per_week(terminal) * mean))


class _Yard:
    """Section-hour occupancy, crane use and movements of the published plan while it is being built."""

    def __init__(self, task: Task):
        self.task = task
        self.occ: set[tuple[int, int]] = set()
        self.use: dict[int, int] = {}
        self.moves: dict[int, int] = {}

    def fits(self, ship: Ship, h: int, sec: int, c: int) -> tuple[bool, int, list[tuple[int, int]]]:
        t = self.task
        last = sec + ship.sections - 1
        if sec < t.first_section or last > t.last_section:
            return False, 0, []
        for b in t.blocks:
            if b.applies_to(ship) and sec <= b.last and b.first <= last and h < b.end and b.start < h + 1:
                return False, 0, []
        finish, rows = work(t, ship, h, {name: c for name in SHIFT_NAMES})
        dep = t.departure(ship, finish)
        if self.moves.get(h, 0) >= 2 or self.moves.get(dep, 0) >= 2 or (h == dep and self.moves.get(h, 0) >= 1):
            return False, 0, []
        for b in t.blocks:
            if b.applies_to(ship) and sec <= b.last and b.first <= last and h < b.end and b.start < dep:
                return False, 0, []
        for hr in range(h, dep):
            for s in range(sec, last + 1):
                if (hr, s) in self.occ:
                    return False, 0, []
        for hr, cc in rows:
            if self.use.get(hr, 0) + cc > t.crane_pool_at(hr):
                return False, 0, []
        return True, dep, rows

    def take(self, h: int, dep: int, sec: int, last: int, rows: list[tuple[int, int]]) -> None:
        for hr in range(h, dep):
            for s in range(sec, last + 1):
                self.occ.add((hr, s))
        for hr, cc in rows:
            self.use[hr] = self.use.get(hr, 0) + cc
        self.moves[h] = self.moves.get(h, 0) + 1
        self.moves[dep] = self.moves.get(dep, 0) + 1


def _imo(rng: random.Random) -> str:
    return "GEN" + str(rng.randint(9_000_000, 9_999_999))


def generate_calls(rng: random.Random, terminal: str, weeks: int) -> tuple[list[Ship], list[Block]]:
    """Generated ship calls for `weeks` weeks at `terminal` and a published plan (planned_hour, planned_section,
    std_cranes, due) that is feasible under the rules with no disruption: no shared section-hour, deep enough
    sections, cranes within the pool every hour (hoot pool in hoot hours), at most 2 movements per hour. One or two
    ships are already alongside at hour 0 (returned as "alongside" blocks); shallow sections come back as "shallow"
    blocks. Ships arrive at their planned hour (arrival = planned_hour) and are due at their planned departure, so the
    published plan costs 0. The calls are GENERATED, not real records."""
    term = TERMINALS[terminal]
    horizon = 168 * weeks
    rules = base_rules(terminal)
    blocks = shallow_blocks(terminal, horizon)
    scratch = Task("gen", "gen", term.berths, terminal, 1, term.sections, SECTION_M, 0, "", [], blocks, [], [],
                   "none", rules=rules, kind="berth", weeks=weeks)
    yard = _Yard(scratch)
    services = [s for s in SERVICES if terminal in s.terminals]
    rotation: dict[str, int] = {s.code: rng.randrange(len(s.names)) for s in services}

    def make(svc: Service, sid: int, arrival: int, moves_scale: float = 1.0) -> Ship:
        name = svc.names[rotation[svc.code] % len(svc.names)]
        rotation[svc.code] += 1
        length = random.Random(name).randint(*svc.length_m)   # one generated ship keeps one length
        mn, mx, std = crane_class(length, term.max_cranes_per_ship)
        moves = int(round(rng.randint(*svc.moves) * moves_scale / 10.0)) * 10
        return Ship(sid, name, _imo(rng), float(length), int(math.ceil(length / SECTION_M)), arrival, 0, None, None,
                    arrival, svc.from_port, svc.to_port, round(length / 7.6, 1), draught_for(length, rng),
                    max(MOVES_PER_CRANE_HOUR, moves), mn, mx, std, line=svc.carrier, service=svc.code)

    # ships already alongside at hour 0: a part of their moves is left, placed as blocks
    n_along = rng.choice((1, 2))
    for k in range(n_along):
        svc = rng.choice(services)
        s = make(svc, -1 - k, 0, moves_scale=rng.uniform(0.2, 0.5))
        starts = list(range(1, term.sections - s.sections + 2))
        rng.shuffle(starts)
        for sec in starts:
            ok, dep, rows = yard.fits(s, 0, sec, s.std_cranes)
            if ok:
                yard.take(0, dep, sec, sec + s.sections - 1, rows)
                blocks.append(Block(sec, sec + s.sections - 1, 0, dep, "alongside",
                                    f"{s.name} ({s.line}, generated call)", cranes=s.std_cranes))
                break

    # this week's calls: weekday and hour from the service pattern, a few hours of jitter
    wanted: list[tuple[int, Service]] = []
    per_week = calls_per_week(terminal)
    for w in range(weeks):
        slots = [(svc, d) for svc in services for d in svc.weekdays]
        for i in range(per_week):
            svc, d = slots[i % len(slots)] if i < len(slots) else rng.choice(slots)
            hour = w * 168 + d * 24 + svc.hour + rng.randint(-4, 4)
            wanted.append((max(1, min(horizon - 30, hour)), svc))
    wanted.sort(key=lambda x: (x[0], x[1].code))
    scale = moves_scale(terminal, services)

    ships: list[Ship] = []
    for arrival, svc in wanted:
        s = make(svc, len(ships), arrival, scale)
        home = rng.randint(1, max(1, term.sections - s.sections + 1))
        starts = sorted(range(1, term.sections - s.sections + 2), key=lambda x: (abs(x - home), x))
        placed = False
        for h in range(arrival, min(horizon - 12, arrival + 96)):
            for sec in starts:
                ok, dep, rows = yard.fits(s, h, sec, s.std_cranes)
                if ok:
                    yard.take(h, dep, sec, sec + s.sections - 1, rows)
                    s.arrival, s.planned_hour, s.planned_section = h, h, sec
                    s.handling, s.due = dep - h, dep
                    placed = True
                    break
            if placed:
                break
        if placed:
            ships.append(s)
    ships.sort(key=lambda s: (s.planned_hour, s.planned_section))
    for i, s in enumerate(ships):
        s.id = i
    return ships, blocks


def make_task(seed: int, terminal: str, weeks: int = 1, kind: str = "berth", split: str = "train") -> Task:
    """An undisturbed task (published plan intact): the base generate.py disrupts. Week 1 starts Monday
    2026-10-26 00:00 Pacific (07:00 UTC)."""
    rng = random.Random(f"oakland-{terminal}-{weeks}-{seed}")
    ships, blocks = generate_calls(rng, terminal, weeks)
    term = TERMINALS[terminal]
    rules = base_rules(terminal)
    if kind == "crane":
        rules["fixed_berths"] = True
    return Task(f"oak-{terminal.lower()}-{kind}-w{weeks}-{seed}", split, term.berths, terminal, 1, term.sections,
                SECTION_M, 1, "2026-10-26T07:00:00Z", ships, blocks, [], [], "none", rules=rules, kind=kind,
                weeks=weeks)
