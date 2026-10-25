#!/usr/bin/env bash
# Hackathon demo: Gemini 4 Argon runs the Port of Oakland berth plans through oakland/loop while the dashboard, the
# 3D viewer and the operator chat follow the run live. Ship calls are GENERATED, not real records.
#
#   ./demo.sh                     # viewer on 8765, chat on 8771, run "live": 9 episodes, a coach round every 3
#   LOOP=off RUN=live ./demo.sh   # serve an existing run only (viewer and chat), no loop
#   ./demo.sh stop                # stop what demo.sh started for RUN (pids in runs/<RUN>/logs/pids)
#   RUN=rehearsal EPISODES=12 COACH_EVERY=4 PLAYER=scripted COACH=scripted ./demo.sh
#   PYTHON=/path/to/.venv/bin/python ./demo.sh   # another interpreter (default ../.venv/bin/python)
#   PORT=8766 CHAT_PORT=8781 ENV_FILE=/path/.env ./demo.sh   # other ports, another .env (default ../.env)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-8765}"
CHAT_PORT="${CHAT_PORT:-8771}"
RUN="${RUN:-live}"
LOOP="${LOOP:-on}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
cd "$HERE"
PYTHON="${PYTHON:-../.venv/bin/python}"
LOGS="runs/$RUN/logs"
PIDS="$LOGS/pids"

if [ "${1:-}" = "stop" ]; then
  if [ ! -f "$PIDS" ]; then
    echo "[demo] nothing to stop for run $RUN (no $PIDS)"
    exit 0
  fi
  while read -r name pid; do
    if kill "$pid" 2>/dev/null; then echo "[demo] stopped $name (pid $pid)"; else echo "[demo] $name (pid $pid) was not running"; fi
  done < "$PIDS"
  rm -f "$PIDS"
  exit 0
elif [ -n "${1:-}" ]; then
  echo "[demo] unknown command: $1 (use ./demo.sh or ./demo.sh stop)" >&2
  exit 2
fi

# API keys (GOOGLE_API_KEY or GEMINI_API_KEY) from the repo's .env, never printed
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi
if [ -z "${GOOGLE_API_KEY:-}" ] && [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "[demo] no GOOGLE_API_KEY or GEMINI_API_KEY (looked in $ENV_FILE); the chat server needs one" >&2
  exit 1
fi
export ALLOW_MODEL_REQUESTS=1

port_busy() {
  python3 - "$1" <<'PY'
import socket, sys
s = socket.socket()
s.settimeout(0.5)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
}
viewer_up() { curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/viewer/" 2>/dev/null; }
chat_up() { curl -fsS --max-time 2 "http://127.0.0.1:$CHAT_PORT/health" 2>/dev/null | grep -q '"ok": *true'; }

# Fail before starting anything when a port is held by something that is not ours
if port_busy "$PORT" && ! viewer_up; then
  echo "[demo] port $PORT is taken by something that does not serve /viewer/; free it or set PORT" >&2
  exit 1
fi
if port_busy "$CHAT_PORT" && ! chat_up; then
  echo "[demo] port $CHAT_PORT is taken by something that does not answer /health; free it or set CHAT_PORT" >&2
  exit 1
fi

if [ "$LOOP" = "off" ] && [ ! -d "runs/$RUN" ]; then
  echo "[demo] warning: runs/$RUN does not exist yet; the viewer and chat will have nothing to show" >&2
fi
mkdir -p "$LOGS"

if port_busy "$PORT"; then
  echo "[demo] port $PORT already serves the viewer, reusing it"
else
  python3 -m http.server "$PORT" --bind 127.0.0.1 >>"$LOGS/http.log" 2>&1 &
  HTTP_PID=$!
  echo "http $HTTP_PID" >> "$PIDS"
  for _ in $(seq 1 20); do viewer_up && break; sleep 0.25; done
  viewer_up || { echo "[demo] static server did not come up on port $PORT (see $LOGS/http.log)" >&2; exit 1; }
  echo "[demo] static server on port $PORT (pid $HTTP_PID), serving $HERE"
fi

if chat_up; then
  echo "[demo] port $CHAT_PORT already answers /health, reusing that chat server"
else
  "$PYTHON" -m chat.server --port "$CHAT_PORT" --runs-dir runs --verify-pack tasks/berth-eval-demo.jsonl \
    >>"$LOGS/chat.log" 2>&1 &
  CHAT_PID=$!
  echo "chat $CHAT_PID" >> "$PIDS"
  for _ in $(seq 1 40); do
    chat_up && break
    if ! kill -0 "$CHAT_PID" 2>/dev/null; then
      echo "[demo] chat server exited at start; last lines of $LOGS/chat.log:" >&2
      tail -n 5 "$LOGS/chat.log" >&2
      exit 1
    fi
    sleep 0.5
  done
  chat_up || { echo "[demo] chat server did not answer /health within 20 s (see $LOGS/chat.log)" >&2; exit 1; }
  echo "[demo] chat server on port $CHAT_PORT (pid $CHAT_PID)"
fi

echo "[demo] dashboard: http://127.0.0.1:$PORT/dashboard/?run=../runs/$RUN"
echo "[demo] viewer:    http://127.0.0.1:$PORT/viewer/?run=../runs/$RUN"
echo "[demo] chat:      http://127.0.0.1:$CHAT_PORT/health"
echo "[demo] logs in $LOGS/, stop the servers with ./demo.sh stop"

if [ "$LOOP" = "off" ]; then
  exit 0
fi

# The loop runs in the background so Ctrl-C stops it alone; the servers stay up until ./demo.sh stop
"$PYTHON" -m loop.run --run "$RUN" \
  --episodes "${EPISODES:-9}" --coach-every "${COACH_EVERY:-3}" --kind berth \
  --tasks tasks/berth-train.jsonl --verify-pack tasks/berth-eval-demo.jsonl --tiers storm,extreme --workers 4 \
  --player "${PLAYER:-auto}" --coach "${COACH:-auto}" --quiet >>"$LOGS/loop.log" 2>&1 &
LOOP_PID=$!
echo "loop $LOOP_PID" >> "$PIDS"
trap 'kill "$LOOP_PID" 2>/dev/null || true' INT TERM
echo "[demo] loop running (pid $LOOP_PID), follow it with: tail -f $LOGS/loop.log"
wait "$LOOP_PID"
