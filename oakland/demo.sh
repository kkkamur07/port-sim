#!/usr/bin/env bash
# Hackathon demo: Gemini 4 Argon runs the Port of Oakland berth plans through oakland/loop while the dashboard and
# the 3D viewer follow the run live. Ship calls are GENERATED, not real records.
#
#   ./demo.sh                     # run "live": 9 episodes, a coach round every 3
#   RUN=rehearsal EPISODES=12 COACH_EVERY=4 PLAYER=scripted COACH=scripted ./demo.sh
#   PYTHON=/path/to/.venv/bin/python ./demo.sh   # another interpreter (default ../.venv/bin/python)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-8765}"
RUN="${RUN:-live}"
cd "$HERE"
PYTHON="${PYTHON:-../.venv/bin/python}"

# API keys (GOOGLE_API_KEY or GEMINI_API_KEY) from the repo's .env, never printed
if [ -f "$ROOT/.env" ]; then
  set -a
  . "$ROOT/.env"
  set +a
fi

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

port_busy() {
  python3 - "$PORT" <<'PY'
import socket, sys
s = socket.socket()
s.settimeout(0.5)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
}

if port_busy; then
  echo "[demo] port $PORT is busy (already serving), not starting a server; continuing"
else
  python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  SERVER_PID=$!
  echo "[demo] static server on port $PORT (pid $SERVER_PID), serving $HERE"
fi

echo "[demo] dashboard: http://127.0.0.1:$PORT/dashboard/?run=../runs/$RUN"
echo "[demo] viewer:    http://127.0.0.1:$PORT/viewer/?run=../runs/$RUN"

"$PYTHON" -m loop.run --run "$RUN" \
  --episodes "${EPISODES:-9}" --coach-every "${COACH_EVERY:-3}" --kind berth \
  --tasks tasks/berth-train.jsonl --verify-pack tasks/berth-eval-demo.jsonl --tiers storm,extreme --workers 4 \
  --player "${PLAYER:-auto}" --coach "${COACH:-auto}" --quiet
