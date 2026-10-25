#!/usr/bin/env bash
# One-time setup on the A6000 box. Run from the repo root. Needs CUDA 12.x drivers and uv.
set -euo pipefail
uv venv -p 3.12 .venv
source .venv/bin/activate
uv pip install -e '.[train]'
# vLLM in the same env usually works; if torch versions fight, give it its own venv (see serve.sh)
uv pip install vllm
uv pip install flash-attn --no-build-isolation || echo "flash-attn skipped, sdpa will do"
python -m portsim.data fetch
python -m portsim.data build
hf download Qwen/Qwen3.5-4B --quiet || huggingface-cli download Qwen/Qwen3.5-4B
python - <<'PY'
import portsim, json
from portsim.data import load
from portsim.grade import load_task, grade_plan
df = load("eval"); r = df.iloc[0]; t = load_task(r["task"])
print("checker smoke test: optimal ->", grade_plan(t, json.loads(r["optimal_plan"]))["reward"])
PY
