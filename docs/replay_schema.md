# Shared contracts between the environment core, the 3D replay and the agent loop

## Task JSON (`Task.to_dict()`)

Same fields as PortSimEnv's `berth_core.model.Task` (see third_party/berth_core/model.py), plus:

- `kind`: "berth" | "crane"
- `terminal`: "OICT" | "TraPac" | "Everport" | "Matson"; `quay`: the berth numbers, e.g. "55-60"
- `first_section` = 1, `last_section` = number of 42 m sections of that terminal
- `ships[i].draught_m` is always set; `blocks` may include kind "shallow" (sections too shallow for ships with
  `draught_m` > `max_draught_m`; such a block carries `max_draught_m` in its `label` as "max draught 12.8 m" and
  spans hours 0..horizon)
- `rules`: `crane_pool`, `crane_outages`, `max_moves_per_hour` (2), `no_moves` (fog/bar windows, min_length 0),
  `reward` (3), `gap_k` (100), `moves_per_crane_hour` (26), `shifts` {"day":[8,17],"night":[18,27],"hoot":[3,8]} in hours
  of the day (night 18..27 means 18:00 to 03:00 next day), `meal_hours` [17] (no crane work 17:00-18:00),
  `hoot_pool` (cranes available in hoot hours), `hoot_gang_cost` (2)
- for kind "crane": `ships[i].planned_hour` and `planned_section` are the FIXED berth (hour and section) the agent
  cannot change; `fixed_berths: true` in `rules`.

## Plan JSON (the action)

- kind "berth": `[{"ship": 0, "berth_hour": 12, "section": 7, "cranes": 3}, ...]` (PortSim's format)
- kind "crane": `[{"ship": 0, "cranes": {"day": 3, "night": 3, "hoot": 1}}, ...]`

## Replay JSON (`oakland_core.replay(task, plan) -> dict`), what the 3D viewer loads

```json
{
  "task": { ...Task.to_dict(public=True)... },
  "plan": [ ...plan JSON as submitted... ],
  "grade": { "reward": 0.73, "feasible": true, "cost": 412, "optimal_cost": 380, "violations": [] },
  "horizon_h": 336,
  "ships": [
    {"id": 0, "name": "ONE APUS", "line": "ONE", "length_m": 364, "sections": 9, "first_section": 3,
     "arrival": 10, "berth_hour": 12, "departure": 41, "due": 38, "late_h": 3,
     "cranes_by_hour": [[12, 3], [13, 3], ...],   // (hour, cranes working that hour)
     "problems": []}
  ],
  "blocks": [ {"first": 1, "last": 6, "start": 100, "end": 148, "kind": "closed", "label": "crane rail repair"} ],
  "no_moves": [ {"start": 30, "end": 36, "label": "fog, bar closed"} ],
  "crane_pool_by_hour": [[0, 10], [1, 10], ...]
}
```

`cranes_by_hour` is empty for hours the ship waits alongside (meal hour, no-movement window). Everything the viewer
needs is in this one file; it never recomputes rules.

## Agent loop tools (the Argon player sees exactly these)

- `get_situation()` -> the rules text + situation text
- `check_plan(plan)` -> `{"feasible": bool, "cost": int|null, "violations": [{"ship": 0, "problem": "..."}]}` (max 10 per episode, never a reward)
- `submit_plan(plan)` -> ends the episode, returns the grade
