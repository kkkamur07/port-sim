"""Read-only tools over one run directory, for the operator chat. Every tool returns compact JSON text (at most
about 1500 characters, numbers rounded). Nothing here writes to the run; what_if grades a modified copy of a plan
with the real checker (oakland_core.grade) and keeps it in memory.

    tools = RunTools("runs/real-berth-gepa")
    tools.run_status(); tools.episode(7); tools.what_if(7, 0, berth_hour=30, section=4, cranes=3)
    tools.langchain_tools()   # the same functions as LangChain tools, for the chat agent

Run layout read here: episodes.jsonl (or episodes.json), eval.jsonl, playbooks/tree.json and vN.md,
replays/epNNN.json, events/epNNN.jsonl. Any of them may be missing (a live run that just started): the tools then
say so instead of failing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from env import MAX_CHECKS
from oakland_core import PlanError, Task, grade, parse_plan

MAX_CHARS = 1500


def _round(x: Any) -> Any:
    if isinstance(x, float):
        return round(x, 4)
    if isinstance(x, dict):
        return {k: _round(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_round(v) for v in x]
    return x


def _dump(obj: Any, limit: int = MAX_CHARS) -> str:
    """Compact JSON text; when it is too long the longest list values are cut until it fits."""
    obj = _round(obj)
    text = json.dumps(obj, separators=(",", ":"))
    while len(text) > limit and isinstance(obj, dict):
        lists = [(len(json.dumps(v)), k) for k, v in obj.items() if isinstance(v, list) and len(v) > 1]
        if not lists:
            break
        _, k = max(lists)
        obj[k] = obj[k][: max(1, len(obj[k]) * 2 // 3)]
        obj["truncated"] = True
        text = json.dumps(obj, separators=(",", ":"))
    if len(text) > limit:
        text = text[: limit - 3] + "..."
    return text


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass   # a live run may be mid-write
    return out


def _short(text: Any, n: int = 160) -> str:
    s = text if isinstance(text, str) else json.dumps(text)
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 3] + "..."


class RunTools:
    """The chat tools over one run directory. Files are read on every call, so a live run is always current."""

    def __init__(self, run_dir: str | Path):
        self.run_dir = Path(run_dir)

    # ------------------------------------------------------------ file access

    def episodes(self) -> list[dict]:
        rows = _read_jsonl(self.run_dir / "episodes.jsonl")
        if rows:
            return rows
        p = self.run_dir / "episodes.json"
        if p.exists():
            try:
                data = json.loads(p.read_text())
                return data if isinstance(data, list) else data.get("episodes", [])
            except json.JSONDecodeError:
                return []
        return []

    def evals(self) -> list[dict]:
        return _read_jsonl(self.run_dir / "eval.jsonl")

    def tree(self) -> list[dict]:
        p = self.run_dir / "playbooks" / "tree.json"
        if not p.exists():
            return []
        try:
            return json.loads(p.read_text()).get("nodes", [])
        except json.JSONDecodeError:
            return []

    def replay(self, n: int) -> dict | None:
        p = self.run_dir / "replays" / f"ep{int(n):03d}.json"
        return json.loads(p.read_text()) if p.exists() else None

    def events(self, n: int) -> list[dict]:
        return _read_jsonl(self.run_dir / "events" / f"ep{int(n):03d}.jsonl")

    def _episode_row(self, n: int) -> dict:
        return next((e for e in self.episodes() if int(e.get("episode", -1)) == int(n)), {})

    def _task(self, rep: dict) -> Task:
        """The replay's task, with the stored optimum put back so grade() scores like the run did."""
        task = Task.from_dict(rep["task"])
        opt = (rep.get("grade") or {}).get("optimal_cost")
        if opt is not None:
            task.reference = {**task.reference, "optimal_cost": opt}
        return task

    # ------------------------------------------------------------ tools

    def run_status(self) -> str:
        """Run status: episodes done, current playbook version, verification mean per accepted version, the last
        3 coach rounds (version, verdict, reason) and model cost spent."""
        eps, evals = self.episodes(), self.evals()
        if not eps and not evals:
            return _dump({"error": f"no episodes or evaluations yet in run {self.run_dir.name}"})
        accepted = [e for e in evals if e.get("verdict") == "accepted"]
        current = accepted[-1]["version"] if accepted else (eps[-1].get("playbook_version") if eps else None)
        spent = sum(float(e.get("cost_usd") or 0) for e in eps) + sum(
            float(e.get("coach_cost_usd") or 0) + float(e.get("eval_cost_usd") or 0) for e in evals)
        last = eps[-1] if eps else {}
        return _dump({
            "run": self.run_dir.name, "episodes_done": len(eps), "current_playbook_version": current,
            "last_episode": {"episode": last.get("episode"), "task_id": last.get("task_id"),
                             "reward": last.get("reward"), "playbook_version": last.get("playbook_version")},
            "verification_mean_by_accepted_version": {f"v{e['version']}": e.get("eval_mean") for e in accepted},
            "last_rounds": [{"version": e.get("version"), "verdict": e.get("verdict"), "reason": e.get("reason")}
                            for e in evals[-3:]],
            "model_cost_usd": round(spent, 4)})

    def improvement(self) -> str:
        """Are you improving: verification mean and verdict per playbook version, delta against v0, and the mean
        episode reward played under each playbook version."""
        evals, eps = self.evals(), self.episodes()
        if not evals and not eps:
            return _dump({"error": "no evaluations or episodes yet"})
        base = next((e.get("eval_mean") for e in evals if e.get("version") == 0), None)
        versions = []
        for e in evals:
            m = e.get("eval_mean")
            versions.append({"version": e.get("version"), "verdict": e.get("verdict"), "verification_mean": m,
                             "delta_vs_v0": None if m is None or base is None else round(m - base, 4)})
        by_v: dict[int, list[float]] = {}
        for ep in eps:
            v = ep.get("playbook_version")
            if v is None:   # episodes.json rows only carry a label like "playbook v2, ..."
                lab = str(ep.get("label", ""))
                if lab.startswith("playbook v"):
                    try:
                        v = int(lab.split(",")[0].split("v")[1])
                    except (IndexError, ValueError):
                        v = None
            if v is not None and ep.get("reward") is not None:
                by_v.setdefault(int(v), []).append(float(ep["reward"]))
        accepted = [x for x in versions if x["verdict"] == "accepted"]
        best = max(accepted, key=lambda x: x["verification_mean"] or 0) if accepted else None
        return _dump({
            "verification_v0": base,
            "best_accepted": best,
            "versions": versions,
            "episode_reward_mean_by_playbook": {f"v{v}": {"mean": round(sum(r) / len(r), 4), "episodes": len(r)}
                                                for v, r in sorted(by_v.items())},
            "note": "verification means are on held-out tasks; episode rewards are on different training tasks"})

    def coach_round(self, version: int) -> str:
        """One coach round: the playbook change, the diagnosis, the mistakes with evidence spans (episode,
        event index), and the verdict and reason."""
        version = int(version)
        ev = next((e for e in self.evals() if e.get("version") == version), None)
        node = next((n for n in self.tree() if n.get("version") == version), None)
        if ev is None and node is None:
            return _dump({"error": f"no coach round for playbook v{version}"})
        ev, node = ev or {}, node or {}
        mistakes = [{"what": m.get("what"), "impact": m.get("impact"),
                     "evidence": [f"ep{x.get('episode')}#{x.get('event_idx')}" for x in m.get("evidence", [])][:4]}
                    for m in node.get("mistakes", [])][:5]
        return _dump({
            "version": version, "parent": ev.get("parent", node.get("parent")),
            "change": ev.get("change", node.get("change")), "diagnosis": ev.get("diagnosis", node.get("diagnosis")),
            "verdict": ev.get("verdict", node.get("verdict")), "reason": ev.get("reason", node.get("reason")),
            "verification_mean": ev.get("eval_mean", node.get("eval_mean")),
            "parent_verification_mean": ev.get("current_eval_mean"),
            "train_mean": ev.get("train_mean"), "mistakes": mistakes})

    def playbook(self, version: int | None = None) -> str:
        """The playbook text of a version (default: the current accepted one) and the lines added since v0."""
        pdir = self.run_dir / "playbooks"
        if version is None:
            accepted = [e["version"] for e in self.evals() if e.get("verdict") == "accepted"]
            version = accepted[-1] if accepted else 0
        p = pdir / f"v{int(version)}.md"
        if not p.exists():
            return _dump({"error": f"no playbook v{version}"})
        text = p.read_text()
        v0 = (pdir / "v0.md").read_text() if (pdir / "v0.md").exists() else ""
        base = {ln.strip() for ln in v0.splitlines()}
        added = [ln.strip() for ln in text.splitlines()
                 if ln.strip() and ln.strip() not in base and not ln.startswith("# Playbook")]
        return _dump({"version": int(version), "added_since_v0": added, "text": text[:900]})

    def episode(self, n: int) -> str:
        """One episode: task id, tier, reward, cost vs optimal, checks used, violations, late ships, ships moved off
        their planned section, first feasible check."""
        n = int(n)
        rep, row = self.replay(n), self._episode_row(n)
        if rep is None:
            return _dump({"error": f"no replay for episode {n}"})
        task, g = rep["task"], rep.get("grade") or {}
        planned = {s["id"]: s.get("planned_section") for s in task["ships"]}
        moved = [{"ship": r["ship"], "planned": planned.get(r["ship"]), "used": r.get("section")}
                 for r in rep.get("plan", []) if planned.get(r["ship"]) is not None
                 and r.get("section") is not None and r.get("section") != planned.get(r["ship"])]
        late = sorted(({"ship": s["id"], "name": s["name"], "late_h": s["late_h"]}
                       for s in rep.get("ships", []) if (s.get("late_h") or 0) > 0), key=lambda s: -s["late_h"])
        first_ok = row.get("first_feasible_check")
        if first_ok is None:
            stop = next((e for e in self.events(n) if e["type"] == "stop"), None)
            first_ok = (stop or {}).get("payload", {}).get("first_feasible_check")
        return _dump({
            "episode": n, "task_id": task.get("task_id"), "tier": task.get("difficulty"),
            "terminal": task.get("terminal"), "playbook_version": row.get("playbook_version"),
            "reward": g.get("reward"), "feasible": g.get("feasible"), "cost": g.get("cost"),
            "optimal_cost": g.get("optimal_cost"), "checks_used": row.get("checks_used"),
            "first_feasible_check": first_ok, "submitted_by": row.get("submitted_by"),
            "violations": [_short(v, 120) for v in g.get("violations", [])][:5],
            "ships": len(task["ships"]), "late_ships": late[:8], "late_ship_count": len(late),
            "moved_off_planned_section": moved[:8], "moved_count": len(moved)})

    def player_log(self, n: int, limit: int = 12) -> str:
        """The player's own tool log of episode n, condensed: tool, key args, a one-line result, checks so far."""
        evs = self.events(int(n))
        if not evs:
            return _dump({"error": f"no event log for episode {n}"})
        rows, checks, pending = [], 0, {}
        for e in evs:
            p = e.get("payload") or {}
            if e["type"] == "tool_call":
                pending = {"idx": e["idx"], "tool": p.get("tool"), "args": p.get("args") or {}}
            elif e["type"] in ("tool_result", "submit"):
                tool = p.get("tool") or pending.get("tool")
                if tool == "check_plan":
                    checks += 1
                res = p.get("result", "")
                try:
                    obj = json.loads(res) if isinstance(res, str) else res
                    if isinstance(obj, dict) and any(k in obj for k in ("feasible", "cost", "reward")):
                        res = {k: obj[k] for k in ("feasible", "cost", "reward", "checks_left") if k in obj}
                        if obj.get("violations"):
                            res["violations"] = len(obj["violations"])
                            res["first"] = _short(obj["violations"][0].get("problem", ""), 80) \
                                if isinstance(obj["violations"][0], dict) else _short(obj["violations"][0], 80)
                except (json.JSONDecodeError, TypeError):
                    pass
                args = {k: (_short(v, 40) if k != "plan_json" else "<plan>") for k, v in pending.get("args", {}).items()}
                rows.append({"idx": pending.get("idx", e["idx"]), "tool": tool, "args": args,
                             "result": _short(res, 110), "checks": checks})
            elif e["type"] == "stop":
                rows.append({"idx": e["idx"], "tool": "stop", "result": _short(
                    {k: p.get(k) for k in ("reason", "reward", "cost", "optimal_cost", "checks_used")}, 140)})
        limit = max(1, int(limit))
        return _dump({"episode": int(n), "events": len(evs), "log": rows[-limit:]})

    def _find_ship(self, rep: dict, ship_id_or_name: Any) -> dict | None:
        ships = rep["task"]["ships"]
        key = str(ship_id_or_name).strip()
        if key.lstrip("-").isdigit():
            return next((s for s in ships if s["id"] == int(key)), None)
        low = key.lower()
        return next((s for s in ships if s["name"].lower() == low), None) or \
            next((s for s in ships if low in s["name"].lower()), None)

    def ship(self, n: int, ship_id_or_name: Any) -> str:
        """One ship in episode n: ETA, LOA, draught, cranes, planned vs actual section, berth hour, departure, due,
        hours late."""
        rep = self.replay(int(n))
        if rep is None:
            return _dump({"error": f"no replay for episode {n}"})
        s = self._find_ship(rep, ship_id_or_name)
        if s is None:
            return _dump({"error": f"no ship {ship_id_or_name!r} in episode {n}"})
        entry = next((r for r in rep.get("plan", []) if r.get("ship") == s["id"]), {})
        rs = next((r for r in rep.get("ships", []) if r.get("id") == s["id"]), {})
        return _dump({
            "episode": int(n), "ship": s["id"], "name": s["name"], "line": s.get("line"), "eta": s["arrival"],
            "loa_m": s["length_m"], "sections": s["sections"], "draught_m": s.get("draught_m"),
            "cranes_range": [s.get("min_cranes"), s.get("max_cranes")], "cranes_given": entry.get("cranes"),
            "planned_hour": s.get("planned_hour"), "planned_section": s.get("planned_section"),
            "berth_hour": entry.get("berth_hour"), "section": entry.get("section"),
            "departure": rs.get("departure"), "due": s["due"], "late_h": rs.get("late_h"),
            "problems": rs.get("problems", [])[:3], "note": "generated ship call, not a real record"})

    def what_if(self, n: int, ship_id: Any, berth_hour: int | None = None, section: int | None = None,
                cranes: int | None = None) -> str:
        """Change one ship's entry in episode n's submitted plan and run the real checker on the result: feasible,
        violations, cost, optimal cost, reward and the delta against the submitted plan. Nothing is written."""
        rep = self.replay(int(n))
        if rep is None:
            return _dump({"error": f"no replay for episode {n}"})
        s = self._find_ship(rep, ship_id)
        if s is None:
            return _dump({"error": f"no ship {ship_id!r} in episode {n}"})
        task = self._task(rep)
        rows = [dict(r) for r in rep.get("plan", [])]
        entry = next((r for r in rows if r.get("ship") == s["id"]), None)
        if entry is None:
            entry = {"ship": s["id"], "berth_hour": s["arrival"], "section": s.get("planned_section") or
                     task.first_section, "cranes": s.get("std_cranes") or s.get("min_cranes") or 1}
            rows.append(entry)
        before = dict(entry)
        for k, v in (("berth_hour", berth_hour), ("section", section), ("cranes", cranes)):
            if v is not None:
                entry[k] = int(v)
        try:
            plan, problems = parse_plan(task, rows)
            new = grade(task, plan, problems)
            old_plan, old_problems = parse_plan(task, rep.get("plan", []))
            old = grade(task, old_plan, old_problems)
        except PlanError as e:
            return _dump({"error": f"plan could not be read: {e}"})
        delta_cost = None if new.cost is None or old.cost is None else new.cost - old.cost
        return _dump({
            "episode": int(n), "ship": s["id"], "name": s["name"], "before": before, "after": entry,
            "feasible": new.feasible, "cost": new.cost, "optimal_cost": new.optimal_cost,
            "reward": new.reward, "submitted": {"cost": old.cost, "reward": old.reward, "feasible": old.feasible},
            "delta_cost": delta_cost, "delta_reward": round(new.reward - old.reward, 4),
            "violations": [_short(v.get("problem", v), 120) if isinstance(v, dict) else _short(v, 120)
                           for v in new.violations][:6] + new.parse_problems[:2],
            "violation_count": len(new.violations) + len(new.parse_problems)})

    def reward_rules(self) -> str:
        """How reward and cost are computed (fixed text, from oakland_core/reward.py and check.py)."""
        return _dump({
            "reward": ("feasible plan: 0.2 + 0.8 x exp(-g / 0.5) with g = (cost - optimum) / (optimum - floor + 100); "
                       "1.0 at or below the optimum. Infeasible plan: 0.2 x share of ships with no violation, so any "
                       "feasible plan beats any infeasible one."),
            "optimum": "the CP-SAT optimum stored with the task; the player never sees it",
            "floor": "unavoidable cost: each ship alone with the most cranes it can take",
            "plan_cost": ["delay: sections x hours a ship departs after its planned departure (times priority weight)",
                          "moves: 5 for each scheduled ship put on a different starting section than planned",
                          "emergency ships: a stated amount per hour berthed after their deadline"],
            "checker": ("oakland_core.evaluate: arrival, no-movement windows, quay limits, no shared section-hours, "
                        "shallow sections, crane range, crane pool per hour (smaller in hoot hours, less outages), "
                        "movement limit per hour; no cranes work in the meal hour 17:00"),
            "coach_impact": ("the coach ranks mistakes by impact: late ship-hours (meal: ships departing at 18:00), "
                             "5 per ship moved, 1000 per harness submission (episode lost), violations by checks used"),
            "budget": f"at most {MAX_CHECKS} check_plan calls per episode, one submit"})

    # ------------------------------------------------------------ LangChain

    def langchain_tools(self) -> list:
        from langchain_core.tools import StructuredTool

        names = ["run_status", "improvement", "coach_round", "playbook", "episode", "player_log", "ship", "what_if",
                 "reward_rules"]
        return [StructuredTool.from_function(getattr(self, n), name=n) for n in names]
