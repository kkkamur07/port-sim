"""A tiny HTTP server for OaklandEnv: the same three agent tools as JSON, one episode at a time.

    python server.py --tasks tasks/berth-eval.jsonl --port 8011

    POST /reset      {"task_id": "..."} | {"index": 0} | {"split": "eval", "index": 3}   -> reset observation
    GET  /situation                                                                   -> {"situation": text}
    POST /check      {"plan": [...] or "json text"}                                   -> violations and cost
    POST /submit     {"plan": [...] or "json text"}                                   -> the grade, ends the episode
    GET  /tasks                                                                       -> ids, kind, difficulty, terminal
    GET  /replay                                                                      -> replay JSON of the last submission
    GET  /ais?hour=<float>                                                            -> AIS-shaped ship positions

Ship calls are GENERATED (not real records); terminal geometry, fleets, depths and shifts are real. /ais streams real
positions from aisstream.io when AISSTREAM_API_KEY is set, else synthesises them for the current episode's task (see
feed.py). Standard library only. CORS is open so a browser agent or the viewer can call it.
"""

from __future__ import annotations

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs

from env import OaklandEnv
from feed import AISStream, SyntheticAIS


def ais_payload(env: OaklandEnv, hour: float, stream: AISStream | None) -> dict:
    """GET /ais: the real stream when one is running, else the synthetic feed of the current episode's task (the
    submitted plan once there is one) or of the first task when no episode is active."""
    if stream is not None and stream.enabled:
        return {"source": stream.source, "hour": hour, "positions": stream.positions(), "events": []}
    task = env.task or env.tasks[0]
    plan = env.submitted_plan if env.task is not None and env.done else None
    try:
        feed = SyntheticAIS(task, plan)
    except Exception:   # noqa: BLE001, an unreadable submission falls back to the published plan
        feed = SyntheticAIS(task)
    return {"source": feed.source, "hour": hour, "positions": feed.positions(hour), "events": feed.events(hour)}


def make_handler(env: OaklandEnv, lock: threading.Lock,
                 stream: AISStream | None = None) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "OaklandEnv/1"

        def log_message(self, fmt, *args):  # quiet by default
            pass

        def _send(self, status: int, body: dict | list) -> None:
            data = b"" if status == 204 else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n == 0:
                return {}
            body = json.loads(self.rfile.read(n).decode() or "{}")
            if not isinstance(body, dict):
                raise ValueError("request body must be a JSON object")
            return body

        def _result(self, out: dict) -> None:
            self._send(400 if "error" in out else 200, out)

        def do_OPTIONS(self):
            self._send(204, {})

        def do_GET(self):
            path, _, query = self.path.partition("?")
            path = path.rstrip("/")
            with lock:
                if path == "/ais":
                    try:
                        hour = float(parse_qs(query).get("hour", ["0"])[0])
                    except ValueError:
                        self._send(400, {"error": "hour must be a number"})
                        return
                    self._send(200, ais_payload(env, hour, stream))
                elif path == "/tasks":
                    self._send(200, env.task_list())
                elif path == "/situation":
                    try:
                        self._send(200, {"situation": env.get_situation()})
                    except RuntimeError as e:
                        self._send(400, {"error": str(e)})
                elif path == "/replay":
                    self._result(env.replay())
                else:
                    self._send(404, {"error": f"no route GET {path}"})

        def do_POST(self):
            path = self.path.split("?", 1)[0].rstrip("/")
            try:
                body = self._body()
            except (ValueError, UnicodeDecodeError) as e:
                self._send(400, {"error": f"bad request body: {e}"})
                return
            with lock:
                if path == "/reset":
                    try:
                        self._send(200, env.reset(task_id=body.get("task_id"), index=body.get("index"),
                                                  split=body.get("split")))
                    except (KeyError, IndexError, ValueError, TypeError) as e:
                        self._send(400, {"error": str(e)})
                elif path in ("/check", "/submit"):
                    if "plan" not in body:
                        self._send(400, {"error": "body must be {\"plan\": ...}"})
                        return
                    fn = env.check_plan if path == "/check" else env.submit_plan
                    self._result(fn(body["plan"]))
                else:
                    self._send(404, {"error": f"no route POST {path}"})

    return Handler


def make_server(env: OaklandEnv, host: str = "127.0.0.1", port: int = 8011,
                stream: AISStream | None = None) -> HTTPServer:
    """A single-threaded server: requests are handled one at a time, so one episode is live at a time. Without a
    `stream`, one is started when AISSTREAM_API_KEY is set (it does not connect otherwise)."""
    if stream is None:
        stream = AISStream()
    return HTTPServer((host, port), make_handler(env, threading.Lock(), stream))


def main() -> None:
    ap = argparse.ArgumentParser(description="Serve OaklandEnv over HTTP (one episode at a time).")
    ap.add_argument("--tasks", required=True, help="tasks .jsonl (one Task.to_dict() per line)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8011)
    a = ap.parse_args()
    env = OaklandEnv(a.tasks)
    srv = make_server(env, a.host, a.port)
    base = f"http://{a.host}:{a.port}"
    print(f"OaklandEnv: {len(env.tasks)} tasks from {a.tasks}, serving on {base}")
    print(f"  curl {base}/tasks")
    print(f"  curl -X POST {base}/reset -d '{{\"index\": 0}}'")
    print(f"  curl {base}/situation")
    print(f"  curl -X POST {base}/check -d '{{\"plan\": [{{\"ship\": 0, \"berth_hour\": 12, \"section\": 7, \"cranes\": 3}}]}}'")
    print(f"  curl -X POST {base}/submit -d '{{\"plan\": [{{\"ship\": 0, \"berth_hour\": 12, \"section\": 7, \"cranes\": 3}}]}}'")
    print(f"  curl {base}/replay")
    print(f"  curl '{base}/ais?hour=12'", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
