"""On-demand self-improvement from the chat: the coach proposes one playbook change from the run's latest episode
logs, and the proposal is verified in a background thread on the run's verification tasks with the loop's own
scoring (loop.graph.Loop.score) and gate margin (ACCEPT_MARGIN). Ship calls are GENERATED (not real records).

    opt = Optimizer("runs/live")                 # GeminiCoach and GeminiPlayer, needs ALLOW_MODEL_REQUESTS=1
    p = opt.optimize(episodes=3)                 # ~30 s, one coach call
    opt.verify(p["id"])                          # returns at once; status goes verifying -> accepted | rejected
    opt.status(p["id"])

Everything is written to <run_dir>/proposals/ (a directory the loop never touches): proposals.jsonl, one row per
proposal rewritten in place {id, created, from_version, status, diagnosis, mistakes, change, playbook_md,
verification: {eval_mean, per_task} | null, baseline_eval_mean, verdict_reason, cost_usd}, the proposed playbook in
p<id>.md, and the verification episodes' event logs in p<id>/. The run's episodes, eval.jsonl, playbooks/ and
state.sqlite are only read. A verdict here is advisory: the proposal is not added to the run's playbook tree.
"""

from __future__ import annotations

import json
import math
import threading
import time
from pathlib import Path
from typing import Any

from loop.coach import current_rules, load_episode_logs, validate_mistakes
from loop.graph import ACCEPT_MARGIN, OAKLAND, Loop, LoopConfig, load_pack
from loop.player import player_version
from loop.playbook import PlaybookStore, load_heuristic

from .tools import _read_jsonl

DEFAULT_VERIFY_PACK = OAKLAND / "tasks" / "berth-eval-demo.jsonl"
WORKERS = 4
DEFAULT_MINUTES = 8.0   # when the run has no baseline wall times


def _mean(xs: list) -> float | None:
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs), 4) if xs else None


class _Playbooks:
    """What Loop.score reads from a store (text, heuristic): the proposal under its own version, the run's playbook
    store for every other version."""

    def __init__(self, store: PlaybookStore, version: int, text: str, heuristic_path: Path | None):
        self.store, self.version, self._text, self.heuristic_path = store, version, text, heuristic_path

    def text(self, version: int) -> str:
        return self._text if version == self.version else self.store.text(version)

    def heuristic(self, version: int) -> Any:
        if version != self.version:
            return self.store.heuristic(version)
        return load_heuristic(self.heuristic_path) if self.heuristic_path and self.heuristic_path.exists() else None


class Optimizer:
    """Proposals for one run. `coach` and `player` default to Gemini, created on first use; `verify_pack` (task
    files) replaces the run's own verification tasks."""

    def __init__(self, run_dir: str | Path, coach: Any = None, player: Any = None,
                 verify_pack: list[str] | None = None, workers: int = WORKERS):
        self.run_dir = Path(run_dir)
        self.dir = self.run_dir / "proposals"
        self.path = self.dir / "proposals.jsonl"
        self._coach, self._player = coach, player
        self.verify_pack = [str(p) for p in verify_pack] if verify_pack else None
        self.workers = workers
        self.lock = threading.Lock()
        self.threads: dict[int, threading.Thread] = {}

    # ------------------------------------------------------------ parts

    @property
    def coach(self) -> Any:
        if self._coach is None:
            from loop.coach import GeminiCoach
            self._coach = GeminiCoach()
        return self._coach

    @property
    def player(self) -> Any:
        if self._player is None:
            from loop.player import GeminiPlayer
            self._player = GeminiPlayer()
        return self._player

    def store(self) -> PlaybookStore:
        if not (self.run_dir / "playbooks" / "tree.json").exists():
            raise ValueError(f"run {self.run_dir.name} has no playbook tree yet")
        return PlaybookStore(self.run_dir)   # the tree exists, so this only reads

    def rows(self) -> list[dict]:
        if not self.path.exists():
            return []
        return [json.loads(ln) for ln in self.path.read_text().splitlines() if ln.strip()]

    def _save(self, row: dict) -> None:
        with self.lock:
            self.dir.mkdir(exist_ok=True)
            rows = [r for r in self.rows() if r["id"] != row["id"]] + [row]
            rows.sort(key=lambda r: r["id"])
            tmp = self.path.with_suffix(".jsonl.tmp")
            tmp.write_text("".join(json.dumps(r) + "\n" for r in rows))
            tmp.replace(self.path)

    def get(self, pid: int | None = None) -> dict | None:
        rows = self.rows()
        if pid is None:
            return rows[-1] if rows else None
        return next((r for r in rows if r["id"] == int(pid)), None)

    def _episode_paths(self, n: int) -> list[tuple[int, Path]]:
        from .tools import RunTools
        eps = [(int(e["episode"]), self.run_dir / e.get("events", f"events/ep{int(e['episode']):03d}.jsonl"))
               for e in RunTools(self.run_dir).episodes() if e.get("episode") is not None]
        if not eps:
            eps = [(int(p.stem[2:]), p) for p in sorted((self.run_dir / "events").glob("ep*.jsonl"))]
        eps = [(ep, p) for ep, p in sorted(dict(eps).items()) if p.exists()]
        return eps[-max(1, int(n)):]

    def verify_tasks(self) -> list:
        """The verification tasks: --verify-pack when given, else the run's own (the task ids of its latest
        eval.jsonl row, resolved from tasks/*.jsonl), else tasks/berth-eval-demo.jsonl."""
        if self.verify_pack:
            return load_pack(self.verify_pack, "both", what="verification pack")
        evals = [e for e in _read_jsonl(self.run_dir / "eval.jsonl") if e.get("per_task")]
        ids = [t["task_id"] for t in evals[-1]["per_task"]] if evals else []
        if ids:
            by_id = {t.task_id: t for t in load_pack(sorted(str(p) for p in (OAKLAND / "tasks").glob("*.jsonl")),
                                                    "both")}
            tasks = [by_id[i] for i in ids if i in by_id]
            if len(tasks) == len(ids):
                return tasks
        return load_pack([str(DEFAULT_VERIFY_PACK)], "both", what="verification pack")

    # ------------------------------------------------------------ propose

    def optimize(self, episodes: int = 3, verify: bool = True) -> dict:
        """One coach call on the last `episodes` episode logs against the accepted playbook in force, as the loop's
        maybe_coach does (same rejected list, lessons and exclusions); writes the proposal (status proposed) and,
        with `verify`, starts its verification at once (status verifying)."""
        store = self.store()
        accepted = store.latest_accepted()
        paths = self._episode_paths(episodes)
        if not paths:
            raise ValueError(f"run {self.run_dir.name} has no episode logs yet")
        logs = load_episode_logs(paths)
        rejected = store.rejected_changes() + [r["change"] for r in self.rows()
                                               if r["status"] == "rejected" and r.get("change")]
        rejected = list(dict.fromkeys(rejected))
        text = store.text(accepted)
        exclude = list(dict.fromkeys(current_rules(text) + rejected))
        version = max(n["version"] for n in store.nodes()) + 1
        out = self.coach.propose(logs, text, version, rejected, store.lessons(accepted), exclude=exclude)
        mistakes = validate_mistakes(out.get("mistakes") or [], logs)
        rows = self.rows()
        pid = (max(r["id"] for r in rows) + 1) if rows else 1
        self.dir.mkdir(exist_ok=True)
        (self.dir / f"p{pid}.md").write_text(out["playbook_md"])
        if out.get("heuristic_code"):
            (self.dir / f"p{pid}_heuristic.py").write_text(out["heuristic_code"])
        row = {"id": pid, "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "from_version": accepted,
               "version": version, "episodes": [ep for ep, _ in paths],
               "status": "proposed" if out.get("change") or out.get("heuristic_code") else "rejected",
               "diagnosis": out["diagnosis"], "mistakes": mistakes, "change": out.get("change"),
               "playbook_md": out["playbook_md"], "verification": None, "baseline_eval_mean": None,
               "verdict_reason": None if out.get("change") or out.get("heuristic_code") else "no change proposed",
               "coach_model": out.get("model"), "cost_usd": round(float(out.get("cost_usd") or 0), 6)}
        self._save(row)
        out = {"id": pid, "status": row["status"], "from_version": accepted, "change": row["change"],
               "diagnosis": row["diagnosis"], "episodes": row["episodes"],
               "mistakes": [{"what": m["what"], "evidence": len(m["evidence"])} for m in mistakes][:5],
               "baseline_eval_mean": None, "expected_minutes": None, "cost_usd": row["cost_usd"]}
        if verify and row["status"] == "proposed":
            v = self.verify(pid)
            out.update(status=v["status"], baseline_eval_mean=v["baseline_eval_mean"],
                       expected_minutes=v["expected_minutes"])
        return out

    # ------------------------------------------------------------ verify

    def _baseline_known(self, accepted: int, ids: list[str]) -> bool:
        """The accepted version's per-task rewards on `ids` exist, from the same player: no rescoring needed."""
        node = self.store().node(accepted)
        prior = node.get("eval_per_task") or {}
        return (node.get("player_version") == player_version(self.player.model_id)
                and all(prior.get(i) is not None for i in ids))

    def expected_minutes(self, accepted: int, n_tasks: int, rescore: bool = False) -> float:
        """The accepted version's baseline eval wall time per episode (its eval/v<k>/ stop events) times the rounds
        of `workers` episodes, doubled when the baseline is rescored; DEFAULT_MINUTES without wall times."""
        walls = []
        for p in (self.run_dir / "eval" / f"v{accepted}").glob("*.jsonl"):
            stop = next((e for e in reversed(_read_jsonl(p)) if e.get("type") == "stop"), None)
            if stop and stop.get("wall_s"):
                walls.append(float(stop["wall_s"]))
        if not walls:
            return DEFAULT_MINUTES
        rounds = math.ceil(n_tasks / self.workers) * (2 if rescore else 1)
        return round(rounds * sum(walls) / len(walls) / 60, 1)

    def verify(self, pid: int, wait: bool = False) -> dict:
        """Start verifying proposal `pid` in a background thread (one per proposal); returns at once with
        {id, status, expected_minutes}. `wait` joins the thread (tests)."""
        row = self.get(pid)
        if row is None:
            raise ValueError(f"no proposal {pid}")
        pid = row["id"]
        with self.lock:
            busy = pid in self.threads and self.threads[pid].is_alive()
        if busy or row["status"] in ("accepted", "rejected"):
            return {"id": pid, "status": row["status"], "verdict_reason": row.get("verdict_reason"),
                    "baseline_eval_mean": row.get("baseline_eval_mean"), "expected_minutes": 0.0, "note": "already verifying" if busy else "already verified"}
        tasks = self.verify_tasks()
        ids = [t.task_id for t in tasks]
        rescore = not self._baseline_known(row["from_version"], ids)
        if not rescore:
            prior = self.store().node(row["from_version"])["eval_per_task"]
            row["baseline_eval_mean"] = _mean([prior[i] for i in ids])
        row.update(status="verifying", verify_tasks=[t.task_id for t in tasks], verdict_reason=None)
        self._save(row)
        t = threading.Thread(target=self._verify, args=(pid, tasks), name=f"verify-p{pid}", daemon=True)
        with self.lock:
            self.threads[pid] = t
        t.start()
        if wait:
            t.join()
        return {"id": pid, "status": "verifying" if not wait else self.get(pid)["status"],
                "tasks": len(tasks), "baseline_eval_mean": row["baseline_eval_mean"],
                "expected_minutes": self.expected_minutes(row["from_version"], len(tasks), rescore)}

    def _verify(self, pid: int, tasks: list) -> None:
        row = self.get(pid)
        try:
            row.update(self._score(row, tasks))
        except Exception as e:   # noqa: BLE001, a failed verification must still end the proposal
            row.update(status="rejected", verdict_reason=f"verification failed: {type(e).__name__}: {e}")
        self._save(row)

    def _score(self, row: dict, tasks: list) -> dict:
        store = self.store()
        accepted, version = row["from_version"], row["version"]
        heur = self.dir / f"p{row['id']}_heuristic.py"
        loop = Loop.__new__(Loop)   # only what Loop.score reads: cfg, store, player
        loop.cfg = LoopConfig(workers=self.workers)
        loop.store = _Playbooks(store, version, row["playbook_md"], heur)
        loop.player = self.player
        idx = list(range(len(tasks)))
        out = self.dir / f"p{row['id']}"
        s = loop.score(tasks, idx, version, out / "proposal")
        cost = s["cost_usd"]
        prior = store.node(accepted).get("eval_per_task") or {}
        ids = [t.task_id for t in tasks]
        if self._baseline_known(accepted, ids):
            base, base_from = _mean([prior[i] for i in ids]), "run"
        else:   # other tasks or another player than the run's scores: score the accepted playbook here too
            b = loop.score(tasks, idx, accepted, out / f"v{accepted}")
            base, base_from, cost = b["mean"], "rescored", cost + b["cost_usd"]
        gain = round(s["mean"] - base, 4)
        if gain >= ACCEPT_MARGIN:
            status, reason = "accepted", f"verification +{gain:.3f} over v{accepted} (margin {ACCEPT_MARGIN})"
        else:
            status, reason = "rejected", (f"no verification gain: verification {gain:+.3f} over v{accepted} "
                                          f"(needs +{ACCEPT_MARGIN})")
        return {"status": status, "verdict_reason": reason, "baseline_eval_mean": base, "baseline_from": base_from,
                "verification": {"eval_mean": s["mean"], "feasibility_rate": s["feasibility_rate"],
                                 "per_task": [{k: r[k] for k in ("task_id", "reward", "feasible", "gap_pct")}
                                              for r in s["per_task"]],
                                 "baseline_per_task": {i: prior.get(i) for i in ids} if base_from == "run" else None},
                "cost_usd": round(row.get("cost_usd", 0.0) + cost, 6), "verified": time.strftime("%Y-%m-%dT%H:%M:%S")}

    # ------------------------------------------------------------ status

    def status(self, pid: int | None = None) -> dict:
        row = self.get(pid)
        if row is None:
            return {"error": "no proposal yet" if pid is None else f"no proposal {pid}"}
        v = row.get("verification") or {}
        return {"id": row["id"], "status": row["status"], "change": row.get("change"),
                "baseline_eval_mean": row.get("baseline_eval_mean"), "eval_mean": v.get("eval_mean"),
                "verdict_reason": row.get("verdict_reason"), "from_version": row["from_version"],
                "tasks": len(row.get("verify_tasks") or []), "created": row["created"],
                "verified": row.get("verified"), "cost_usd": row.get("cost_usd"),
                "note": "advisory: an accepted proposal is not added to the running loop's playbook tree"}
