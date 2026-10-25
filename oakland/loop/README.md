# oakland/loop: the self-improving player and coach loop

A LangGraph program where a **Player** agent plays OaklandPortEnv episodes with tools (including a live AIS-shaped
ship feed), and every N episodes a **Coach** reads the Player's full event logs and proposes a new versioned
playbook that goes into the Player's system prompt. A code gate keeps a playbook only if it raises the mean reward on
the fixed verification set. No model weights change; the playbook is the only state (in-context adaptation): the
Player plays a task stream (`tasks/<kind>-train.jsonl`) and the gate scores on a verification set
(`tasks/<kind>-eval.jsonl`). File and JSON field names keep the old words (`train_mean`, `eval_mean`, `eval.jsonl`,
`eval/`) so other tools keep working. Each graded episode writes a replay JSON and a manifest row, so the dashboard shows the
improvement curve.

The ship calls in every task are GENERATED (not real records); so are the live-feed positions. The terminals,
cranes, depths and ILWU shifts are real.

It runs end to end with no API key (scripted Player and Coach, no network) and uses Gemini 4 Argon
(`gemini-4-argon` through `langchain-google-genai`) when `GOOGLE_API_KEY` or `GEMINI_API_KEY` is set.

## Run it

```bash
cd oakland
# tiny packs (the real ones are tasks/{berth,crane}-{train,eval}.jsonl)
../.venv/bin/python build_tasks.py --kind berth --split train --n 3 --time-limit 10 --out /tmp/oak-loop-train.jsonl
../.venv/bin/python build_tasks.py --kind berth --split eval  --n 3 --time-limit 10 --out /tmp/oak-loop-eval.jsonl

../.venv/bin/python -m loop.run --run demo --episodes 6 --coach-every 3 --kind berth \
    --tasks /tmp/oak-loop-train.jsonl --verify-pack /tmp/oak-loop-eval.jsonl \
    --player scripted --coach scripted --scripted-mistakes
```

Flags: `--run NAME`, `--episodes 30`, `--coach-every 4`, `--kind berth|crane|both`, `--tasks PATH` (the task
stream) and `--verify-pack PATH` (the verification set; both repeatable, defaults `tasks/<kind>-train.jsonl` and
`tasks/<kind>-eval.jsonl`; `--train-pack` and `--eval-pack` still work as hidden aliases),
`--tiers standard,busy,storm,extreme` (difficulty tiers kept in BOTH sets, filtered before the sanity gates; the run
aborts naming the set when one becomes empty; Gemini already scores 1.0 on standard tasks, so the demo plays
`--tiers storm,extreme`), `--select pareto|latest` (default pareto), `--prescreen on|off` (default on),
`--workers 4` (episodes scored concurrently, 1 = sequential), `--player auto|gemini|scripted`,
`--coach auto|gemini|scripted` (auto: Gemini when a key is set), `--live-feed on|off`, `--scripted-mistakes`,
`--resume` (continue `runs/<run>` from its checkpoint; without it the run directory is started fresh), `--quiet`
(hide the `[graph] node` event lines), `--runs-dir`.

Output: one `[graph] <node>` line per node event, one line per episode (episode, task, reward, checks used, first
feasible check, playbook version, tokens, cost), one line per coach round (verification and episode means before and after,
ACCEPT or REJECT with the reason, the one change), and a run summary with the cost per episode and per coach round.

## Files in runs/\<run\>/

| path | what |
|---|---|
| `episodes.jsonl` | one row per graded training episode: reward, cost, optimal_cost, gap_pct, checks, first feasible check, playbook_version, player_version, metrics, tokens, cost |
| `episodes.json` | the dashboard manifest `[{episode, replay, reward, label}]`, rewritten atomically after each episode |
| `replays/ep001.json` ... | the replay JSON of each episode (`oakland_core.replay`) |
| `events/ep001.jsonl` ... | the event log of each episode (below) |
| `eval.jsonl` | the baseline row for v0, then one candidate row per coach round: train_mean (episodes) and eval_mean (verification) side by side, feasibility, gap, verdict, reason, comparable, per-task rewards, parent_selected_by, accepted_version, merged_from, prescreened |
| `eval/v<k>/`, `eval/v<k>-train/` | event logs of the verification and window episodes played for version k |
| `playbooks/v<k>.md`, `v<k>_heuristic.py` | the playbook text of each version and the coach's optional heuristic |
| `playbooks/tree.json`, `changelog.json` | the playbook tree and its changelog |
| `state.sqlite` | the LangGraph SqliteSaver checkpoint (thread id = run name) |

`oakland/runs/` is git-ignored.

## The graph

```
pick_task -> player -> grade_and_log -> maybe_coach -> eval_candidate -> accept_or_reject -> pick_task
                                                   \-> pick_task (not a coach episode)        \-> END
```

Typed state (`graph.LoopState`): run dir, episode index, accepted playbook version, coach round, the window of
episodes since the last coach round, episode summaries, the pending candidate. Runtime objects (packs, player,
coach, playbook store) live in `graph.Loop`, whose methods are the nodes.

- **pick_task**: the next train task, cycling through the train pack in order.
- **player**: one episode with the accepted playbook (`player.run_episode`).
- **grade_and_log**: the episode row, the manifest, the printed line.
- **maybe_coach**: every `--coach-every` episodes, picks the parent (below) and asks the coach for a child of it,
  or builds a merge candidate.
- **eval_candidate**: plays the window's tasks with the candidate (the pre-screen), then the whole verification set,
  same player.
- **accept_or_reject**: the gate (below), the tree verdict, the eval row, the printed line.

## Player

`tools.py` wraps one `OaklandEnv` episode: `get_situation`, `get_rules`, `read_playbook`, `baseline_plan` (the
greedy plan; the reference solver is never exposed), `check_plan` (the env's 10-check limit), `submit_plan`,
`ship_timeline(plan_json, ship_id)` (hour-by-hour cranes and sections, departure and lateness of one ship, no check
used), `live_ships(hour)` (`SyntheticAIS(task).positions(hour)` and `.events(hour)`, only with `--live-feed on`) and
`apply_heuristic(plan_json)` (only when the playbook version has a heuristic). The env's own transcript gets the
extra tools too.

`player.py`:
- **GeminiPlayer**: `create_react_agent(ChatGoogleGenerativeAI(model="gemini-4-argon", temperature=0.2), tools)`
  with a recursion limit. The system prompt is the rules text, the playbook with its version, and "at most 10
  checks; submit exactly once".
- **ScriptedPlayer**: situation, playbook, live feed, baseline, then the playbook rules it recognises (planned
  sections, screened one ship at a time with ship_timeline; the no-movement rule), check, repair from the violation
  text, submit the best feasible checked plan. `--scripted-mistakes` berths one ship inside a no-movement window on
  the first check unless the playbook has the no-movement rule.
- **Harness** (`run_episode`): if the player never submits, it submits the best feasible checked plan, else the
  baseline, and notes it. It then grades, writes the replay, and closes the event log with a stop event.

**Scripted coach ranking** (`coach.rank_findings`): the scripted coach ranks the findings it detects by an estimated cost impact over the window's stop events, highest first, catalogue order on ties: moved = 5 x moved ships, late = late ship-hours (meal: those of ships departing at 18:00), harness = 1000 per harness submit, a violation = the rejected checks it appears in plus 1000 per episode that ended below reward 0.21 with an infeasible submission and that violation in its last rejected check, feed = 0. It adds the rule of the highest ranked finding not in the playbook and not rejected before; the diagnosis names that impact and each mistake in the tree records its `impact`.

**Steering hook**: a rejected `check_plan` result gets a `playbook_hint` with the one or two playbook rules whose
keywords match the violation texts (no-movement, pool, hoot, meal, shallow, overlap, movement limit, moved), so the
correction reaches the model at the point of failure. The hint is part of the logged tool_result.

## Event logs: what the model saw, and all the coach reads

Each episode's `events/ep<k>.jsonl` holds `{idx, ts, type, payload, tokens_in, tokens_out, cost_usd, wall_s}` with
type `model_call | tool_call | tool_result | submit | stop`:
- the first `model_call` carries the system prompt (with the playbook version) and every tool definition;
- each Gemini call is a `model_call` with the messages it got, its reply, tokens, wall time and an estimated cost
  (prices `OAK_PRICE_IN` / `OAK_PRICE_OUT` in USD per million tokens, defaults 1.25 and 10);
- every tool call and its result (including the steering hint), the submit, and the stop event with the grade, the
  gap to the hidden optimum, the port metrics and the late ships.

Token and cost fields are 0 in scripted mode. The coach reads these logs and nothing else from the episodes.

## Coach

`coach.py` proposes `{diagnosis, mistakes: [{what, evidence: [{episode, event_idx}], rule}], playbook_md,
heuristic_code | null}`. Each `rule` is an imperative sentence; a finding without evidence spans pointing at real
events is dropped by code. The playbook is prose rules plus a short ordered checklist, at most 60 lines, and changes
by one rule per round.

- **ScriptedCoach**: a fixed catalogue matched in priority order against the logs (no-movement windows, hoot pool,
  crane pool, movement limit, overlaps, shallow sections, early berths, harness submits, ships moved off their
  planned section, meal-hour lateness, late ships, ignored ETA updates). It adds the first rule that is neither in
  the current playbook nor rejected before. Deterministic.
- **GeminiCoach**: the same structure via `with_structured_output`, with token and cost accounting. A
  `heuristic(task, plan) -> plan` is saved as `playbooks/v<k>_heuristic.py` and offered to the player as
  `apply_heuristic`; it only stays in use if its version is accepted.

## Candidate pool (GEPA-style)

Borrowed from GEPA (github.com/gepa-ai/gepa, Genetic-Pareto prompt evolution). The gate and the player are
unchanged: the player always uses the latest ACCEPTED playbook, and every candidate is gated against that version's
verification mean.

- **Per-task scores**: every scored node keeps `eval_per_task` and `train_per_task` (`{task_id: reward}`).
- **Pareto front** (`PlaybookStore.pareto_front()`): the versions, accepted or rejected, scored on the verification
  set with the latest accepted node's player_version, that have the best reward on at least one verification task
  (ties count for every tied version). Each node's `front` and `wins` (tasks it is best on) are refreshed after every
  scoring.
- **Parent selection** (`--select pareto`, default): the coach's parent is sampled from the front weighted by `wins`,
  with `random.Random("<run>:<round>")`, so runs are reproducible. `--select latest` uses the latest accepted node.
  Each candidate row logs `parent_selected_by`.
- **Pre-screen** (`--prescreen on`, default): the candidate first plays the coach window's tasks; if their mean falls
  below the window's own mean by more than 0.005 it is rejected as `minibatch: episodes -x.xxx` without playing the
  verification set (`eval_mean` null, `per_task` empty). This saves model cost: a bad candidate costs a window of
  episodes, not the whole verification set.
- **Merge**: after a rejected round, when the front has two members that win different task sets and that pair was
  never merged (`merged_from` in the tree), maybe_coach proposes a merge instead of asking the coach: the union of
  their `## Rules` bullets (parent order, then the other's new ones), the first's checklist, at most 60 lines,
  change `merge v<a>+v<b>`. It goes through the same pre-screen and gate.
- **Ancestor lessons**: the coach gets `lessons`, one line `v<k> (<verdict>, <reason>): <change>` for the parent and
  each ancestor up to the root, newest first, at most 8. GeminiCoach shows them under
  "## Lessons from this playbook's ancestors"; ScriptedCoach ignores them.
- **Parallel scoring**: `Loop.score()` plays its episodes with a `ThreadPoolExecutor` of `--workers` threads (each
  episode has its own env and event log; rows stay in task order). A live Gemini episode takes about 2 minutes, so
  with 4 workers a coach round costs about one episode of wall time plus the coach call.

## Verification protocol and the gate

Code decides, models propose; no model judgement enters the score, which is the kernel's reward v3.

- **Sanity gates at startup**: every eval task's reference plan must score 1.0 and its naive plan below 0.5, or the
  run aborts naming the task.
- **Baseline**: v0 is played once on the whole verification set (one episode per task, the dataset's own rules and
  situation, at most 10 checks, one submit).
- **Candidate**: played on the tasks of the coach window (pre-screen) and on the whole verification set, by the
  same player.
- **Accept** when the verification mean >= the latest accepted version's verification mean + 0.005. Otherwise
  **reject**: "minibatch" when the pre-screen dropped it, "overfit" when the episodes' mean rose by the margin and
  the verification mean did not, "no verification gain" otherwise, "no change proposed" when the playbook is
  unchanged. Episode and verification means are reported side by side, never averaged.
- **Frozen player**: `player_version` is a hash over player.py, tools.py and the model id, written on every episode
  row and eval row. A candidate scored with a different player_version than its parent is rejected as
  "not comparable" (`comparable: false` in eval.jsonl).
- **Tree** (`playbooks/tree.json`): nodes `{version, parent, created_at, diagnosis, change, verdict, train_mean,
  eval_mean, feasibility_rate, mean_gap_pct, reason, mistakes, eval_per_task, train_per_task, front, wins,
  merged_from, ...}`. The player uses the latest accepted node; rejected nodes stay in the pool and the report.

## Metrics

`metrics.py` is a line-by-line port of `dashboard/metrics.js` `summary()` and `shifts()`, so the loop and the
dashboard quote identical numbers: reward, cost, optimal_cost, gap_pct, feasible, ships_served, on_time_pct,
avg_wait_h, max_wait_h, avg_late_h, late_ship_hours (= total_late_h), occupancy_pct, crane_util_pct, moved_ships,
problems, and crane-hours by shift. On `viewer/fixtures/oict-demo.json` both give reward 0.833, 14 ships, on time
85.7%, occupancy 34%, crane utilisation 71%, average wait 0.57 h.

## The dashboard

```bash
cd oakland && python3 -m http.server 8777
# open http://127.0.0.1:8777/dashboard/?manifest=../runs/<run>/episodes.json
```

Replay paths in the manifest are relative to it (`replays/ep001.json`), so the dashboard finds them.

## Offline guard

Constructing the Gemini client (player or coach) raises `ModelRequestsDisabled` unless `ALLOW_MODEL_REQUESTS=1`.
The tests leave it off; `loop.run` turns it on for its own process only when Gemini is chosen. Keys are never
printed or logged.

## Tests

```bash
cd oakland && PYTHONDONTWRITEBYTECODE=1 ../.venv/bin/python -m pytest -q -p no:cacheprovider tests/test_loop.py
```

Metrics parity on the fixture; a scripted 6-episode run with two coach rounds and every output file; the mistake
mode teaching the no-movement rule; the event log shape; the steering hook; evidence validation; the playbook tree;
the sanity gates; the Gemini guard and the `gemini-4-argon` model id (with a fake model class, nothing is called);
the Pareto front with ties, reproducible weighted parent sampling, ancestor lessons, the pre-screen rejecting
without playing the verification set, a merge candidate that is never repeated, parallel scoring in task order.
