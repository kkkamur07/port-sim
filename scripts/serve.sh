#!/usr/bin/env bash
# Serve a model for eval on GPU 1 (the trainer uses GPU 0).  usage: scripts/serve.sh models/loop1 [port]
set -euo pipefail
MODEL=${1:?model path or hub id}
PORT=${2:-8000}
CUDA_VISIBLE_DEVICES=${GPU:-1} vllm serve "$MODEL" --served-model-name qwen-sft --port "$PORT" \
  --language-model-only --max-model-len 16384 --gpu-memory-utilization 0.9 --dtype bfloat16 \
  --max-num-seqs 32 --reasoning-parser qwen3
