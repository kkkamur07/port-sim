# PortForge Agent Context

This file is the persistent implementation context for contributors and coding agents working on this repository.
Read it before changing PortForge. Keep it accurate when architecture or runtime behavior changes.

## Product goal

PortForge is a live port-operations optimization demo. The main experience is a 3D terminal surrounded by two
visible roles, a fixed-seed performance comparison, an epoch history, and a graph of measured turnaround time.

- Agent 1, **Supervisor**, observes metrics, selects a controlled challenge, diagnoses a weakness, and proposes a
  bounded strategy change.
- Agent 2, **Operator**, produces berth and crane assignments under the active strategy.
- A deterministic simulator is the source of truth for port state and performance.
- A candidate is accepted only when it improves average turnaround time on the same fixed benchmark without
  reducing completed vessels.

Never fabricate metrics, agent states, decisions, improvements, or simulation state for presentation.

## Current repository shape

- `frontend/`: React/Vite/TypeScript control-room UI.
- `frontend/src/three/`: the small subset of the public Rork seaport UI retained for the 3D port.
- `frontend/src/portforge/`: PortForge shell, live agent panels, graph, metrics, and WebSocket client.
- `portforge/backend/agents/`: LangGraph roles, LangChain Gemini adapter, prompts, and structured schemas.
- `portforge/backend/simulation/`: deterministic minute-step port simulator and scheduling policies.
- `portforge/backend/improvement/`: benchmark runner, strategy promotion, history, and eight-stage epoch loop.
- `portforge/backend/api/`: HTTP commands and WebSocket event broker.
- `tests/test_portforge.py`: constraints, reproducibility, fallback, and loop-event tests.
- `docs/replay_schema.md`: exact upstream contract for PortSimEnv task, plan, grade, and self-contained 3D replay JSON.
- `portsim/`: the original training/evaluation project from `kkkamur07/port-sim`; it is separate from the live
  PortForge dashboard runtime.

The visual foundation came from `alexngdev99/rork-seaport-logistics-3d`, but its navigation, mock logistics pages,
mock weather, and mock AIS dashboard are not mounted. PortForge uses only the useful Three.js port primitives and a
custom control-room UI.

The upstream PortSim replay contract is authoritative for future `oakland_core.replay(task, plan)` payloads. Do not
silently relabel PortForge's minute-snapshot trace as that schema: PortSim uses section/hour plans and deterministic
grades, while the current dashboard simulator uses berth IDs and minute snapshots. Adapt explicitly at the replay
boundary when the core replay producer is integrated; do not change agent invocation behavior as part of that work.

## Runtime modes

### Live Gemini mode

Live model calls occur only when `GEMINI_API_KEY` is present and the provider request succeeds.

```env
GEMINI_API_KEY=...
ARGON_MODEL=<a Gemini model available to that API key>
```

`ArgonClient.structured()` builds a LangChain chain:

`ChatPromptTemplate -> ChatGoogleGenerativeAI -> Pydantic structured output`

The configured default model string is currently `gemini-4-argon`. Confirm that the account actually exposes the
configured model before describing it as live. The presence of a key alone does not prove the request succeeded.

Per epoch, live model calls occur at these boundaries:

1. **Supervisor call:** receives the active strategy, measured benchmark metrics, recent epoch history, the
   server-selected scenario, and the allowed strategy parameter values. It returns a structured diagnosis and
   candidate strategy.
2. **Operator calls:** receives a current snapshot, active strategy, and trigger list whenever a vessel arrives, a
   berth becomes available, a vessel departs, an evaluator disruption begins, or queue congestion crosses the
   threshold. It returns structured berth and crane assignments for each meaningful event.

Every assignment validation failure emits a structured `decision_rejected` event with the action, affected resource,
and reason. The Operator receives recent events in its next prompt. A rejected decision causes one immediate
correction request; if that correction still cannot make progress, the validated deterministic policy safely
rescues the simulation. The following Supervisor epoch receives the previous trace's rejection evidence.

The server still owns scenario seeds and replaces any model-supplied scenario with the fixed server scenario. Model
output must validate against Pydantic schemas. The simulator validates assignments before applying them.

### Deterministic fallback mode

Fallback mode is used when:

- `GEMINI_API_KEY` is absent;
- LangChain's Google integration cannot load;
- the provider request fails or times out; or
- structured output is missing or invalid.

In fallback mode:

- The Supervisor cycles through four fixed scenarios and bounded strategy variants in
  `EvaluatorAgent._mock_proposal()`.
- The Operator uses `PortEngine._operator_decision()`, which delegates to deterministic berth and crane scheduling
  rules.
- The UI must say **MOCK MODE / DETERMINISTIC MOCK** and must not attribute these outputs to Gemini.

The fallback is intentional so the complete product remains demonstrable without external credentials. It is not
an AI agent and should never be presented as one.

### Logic that is always deterministic

These components remain deterministic even when live Gemini calls are enabled:

- vessel generation from a scenario seed;
- minute-by-minute arrivals, queues, unloading, departures, crane availability, and berth occupancy;
- validation that berths and cranes cannot be double-assigned;
- the three fixed evaluation scenarios and their seeds;
- baseline, incumbent, and candidate simulation runs;
- all turnaround, waiting, utilization, completion, and improvement calculations;
- candidate acceptance or rejection;
- the state rendered by the 3D port and all chart points.

The visible scenario is event-driven and agent-controlled. The fixed acceptance benchmark intentionally remains
deterministic: it evaluates the scheduling policy encoded by the proposed strategy without allowing model latency or
sampling variance to contaminate the comparison. Describe this as agent-controlled operations with deterministic
evaluation, not as an LLM producing the benchmark scores directly.

## Epoch workflow

The UI and backend expose eight stages:

1. **GENERATE CHALLENGE** — LangGraph runs Supervisor, then Operator. Each node uses Gemini only if live mode works;
   otherwise it uses the deterministic fallback described above.
2. **EXECUTE OPERATOR** — run the full visible scenario minute by minute. Stream every minute over WebSocket and ask
   the Operator for a new validated decision at each meaningful operational event.
3. **MEASURE PERFORMANCE** — deterministically run the incumbent strategy on the selected scenario.
4. **EVALUATE RESULTS** — expose the Supervisor diagnosis generated in stage 1.
5. **PROPOSE IMPROVEMENT** — expose the bounded candidate strategy generated in stage 1.
6. **TEST CANDIDATE** — run baseline, incumbent, and candidate strategies against identical fixed-seed benchmark
   scenarios, arrival schedules, horizons, and disruptions.
7. **ACCEPT OR REJECT** — accept only if average turnaround improves by more than 0.05 minutes and completed vessel
   count does not regress.
8. **NEXT EPOCH** — atomically persist the epoch, strategies, metrics, decisions, and baseline/candidate/operator
   replay traces. Replay controls can play, pause, change speed, scrub, and switch between baseline and Best AI.

`AgentStatus.THINKING` is reserved for the duration of a real Gemini provider request. Fallback execution uses
`EVALUATING` or `EXECUTING`, never `THINKING`.

## Live data path

`POST /api/optimization/start` starts the loop. `ImprovementLoop` emits stage, agent, decision, simulation, metric,
and epoch events through `EventBroker`. The frontend listens on `/ws/events` and refreshes `/api/state` after events.
The 3D scene maps backend vessel IDs, berth IDs, and crane IDs to the retained Three.js objects. The chart and epoch
cards are built only from completed backend `EpochRecord` objects.

Completed state is stored in `data/portforge_state.json` using atomic replace semantics and restored on server start.
This runtime file is ignored by Git. Reset intentionally clears both memory and the persisted state.

## Starter data

Starter data already exists in code; there is no database requirement for the demo.

- Ten stable vessel IDs, eight berths, and fourteen STS cranes are defined by the simulator state.
- Four rotating challenge templates use reproducible seeds derived from epoch number.
- Three fixed benchmark scenarios use seeds `101`, `211`, and `307`.
- Before optimization starts, the 3D port shows a real replay snapshot from the first benchmark scenario using the
  FCFS baseline strategy.

## Truthful UI rules

- Read `agent_mode` from backend state. Show `gemini/argon` branding only in live mode; show `MOCK MODE · NO API
  KEY` or a provider-failure fallback label otherwise.
- A WebSocket being connected means only that the live event stream is connected. It does not mean Gemini is active.
- Do not show `Thinking` unless an actual provider request is in progress.
- Candidate performance may fluctuate. Best accepted performance may not regress on the fixed benchmark.
- Do not compare throughput from simulations with different horizons.
- The 3D scene must use backend simulation state, not invented client-side movement or status values.

## Commands

```bash
# Python environment and server
uv sync
.venv/bin/python -m uvicorn portforge.backend.main:app --host 127.0.0.1 --port 8000

# Backend test suite (works without pytest)
.venv/bin/python -m unittest -v tests.test_portforge

# Frontend verification and production build
cd frontend
./node_modules/.bin/tsc --noEmit
bun run build
```

The FastAPI server serves `frontend/dist`, so rebuild the frontend after UI changes. Preserve the user's unrelated
working-tree changes. Do not replace real data with hard-coded demo numbers to make the presentation look better.
