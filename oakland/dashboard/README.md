# Oakland port operations dashboard

A static page that answers "how well is the port being operated" from replay JSON files (see
`docs/replay_schema.md`). For one replay it shows KPI tiles, a berth Gantt, hour-by-hour charts, a per-ship table and
the events list. Across many replays (the episodes the Argon player runs over time) it shows the reward, best so far,
a moving average of 3, and the cost gap to the optimal plan, so improvement is visible at a glance.

Vanilla HTML, CSS and JS with canvas charts. No dependencies, no build step, no npm, no network.

## How to open

- Served (recommended): `cd oakland && python3 -m http.server 8777`, then open `http://127.0.0.1:8777/dashboard/`.
  Serve from `oakland/` (not from `dashboard/`) so the default manifest can reach `../viewer/fixtures/`.
- From disk: double-click `index.html`. Browsers cannot fetch files on `file://`, so the page falls back to the two
  demo replays embedded in `../viewer/fixtures/demo-fixtures.js`. Load your own files with "Load JSON" or by
  dropping them on the page.

## URL parameters

- `?run=../runs/<name>` (or `?run=fixtures/run-demo`): an oakland/loop run directory. Reads `episodes.jsonl`,
  `eval.jsonl`, `playbooks/tree.json`, `playbooks/v<k>.md` and the replays with `cache: "no-store"`, and re-polls every
  3 s (`&live=0` turns polling off). Adds the self-improvement chart (verification reward per coach round: accepted
  lineage as a step line, each candidate coloured by verdict, its episode reward as a hollow ring, the baseline
  dashed), episode rewards with the coach rounds marked, the coach rounds list and the playbook in force with its
  added lines highlighted. The builders are pure functions in `runs.js` (`node --test tests/`). The UI never says
  "train" or "eval": nothing is trained, only the playbook changes between episodes. `fixtures/run-demo/` is a finished
  real 16-episode run (events dropped) for offline use.

- `?manifest=episodes.json` (the default): a manifest listing one replay per episode. Replay paths are resolved
  relative to the manifest's URL.
- `?replays=a.json,b.json,c.json`: a comma-separated list of replay URLs, taken as episodes 1, 2, 3 in that order
  (relative to the page URL).

Dropped files: replay JSON files become episodes in file-name order (name them `ep001.json`, `ep002.json`, ... so the
order is right). If you drop a manifest together with its replays, the manifest decides episode numbers and labels.

The episode selector picks the replay shown in the tiles, Gantt, hourly charts, table and events; the improvement
charts always show every episode. Hover any chart for values.

## What the numbers mean (all in `metrics.js`, pure functions, node-testable)

- Reward, cost, optimal cost, feasible: copied from the replay `grade`. Gap = (cost - optimal) / optimal.
- On time: ships with `late_h` = 0. Wait: `berth_hour - arrival` (hours at anchor). Late ship-hours: sum of `late_h`.
- Quay occupancy: section-hours alongside / section-hours available over the horizon, where closed blocks are
  subtracted from the available hours (shallow blocks still count as available, small ships may use them).
- Crane utilisation: crane-hours worked (sum of `cranes_by_hour`) / sum of `crane_pool_by_hour`.
- Moved: the ship berthed at a different first section than the task's `planned_section`.
- Problems: per-ship `problems` plus grade `violations`.
- Shift breakdown: crane-hours in the day (08-17), night (18-03) and hoot (03-08) shifts from the task `rules.shifts`;
  hour 0 is Monday 00:00 Pacific.

In node: `const M = require("./metrics.js"); M.summary(replay); M.series(replay); M.shipRows(replay); M.events(replay); M.episodes([r1, r2])`.

## Writing replays from the Argon loop

Write one replay JSON per episode (the dict returned by `oakland_core.replay(task, plan)`, see
`docs/replay_schema.md`) and an `episodes.json` manifest next to them:

```json
[
  {"episode": 1, "replay": "ep001.json", "reward": 0.42, "label": "baseline"},
  {"episode": 2, "replay": "ep002.json", "reward": 0.57, "label": "after SFT round 1"}
]
```

- `replay` is a path relative to the manifest (or any URL the browser may fetch).
- `reward` is optional: the dashboard uses the replay's `grade.reward` and only falls back to the manifest value.
- `label` is optional free text shown in the episode selector.
- Append to the manifest as episodes finish (rewrite the whole file atomically, for example write
  `episodes.json.tmp` and rename it), then reload the page.

Then open `http://127.0.0.1:8777/dashboard/?manifest=../runs/<run>/episodes.json` (any path the server can serve).

## Demo data

`episodes.json` lists the two viewer fixtures (`../viewer/fixtures/oict-demo.json` and `matson-demo.json`) as
episodes 1 and 2. They are different terminals, so the "improvement" curve there only demonstrates the chart. The ship
calls in these fixtures are GENERATED, not real records; the plans and grades are illustrative.
