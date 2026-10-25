"""What the agent reads: the situation (terminal, notices, ships) and the rules, cost and plan format, for both kinds."""

from __future__ import annotations

from datetime import datetime

from .model import MEAL_HOURS, MOVE_PENALTY, SHIFTS, Task
from .world import TERMINALS

PROMPT_VERSION = 1
DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
BERTH_PLAN_FORMAT = '[{"ship": 0, "berth_hour": 36, "section": 22, "cranes": 3}, {"ship": 1, "berth_hour": 163, "section": 24, "cranes": 2}, ...]'
CRANE_PLAN_FORMAT = '[{"ship": 0, "cranes": {"day": 3, "night": 3, "hoot": 1}}, {"ship": 1, "cranes": {"day": 2, "night": 2, "hoot": 0}}, ...]'


def when(h: int) -> str:
    return f"{DAYS[(h // 24) % 7]} {h % 24:02d}:00" + (f" (week {h // 168 + 1})" if h >= 168 else "")


def plan_format(task: Task) -> str:
    return CRANE_PLAN_FORMAT if task.kind == "crane" else BERTH_PLAN_FORMAT


def _shift_lines(task: Task) -> list[str]:
    r = task.rules
    sh = r.get("shifts", SHIFTS)
    meal = r.get("meal_hours", MEAL_HOURS)

    def clock(a: int, b: int) -> str:
        return f"{a % 24:02d}:00-{b % 24:02d}:00"

    return [
        "| shift | hours of the day | cranes available |",
        "|---|---|---|",
        f"| day | {clock(*sh['day'])} | {r['crane_pool']} |",
        f"| night | {clock(*sh['night'])} | {r['crane_pool']} |",
        f"| hoot | {clock(*sh['hoot'])} | {r.get('hoot_pool', r['crane_pool'])} |",
        *[f"| meal | {clock(m, m + 1)} | none work (ships may still berth or leave) |" for m in meal],
    ]


def situation(task: Task) -> str:
    r = task.rules
    term = TERMINALS.get(task.terminal)
    try:
        start = f"{datetime.strptime(task.week_start_utc[:10], '%Y-%m-%d'):%A %d %B %Y}"
    except ValueError:
        start = "Monday"
    weeks = "one week" if task.weeks == 1 else f"{task.weeks} weeks"
    lines = [
        f"# {task.terminal}, Port of Oakland, berths {task.quay}: {weeks}, hours 0-{task.horizon_h}",
        "The terminal, its cranes, depths and shifts are real; the ships are generated calls at the real terminal "
        "(modelled on the services that call Oakland, not real records).",
        f"Hour 0 is {start} 00:00 Pacific. Times are whole hours from then.",
        f"The quay is sections {task.first_section}-{task.last_section} (about {task.section_m:.0f} m each). "
        "A ship needs its number of consecutive sections while it is alongside.",
    ]
    if task.notices:
        lines += ["", "## Notices", *[f"- {n}" for n in task.notices]]
    along = [b for b in task.blocks if b.kind == "alongside"]
    closed = [b for b in task.blocks if b.kind == "closed"]
    shallow = [b for b in task.blocks if b.kind == "shallow"]
    lines += ["", "## Depth"]
    if term is not None:
        deep = sorted({d for d in term.depth_m})
        lines.append(f"- Alongside depth: {', '.join(f'{d:.1f} m' for d in deep)}.")
    if shallow:
        lines += [f"- Sections {b.first}-{b.last}: max draught {b.max_draught_m:.1f} m, ships drawing more may not use "
                  "them." for b in shallow]
    else:
        lines.append("- Every section is deep enough for every ship in the table.")
    if along:
        lines += ["", "## Already alongside at hour 0 (cannot move)"]
        lines += [f"- {b.label}: sections {b.first}-{b.last} until hour {b.end}, {b.cranes} cranes working it" for b in along]
    if closed:
        lines += ["", "## Closed sections"]
        lines += [f"- sections {b.first}-{b.last}, hours {b.start}-{b.end} ({b.label})" for b in closed]
    lines += ["", "## Shifts and quay cranes (ILWU)", *_shift_lines(task), ""]
    lines.append(f"- The terminal has {r['crane_pool']} quay cranes." + "".join(
        f" From hour {o['start']} to hour {o['end']} {o['cranes']} fewer are available"
        f"{' (' + o['reason'] + ')' if o.get('reason') else ''}." for o in r.get("crane_outages", [])))
    lines.append(f"- A crane handles {task.rate} container moves per hour, in every working hour of its shift.")
    lines.append(f"- At most {r.get('max_moves_per_hour', 2)} ships may berth or leave in any one hour (bar pilots and tugs).")
    for w in r.get("no_moves", []):
        who = f"ships of {w['min_length']} m or more" if w.get("min_length") else "all ships"
        why = w.get("reason", w.get("label", "fog"))
        lines.append(f"- No berthing or leaving for {who} from hour {w['start']} ({when(w['start'])}) to hour "
                     f"{w['end']} ({when(w['end'])}): {why}.")
    if task.kind == "crane":
        lines.append(f"- Hoot gangs cost {r.get('hoot_gang_cost', 2)} per crane-hour worked in hoot hours.")
        lines += ["", "## Ships (berth hour and section are fixed)", "",
                  "| id | ship | line | length m | draught m | sections | berth hour | section | moves | cranes min-max | "
                  "published cranes | planned departure (hour) | notes |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for s in sorted(task.ships, key=lambda s: (s.planned_hour if s.planned_hour is not None else s.arrival, s.id)):
            lines.append(f"| {s.id} | {s.name} | {s.line} | {s.length_m:.0f} | {s.draught_m:.1f} | {s.sections} | "
                         f"{s.planned_hour} ({when(s.planned_hour)}) | {s.planned_section} | {s.workload} | "
                         f"{s.min_cranes}-{s.max_cranes} | {s.std_cranes} | {s.due} | {'; '.join(_notes(s))} |")
        return "\n".join(lines)
    lines += ["", "## Ships to berth", "",
              "| id | ship | line | length m | draught m | sections | arrives (hour) | moves | cranes min-max | "
              "planned berth (hour @ section, cranes) | planned departure (hour) | notes |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for s in sorted(task.ships, key=lambda s: (s.planned_hour if s.planned_hour is not None else s.arrival, s.id)):
        planned = ("none (unscheduled)" if s.planned_section is None
                   else f"{s.planned_hour} @ {s.planned_section}, {s.std_cranes} cranes")
        lines.append(f"| {s.id} | {s.name} | {s.line} | {s.length_m:.0f} | {s.draught_m:.1f} | {s.sections} | "
                     f"{s.arrival} ({when(s.arrival)}) | {s.workload} | {s.min_cranes}-{s.max_cranes} | {planned} | "
                     f"{s.due} | {'; '.join(_notes(s))} |")
    return "\n".join(lines)


def _notes(s) -> list[str]:
    notes = []
    if s.berth_deadline is not None:
        notes.append(f"emergency: dock by hour {s.berth_deadline} (+{s.deadline_penalty} per hour later)")
    if s.weight != 1:
        notes.append(f"priority: lateness x{s.weight}")
    return notes


def _tools(max_checks: int) -> str:
    return f"""Tools:
- get_situation(): this situation again.
- check_plan(plan): lists rule violations in your plan and its cost. You have {max_checks} checks.
- submit_plan(plan): your final answer. It ends the episode and is graded once: an infeasible plan scores low, a feasible one scores higher the closer its cost is to the best possible.
Submit before you run out of turns; an episode that ends without a submission scores 0."""


def rules(task: Task, max_checks: int = 10) -> str:
    if task.kind == "crane":
        return crane_rules(task, max_checks)
    r = task.rules
    return f"""You are the berth planner for {task.terminal} at the Port of Oakland. The published plan no longer works. Make a new berth plan for every ship in the table: when it berths, where, and how many quay cranes work it.

Rules (a plan that breaks any of them is infeasible):
- A ship berths at or after its arrival hour, and not inside a no-movement window.
- It gets between its min and max cranes, the same count in every working hour. Cranes work in the day, night and hoot shifts but not in the meal hour ({', '.join(f'{m:02d}:00' for m in r.get('meal_hours', MEAL_HOURS))}). Each working hour does {task.rate} moves per crane; the ship departs when its moves are done, unless that hour is inside a no-movement window, in which case it waits alongside (still occupying its sections, cranes free) until the window ends.
- It occupies `sections` consecutive sections starting at the section you give, all within {task.first_section}-{task.last_section}, and deep enough for its draught.
- No two ships may use the same section in the same hour. Ships already alongside and closed sections are off limits for the hours listed.
  A ship that leaves at hour h frees its sections for a ship berthing at hour h.
- In every hour, the cranes working all ships (including ships already alongside) may not exceed the cranes available that hour: {r['crane_pool']} in day and night hours, {r.get('hoot_pool', r['crane_pool'])} in hoot hours, fewer during an outage.
- At most {r.get('max_moves_per_hour', 2)} movements per hour: a ship berthing at hour h and a ship leaving at hour h each count as one movement in hour h.

Cost (lower is better):
- Delay: for each ship, (its sections) x (hours it departs after its planned departure). Leaving early earns nothing.
- Moves: {MOVE_PENALTY} for each scheduled ship you put on a different starting section than planned. Changing the hour or the cranes costs nothing beyond delay. Unscheduled calls have no planned section.
- Priority ships (notes column): their delay counts that many times. Emergency ships (notes column): each hour they dock after their deadline adds the stated amount.

Plan format, one entry per ship, using the ids from the table:
{BERTH_PLAN_FORMAT}

{_tools(max_checks)}"""


def crane_rules(task: Task, max_checks: int = 10) -> str:
    r = task.rules
    return f"""You are the crane planner for {task.terminal} at the Port of Oakland. Every ship's berth hour and section are fixed. Decide how many quay cranes work each ship in each shift type.

Rules (a plan that breaks any of them is infeasible):
- For every ship give a crane count for day hours, night hours and hoot hours. It applies in every hour of that shift while the ship is alongside. Day and night counts must be within the ship's min-max; the hoot count is 0 (no hoot gang hired) or within min-max.
- Cranes do not work in the meal hour ({', '.join(f'{m:02d}:00' for m in r.get('meal_hours', MEAL_HOURS))}), nor in hoot hours with a hoot count of 0. Each working hour does {task.rate} moves per crane; the ship departs when its moves are done, unless that hour is inside a no-movement window, in which case it waits alongside (still occupying its sections, cranes free) until the window ends.
- A ship stays on its fixed sections until it departs, so it must leave before the next ship on those sections berths: no two ships may use the same section in the same hour.
- In every hour, the cranes working all ships (including ships already alongside) may not exceed the cranes available that hour: {r['crane_pool']} in day and night hours, {r.get('hoot_pool', r['crane_pool'])} in hoot hours, fewer during an outage.
- At most {r.get('max_moves_per_hour', 2)} movements per hour: a ship berthing at hour h and a ship leaving at hour h each count as one movement in hour h.

Cost (lower is better):
- Delay: for each ship, (its sections) x (hours it departs after its planned departure). Leaving early earns nothing.
- Hoot gangs: {r.get('hoot_gang_cost', 2)} per crane-hour worked in hoot hours.
- Priority ships (notes column): their delay counts that many times. Emergency ships (notes column): each hour they dock after their deadline adds the stated amount.

Plan format, one entry per ship, using the ids from the table:
{CRANE_PLAN_FORMAT}

{_tools(max_checks)}"""


def brief(task: Task, max_checks: int = 10) -> str:
    return rules(task, max_checks) + "\n\n" + situation(task)
