# OaklandPortEnv task packs

Fixed task packs for both task kinds, one task per line (`oakland_core.pack.load_jsonl`). Terminal geometry, crane
fleets, depths and ILWU shifts are real; the ship calls are GENERATED from the services that call Oakland, not real
records.

| File | Tasks | Seeds | standard | busy | storm | extreme |
| --- | --- | --- | --- | --- | --- | --- |
| `berth-eval.jsonl` | 12 | 100000-100014 (15 tried) | 4 | 3 | 4 | 1 |
| `berth-train.jsonl` | 24 | 0-32 (33 tried) | 8 | 6 | 5 | 5 |
| `crane-eval.jsonl` | 12 | 100000-100018 (19 tried) | 3 | 2 | 4 | 3 |
| `crane-train.jsonl` | 24 | 0-27 (28 tried) | 6 | 7 | 5 | 6 |

Terminals: berth-eval Everport 5, TraPac 5, Matson 2 (no OICT); berth-train OICT 7, Matson 7, Everport 6, TraPac 4;
crane-eval OICT 5, Matson 4, TraPac 2, Everport 1; crane-train TraPac 10, OICT 7, Matson 5, Everport 2.

Eval seeds start at 100000 and train seeds at 0, so the splits never share a task. The eval packs are the fixed,
board-comparable benchmark: one episode per task, never show the agent `reference`.

## How they were built

```
python build_tasks.py --kind berth --split eval  --n 12 --time-limit 20 --out tasks/berth-eval.jsonl
python build_tasks.py --kind berth --split train --n 24 --time-limit 20 --out tasks/berth-train.jsonl
python build_tasks.py --kind crane --split eval  --n 12 --time-limit 20 --out tasks/crane-eval.jsonl
python build_tasks.py --kind crane --split train --n 24 --time-limit 20 --out tasks/crane-train.jsonl
```

Default seeds, tiers in rotation (standard, busy, storm, extreme), CP-SAT time limit 20 s per task for every tier
(the crane extreme tier proved within it, no longer limit was needed). A candidate is kept only when CP-SAT proves the
optimum within the limit, the naive re-plan is feasible and scores at most 0.6, and the greedy heuristic scores at
most 0.85 (see `oakland_core/pack.py`). The whole build took about 6.5 minutes on 10 cores (the four packs in
parallel).

| Pack | Dropped (reason) | Median solve | Naive reward | Greedy reward |
| --- | --- | --- | --- | --- |
| berth-eval | 2 not proven, 1 greedy too good | 1.9 s | 0.200-0.310 | 0.201-0.752 |
| berth-train | 6 not proven, 2 greedy too good, 1 naive too good | 2.9 s | 0.200-0.559 | 0.200-0.699 |
| crane-eval | 7 greedy too good | 0.2 s | 0.200-0.301 | 0.226-0.827 |
| crane-train | 4 greedy too good | 0.1 s | 0.200-0.442 | 0.302-0.838 |

Every kept task scores reward 1.0 with its reference plan.

## The reference block

Each task's `reference` holds `optimal_plan` (plan rows, `plan_from_list` reads them), `optimal_cost` (proven
optimal), `naive_plan`, `naive_cost`, `greedy_cost`, `proven_optimal: true` and `solver: "ortools-cpsat"`. It is
for grading and analysis only and must never reach the agent.

## Solver replays

`viewer/fixtures/oict-solver.json`, `trapac-solver.json` and `matson-crane.json` are `oakland_core.replay` output for
the first OICT berth, TraPac berth and Matson crane task of these packs with the reference plan (reward 1.0). OICT is
absent from `berth-eval`, so its replay uses the first OICT task of `berth-train` (`oak-oict-berth-storm-6`); the
other two come from the eval packs (`oak-trapac-berth-standard-100004`, `oak-matson-crane-busy-100001`). The
dashboard's `episodes.json` lists the three as episodes 1 to 3.
