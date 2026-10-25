# Oakland berth replay (3D viewer)

A static page that replays one berth plan at a Port of Oakland terminal in 3D: ships arrive from the bay, wait at
anchor, berth on their quay sections, quay cranes work them hour by hour, late ships are flagged, and closures,
shallow sections and fog windows are shown. It reads a replay JSON (see `docs/replay_schema.md`) and never recomputes
rules: everything it draws comes from that file.

## How to open

- Double-click `index.html` (works from disk, no build step, no npm). It opens the OICT demo fixture.
- Or serve the folder: `cd oakland/viewer && python -m http.server 8000`, then open `http://localhost:8000/`.
- Load another replay with the "Load JSON" button, or by URL when served: `http://localhost:8000/?replay=fixtures/matson-demo.json`
  (any URL the browser may fetch). Pages opened from disk cannot fetch files, so use "Load JSON" there.

Controls: Play/Pause (or the space bar), speed 1x 4x 16x 64x (1x is a quarter of a sim hour per second), the hour
scrubber, camera presets Overview, Quayside, Overhead, and mouse orbit (drag to rotate, right-drag to pan, wheel to
zoom). Click a ship in the side list to fly to it.

## What you see

- Ship state at hour t: at sea before `arrival`, at anchor from `arrival` to `berth_hour`, alongside until
  `departure`, then departed. Moves are smoothed over about one to two hours of sim time.
- Quay cranes (the terminal's `crane_pool`) slide along the rail to the ships listed in `cranes_by_hour` and run the
  trolley while working; idle cranes park. Cranes keep their order on the rail. They dim in the meal hour
  (17:00 to 18:00), and working cranes switch on their lights at night and in the hoot shift.
- Closed blocks: red-striped quay segments during their hours. Shallow blocks: a pale band in the water with the
  depth label. `no_moves` windows: fog closes in and a "Bar closed" banner shows.
- A ship whose `late_h` is above zero shows a red flag and a red label from its due hour until it leaves; the side
  list shows late hours in red. The header shows the grade (reward, cost vs optimal, feasible).
- The sky follows the hour of day (hour 0 is Monday 00:00 Pacific).

## Fixtures (demo data)

`fixtures/oict-demo.json` (OICT, 50 sections, 10 cranes, 6 in hoot hours, 14 ships over 168 h, sections 47-50
shallow at 12.8 m, sections 20-26 closed hours 60-96 for crane rail repair, fog hours 30-35) and
`fixtures/matson-demo.json` (Matson, 13 sections, 4 cranes, 6 ships) are DEMO DATA built for this viewer. The ship
calls are generated, not real records; the plans and grades are illustrative, not solver output. `fixtures/demo-fixtures.js`
embeds the same two files as a classic script so the page works from disk.

## Scene caveat

The scene is a stylised representation of the terminal (quay length from the section count, simple gantries, a
generic yard, a low Bay Bridge and San Francisco silhouette on the horizon), not a survey-grade digital twin.

## Third-party

three.js r147 (`three@0.147.0`, `build/three.min.js` and `examples/js/controls/OrbitControls.js`), vendored under
`vendor/` from cdn.jsdelivr.net. MIT licence, copyright 2010-2022 three.js authors, see `vendor/LICENSE`. r147 is the
last release that ships the classic (non-module) OrbitControls, which keeps the page working from `file://`.
