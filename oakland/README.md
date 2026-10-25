# OaklandPortEnv

A digital twin of the **Port of Oakland**, California, for berth and crane planning, operated by a self-improving
Gemini 4 Argon agent. The agent gets one terminal over one or two weeks after something went wrong (late ships, fog,
a crane outage, a closed berth), writes one plan, and the plan is graded once, deterministically, against a reference
plan that a CP-SAT solver proved optimal. A coach agent reads the player's logs and updates its playbook, and each
change is kept only if it raises the score on held-out tasks (see `loop/README.md` and `../docs/demo-script.md`).

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
| `GET /ais?hour=12` | | `{"source", "hour", "positions", "events"}`: AIS-shaped ship positions (see Ship feed) |

Errors (no episode, checks used up, episode ended, unknown task) come back as HTTP 400 with `{"error": ...}`.

```bash
curl http://127.0.0.1:8011/tasks
curl -X POST http://127.0.0.1:8011/reset -d '{"index": 0}'
curl http://127.0.0.1:8011/situation
curl -X POST http://127.0.0.1:8011/check -d '{"plan": [{"ship": 0, "berth_hour": 12, "section": 7, "cranes": 3}]}'
curl -X POST http://127.0.0.1:8011/submit -d '{"plan": [{"ship": 0, "berth_hour": 12, "section": 7, "cranes": 3}]}'
curl http://127.0.0.1:8011/replay
curl 'http://127.0.0.1:8011/ais?hour=12'
```

## Ship feed (`feed.py`)

Ship positions in the shape of real AIS messages, so the viewer and an agent see the same message either way:

- **Synthetic** (`SyntheticAIS(task, plan=None)`, the default): for every GENERATED ship call of the task, a stylised
  route from the Golden Gate across the Bay and the Oakland bar channel to the terminal's anchorage (reached at the
  ship's arrival hour) and its berth (reached at its berth hour from the plan, else the published planned hour), then
  back out the same way after departure. `positions(t_h)` gives every ship in the area at hour `t_h`; `events(t_h)`
  gives `eta_update` notices for ships arriving later than planned. These positions are generated, not real records,
  and the routes and berth coordinates are a stylised representation.
- **Real** (`AISStream()`): when `AISSTREAM_API_KEY` is set, a background thread subscribes to the aisstream.io
  websocket for the box 37.70-37.90 N, 122.20-122.50 W (position reports and static data) and keeps the latest
  position per MMSI. It needs the optional `websockets` package; without the key it never connects. The key is never
  logged or printed.

Every position is one dict:

```json
{"mmsi": 538504040, "imo": "GEN9109966", "name": "ONE CYGNUS", "lat": 37.797812, "lon": -122.316063,
 "sog_kn": 0.0, "cog_deg": 100.0, "heading_deg": 100, "nav_status": "moored", "eta": "2026-10-26T13:00",
 "destination": "US OAK", "ship_type": 70, "length_m": 347.0, "beam_m": 45.7, "draught_m": 13.5,
 "ts": "2026-10-26T19:00:00Z", "source": "synthetic"}
```

`nav_status` is `under way`, `at anchor` or `moored`; `eta` and `ts` are UTC (hour 0 is Monday 26 October 2026
00:00 Pacific, 07:00 UTC). `GET /ais?hour=<float>` serves the real stream when the key is set, else the synthetic feed
of the current episode's task (following the submitted plan once there is one), or of the first task when no episode
is active.

```bash
python examples/ais_tail.py                      # synthetic positions of a generated OICT task at hours 0, 12, 24
AISSTREAM_API_KEY=... python examples/ais_tail.py   # the real stream for 20 seconds
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

## Demo

Three commands, from `oakland/`:

```bash
./demo.sh                     # viewer on 8765, chat on 8771, and the loop on run "live"
LOOP=off RUN=live ./demo.sh   # serve an existing run only: viewer and chat, no loop
./demo.sh stop                # stop what demo.sh started for RUN
```

`./demo.sh` loads the repo's `.env` (`ENV_FILE` to override; the key is never printed) and exits 1 when neither
`GOOGLE_API_KEY` nor `GEMINI_API_KEY` is set. It exports `ALLOW_MODEL_REQUESTS=1`, starts a static server on `PORT`
(default 8765) from `oakland/` and the chat server on `CHAT_PORT` (default 8771, `--runs-dir runs --verify-pack
tasks/berth-eval-demo.jsonl`), then prints the dashboard, viewer and chat health URLs. A port that already serves
`/viewer/` (or answers `/health` for chat) is reused; a port held by anything else is an error (exit 1). With the
default `LOOP=on` it then runs the loop in the background and waits for it (Ctrl-C stops the loop only):

```bash
$PYTHON -m loop.run --run $RUN --episodes ${EPISODES:-9} --coach-every ${COACH_EVERY:-3} --kind berth \
    --tasks tasks/berth-train.jsonl --verify-pack tasks/berth-eval-demo.jsonl --tiers storm,extreme --workers 4 \
    --player ${PLAYER:-auto} --coach ${COACH:-auto} --quiet
```

Logs go to `runs/<RUN>/logs/{http.log,chat.log,loop.log}` and the pids of what it started to `runs/<RUN>/logs/pids`,
which `./demo.sh stop` reads (use the same `RUN`). The servers keep running after the loop ends until you stop them.

- Dashboard: `http://127.0.0.1:8765/dashboard/?run=../runs/live` re-reads the run every 3 s: the self-improvement
  chart (verification reward per coach round, accepted lineage, every candidate by verdict), episode rewards with the
  coach rounds marked, the coach rounds list and the playbook in force with its added lines highlighted.
- Viewer: `http://127.0.0.1:8765/viewer/?run=../runs/live` plays the newest episode at 16x and moves to each new one
  when its playback ends, with a toast per new episode.
- Offline: `dashboard/?run=fixtures/run-demo&live=0` and `viewer/?run=../dashboard/fixtures/run-demo` show a finished
  16-episode real run (4 coach rounds) bundled with the dashboard.

Nothing is trained: only the playbook changes between episodes (in-context adaptation from feedback). The UI calls the
held-out score the "verification reward" and the score on the episodes just played the "episode reward".

`tasks/berth-eval-demo.jsonl` is the demo subset of the verification pack: the 4 storm and extreme tier tasks of
`tasks/berth-eval.jsonl` on which the greedy baseline plan scores lowest (`reward.grade` of `solve.greedy_plan`:
everport-storm-100002 0.25, everport-storm-100010 0.28, trapac-extreme-100011 0.34, trapac-storm-100014 0.38), so a
good playbook rule has room to show and each coach round stays short on stage. The full 12-task
`tasks/berth-eval.jsonl` stays the benchmark.

## Chat with the operator

`oakland/chat/` answers questions about a run as the Gemini Argon operator: a LangGraph ReAct agent (the player's
`make_model` wrapper, model `gemini-4-argon`, temperature 0.3) over read-only tools on the run's files and the real
checker. Nothing is trained; only the playbook changes between episodes. Ship calls are GENERATED.

    cd oakland
    set -a; . ../.env; set +a                      # GOOGLE_API_KEY or GEMINI_API_KEY
    ALLOW_MODEL_REQUESTS=1 python -m chat.server --runs-dir runs --port 8771

Contract (CORS open, stateless: the client sends the whole conversation, one agent is cached per run, 90 s per
request, errors as `{"error": ...}`):

    POST /chat   {"run": "live", "messages": [{"role": "user", "content": "Are you improving?"}], "episode": 7,
                  "hour": 40}
                 run: a directory name under --runs-dir ("../runs/live" also works, its basename is used)
                 episode, hour, ship_id: what the viewer is showing (ship_id: the selected ship), or null; the
                 tools default to them, so "how is the port doing" and "this ship" mean what is on screen
              -> {"answer": "...", "steps": [{"tool", "args", "result_preview"}],
                  "links": [{"episode", "ship_id"?, "hour"?}], "what_if": {...} | null,
                  "tokens_in", "tokens_out", "cost_usd"}
    GET  /health -> {"ok": true, "model": "gemini-4-argon", "runs_dir": "runs"}
    GET  /runs   -> [{"run": "real-berth-gepa", "episodes": 16}]

Tools (`chat/tools.py`, `RunTools(run_dir)`, compact JSON of at most about 1500 characters, 3000 for the port
tools): `port_status(episode, hour)` (the quay at one hour of the plan: ships alongside with section and cranes,
ships waiting, late ships, cranes in use of the pool, bar closures, next arrivals, plan cost against the optimum;
default the viewer's episode and hour, else the latest episode at its last berthing), `late_ships(episode)` (every
late ship with due and berth hours and the reason: arrived late, bar closure, occupied section, crane pool, too few
cranes), `run_status`,
`improvement`, `coach_round(version)`, `playbook(version)`, `episode(n)`, `player_log(n, limit)`, `ship(n, id or
name)`, `what_if(n, ship_id, berth_hour, section, cranes)` (regrades a modified copy of the submitted plan with
`oakland_core.grade`, writes nothing) and `reward_rules`. `what_if` in the response is that tool's last result, so the
viewer can draw the changed berth. Tests use the scripted `FakeModel` (`tests/test_chat.py`, needs
`runs/real-berth-gepa` copied in; skipped otherwise; `tests/test_chat_tools.py` runs on the dashboard fixture).
"How is the port doing?" routes to `port_status` and is answered from the quay; run statistics only when asked
about the run. Answers from the port tools link every ship they name (`{episode, ship_id, hour}`).

Schedules on demand: `make_plan(episode, pins)` solves the episode's task with the exact solver
(`oakland_core.solve`, 20 s, 4 workers, cached per episode), applies `pins` = `[{ship, section?, berth_hour?,
cranes?}]` over the optimum and grades the result with the real checker, so a pin that breaks a rule is reported as
violations rather than repaired. `route_ship(episode, ship, section, berth_hour, cranes)` is `make_plan` with one
pin. Each call writes a viewer replay to `<run_dir>/proposals/plans/plan<N>.json` and the response gains
`"plan": {replay, cost, optimum, feasible, violations}`; links carry the pinned ships.

Any question: `overview()` is one digest of everything (the port now, the latest episode, the run, the playbook's
rules, the latest chat proposal; no model, no solver) that the agent calls when no other tool fits. `ship()` with no
arguments is the selected ship, else the most late one. A failed agent run (model error or the recursion limit) is
retried once on the digest alone; if that fails too the answer is built in code from the digest and the response
carries `"degraded": true`. A model error never turns into a 500.

Optimize on demand (`chat/optimize.py`, `Optimizer(run_dir)`): "Optimize my playbook" makes the agent call
`optimize_playbook(episodes=3)` once (one `GeminiCoach.propose` call on the last episode logs against the accepted
playbook in force, with the loop's rejected list, lessons and exclusions; evidence spans validated; about 20 to 30 s,
under $0.05) and answer in two sentences ("Okay, I optimized this: <rule>." and "I am checking it on the held-out
tasks now; the result will appear here."). The tool starts the verification itself and returns at once; it scores
the proposed playbook in a background thread with the loop's `Loop.score` (4 workers) on the run's own verification tasks (the task ids of its last
`eval.jsonl` row, from `tasks/*.jsonl`) or on `--verify-pack FILE...`. The baseline is the accepted version's
per-task rewards on the same tasks when the player is the same, else the accepted playbook is scored there too; the
verdict uses `ACCEPT_MARGIN`. `verify_proposal(id)` re-runs it. "Did it work?" calls `proposal_status(id=None)`
and answers in one sentence. `expected_minutes` comes from the baseline eval's wall time per episode (8 when the
run has none). Measured with Gemini: 4 tasks on `runs/live` took 8 minutes and $1.93.

    POST /chat ... -> also "proposal": {id, status, change, baseline_eval_mean, eval_mean, verdict_reason} after a
                      turn that used optimize_playbook, verify_proposal or proposal_status (key absent otherwise)
    GET  /proposal?run=live[&id=1] -> the same object, the latest proposal without id; 404 {error} when unknown

Everything is written under `<run_dir>/proposals/`, which the loop never touches: `proposals.jsonl` (one row per
proposal, rewritten in place: `{id, created, from_version, status: proposed|verifying|accepted|rejected, diagnosis,
mistakes, change, playbook_md, verification: {eval_mean, per_task} | null, baseline_eval_mean, verdict_reason,
cost_usd}` plus `version, episodes, verify_tasks, baseline_from, verified`), `p<id>.md` and the verification event
logs in `p<id>/`. The verdict is advisory: an accepted proposal is not added to the running loop's playbook tree.
Tests: `tests/test_chat_optimize.py` (stub coach, scripted player, FakeModel).

## Tests

```bash
cd oakland
python -m pytest -q tests/
```

`tests/test_env.py` covers the episode flow (reset keys, checks without rewards, the 10-check limit, submission
ends the episode, malformed plans, determinism) and an HTTP round trip on generated OICT berth and Matson crane
tasks; `tests/test_feed.py` covers the ship feed (keys, anchorage distance, nav status progression, no connection
without a key, `GET /ais`).

## Licence and attribution

Code adapted from FineEnvs PortSimEnv v1, Apache-2.0 (see `third_party/berth_core/LICENSE`). Terminal facility
figures (berths, quay lengths, cranes, depths) are from the Port of Oakland's public facilities pages. Ship calls are
generated and do not describe real vessels' schedules.
