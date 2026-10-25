# port-sim: Argon trains a small model on PortSimEnv

Gemini 4 Argon acts as the ML engineer. It owns the training recipe for a Qwen3.5-4B LoRA fine-tune on
[PortSimEnv](https://huggingface.co/datasets/FineEnvs/PortSimEnv) (berth planning at the Port of Barcelona, graded
deterministically against a CP-SAT optimum), launches training and eval on two A6000s, then reads every graded
rollout of the run in a single call, diagnoses the failure modes, rewrites the recipe and goes again.

Train, evaluate, watch, critique, fix. The reward curve over loops is the product.

## PortForge live dashboard

This repository also includes **PortForge**, a measured two-agent port operations demo:

- **Agent 1 — Supervisor (Gemini Argon):** watches the full experiment, introduces controlled challenges,
  diagnoses weaknesses from simulator statistics, and proposes bounded strategy changes.
- **Agent 2 — Operator (Gemini Argon):** executes berth allocation and crane scheduling using the active strategy.
- A deterministic minute-step simulator validates every action, computes all metrics, and only promotes a candidate
  when it improves the same fixed-seed benchmark without reducing completed vessels.
- The visible scenario asks the Operator for a new decision at vessel arrivals, departures, berth releases,
  disruptions, and congestion thresholds; every simulated minute is streamed to the 3D port.
- Completed epochs, accepted strategies, and replay traces persist in `data/portforge_state.json` and accepted
  strategies can be replayed against the baseline with play, pause, speed, and scrub controls.

Agent calls are orchestrated through LangChain's `ChatGoogleGenerativeAI` and Pydantic structured output. If
`GEMINI_API_KEY` is absent or Argon is unavailable, the dashboard explicitly displays **MOCK MODE**; it never labels
fallback decisions as live Argon output.

```bash
uv sync
cp .env.example .env  # add GEMINI_API_KEY for live Argon
uv run uvicorn portforge.backend.main:app --reload
```

Open http://127.0.0.1:8000. Run the guardrail and reproducibility suite with:

```bash
uv run python -m unittest tests.test_portforge -v
```

## Layout

| Path | What |
|---|---|
| `portsim/data.py` | fetches the dataset, builds `data/sft.jsonl` from the recipe |
| `portsim/grade.py` | grades a model's text with the PortSimEnv checker (no judge) |
| `portsim/evaluate.py` | runs a split against any OpenAI-compatible endpoint, writes `runs/<run>/` |
| `portsim/train_sft.py` | LoRA SFT with TRL, saves a merged model for vLLM |
| `portsim/agent.py` | the Argon loop and its tools |
| `portsim/recipe.json` | every knob Argon can turn |
| `scripts/setup_gpu.sh`, `scripts/serve.sh` | GPU box setup and vLLM serving |
| `third_party/berth_core` | the checker, vendored unchanged from FineEnvs (Apache-2.0) |

## Run

```bash
# laptop or GPU box
uv venv -p 3.12 .venv && uv pip install -e .
.venv/bin/python -m portsim.data fetch && .venv/bin/python -m portsim.data build

# GPU box (once)
scripts/setup_gpu.sh

# one loop by hand
CUDA_VISIBLE_DEVICES=0 .venv/bin/python -m portsim.train_sft --run loop1
GPU=1 scripts/serve.sh models/loop1 &
.venv/bin/python -m portsim.evaluate --run loop1 --base-url http://localhost:8000/v1 --model qwen-sft

# the whole thing, Argon in charge
GEMINI_API_KEY=... .venv/bin/python -m portsim.agent --loops 4 --gpu-host <ssh host>
```

## Eval protocol

Single shot: the dataset's own system prompt and situation, the model answers with the plan JSON, the checker grades
it. The published board let models call `check_plan` up to 10 times over 12 turns, so our numbers are a harder setting
than theirs. Reference points on the same 50 tasks: optimal plan 1.000, naive re-plan 0.201.

## Attribution

Tasks, checker and reward: FineEnvs PortSimEnv v1 (data CC BY-SA 4.0 from the Port de Barcelona open data portal,
code Apache-2.0). See `third_party/NOTICE`. Everything outside `third_party/` was written during the hackathon.
