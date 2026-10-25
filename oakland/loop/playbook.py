"""Versioned playbooks of one run, kept as a tree (one change per coach round).

    runs/<run>/playbooks/v<k>.md              the playbook text of version k (v0 is the empty starting playbook)
    runs/<run>/playbooks/v<k>_heuristic.py    the coach's heuristic(task, plan) -> plan, when version k has one
    runs/<run>/playbooks/tree.json            nodes {version, parent, created_at, diagnosis, verdict, train_mean,
                                              eval_mean, feasibility_rate, mean_gap_pct, ...}
    runs/<run>/playbooks/changelog.json       one entry per version: parent, change, verdict, reason

Verdicts: "accepted", "rejected", "open" (scored or not, not yet decided). The next coach round starts from the
latest ACCEPTED node; rejected nodes stay in the tree for the report.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable

MAX_LINES = 60

V0_TEXT = """# Playbook v0

No rules yet: plan from the rules text and the situation.

## Checklist
1. Read the situation (get_situation) and the playbook (read_playbook).
2. Start from baseline_plan, improve it, check it, submit the best feasible plan once.
"""


def clamp_lines(md: str, limit: int = MAX_LINES) -> str:
    lines = md.strip().splitlines()
    return "\n".join(lines[:limit]) + "\n"


def _write_json(path: Path, obj: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2))
    tmp.replace(path)


def load_heuristic(path: str | Path) -> Callable[[dict, list], list]:
    """The function `heuristic(task, plan) -> plan` defined in a coach heuristic file."""
    code = Path(path).read_text()
    ns: dict[str, Any] = {"__name__": "oak_heuristic"}
    exec(compile(code, str(path), "exec"), ns)   # coach code; only run inside apply_heuristic's error guard
    fn = ns.get("heuristic")
    if not callable(fn):
        raise ValueError(f"{path} defines no heuristic(task, plan) function")
    return fn


class PlaybookStore:
    def __init__(self, run_dir: str | Path):
        self.dir = Path(run_dir) / "playbooks"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.tree_path = self.dir / "tree.json"
        self.changelog_path = self.dir / "changelog.json"
        if not self.tree_path.exists():
            (self.dir / "v0.md").write_text(V0_TEXT)
            _write_json(self.tree_path, {"nodes": [self._node(0, None, "starting playbook", "accepted", None)]})
            _write_json(self.changelog_path, [{"version": 0, "parent": None, "change": "starting playbook",
                                               "verdict": "accepted", "reason": "root"}])

    @staticmethod
    def _node(version: int, parent: int | None, diagnosis: str, verdict: str, change: str | None) -> dict:
        return {"version": version, "parent": parent, "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "diagnosis": diagnosis, "change": change, "verdict": verdict, "train_mean": None,
                "eval_mean": None, "feasibility_rate": None, "mean_gap_pct": None, "reason": None,
                "has_heuristic": False}

    # reading

    def nodes(self) -> list[dict]:
        return json.loads(self.tree_path.read_text())["nodes"]

    def node(self, version: int) -> dict:
        return next(n for n in self.nodes() if n["version"] == version)

    def latest_accepted(self) -> int:
        return max(n["version"] for n in self.nodes() if n["verdict"] == "accepted")

    def rejected_changes(self) -> list[str]:
        return [n["change"] for n in self.nodes() if n["verdict"] == "rejected" and n.get("change")]

    def text(self, version: int) -> str:
        return (self.dir / f"v{version}.md").read_text()

    def heuristic_path(self, version: int) -> Path:
        return self.dir / f"v{version}_heuristic.py"

    def heuristic(self, version: int) -> Callable | None:
        p = self.heuristic_path(version)
        return load_heuristic(p) if p.exists() else None

    def heuristic_code(self, version: int) -> str | None:
        p = self.heuristic_path(version)
        return p.read_text() if p.exists() else None

    # writing

    def add(self, parent: int, playbook_md: str, diagnosis: str, change: str | None,
            heuristic_code: str | None = None) -> int:
        """A new open node under `parent`; returns its version."""
        nodes = self.nodes()
        version = max(n["version"] for n in nodes) + 1
        (self.dir / f"v{version}.md").write_text(clamp_lines(playbook_md))
        node = self._node(version, parent, diagnosis, "open", change)
        if heuristic_code:
            self.heuristic_path(version).write_text(heuristic_code)
            node["has_heuristic"] = True
        nodes.append(node)
        _write_json(self.tree_path, {"nodes": nodes})
        log = json.loads(self.changelog_path.read_text())
        log.append({"version": version, "parent": parent, "change": change, "verdict": "open", "reason": None})
        _write_json(self.changelog_path, log)
        return version

    def update(self, version: int, **fields: Any) -> None:
        nodes = self.nodes()
        for n in nodes:
            if n["version"] == version:
                n.update(fields)
        _write_json(self.tree_path, {"nodes": nodes})
        if "verdict" in fields or "reason" in fields:
            log = json.loads(self.changelog_path.read_text())
            for e in log:
                if e["version"] == version:
                    e["verdict"] = fields.get("verdict", e["verdict"])
                    e["reason"] = fields.get("reason", e["reason"])
            _write_json(self.changelog_path, log)
