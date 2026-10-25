# Port of Oakland digital twin, operated by a self-improving Gemini Argon agent

Running a port is constant optimization. Ships arrive late, fog closes the channel, a crane breaks, and the berth
plan has to be redone. A digital twin can run the port in simulation and help the people who operate the real one.
This repository is a digital twin of the Port of Oakland, the container port across the bay from San Francisco, with
its real terminals, cranes and shifts and an AIS-shaped ship feed. Gemini 4 Argon operates it: it makes the berth
plans, answers questions about the port, makes schedules when asked, and improves its own playbook. It does not get
to grade itself. Every change to the playbook is verified by code against the exact optimum from a CP-SAT solver.

## What you see

The main screen is the 3D port: ships come in from the Golden Gate, wait at anchor, berth on their quay sections and
get worked by quay cranes hour by hour, with late ships, closures and fog windows marked. The side panel has two tabs.
Operator shows the port at the current hour (the quay to scale with each ship's sections and cranes, ships
alongside, ships waiting at anchor, the next arrival, cranes working of the pool, late ship-hours, and one sentence
naming the exception in force, such as a storm closure or a late ship) and a chat with the agent, which can explain a late ship, regrade a what-if with the real
checker, or propose a plan and show it in 3D. Results has the "Optimize my playbook" button, a result card per
proposal (before, after, accepted or rejected, the rule) and the curve of playbook versions.

## Run it

Put your key in `.env` at the repo root as `GEMINI_API_KEY` (`GOOGLE_API_KEY` also works). `demo.sh` loads it,
never prints it, and exits if neither is set. It uses `../.venv/bin/python` from `oakland/` unless `PYTHON` is set;
the loop and the chat need the `loop` extra from `pyproject.toml`. From `oakland/`:

```bash
LOOP=off RUN=live ./demo.sh   # serve an existing run: viewer and chat, no loop
./demo.sh                     # viewer and chat, then the loop on run "live": 9 episodes, a coach round every 3
./demo.sh stop                # stop what demo.sh started for RUN
```

Then open:

- viewer: http://127.0.0.1:8765/viewer/?run=../runs/live
- dashboard: http://127.0.0.1:8765/dashboard/?run=../runs/live
- chat health: http://127.0.0.1:8771/health

Logs go to `oakland/runs/<RUN>/logs/`. Without a live run, `viewer/?run=fixtures/run-demo` replays a finished
16-episode run bundled with the repo. The environment itself (tasks, rules, the HTTP server, the ship feed) is
documented in [oakland/README.md](oakland/README.md), and the 90-second walkthrough is in
[docs/demo-script.md](docs/demo-script.md).

## How the agent improves

There are two agents. The player gets one terminal over one or two weeks after something went wrong, uses its tools,
checks plans against the rules and submits one berth plan. The coach reads the player's full event logs, names
mistakes with evidence that points at real events, and adds one rule to the playbook. The playbook is a short
markdown file that goes into the player's system prompt, so it is the agent's context and the only thing that changes
between episodes. Nothing is trained and no weights change.

A new playbook version is first played on the coach window's recent episodes. If its mean falls below theirs by more
than 0.005 it is rejected there. If it passes, the same frozen player plays the held-out verification tasks, whose
optimum the CP-SAT solver has proven, and the version is accepted only when its mean beats the accepted version's by
at least 0.005. Rejected versions stay in the tree and can still be parents later.

The reward is deterministic:

    feasible plan     0.2 + 0.8 x exp(-g / 0.5), so the optimum scores 1.0
    infeasible plan   0.2 x the fraction of ships with no violation, so below 0.2
    g                 (cost - optimum) / (optimum - floor + 100), floor being a provable lower bound on the cost

## What is real and what is generated

The four terminals (OICT, TraPac, Everport, Matson) are real: berth numbers, quay lengths, depths and crane pools
come from the Port of Oakland's public facilities pages, and the ILWU day, night and hoot shifts are the real hours.
The ship calls and their names are generated. They follow real services that call Oakland, but they are not real
records, and generating them is what lets every task have a proven optimum. The AIS feed takes the live aisstream.io
stream for the Bay when `AISSTREAM_API_KEY` is set and otherwise produces generated positions for the task's ships.
The twin itself (world, checker, solver, viewer) was built by coding agents during the Gemini 4 Argon SF Hackathon
on 2026-10-25. Argon operates it.

## Repository layout

| path | what |
|---|---|
| `oakland/` | the digital twin: kernel and solver (`oakland_core`), episode env and server, ship feed, the player and coach loop (`loop`), operator chat (`chat`), 3D viewer, dashboard, task packs, tests |
| `docs/` | the demo script, the Oakland spec and the replay JSON schema |
| `portsim/` | the earlier PortSim (Barcelona) experiment, where Argon ran an SFT loop on a small open model |
| `data/` | the SFT data built by `portsim.data` |
| `scripts/` | GPU box setup and vLLM serving for `portsim` |
| `runs/` | output of `portsim.evaluate` |
| `third_party/` | `berth_core`, the FineEnvs PortSimEnv v1 checker (Apache-2.0, data CC BY-SA 4.0), see `third_party/NOTICE` |

## Results of the live run

On `runs/live` the player played 9 episodes on playbook v0, which scores 0.926 on verification. The coach proposed
three versions. v1 and v2 were rejected at the prescreen (episodes -0.034 and -0.212). v3 did better on the recent
episodes (+0.086) and worse on verification (-0.136), so it was rejected as overfit. A proposal requested from the
chat with "Optimize my playbook" scored 0.913 against 0.926 on the held-out tasks and was rejected too. No proposal
has been accepted yet. That is the gate working as intended: the verifier decides, not the model.
