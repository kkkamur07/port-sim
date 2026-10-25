# Demo script: Port of Oakland digital twin (90 seconds)

Open before going on stage: `http://127.0.0.1:8765/viewer/?run=../runs/live` (run `runs/live`, 9 episodes on
playbook v0, verification 0.926, coach proposals v1 and v2 rejected by the gate, v3 pending).

| time | click | say |
|---|---|---|
| 0:00 | Viewer open, 3D port playing the newest episode | "Running a port is constant optimization: ships arrive late, fog closes the channel, a crane breaks. We built a digital twin of the Port of Oakland, the container port across the bay from San Francisco." |
| 0:12 | Point at the ships moving in from the Golden Gate | "The terminals, berths, cranes, depths and ILWU shifts are the real ones. Ships come in on an AIS-shaped feed; it can take the live aisstream.io feed, and here it replays generated calls so every task has a proven optimum." |
| 0:25 | Panel, **Operator** tab, port statistics | "Gemini Argon operates the port. Each episode it gets a disruption, uses its tools, checks plans against the rules and submits one berth plan." |
| 0:35 | **Operator** tab, chat: type "Are you improving?" | "You can ask it why it did what it did. It answers from its own logs and can regrade a what-if with the real checker." |
| 0:48 | **Results** tab, routine outcome and playbook versions front | "The self-improving part is two agents. The player operates. The coach reads the player's logs and rewrites its context, the playbook, one rule at a time. Every change is scored on held-out tasks against the exact optimum from a CP-SAT solver, and kept only if the score goes up." |
| 1:05 | Point at v1 and v2 marked rejected | "Honest number: every proposal so far was rejected by the gate: the coach's v1 and v2 at the prescreen, and the one I asked for from the chat on the held-out tasks (0.913 against 0.926). The verifier decides, not the model." |
| 1:15 | Click **Optimize my playbook** | "This asks the coach for a new rule right now; the verification result lands in this panel in a few minutes." |
| 1:25 | Back to the 3D view | "One more honesty line: the digital twin (world, checker, solver, viewer) was built by coding agents during this hackathon. Argon operates it." |

> **If something breaks**
>
> - Restart the demo without the loop: `cd oakland && LOOP=off RUN=live ./demo.sh`
> - Fixture fallback (a finished real run, no server state needed): `http://127.0.0.1:8765/viewer/?run=fixtures/run-demo`
> - Chat server health: `http://127.0.0.1:8771/health` should return `{"ok": true, "model": "gemini-4-argon", ...}`

## Likely judge questions

**How is verification done?** By code, never by a model. Each candidate playbook is first played on the coach
window's tasks (a pre-screen); if it falls below the window's own mean by more than 0.005 it is rejected at once,
which is what happened to v1 (-0.034) and v2 (-0.212). A candidate that passes plays the whole held-out verification
set with the same frozen player, and is accepted only when its mean reward beats the accepted version's mean by at
least 0.005. The reward is the kernel's deterministic v3 formula; episode and verification means are reported side
by side, never averaged. Every proposal so far was rejected by the gate: the coach's v1 and v2 at the prescreen,
and the one asked for from the chat on the held-out tasks (0.913 against 0.926). The verifier decides, not the model.

**What is the optimum?** For every task a CP-SAT solver computes the minimum-cost plan (lateness in section-hours,
priority weights, emergency penalties, a penalty per ship moved off its published section) and a task is kept only
if the solver proves optimality within its time limit. The optimum scores 1.0; a feasible plan scores
`0.2 + 0.8 x exp(-g / 0.5)` with `g` the normalised gap to the optimum; an infeasible plan scores below 0.2. The
solver is never exposed to the player.

**What does the coach change?** Only the playbook: a markdown file of prose rules plus a short checklist (at most 60
lines) that goes into the player's system prompt. The coach reads the player's full event logs (every model call,
tool call and result), names mistakes with evidence spans pointing at real events (findings without valid evidence
are dropped by code), and adds one imperative rule per round. Candidates form a GEPA-style tree with a Pareto front,
so a rejected version can still be a parent later.

**Is anything trained?** No. No model weights change. The playbook is the only state that changes between episodes;
this is in-context adaptation from feedback, verified on held-out tasks.

**What does an episode cost?** On `runs/live` the 9 Gemini Argon episodes cost about $0.56 each on average (from
$0.06 to $1.02, estimated from token counts) and take about 2 minutes. One on-demand "Optimize my playbook" proposal
is under $0.05 for the coach call; verifying it on 4 held-out tasks took 8 minutes and $1.93.

**What is real data and what is generated?** Real: the four terminals (OICT, TraPac, Everport, Matson) with their
berth numbers, quay lengths, crane fleets and depths from the Port of Oakland's public facilities pages, and the ILWU
shift hours. Generated: every ship call (built from real services that call Oakland, but not real records), the
disruptions, and the synthetic AIS positions. The feed code can subscribe to the real aisstream.io stream for the Bay
when a key is set.
