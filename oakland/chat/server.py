"""The operator chat over HTTP, standard library only, CORS open so the viewer can call it.

    python -m chat.server --runs-dir runs --port 8770      (from oakland/)

    POST /chat    {"run": "live", "messages": [{"role": "user", "content": "..."}], "episode": 7 | null}
                  -> {answer, steps, links, what_if, tokens_in, tokens_out, cost_usd} | {error}
    GET  /health  -> {ok, model, runs_dir}
    GET  /runs    -> [{run, episodes}]
    GET  /proposal?run=live[&id=3] -> {id, status, change, baseline_eval_mean, eval_mean, verdict_reason} | 404
                  (the latest chat proposal when no id); /chat also returns it as `proposal` after a turn that
                  used optimize_playbook, verify_proposal or proposal_status

`run` is a directory name under --runs-dir; a path like "../runs/live" is accepted and only its basename is used.
The server is stateless: the conversation is the messages list the client sends. One agent is cached per run.
Each request gets 90 s; errors come back as {"error": ...}. Gemini needs ALLOW_MODEL_REQUESTS=1 and a key.
"""

from __future__ import annotations

import argparse
import json
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs

from loop.player import MODEL_ID

from .agent import PROPOSAL_KEYS, ChatAgent
from .tools import RunTools

TIMEOUT_S = 90


class Chat:
    """The run lookup and the per-run agent cache behind the handler."""

    def __init__(self, runs_dir: str | Path, make_agent: Callable[[Path], Any] | None = None,
                 timeout_s: float = TIMEOUT_S):
        self.runs_dir = Path(runs_dir)
        self.make_agent = make_agent or ChatAgent
        self.timeout_s = timeout_s
        self.agents: dict[str, Any] = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=4)

    def runs(self) -> list[dict]:
        if not self.runs_dir.is_dir():
            return []
        return [{"run": p.name, "episodes": len(RunTools(p).episodes())}
                for p in sorted(self.runs_dir.iterdir()) if p.is_dir() and not p.name.startswith(".")]

    def agent(self, run: str) -> Any:
        name = Path(str(run).rstrip("/")).name
        if not name or name in (".", ".."):
            raise ValueError("run must name a run directory")
        path = self.runs_dir / name
        if not path.is_dir():
            raise ValueError(f"no run {name!r} under {self.runs_dir}")
        with self.lock:
            if name not in self.agents:
                self.agents[name] = self.make_agent(path)
            return self.agents[name]

    def chat(self, body: dict) -> tuple[int, dict]:
        msgs = body.get("messages")
        if not isinstance(msgs, list) or not msgs:
            return 400, {"error": "messages must be a non-empty list of {role, content}"}
        episode = body.get("episode")
        try:
            episode = None if episode is None else int(episode)
            agent = self.agent(body.get("run") or "live")
        except (ValueError, TypeError) as e:
            return 400, {"error": str(e)}
        fut = self.pool.submit(agent.ask, msgs, episode)
        try:
            return 200, fut.result(timeout=self.timeout_s)
        except FutureTimeout:
            return 504, {"error": f"the operator took longer than {self.timeout_s:g} s"}
        except ValueError as e:
            return 400, {"error": str(e)}
        except Exception as e:   # noqa: BLE001, any model or tool failure goes back as an error
            return 500, {"error": f"{type(e).__name__}: {e}"}

    def proposal(self, run: str, pid: str | None) -> tuple[int, dict]:
        """The latest (or given) chat proposal of a run: {id, status, change, baseline_eval_mean, eval_mean,
        verdict_reason}, or 404."""
        try:
            agent = self.agent(run)
            got = agent.tools.optimizer.status(None if pid in (None, "") else int(pid))
        except (ValueError, TypeError) as e:
            return 404, {"error": str(e)}
        if "error" in got:
            return 404, got
        return 200, {k: got.get(k) for k in PROPOSAL_KEYS}


def make_handler(chat: Chat) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "OaklandChat/1"

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

        def do_OPTIONS(self):
            self._send(204, {})

        def do_GET(self):
            path = self.path.split("?", 1)[0].rstrip("/")
            if path == "/health":
                self._send(200, {"ok": True, "model": MODEL_ID, "runs_dir": str(chat.runs_dir)})
            elif path == "/runs":
                self._send(200, chat.runs())
            elif path == "/proposal":
                q = parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
                self._send(*chat.proposal(q.get("run", ["live"])[0], q.get("id", [None])[0]))
            else:
                self._send(404, {"error": f"no route GET {path}"})

        def do_POST(self):
            path = self.path.split("?", 1)[0].rstrip("/")
            if path != "/chat":
                self._send(404, {"error": f"no route POST {path}"})
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode() or "{}") if n else {}
                if not isinstance(body, dict):
                    raise ValueError("request body must be a JSON object")
            except (ValueError, UnicodeDecodeError) as e:
                self._send(400, {"error": f"bad request body: {e}"})
                return
            self._send(*chat.chat(body))

    return Handler


def make_server(runs_dir: str | Path, host: str = "127.0.0.1", port: int = 8770,
                make_agent: Callable[[Path], Any] | None = None) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), make_handler(Chat(runs_dir, make_agent)))


def main() -> None:
    ap = argparse.ArgumentParser(description="Chat with the Gemini Argon operator about a run.")
    ap.add_argument("--runs-dir", default="runs")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--verify-pack", nargs="+", default=None,
                    help="task files to verify chat proposals on (default: the run's own verification tasks)")
    a = ap.parse_args()
    make_agent = None
    if a.verify_pack:
        from .optimize import Optimizer

        def make_agent(path: Path) -> Any:
            return ChatAgent(path, optimizer=Optimizer(path, verify_pack=a.verify_pack))
    srv = make_server(a.runs_dir, a.host, a.port, make_agent)
    base = f"http://{a.host}:{a.port}"
    print(f"operator chat on {base}, runs from {a.runs_dir}")
    print(f"  curl {base}/runs")
    print(f"  curl -X POST {base}/chat -d '{{\"run\": \"live\", \"messages\": "
          f"[{{\"role\": \"user\", \"content\": \"Are you improving?\"}}]}}'", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
