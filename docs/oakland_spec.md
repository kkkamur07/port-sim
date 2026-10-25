# OaklandPortEnv: specification for the generated environment

You are generating a sibling of PortSimEnv v1 (whose source is in this bundle) for the **Port of Oakland**,
California. Keep its shape: one plan as the action, graded once, deterministically, against a reference plan a
solver proved optimal. Two task kinds share one world.

## The world (real facts, from the Port of Oakland facilities pages)

| terminal | berths | quay length | cranes | depth | sections (42 m) |
|---|---|---|---|---|---|
| OICT (SSA Marine), berths 55-60 | 55-60 | 6,855 ft / 2,089 m | 10 super post-Panamax | 50 ft (42 ft at berth 60) | 50 |
| TraPac, berths 25-33 | 25-33 | 4,263 ft / 1,300 m | 7 (5 post-Panamax, 2 super post-Panamax) | 50 ft | 31 |
| Everport, berths 35-38 | 35-38 | 2,157 ft / 657 m | 4 super post-Panamax | 50 ft | 15 |
| Matson, berths 61-63 | 61-63 | 1,888 ft / 575 m | 4 post-Panamax | 42 ft | 13 |

Each task is one terminal (its quay as numbered sections of 42 m, numbered from 1), one or two weeks, hour 0 Monday
00:00 Pacific. The ships are **generated calls**, built from real services that call Oakland (transpacific loops of
ONE, Maersk, MSC, CMA CGM, Evergreen, Hapag-Lloyd, OOCL, COSCO, Yang Ming, Wan Hai, Matson's Hawaii and Guam
services at Matson) with realistic lengths (180-400 m), move counts and weekly patterns. Label them as generated
everywhere a human reads them. Do not invent "real 2024 records".

Oakland specifics to model (all as rules in `task.rules`, so the checker is data-driven):

- **Labor shifts (ILWU):** day 08:00-17:00, night 18:00-03:00, hoot 03:00-08:00. Cranes work in all shifts, but the
  hoot shift has fewer gangs: the crane pool in hoot hours is `rules["hoot_pool"]` (about 60% of the fleet, rounded
  down). Hours 17:00-18:00 are a meal hour: cranes do not work, ships may still berth or leave.
- **Draught and depth:** ships with draught over the berth depth may not use those sections (Matson 42 ft, OICT
  berth 60 sections). Represent as `blocks` of kind "shallow" with a `max_draught_m`, or as a per-section depth list.
- **Fog and bar closures:** no-movement windows like PortSim's wind windows, applying to all ships (`no_moves` with
  `min_length` 0), from a generated fog season (summer mornings) or storms.
- **Movement limit:** at most 2 berthings or departures per hour per terminal (Bar pilots and tug capacity).
- **Productivity:** 26 moves per crane-hour. Hours alongside = ceil(moves / (26 x cranes)) counting only hours when
  cranes work (not the meal hour), then departure waits for any no-movement window.
- **Cranes per ship:** min 1, max by length (one per 55 m, capped at 6 at OICT, 4 elsewhere). The published plan
  assumes `std_cranes`.

## Task kind A: berth allocation (`kind = "berth"`)

Exactly PortSim's dock-v1 decision: for every ship, `{"ship", "berth_hour", "section", "cranes"}`. Rules: berth at or
after arrival, not inside a no-movement window, consecutive sections inside the quay and deep enough, no
section-hour shared with another ship, a ship already alongside or a closed section, cranes within the ship's range
and within the pool every hour (hoot pool in hoot hours), movement limit per hour. Cost: sections x hours late past
planned departure (x weight for priority cargo), plus emergency penalties, plus 5 per scheduled ship moved off its
planned section.

## Task kind B: crane scheduling (`kind = "crane"`)

Berths and berth hours are **fixed** (given in the situation, already feasible on sections). The agent decides the
crane profile of every ship: `{"ship", "cranes": {"day": c1, "night": c2, "hoot": c3}}`, a crane count per shift
type that applies in every hour of that shift while the ship is alongside. The ship departs when its moves are done.
Rules: each count within the ship's min-max (0 allowed only for hoot, meaning no hoot gang hired), the total cranes
working in every hour within the pool of that hour (with outages), and the departure must not fall inside a
no-movement window (then it waits, cranes free). Cost: sections x hours late past planned departure (x weight), plus
emergency penalties, plus a gang cost: `rules["hoot_gang_cost"]` (default 2) per crane-hour worked in the hoot shift,
since hoot gangs are paid more. Infeasible if two ships' fixed berths ever overlap, which the generator must never
produce.

## Disruptions (generator, per tier and seed)

Late and bunched ships (transpacific weather), crane outages, fog windows, a closed berth (crane rail repair or a
labor stoppage), diverted traffic from LA/Long Beach, unscheduled calls, an emergency (reefer failure on an export
ag cargo: dock by a deadline or pay per hour), priority cargo (lateness counts triple). Tiers standard / busy /
storm / extreme like PortSim. Keep a task only if the solver proves the optimum within its time limit, the naive
re-plan scores at most 0.6 and the greedy heuristic at most 0.85.

## Reward

PortSim's v3 reward unchanged: infeasible `0.2 x clean fraction`; feasible `0.2 + 0.8 exp(-g/0.5)` with
`g = (cost - optimum) / (optimum - floor + 100)` and the floor computed like `check.unavoidable_cost` (for crane
tasks: every ship with max cranes in every shift, no pool limit).

## Required public API of the package `oakland_core` (the harness calls exactly these)

```python
from oakland_core import Task, Ship, Block, Plan, PlanError           # dataclasses like berth_core
from oakland_core import parse_plan, plan_to_list, plan_from_list     # same signatures as berth_core
from oakland_core import evaluate, grade, unavoidable_cost            # evaluate(task, plan) -> PlanResult; grade(task, plan, problems=None) -> Grade
from oakland_core import generate_task                               # generate_task(seed: int, tier: str, kind: str, terminal: str | None = None) -> Task
from oakland_core import solve, naive_plan, greedy_plan              # solve(task, time_limit_s=30.0) -> (Plan, cost, proven: bool); naive_plan(task) -> Plan; greedy_plan(task) -> Plan
from oakland_core import rules, situation                            # the two prompt texts, like berth_core.prompts
from oakland_core import build_pack                                  # build_pack(n: int, split: str, kind: str, seed0: int, time_limit_s: float) -> list[Task] with task.reference filled
from oakland_core import render                                      # render(task, plan, path) -> writes a PNG berth-time chart (matplotlib): sections on y, hours on x, one box per ship labelled with id and cranes, closures and no-movement windows shaded
```

`Task.to_dict()` / `Task.from_dict()` must round-trip through JSON. `task.kind` is "berth" or "crane". `task.reference`
holds `optimal_plan`, `optimal_cost`, `naive_cost`, `greedy_cost`, `proven_optimal`. `task.difficulty` is the tier.
Everything the agent reads comes from `rules(task)` and `situation(task)`.

## Deliverables (files, each in its own block)

```
oakland/oakland_core/__init__.py      the API above
oakland/oakland_core/model.py         Task, Ship, Block, Plan, parse_plan, plan_to_list, plan_from_list
oakland/oakland_core/world.py         the four terminals, services, ship generator, shifts
oakland/oakland_core/check.py         evaluate, unavoidable_cost (pure Python, no solver)
oakland/oakland_core/reward.py        grade, Grade
oakland/oakland_core/generate.py      generate_task, disruptions, tiers
oakland/oakland_core/solve.py         solve (OR-Tools CP-SAT), naive_plan, greedy_plan
oakland/oakland_core/prompts.py       rules, situation
oakland/oakland_core/pack.py          build_pack, save/load jsonl
oakland/oakland_core/render.py        render
oakland/tests/test_*.py               your own tests: checker vs an independent occupancy grid, hostile plans, solver vs brute force on tiny tasks, lazy policies stay low, prompt round trip
oakland/README.md                     what is real, what is generated, the rules, the reward, how to run
```

Pure Python 3.12, standard library plus `ortools` and `matplotlib` only. No network. Deterministic from the seed.
Write complete files, no placeholders, no "..." elisions. Prefer correctness over cleverness: the checker must be an
hour-by-section grid with clear error messages per ship, like berth_core.check, so a model that reads a violation
can repair it.
