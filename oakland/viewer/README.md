# Oakland berth replay (3D viewer)

A static page that replays one berth plan at a Port of Oakland terminal in 3D: ships come in from the bay, wait at
anchor, berth on their quay sections, quay cranes work them hour by hour, late ships are flagged, and closures,
shallow sections and fog windows are shown. A KPI panel shows how well the port is being run at the current hour. It
reads a replay JSON (see `docs/replay_schema.md`) and never recomputes rules: everything it draws comes from that file.

## The learning HUD

The screen is the 3D port, a top bar, one Learning panel and the playback bar. The top bar centre says which episode
is shown ("Episode 4 of 9 · TraPac · storm · playbook v2") and a pill says LIVE (following a run) or REPLAY. The
Learning panel has three blocks: the verification score of the accepted playbook with its delta since v0, the
evolution front (playbook versions by coach round, height = verification score, accepted in the accent, rejected as
outlines, overfit in amber, a halo on the Pareto front, the accepted lineage as one line; hover or focus a node for
its change) and the last coach decision in one sentence. The Playbook button opens the playbook in force with the
rules added since v0 highlighted, and the reward per episode chart below it. Nothing is trained: only that text changes.

- `?run=<path>` loads a loop run directory (`episodes.json` or `episodes.jsonl`, `eval.jsonl`, `playbooks/`,
  `replays/`), relative to this page, plays the newest episode and polls every 5 s; a new episode or coach round
  shows a 3 s toast and the new front node fades in. `&live=0` turns polling off. Without `?run=` the bundled
  `fixtures/run-demo` (a finished 16-episode run with an accepted round) is shown, without polling.
- `?replay=<url>` or `?scenario=<key>` still load a single replay; the panel then still shows the run.
- `runs.js` mirrors `oakland/dashboard/runs.js` on branch oak/demo (the pure readers of a run directory);
  `learning.js` draws the panel.
- Keys: Space play or pause, 1 to 9 episode N, G berth schedule, L Learning panel, C next camera, P playbook,
  T AIS tracks, V truck trails, N night, H hide panels, Esc closes the sheet or the ship card. Click a ship (in the
  scene or the schedule) for one small card; click the water to dismiss it.
- The "..." button at the bottom right holds the terminal and policy scenarios, loading a replay JSON, cameras and layers.

## How to open

- Double-click `index.html` (works from disk, no build step, no npm). It opens the bundled run; from disk, where fetch is blocked, it falls back to the OICT demo fixture.
- Or serve the folder: `cd oakland/viewer && python -m http.server 8000`, then open `http://localhost:8000/`.
- Load another replay with "Load replay JSON" in the "..." menu, or by URL when served: `http://localhost:8000/?replay=fixtures/matson-demo.json`
  (any URL the browser may fetch). Pages opened from disk cannot fetch files, so use "Load replay JSON" there.

## Controls and camera presets

Play/Pause (or the space bar), speed 1x 4x 16x 64x (1x is a quarter of a sim hour per second), the hour scrubber,
and mouse orbit (drag to rotate, right-drag to pan, wheel to zoom). Click a ship in the scene to fly to it.

- Satellite: high above the port, about 60 degrees down from the south-south-west with north up on screen (the
  Google Maps satellite look). With the map loaded it frames all four terminals, else this terminal and its anchorage.
- Overview: the terminal and the water in front of it, from the bay side.
- Quayside: low along the quay from section 1.
- Overhead: straight down onto the quay and berths.

## Asset modules (optional)

`index.html` loads four classic scripts from `assets/` before `viewer.js`. Each is optional: the viewer
feature-detects its global and falls back to the built-in geometry when the file is missing (a 404 is harmless).

- `assets/oakland_geo.js` (`window.OakGeo`): the map of the Port of Oakland (land, quays, Bay Bridge, roads, labels)
  is built once, and the replay scene is placed on its terminal's real quay line with `OakGeo.terminalFrame`. Waiting
  ships anchor in the bay west of the terminal (nudged off any land polygon), and ships come in from the west, the
  Golden Gate direction, along a curved path through the anchorage to the berth. Without it the viewer keeps its
  single-terminal layout with a low Bay Bridge and San Francisco silhouette on the horizon.
- `assets/ships.js` (`window.OakShips`): detailed hulls in the line's livery, deck load following the ship's
  remaining work, lights at night. Fallback: box ships.
- `assets/cranes.js` (`window.OakCranes`): detailed quay cranes with the terminal's trim colour (OICT blue, TraPac
  red, Everport green, Matson yellow), boom raised while idle. Their animation runs at most 60 times real time so the
  trolley stays readable at high replay speeds. Fallback: box gantries.
- `assets/yard.js` (`window.OakYard`): the container yard behind the quay. Fallback: instanced box stacks.

## What you see

- Ship state at hour t: at sea before `arrival`, anchored from `arrival` to `berth_hour`, alongside until
  `departure`, then departed. Moves are smoothed over about one to two hours of sim time; ships under way leave a wake.
- Quay cranes (the terminal's `crane_pool`) slide along the rail to the ships listed in `cranes_by_hour` and work
  while assigned; idle cranes park. Cranes keep their order on the rail. They stop in the meal hour (17:00 to 18:00),
  and working cranes switch on their lights at night.
- Closed blocks: red-striped quay segments during their hours. Shallow blocks: a pale band in the water with the
  depth label. `no_moves` windows: fog closes in, visibility drops and a "Bar closed" banner shows.
- A ship whose `late_h` is above zero shows a red flag and a red label from its due hour until it leaves.
- Sky colour, sun height and colour, fog colour and water colour follow the hour of day (hour 0 is Monday 00:00
  Pacific), with dawn and dusk tints, stars and glowing floodlights at night. The sun casts soft shadows over the
  terminal. The water has two layers of scrolling procedural waves.

## KPI panel

`kpi.js` holds pure functions (`window.OakKPI.at(replay, t)` and `window.OakKPI.series(replay)`) over replay fields
only, testable with node. At the current hour the panel shows: berth occupancy (sections occupied over sections),
cranes working over the hour's pool, ships alongside, ships at anchor (arrived, not berthed), ships departed, late
ships so far, cumulative late ship-hours, cost so far against the final cost (and the optimum), and the reward. Cost
so far accrues by the kernel's price: sections x hours late x weight, plus berth-deadline penalties, plus the move
penalty for ships put off their planned section, plus hoot gang cost on crane tasks. It reaches the grade's cost at
the horizon. A sparkline under the tiles plots berth occupancy and crane use (working over pool) for the whole
week, shades the bar-closed windows, and marks the current hour.

The side list gives each ship its line colour, status (at sea, anchored, alongside, departed), a progress bar of
moves done (crane-hours worked over the workload, times moves per crane-hour) and its lateness. The header shows
terminal, week, plan kind and grade.

## Fixtures (demo data)

`fixtures/oict-demo.json` (OICT, 50 sections, 10 cranes, 6 in hoot hours, 14 ships over 168 h, sections 47-50
shallow at 12.8 m, sections 20-26 closed hours 60-96 for crane rail repair, fog hours 30-35) and
`fixtures/matson-demo.json` (Matson, 13 sections, 4 cranes, 6 ships) are DEMO DATA built for this viewer. The ship
calls are generated, not real records; the plans and grades are illustrative, not solver output. `fixtures/demo-fixtures.js`
embeds the same two files as a classic script so the page works from disk.

## What is stylised

The scene is a stylised representation of the port, not a survey-grade digital twin: quay length comes from the
section count, the yard is generic, ship and crane models are simplified, the anchorage and sea lanes are placed for
readability (not real anchorage areas or traffic lanes), the sun path is a simple arc, and lighting, water and fog are
artistic. Ship calls are generated.

## Third-party

three.js r147 (`three@0.147.0`, `build/three.min.js` and `examples/js/controls/OrbitControls.js`), vendored under
`vendor/` from cdn.jsdelivr.net. MIT licence, copyright 2010-2022 three.js authors, see `vendor/LICENSE`. r147 is the
last release that ships the classic (non-module) OrbitControls, which keeps the page working from `file://`.
