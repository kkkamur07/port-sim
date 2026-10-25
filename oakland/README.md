# OaklandPortEnv

A berth and crane planning environment for the **Port of Oakland**, California. The agent gets one terminal over
one or two weeks after something went wrong (late ships, fog, a crane outage, a closed berth), writes one plan, and
the plan is graded once, deterministically, against a reference plan that a CP-SAT solver proved optimal.

OaklandPortEnv is adapted from FineEnvs **PortSimEnv v1** (the Barcelona berth planner, Apache-2.0, vendored in
`third_party/berth_core/`). It was built during the **Gemini 4 Argon SF Hackathon on 2026-10-25**, with Claude Code
workers writing the kernel, solver, generator, viewer and this episode interface in parallel.

## What is real and what is generated

| real (Port of Oakland public facilities pages) | generated |
|---|---|
| terminal geometry: berth numbers and quay lengths, cut into 42 m sections | every ship call: names, arrivals, move counts, lateness |
| crane fleets per terminal | disruptions: delays, fog windows, outages, closures, emergencies |
| berth depths (50 ft, 42 ft at Matson and OICT berth 60) | the published plan that no longer works |
| ILWU shifts: day 08:00-17:00, night 18:00-03:00, hoot 03:00-08:00, meal hour 17:00-18:00 | |

Ship calls are **generated** from real services that call Oakland (transpacific loops of ONE, Maersk, MSC, CMA CGM,
Evergreen, Hapag-Lloyd, OOCL, COSCO, Yang Ming, Wan Hai, and Matson's Hawaii and Guam services) with realistic
lengths, move counts and weekly patterns. They are **not** real records.

| terminal | berths | quay | cranes | depth | sections |
|---|---|---|---|---|---|
| OICT (SSA Marine) | 55-60 | 2,089 m | 10 super post-Panamax | 50 ft (42 ft at berth 60) | 50 |
| TraPac | 25-33 | 1,300 m | 7 (5 post-Panamax, 2 super post-Panamax) | 50 ft | 31 |
| Everport | 35-38 | 657 m | 4 super post-Panamax | 50 ft | 15 |
| Matson | 61-63 | 575 m | 4 post-Panamax | 42 ft | 13 |

Hour 0 is Monday 00:00 Pacific; all times are whole hours from then.

## Two task kinds

**`kind = "berth"`, berth allocation.** For every ship choose when it berths, where (first section) and how many
cranes work it:

```json
[{"ship": 0, "berth_hour": 12, "section": 7, "cranes": 3}, {"ship": 1, "berth_hour": 30, "section": 20, "cranes": 2}]
```

**`kind = "crane"`, crane scheduling.** Berths and berth hours are fixed (given in the situation). For every ship
choose a crane count per shift type, applied in every hour of that shift while the ship is alongside; the ship
leaves when its moves are done:

```json
[{"ship": 0, "cranes": {"day": 3, "night": 3, "hoot": 1}}, {"ship": 1, "cranes": {"day": 2, "night": 2, "hoot": 0}}]
```

## Rules

| rule | berth | crane |
|---|---|---|
| berth at or after arrival | yes | fixed by the task |
| consecutive sections inside the quay, deep enough for the ship's draught | yes | fixed by the task |
| no section-hour shared with another ship, a ship already alongside, or a closed section | yes | fixed by the task |
| no berthing or departure inside a fog or bar closure window (departure waits, cranes free) | yes | yes |
| cranes per ship within its min-max (one per 55 m, at most 6 at OICT, 4 elsewhere) | yes | yes (0 allowed only for hoot) |
| cranes in use every hour within the pool (less outages; `hoot_pool` in hoot hours) | yes | yes |
| no crane work in the meal hour 17:00-18:00 | yes | yes |
| at most 2 berthings or departures per hour per terminal | yes | yes |
| hours alongside = ceil(moves / (26 x cranes)), counting only working hours | yes | yes |

**Cost** (lower is better): sections x hours late past the planned departure (times the weight for priority cargo),
plus emergency penalties for docking after a deadline. Berth tasks add 5 per scheduled ship moved off its planned
section; crane tasks add `hoot_gang_cost` (2) per crane-hour worked in the hoot shift.

## Reward

PortSim's v3 reward:

- infeasible or unreadable: `0.2 x clean fraction` (ships with no violation over all ships), so in [0, 0.2)
- feasible: `0.2 + 0.8 x exp(-g / 0.5)` with `g = (cost - optimum) / (optimum - floor + 100)`

The floor is a provable lower bound (`unavoidable_cost`: each ship alone at its earliest legal hour with its maximum
cranes; for crane tasks, maximum cranes in every shift and no pool limit). The optimum scores 1.0.

## Package API (`oakland_core`)

```python
from oakland_core import Task, Ship, Block, Plan, PlanError
from oakland_core import parse_plan, plan_to_list, plan_from_list
from oakland_core import evaluate, grade, unavoidable_cost        # evaluate(task, plan) -> PlanResult; grade(task, plan, problems=None) -> Grade
from oakland_core import generate_task                            # generate_task(seed, tier, kind, terminal=None) -> Task
from oakland_core import solve, naive_plan, greedy_plan           # solve(task, time_limit_s=30.0) -> (Plan, cost, proven)
from oakland_core import rules, situation                         # the two prompt texts
from oakland_core import build_pack                               # build_pack(n, split, kind, seed0, time_limit_s) -> list[Task]
from oakland_core import render                                   # render(task, plan, path) -> PNG berth-time chart
from oakland_core import replay                                   # replay(task, plan) -> dict, what the 3D viewer loads
```

`Task.to_dict()` and `Task.from_dict()` round-trip through JSON. `task.reference` (never shown to the agent) holds
`optimal_plan`, `optimal_cost`, `naive_cost`, `greedy_cost`, `proven_optimal`.

## Playing an episode in Python (`env.py`)

```python
from env import OaklandEnv

env = OaklandEnv("tasks/berth-eval.jsonl")     # or a list of Task objects
obs = env.reset(index=0)                       # or task_id="...", or split="eval", index=3
# obs: task_id, kind, terminal, difficulty, rules, situation, checks_left
text = env.get_situation()                     # rules + situation again
chk = env.check_plan(plan)                     # {"feasible", "cost", "violations": [{"ship", "problem"}], "parse_problems", "checks_left"}
g = env.submit_plan(plan)                      # {"reward", "feasible", "cost", "optimal_cost", "naive_cost", "violations", "parse_problems", ...}
env.replay()                                   # replay JSON of the submitted plan
env.transcript                                 # every call and result, with timestamps
```

A plan may be a JSON string (a fenced ```json block is fine) or a parsed list or dict. `check_plan` allows 10 checks
per episode, the 11th returns `{"error": ...}`, and it never returns a reward or any reference value.
`submit_plan` ends the episode; later calls return an error until the next `reset`. An unreadable plan scores 0.
Everything is deterministic.

Quick run with the naive re-plan:

```bash
python examples/play_random.py --tasks tasks/berth-eval.jsonl --index 0
```

## HTTP server (`server.py`)

Standard library only, one episode at a time, CORS open.

```bash
python server.py --tasks tasks/berth-eval.jsonl --port 8011
```

| route | body | returns |
|---|---|---|
| `GET /tasks` | | ids, kind, difficulty, terminal, split, ships |
| `POST /reset` | `{"task_id": ...}` or `{"index": 0}` or `{"split": "eval", "index": 3}` | the reset observation |
| `GET /situation` | | `{"situation": rules + situation}` |
| `POST /check` | `{"plan": [...]}` or `{"plan": "json text"}` | violations and cost (no reward) |
| `POST /submit` | `{"plan": [...]}` | the grade; ends the episode |
| `GET /replay` | | replay JSON of the last submission |

Errors (no episode, checks used up, episode ended, unknown task) come back as HTTP 400 with `{"error": ...}`.

```bash
curl http://127.0.0.1:8011/tasks
curl -X POST http://127.0.0.1:8011/reset -d '{"index": 0}'
curl http://127.0.0.1:8011/situation
curl -X POST http://127.0.0.1:8011/check -d '{"plan": [{"ship": 0, "berth_hour": 12, "section": 7, "cranes": 3}]}'
curl -X POST http://127.0.0.1:8011/submit -d '{"plan": [{"ship": 0, "berth_hour": 12, "section": 7, "cranes": 3}]}'
curl http://127.0.0.1:8011/replay
```

## Building tasks

Task packs are built with the solver and generator (each task is kept only if CP-SAT proves the optimum in its time
limit, the naive re-plan scores at most 0.6 and the greedy heuristic at most 0.85):

```bash
python build_tasks.py --help        # e.g. a berth eval pack and a crane eval pack written to tasks/*.jsonl
```

## 3D viewer

Open `oakland/viewer/index.html` in a browser and point it at a replay JSON with `?replay=`, for example
`viewer/index.html?replay=replays/berth-eval-0.json`. Save a replay with
`json.dump(env.replay(), open("replays/berth-eval-0.json", "w"))` after a submission, or fetch `GET /replay`.

## Tests

```bash
cd oakland
python -m pytest -q tests/
```

`tests/test_env.py` covers the episode flow (reset keys, checks without rewards, the 10-check limit, submission
ends the episode, malformed plans, determinism) and an HTTP round trip.

## Licence and attribution

Code adapted from FineEnvs PortSimEnv v1, Apache-2.0 (see `third_party/berth_core/LICENSE`). Terminal facility
figures (berths, quay lengths, cranes, depths) are from the Port of Oakland's public facilities pages. Ship calls are
generated and do not describe real vessels' schedules.
