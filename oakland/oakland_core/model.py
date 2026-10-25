"""Tasks and plans for OaklandPortEnv.

A task is one or two weeks at one Port of Oakland container terminal (OICT, TraPac, Everport or Matson). The quay is
a row of numbered sections of 42 m (from 1), every ship needs a run of consecutive sections while it is alongside, and
quay cranes work it at 26 container moves per crane-hour in the ILWU shifts (day 08:00-17:00, night 18:00-03:00, hoot
03:00-08:00; 17:00-18:00 is a meal hour with no crane work). Times are whole hours from Monday 00:00 Pacific.

Terminal geometry, crane fleets, depths and shifts are real. The ship calls are GENERATED from the services that call
Oakland, not real records.

Two task kinds share this model:

    kind "berth"   a plan entry is (berth hour, first section, cranes): the agent places every ship.
    kind "crane"   a plan entry is (cranes in day hours, cranes in night hours, cranes in hoot hours): the berth hour
                   and section of every ship are fixed (ship.planned_hour, ship.planned_section) and the agent
                   decides only the crane profile. A hoot count of 0 means no hoot gang is hired for that ship.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import asdict, dataclass, field
from typing import Any, NamedTuple

MOVE_PENALTY = 5  # cost of moving a ship off its planned sections, in section-hours of delay

# ILWU shifts in hours of the day; night 18..27 means 18:00 to 03:00 next day. These are the defaults when a task's
# rules do not carry their own.
SHIFTS: dict[str, list[int]] = {"day": [8, 17], "night": [18, 27], "hoot": [3, 8]}
MEAL_HOURS: list[int] = [17]
SHIFT_NAMES = ("day", "night", "hoot")


@dataclass
class Ship:
    id: int
    name: str
    imo: str
    length_m: float
    sections: int              # consecutive sections the ship needs
    arrival: int               # earliest hour it can berth (after any delay notice)
    handling: int              # hours alongside in the published plan (std cranes, from the planned hour)
    planned_hour: int | None   # berthing hour in the published plan (None: unscheduled call); fixed on crane tasks
    planned_section: int | None
    due: int                   # planned departure hour; leaving later costs sections x hours
    from_port: str = ""
    to_port: str = ""
    beam_m: float | None = None
    draught_m: float | None = None
    workload: int | None = None     # container moves to load and discharge (26 per crane-hour)
    min_cranes: int | None = None
    max_cranes: int | None = None
    std_cranes: int | None = None   # cranes the published plan assumed
    weight: int = 1                  # delay multiplier (priority cargo)
    berth_deadline: int | None = None  # emergency: must be berthed by this hour ...
    deadline_penalty: int = 0          # ... or pay this much per hour berthed after it
    line: str = ""                     # carrier operating the service (generated call)
    service: str = ""                  # generated service code

    @property
    def planned_departure(self) -> int:
        return self.due


@dataclass
class Block:
    """A rectangle of quay a ship may not use: a ship already alongside, closed sections, or sections too shallow
    for ships drawing more than `max_draught_m`."""
    first: int
    last: int                  # inclusive
    start: int                 # hour
    end: int                   # hour, exclusive
    kind: str                  # "alongside" | "closed" | "shallow"
    label: str = ""
    cranes: int = 0            # cranes working a ship already alongside (in every crane-working hour)
    max_draught_m: float | None = None   # shallow blocks: ships with a deeper draught may not use these sections

    def applies_to(self, ship: Ship) -> bool:
        if self.kind != "shallow":
            return True
        return self.max_draught_m is not None and (ship.draught_m or 0.0) > self.max_draught_m


@dataclass
class Task:
    task_id: str
    split: str
    quay: str
    terminal: str
    first_section: int
    last_section: int
    section_m: float
    week: int
    week_start_utc: str
    ships: list[Ship]
    blocks: list[Block]
    notices: list[str]
    disruptions: list[dict]
    difficulty: str
    reference: dict = field(default_factory=dict)   # naive/optimal costs and plans: never shown to the agent
    rules: dict = field(default_factory=dict)       # crane_pool, crane_outages, shifts, hoot_pool, no_moves, ...
    kind: str = "berth"                             # "berth" | "crane"
    weeks: int = 1

    @property
    def n_sections(self) -> int:
        return self.last_section - self.first_section + 1

    @property
    def horizon_h(self) -> int:
        return 168 * max(1, int(self.weeks))

    def ship(self, sid: int) -> Ship:
        return self.ships[sid]

    def to_dict(self, public: bool = False) -> dict:
        d = asdict(self)
        if public:
            d.pop("reference")
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Task":
        d = dict(d)
        d["ships"] = [Ship(**s) for s in d["ships"]]
        d["blocks"] = [Block(**b) for b in d["blocks"]]
        d.setdefault("reference", {})
        d.setdefault("rules", {})
        return cls(**d)

    @property
    def cranes(self) -> bool:
        return bool(self.rules.get("crane_pool"))

    @property
    def fixed_berths(self) -> bool:
        return self.kind == "crane"

    @property
    def rate(self) -> int:
        return int(self.rules.get("moves_per_crane_hour", 26))

    def shift_of(self, hour: int) -> str:
        """"day" | "night" | "hoot" | "meal" for an absolute hour (meal: no crane works)."""
        hod = hour % 24
        if hod in self.rules.get("meal_hours", MEAL_HOURS):
            return "meal"
        for name, (a, b) in self.rules.get("shifts", SHIFTS).items():
            if a <= hod < b or a <= hod + 24 < b:
                return name
        return "meal"

    def crane_pool_at(self, hour: int) -> int:
        pool = int(self.rules["crane_pool"])
        for o in self.rules.get("crane_outages", []):
            if o["start"] <= hour < o["end"]:
                pool -= int(o["cranes"])
        if self.shift_of(hour) == "hoot" and self.rules.get("hoot_pool") is not None:
            pool = min(pool, int(self.rules["hoot_pool"]))
        return max(0, pool)

    def no_move_windows(self, ship: "Ship") -> list[tuple[int, int]]:
        """Merged hour windows [start, end) in which this ship may not berth or leave (fog, bar closures)."""
        ws = sorted((w["start"], w["end"]) for w in self.rules.get("no_moves", [])
                    if ship.length_m >= w.get("min_length", 0))
        out: list[list[int]] = []
        for a, b in ws:
            if out and a <= out[-1][1]:
                out[-1][1] = max(out[-1][1], b)
            else:
                out.append([a, b])
        return [(a, b) for a, b in out]

    def departure(self, ship: "Ship", finish: int) -> int:
        """A ship that finishes inside a no-movement window waits alongside until the window ends."""
        for a, b in self.no_move_windows(ship):
            if a <= finish < b:
                return b
        return finish

    def cranes_of(self, plan_entry: tuple) -> int | None:
        return plan_entry[2] if len(plan_entry) > 2 else None

    def planned(self) -> dict[int, tuple]:
        """The published plan for ships that had one, at the standard crane count: (hour, section, std) on berth
        tasks, (std, std, std) on crane tasks."""
        if self.kind == "crane":
            return {s.id: CraneEntry(s.std_cranes, s.std_cranes, s.std_cranes)
                    for s in self.ships if s.planned_section is not None}
        return {s.id: (s.planned_hour, s.planned_section) + ((s.std_cranes,) if self.cranes else ())
                for s in self.ships if s.planned_section is not None}


class CraneEntry(NamedTuple):
    """A crane-task plan entry: cranes in day, night and hoot hours. Equal to the plain tuple (day, night, hoot)."""
    day: int
    night: int
    hoot: int


Plan = dict[int, tuple]   # ship id -> (hour, section, cranes) on berth tasks, (day, night, hoot) on crane tasks


class PlanError(ValueError):
    pass


def _whole(v: Any, lo: int, hi: int) -> int:
    """A whole number within [lo, hi], or ValueError (booleans, NaN, inf, fractions and text are refused)."""
    if isinstance(v, bool):
        raise ValueError
    if isinstance(v, str):
        v = v.strip()
        if not re.fullmatch(r"-?\d{1,7}", v):
            raise ValueError
        v = int(v)
    if isinstance(v, float) and not math.isfinite(v):
        raise ValueError
    n = int(v)
    if n != float(v) or not lo <= n <= hi:
        raise ValueError
    return n


def _crane_triple(v: Any) -> tuple[Any, Any, Any] | None:
    if isinstance(v, dict):
        if not all(k in v for k in SHIFT_NAMES):
            return None
        return v["day"], v["night"], v["hoot"]
    if isinstance(v, (list, tuple)) and len(v) == 3:
        return v[0], v[1], v[2]
    return None


def parse_plan(task: Task, raw: Any) -> tuple[Plan, list[str]]:
    """Read a plan from what a model sends: a list of plan objects (or a JSON string of one), or a {ship_id: entry}
    mapping. Ships may be named by id or by name.

    kind "berth": {"ship": 0, "berth_hour": 12, "section": 7, "cranes": 3} (or {id: [hour, section, cranes]}).
    kind "crane": {"ship": 0, "cranes": {"day": 3, "night": 3, "hoot": 1}} (or {id: {"day":..}} / {id: [d, n, h]}).

    Returns the plan and a list of problems with entries that could not be read (unknown ship, duplicate,
    non-integer values)."""
    if isinstance(raw, str):
        text = raw.strip()
        fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
        if fence:
            text = fence.group(1)
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as e:
            raise PlanError(f"plan is not valid JSON: {e.msg} at position {e.pos}") from None
        except RecursionError:
            raise PlanError("plan is nested too deeply") from None
    if isinstance(raw, dict) and "plan" in raw and len(raw) == 1:
        raw = raw["plan"]
    crane = task.kind == "crane"
    fmt = ('{"ship": 3, "cranes": {"day": 3, "night": 3, "hoot": 1}}' if crane
           else '{"ship": 3, "berth_hour": 40, "section": 12, "cranes": 3}')
    entries: list[tuple[Any, Any, Any, Any]] = []
    if isinstance(raw, dict):
        for k, v in raw.items():
            if crane:
                if isinstance(v, dict) and "cranes" in v:
                    entries.append((k, None, None, v.get("cranes")))
                else:
                    entries.append((k, None, None, v))
            elif isinstance(v, dict):
                entries.append((k, v.get("berth_hour", v.get("hour")), v.get("section"), v.get("cranes")))
            elif isinstance(v, (list, tuple)) and len(v) in (2, 3):
                entries.append((k, v[0], v[1], v[2] if len(v) == 3 else None))
            else:
                entries.append((k, None, None, None))
    elif isinstance(raw, list):
        for e in raw:
            if not isinstance(e, dict):
                raise PlanError(f"each plan entry must be an object like {fmt}")
            entries.append((e.get("ship", e.get("id", e.get("name"))), e.get("berth_hour", e.get("hour")),
                            e.get("section"), e.get("cranes")))
    else:
        raise PlanError(f"plan must be a list of objects like {fmt}")

    if len(entries) > 4 * len(task.ships) + 10:
        raise PlanError(f"plan has {len(entries)} entries for {len(task.ships)} ships")
    horizon = 100 * 24 * 7  # no plan needs hours beyond ~100 weeks; refusing them keeps grading cheap
    by_name: dict[str, list[int]] = {}
    for s in task.ships:
        by_name.setdefault(s.name.upper(), []).append(s.id)
    plan: Plan = {}
    problems: list[str] = []
    for key, hour, section, cranes in entries:
        sid = None
        if isinstance(key, bool):
            pass
        elif isinstance(key, int) or (isinstance(key, str) and re.fullmatch(r"\s*-?\d{1,7}\s*", key)):
            sid = int(key)
        elif isinstance(key, str) and len(by_name.get(key.strip().upper(), [])) == 1:
            sid = by_name[key.strip().upper()][0]
        if sid is None or not 0 <= sid < len(task.ships):
            problems.append(f"unknown ship {str(key)[:40]!r}: use the ship ids from the table")
            continue
        if sid in plan:
            problems.append(f"ship {sid} appears more than once; the first entry is used")
            continue
        if crane:
            trip = _crane_triple(cranes)
            if trip is None:
                problems.append(f"ship {sid}: cranes must be an object {{\"day\": d, \"night\": n, \"hoot\": h}}")
                continue
            try:
                d, n, ho = (_whole(x, -1000, 1000) for x in trip)
            except (TypeError, ValueError, OverflowError):
                problems.append(f"ship {sid}: day, night and hoot cranes must be whole numbers")
                continue
            plan[sid] = CraneEntry(d, n, ho)
            continue
        try:
            h, sec = _whole(hour, -horizon, horizon), _whole(section, -1000, 1000)
        except (TypeError, ValueError, OverflowError):
            problems.append(f"ship {sid}: berth_hour and section must be whole numbers in range")
            continue
        if task.cranes:
            if cranes is None:
                cranes = task.ships[sid].std_cranes
            try:
                c = _whole(cranes, -1000, 1000)
            except (TypeError, ValueError, OverflowError):
                problems.append(f"ship {sid}: cranes must be a whole number")
                continue
            plan[sid] = (h, sec, c)
        else:
            plan[sid] = (h, sec)
    return plan, problems


def _is_crane_entry(entry: tuple, kind: str | None) -> bool:
    if kind is not None:
        return kind == "crane"
    return isinstance(entry, CraneEntry)


def plan_to_list(plan: Plan, kind: str | None = None) -> list[dict]:
    """The plan as JSON rows. Crane entries are recognised by `kind="crane"` or by being CraneEntry tuples (what
    parse_plan returns); a plain 3-tuple without `kind` is read as a berth entry (hour, section, cranes)."""
    out = []
    for sid, entry in sorted(plan.items()):
        if _is_crane_entry(entry, kind):
            out.append({"ship": sid, "cranes": {"day": entry[0], "night": entry[1], "hoot": entry[2]}})
            continue
        row = {"ship": sid, "berth_hour": entry[0], "section": entry[1]}
        if len(entry) > 2 and entry[2] is not None:
            row["cranes"] = entry[2]
        out.append(row)
    return out


def plan_from_list(rows: list[dict]) -> Plan:
    """Inverse of plan_to_list: a row whose "cranes" is an object is a crane entry, anything else a berth entry."""
    plan: Plan = {}
    for r in rows:
        c = r.get("cranes")
        if isinstance(c, dict):
            plan[int(r["ship"])] = CraneEntry(int(c["day"]), int(c["night"]), int(c["hoot"]))
        else:
            plan[int(r["ship"])] = (int(r["berth_hour"]), int(r["section"])) + ((int(c),) if c is not None else ())
    return plan
