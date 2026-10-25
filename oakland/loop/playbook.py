"""Versioned playbooks of one run, kept as a tree (one change per coach round).

    runs/<run>/playbooks/v<k>.md              the playbook text of version k (v0 is the empty starting playbook)
    runs/<run>/playbooks/v<k>_heuristic.py    the coach's heuristic(task, plan) -> plan, when version k has one
    runs/<run>/playbooks/tree.json            nodes {version, parent, created_at, diagnosis, verdict, train_mean,
                                              eval_mean, feasibility_rate, mean_gap_pct, eval_per_task,
                                              train_per_task, front, wins, merged_from, ...}
    runs/<run>/playbooks/changelog.json       one entry per version: parent, change, verdict, reason

Verdicts: "accepted", "rejected", "open" (scored or not, not yet decided). The player uses the latest ACCEPTED
node; rejected nodes stay in the tree, scored ones as candidates of the Pareto front (pareto_front): a version is on
the front when it has the best eval reward on at least one eval task (accepted versions on a tie, others only when
strictly best; GEPA-style candidate pool).
"""

from __future__ import annotations

import json
import re
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


def _rule_bullets(md: str) -> tuple[list[str], int | None, int | None]:
    """(bullet lines under '## Rules', index of that heading, index where the section ends) of a playbook."""
    lines = md.strip().splitlines()
    start = next((i for i, l in enumerate(lines) if l.strip().lower() == "## rules"), None)
    if start is None:
        return [], None, None
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    bullets = [l for l in lines[start + 1:end] if re.match(r"\s*[-*]\s+\S", l) and "(none yet)" not in l]
    return bullets, start, end


def rule_bullets(md: str) -> list[str]:
    """The bullet lines under '## Rules' of a playbook (the "(none yet)" placeholder left out)."""
    return _rule_bullets(md)[0]


def merge_playbooks(version: int, first: str, second: str) -> str:
    """`first` with the '## Rules' bullets of `second` that it lacks appended (first's order, then the other's new
    ones), first's checklist and other sections, retitled v<version>, clamped to MAX_LINES."""
    lines = first.strip().splitlines()
    own, start, end = _rule_bullets(first)
    other, _s, _e = _rule_bullets(second)
    seen = {b.strip() for b in own}
    rules = own + [b for b in other if b.strip() not in seen]
    if start is None:
        at = next((i for i, l in enumerate(lines) if l.startswith("## ")), len(lines))
        lines = lines[:at] + ["## Rules"] + rules + [""] + lines[at:]
    else:
        lines = lines[:start + 1] + rules + [""] + lines[end:]
    if lines and lines[0].startswith("# "):
        lines[0] = f"# Playbook v{version}"
    else:
        lines = [f"# Playbook v{version}", ""] + lines
    out = "\n".join(lines)
    return clamp_lines(re.sub(r"\n{3,}", "\n\n", out))


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
            root = dict(self._node(0, None, "starting playbook", "accepted", None), reason="root")
            _write_json(self.tree_path, {"nodes": [root]})
            _write_json(self.changelog_path, [{"version": 0, "parent": None, "change": "starting playbook",
                                               "verdict": "accepted", "reason": "root"}])

    @staticmethod
    def _node(version: int, parent: int | None, diagnosis: str, verdict: str, change: str | None) -> dict:
        return {"version": version, "parent": parent, "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "diagnosis": diagnosis, "change": change, "verdict": verdict, "train_mean": None,
                "eval_mean": None, "feasibility_rate": None, "mean_gap_pct": None, "reason": None,
                "has_heuristic": False, "eval_per_task": {}, "train_per_task": {}, "front": False, "wins": 0,
                "merged_from": None}

    # reading

    def nodes(self) -> list[dict]:
        return json.loads(self.tree_path.read_text())["nodes"]

    def node(self, version: int) -> dict:
        return next(n for n in self.nodes() if n["version"] == version)

    def latest_accepted(self) -> int:
        return max(n["version"] for n in self.nodes() if n["verdict"] == "accepted")

    def rejected_changes(self) -> list[str]:
        return [n["change"] for n in self.nodes() if n["verdict"] == "rejected" and n.get("change")]

    def win_sets(self) -> dict[int, set[str]]:
        """{version: eval task ids it is best on} over the versions scored on the eval pack with the latest accepted
        node's player_version (accepted or rejected). An accepted version wins a task when it ties for the best
        reward; any other version only when it strictly beats every other scored version on that task."""
        nodes = self.nodes()
        ref = self.node(self.latest_accepted()).get("player_version")
        pool = [n for n in nodes if n.get("eval_per_task") and n.get("player_version") == ref]
        best: dict[str, float] = {}
        for n in pool:
            for t, r in n["eval_per_task"].items():
                if r is not None and (t not in best or r > best[t]):
                    best[t] = r
        at_best: dict[str, int] = {}
        for n in pool:
            for t, r in n["eval_per_task"].items():
                if r is not None and r == best[t]:
                    at_best[t] = at_best.get(t, 0) + 1
        wins = {n["version"]: {t for t, r in n["eval_per_task"].items() if r is not None and r == best[t]
                               and (n["verdict"] == "accepted" or at_best[t] == 1)}
                for n in pool}
        return {v: w for v, w in wins.items() if w}

    def pareto_front(self) -> list[int]:
        """Versions with the maximum eval reward on at least one eval task (see win_sets)."""
        return sorted(self.win_sets())

    def refresh_front(self) -> None:
        """Rewrite every node's `front` and `wins` from the current per-task scores."""
        ws = self.win_sets()
        nodes = self.nodes()
        for n in nodes:
            n["front"] = n["version"] in ws
            n["wins"] = len(ws.get(n["version"], ()))
        _write_json(self.tree_path, {"nodes": nodes})

    def merged_pairs(self) -> set[frozenset[int]]:
        return {frozenset(n["merged_from"]) for n in self.nodes() if n.get("merged_from")}

    def lineage(self, version: int) -> list[int]:
        """`version`, its parent, ... up to the root."""
        by = {n["version"]: n for n in self.nodes()}
        out = []
        v: int | None = version
        while v is not None and v in by and v not in out:
            out.append(v)
            v = by[v]["parent"]
        return out

    def lessons(self, version: int, limit: int = 8) -> list[str]:
        """"v<k> (<verdict>, <reason>): <change>" for `version` and its ancestors, newest first, at most `limit`."""
        by = {n["version"]: n for n in self.nodes()}
        out = []
        for v in self.lineage(version)[:limit]:
            n = by[v]
            out.append(f"v{v} ({n['verdict']}, {n.get('reason') or '-'}): {n.get('change') or n['diagnosis']}")
        return out

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
