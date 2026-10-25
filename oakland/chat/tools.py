"""Read-only tools over one run directory, for the operator chat. Every tool returns compact JSON text (at most
about 1500 characters, 3000 for port_status and late_ships, numbers rounded). Nothing here writes to the run;
what_if grades a modified copy of a plan with the real checker (oakland_core.grade) and keeps it in memory.

    tools = RunTools("runs/real-berth-gepa")
    tools.run_status(); tools.episode(7); tools.what_if(7, 0, berth_hour=30, section=4, cranes=3)
    tools.langchain_tools()   # the same functions as LangChain tools, for the chat agent

optimize_playbook, verify_proposal and proposal_status (chat/optimize.py) and make_plan / route_ship are the
exception: they write only to <run_dir>/proposals/ (schedules under proposals/plans/), a directory the loop never
touches.

Run layout read here: episodes.jsonl (or episodes.json), eval.jsonl, playbooks/tree.json and vN.md,
replays/epNNN.json, events/epNNN.jsonl. Any of them may be missing (a live run that just started): the tools then
say so instead of failing.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from env import MAX_CHECKS
from oakland_core import PlanError, Task, grade, parse_plan, plan_to_list
from oakland_core import replay as build_replay

MAX_CHARS = 1500
PORT_CHARS = 3000   # port_status and late_ships: a whole quay at one hour
OVERVIEW_CHARS = 2500
SOLVE_S, SOLVE_WORKERS = 15, 4   # make_plan's CP-SAT budget


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

    def __init__(self, run_dir: str | Path, optimizer: Any = None):
        self.run_dir = Path(run_dir)
        self._optimizer = optimizer
        self._optima: dict[int, list[dict]] = {}
        self._view: ContextVar[tuple[int | None, int | None, int | None]] = ContextVar(
            f"view-{id(self)}", default=(None, None, None))

    @property
    def optimizer(self) -> Any:
        if self._optimizer is None:
            from .optimize import Optimizer
            self._optimizer = Optimizer(self.run_dir)
        return self._optimizer

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

    def ship(self, n: int | None = None, ship_id_or_name: Any = None) -> str:
        """One ship in episode n: ETA, LOA, draught, cranes, planned vs actual section, berth hour, departure, due,
        hours late. For "this ship" or "it" leave the arguments out: the episode on screen and the ship selected
        there, else the most late ship (then `picked` says so)."""
        n, _ = self._pick(n, None)
        rep = None if n is None else self.replay(n)
        if rep is None:
            return _dump({"error": f"no replay for episode {n}"})
        picked = None
        if ship_id_or_name is None:
            v_ep, _, v_ship = self._view.get()
            if v_ship is not None and v_ep in (None, n):
                ship_id_or_name, picked = v_ship, "the ship selected in the viewer"
            else:
                late = sorted((x for x in rep.get("ships", []) if (x.get("late_h") or 0) > 0), key=lambda x: -x["late_h"])
                if not late:
                    return _dump({"error": f"no ship named and none late in episode {n}"})
                ship_id_or_name, picked = late[0]["id"], "no ship named: the most late ship"
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
            "problems": rs.get("problems", [])[:3], "note": "generated ship call, not a real record",
            **({"picked": picked} if picked else {})})

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

    # ------------------------------------------------------------ the port at one hour

    @contextmanager
    def viewing(self, episode: int | None = None, hour: int | None = None, ship_id: int | None = None):
        """While inside, the tools default to the episode, hour and selected ship the viewer shows."""
        token = self._view.set((episode, hour, ship_id))
        try:
            yield
        finally:
            self._view.reset(token)

    def _latest_episode(self) -> int | None:
        nums = [int(p.stem[2:]) for p in (self.run_dir / "replays").glob("ep*.json") if p.stem[2:].isdigit()]
        return max(nums) if nums else None

    def _pick(self, episode: Any, hour: Any) -> tuple[int | None, int | None]:
        """The episode (given, else the viewer's, else the latest) and the hour (given, else the viewer's when it is
        the viewer's episode, else None)."""
        v_ep, v_hour, _ = self._view.get()
        if episode is None:
            episode = v_ep if v_ep is not None else self._latest_episode()
        if hour is None and v_ep is not None and episode is not None and int(episode) == int(v_ep):
            hour = v_hour
        return (None if episode is None else int(episode)), (None if hour is None else int(hour))

    def port_status(self, episode: int | None = None, hour: int | None = None) -> str:
        """How the port is doing at one hour of an episode's plan (default: the episode and hour on screen, else the
        latest episode at its last berthing): ships alongside, ships waiting at anchor, late ships, cranes in use of
        the pool, bar closures, the next arrivals, and the plan's cost against the best possible."""
        n, h = self._pick(episode, hour)
        rep = None if n is None else self.replay(n)
        if rep is None:
            return _dump({"error": f"no replay for episode {n}" if n is not None else "no episodes yet"})
        task, g, ships = rep["task"], rep.get("grade") or {}, rep.get("ships", [])
        horizon = int(rep.get("horizon_h") or 1)
        if h is None:
            h = max((s["berth_hour"] for s in ships if s.get("berth_hour") is not None), default=0)
        h = max(0, min(int(h), horizon - 1))

        def span(first: Any, n_sec: Any) -> str | None:
            return None if first is None else f"{first}-{first + (n_sec or 1) - 1}"

        alongside, waiting, cranes = [], [], 0
        for s in ships:
            b, d = s.get("berth_hour"), s.get("departure")
            c = dict((t, k) for t, k in s.get("cranes_by_hour", [])).get(h, 0)
            if b is not None and d is not None and b <= h < d:
                cranes += c
                alongside.append({"ship": s["id"], "name": s["name"], "section": span(s.get("first_section"),
                                  s.get("sections")), "cranes": c, "started_hour": b, "done_hour": d,
                                  "late_hours": s.get("late_h") or 0})
            elif s["arrival"] <= h and (b is None or b > h):
                waiting.append({"ship": s["id"], "name": s["name"], "arrived_hour": s["arrival"],
                                "waited_hours": h - s["arrival"], "berth_hour": b})
        fixed = []
        for blk in rep.get("blocks", []):
            if blk.get("start", 0) <= h < blk.get("end", 0) and blk.get("kind") in ("alongside", "closed"):
                if blk["kind"] == "alongside":
                    cranes += dict((t, k) for t, k in blk.get("cranes_by_hour", [])).get(h, 0)
                fixed.append({"kind": blk["kind"], "sections": f"{blk['first']}-{blk['last']}",
                              "label": blk.get("label"), "until_hour": blk.get("end")})
        closures = [{"label": w.get("label"), "start": w["start"], "end": w["end"]}
                    for w in rep.get("no_moves", []) if w["start"] <= h < w["end"]]
        late = sorted(({"ship": s["id"], "name": s["name"], "late_hours": s["late_h"]}
                       for s in ships if (s.get("late_h") or 0) > 0), key=lambda s: -s["late_hours"])
        nxt = sorted((s for s in ships if s["arrival"] > h), key=lambda s: s["arrival"])[:3]
        pool = dict((t, k) for t, k in rep.get("crane_pool_by_hour", [])).get(h)
        planned = {s["id"]: s.get("planned_section") for s in task["ships"]}
        moved = sum(1 for r in rep.get("plan", []) if planned.get(r["ship"]) is not None
                    and r.get("section") is not None and r.get("section") != planned.get(r["ship"]))
        cost, opt = g.get("cost"), g.get("optimal_cost")
        weather = [w for w in task.get("disruptions", []) if w.get("type") in ("fog", "storm", "wind")]
        return _dump({
            "episode": n, "task_id": task.get("task_id"), "terminal": task.get("terminal"),
            "tier": task.get("difficulty"), "weather": [f"{w['type']} h{w['start']}-{w['end']}" for w in weather][:4],
            "hour": h, "alongside": alongside, "waiting": waiting, "late": late[:5], "late_ship_count": len(late),
            "cranes_in_use": cranes, "crane_pool": pool, "fixed_blocks": fixed, "closures_now": closures,
            "next_arrivals": [{"ship": s["id"], "name": s["name"], "hour": s["arrival"]} for s in nxt],
            "plan": {"cost": cost, "optimum": opt,
                     "gap_pct": None if cost is None or not opt else round(100 * (cost - opt) / opt, 1),
                     "late_ship_hours_total": sum(s["late_hours"] for s in late),
                     "ships_moved_off_published_section": moved, "feasible": g.get("feasible"),
                     "violations": len(g.get("violations", []))}}, limit=PORT_CHARS)

    def late_ships(self, episode: int | None = None) -> str:
        """Every late ship of an episode (default: the one on screen, else the latest), most late first: late hours,
        due hour, arrival, berth hour, section, cranes, and why the plan made it late (arrived late, waited for a
        bar closure, a closed or occupied section, the crane pool, or too few cranes)."""
        n, _ = self._pick(episode, None)
        rep = None if n is None else self.replay(n)
        if rep is None:
            return _dump({"error": f"no replay for episode {n}" if n is not None else "no episodes yet"})
        task, ships = rep["task"], rep.get("ships", [])
        spec = {s["id"]: s for s in task["ships"]}
        plan = {r["ship"]: r for r in rep.get("plan", [])}
        pool = dict((t, k) for t, k in rep.get("crane_pool_by_hour", []))
        arrived_late = {d["ship"]: d["hours"] for d in task.get("disruptions", []) if d.get("type") == "late"}

        def used(t: int, but: int) -> int:
            return sum(dict((x, k) for x, k in o.get("cranes_by_hour", [])).get(t, 0)
                       for o in ships + rep.get("blocks", []) if o.get("id") != but)

        def taken(first: int, last: int, t: int, but: int) -> str | None:
            for o in ships:
                b, d, f = o.get("berth_hour"), o.get("departure"), o.get("first_section")
                if o["id"] != but and None not in (b, d, f) and b <= t < d and f <= last and first <= f + o["sections"] - 1:
                    return f"{o['name']} #{o['id']}"
            for blk in rep.get("blocks", []):
                if blk["kind"] in ("alongside", "closed") and blk["start"] <= t < blk["end"] \
                        and blk["first"] <= last and first <= blk["last"]:
                    return blk.get("label") or blk["kind"]
            return None

        out = []
        for s in sorted((s for s in ships if (s.get("late_h") or 0) > 0), key=lambda s: -s["late_h"]):
            sp, entry = spec.get(s["id"], {}), plan.get(s["id"], {})
            b, a, f = s.get("berth_hour"), s["arrival"], s.get("first_section")
            why = []
            if s["id"] in arrived_late:
                why.append(f"arrived {arrived_late[s['id']]} h late (weather on the crossing)")
            if a >= s["due"]:
                why.append(f"arrived at hour {a}, after its due hour {s['due']}")
            if b is not None and b > a:
                before = len(why)
                w = [x for x in rep.get("no_moves", []) if x["start"] < b and a < x["end"]]
                if w:
                    why.append(f"waited for {w[0].get('label', 'a bar closure')} h{w[0]['start']}-{w[0]['end']}")
                occ = None if f is None else taken(f, f + s["sections"] - 1, a, s["id"])
                if occ:
                    why.append(f"waited {b - a} h for sections {f}-{f + s['sections'] - 1} ({occ} there)")
                if a in pool and used(a, s["id"]) >= pool[a]:
                    why.append(f"crane pool full at hour {a} ({pool[a]} cranes)")
                if len(why) == before:
                    why.append(f"waited {b - a} h at anchor")
            cr = entry.get("cranes")
            if cr is not None and sp.get("max_cranes") and cr < sp["max_cranes"]:
                why.append(f"worked with {cr} of up to {sp['max_cranes']} cranes")
            out.append({"ship": s["id"], "name": s["name"], "late_hours": s["late_h"], "due": s["due"],
                        "arrival": a, "berth_hour": b, "section": None if f is None else f"{f}-{f + s['sections'] - 1}",
                        "cranes": cr, "reason": "; ".join(why) or None})
        return _dump({"episode": n, "late_ship_count": len(out), "late_ship_hours_total": sum(x["late_hours"] for x in out),
                      "late_ships": out}, limit=PORT_CHARS)

    def overview(self) -> str:
        """Everything in one digest, for any question no other tool fits: the port at the latest episode's last
        berthing, that episode (terminal, tier, cost against the optimum, late ships), the run (episodes, accepted
        playbook and its verified score, last coach verdict), the playbook's current rules and the latest chat
        proposal. No model, no solver."""
        out: dict[str, Any] = {}
        n = self._latest_episode()
        if n is not None:
            st = json.loads(self.port_status(n, None))
            if "error" not in st:
                out["port_now"] = {k: st[k] for k in ("terminal", "tier", "hour", "cranes_in_use", "crane_pool")}
                out["port_now"].update(alongside=[x["name"] for x in st["alongside"]],
                                       waiting=[x["name"] for x in st["waiting"]], closures=st["closures_now"])
                out["latest_episode"] = {"episode": n, "task_id": st["task_id"], "ships": len(self.replay(n)["ships"]),
                                         "cost": st["plan"]["cost"], "optimum": st["plan"]["optimum"],
                                         "gap_pct": st["plan"]["gap_pct"], "feasible": st["plan"]["feasible"],
                                         "late_ship_count": st["late_ship_count"], "late_top3": st["late"][:3]}
        eps, evals = self.episodes(), self.evals()
        accepted = [e for e in evals if e.get("verdict") == "accepted"]
        out["run"] = {"episodes_played": len(eps), "accepted_playbook": accepted[-1].get("version") if accepted else None,
                      "verified_score": accepted[-1].get("eval_mean") if accepted else None,
                      "last_coach": None if not evals else
                      f"v{evals[-1].get('version')} {evals[-1].get('verdict')}: {_short(evals[-1].get('reason'), 140)}"}
        p = self.run_dir / "playbooks" / f"v{out['run']['accepted_playbook'] or 0}.md"
        if p.exists():
            out["playbook_rules"] = [_short(ln.strip(" -*"), 120) for ln in p.read_text().splitlines()
                                     if ln.strip() and not ln.startswith("#")][:5]
        try:
            got = self.optimizer.status(None)
            out["chat_proposal"] = None if "error" in got else {k: got.get(k) for k in
                                                                 ("id", "status", "change", "eval_mean")}
        except Exception:   # noqa: BLE001, the digest never fails on a proposal file
            out["chat_proposal"] = None
        if not out.get("latest_episode") and not eps:
            out["note"] = f"no episodes yet in run {self.run_dir.name}"
        return _dump(out, limit=OVERVIEW_CHARS)

    # ------------------------------------------------------------ schedules on demand

    def _optimum_rows(self, n: int, task: Task) -> list[dict]:
        """The CP-SAT optimal plan of episode n's task as plan rows, solved once per episode and kept in memory."""
        if n not in self._optima:
            from oakland_core import solve
            plan, _, _ = solve(task, time_limit_s=SOLVE_S, workers=SOLVE_WORKERS)
            self._optima[n] = plan_to_list(plan, task.kind)
        return [dict(r) for r in self._optima[n]]

    def make_plan(self, episode: int | None = None, pins: list[dict] | None = None) -> str:
        """Build a full berth schedule for an episode's task (default: the one on screen, else the latest) with the
        exact solver, then apply `pins` = [{ship, section?, berth_hour?, cranes?}] on top and run the real checker.
        Returns cost against the best possible and the plan I played, feasibility, violations, late ships, the pinned
        rows and the replay file the viewer can show in 3D."""
        n, _ = self._pick(episode, None)
        rep = None if n is None else self.replay(n)
        if rep is None:
            return _dump({"error": f"no replay for episode {n}" if n is not None else "no episodes yet"})
        task = self._task(rep)
        if task.kind != "berth":
            return _dump({"error": f"episode {n} is a crane task: make_plan builds berth schedules"})
        rows = self._optimum_rows(n, task)
        pinned = []
        for pin in pins or []:
            s = self._find_ship(rep, pin.get("ship"))
            if s is None:
                return _dump({"error": f"no ship {pin.get('ship')!r} in episode {n}"})
            entry = next(r for r in rows if r["ship"] == s["id"])
            for k in ("berth_hour", "section", "cranes"):
                if pin.get(k) is not None:
                    entry[k] = int(pin[k])
            pinned.append({"name": s["name"], **entry})
        try:
            plan, problems = parse_plan(task, rows)
        except PlanError as e:
            return _dump({"error": f"plan could not be read: {e}"})
        g = grade(task, plan, problems)
        out = build_replay(task, plan, problems)
        pdir = self.run_dir / "proposals" / "plans"
        pdir.mkdir(parents=True, exist_ok=True)
        k = 1 + max((int(p.stem[4:]) for p in pdir.glob("plan*.json") if p.stem[4:].isdigit()), default=0)
        (pdir / f"plan{k}.json").write_text(json.dumps(out))
        planned = {s["id"]: s.get("planned_section") for s in rep["task"]["ships"]}
        late = sorted(({"ship": s["id"], "name": s["name"], "late_hours": s["late_h"]}
                       for s in out["ships"] if (s.get("late_h") or 0) > 0), key=lambda s: -s["late_hours"])
        viol = [v.get("problem", v) if isinstance(v, dict) else v for v in g.violations] + g.parse_problems
        played = (rep.get("grade") or {}).get("cost")
        return _dump({
            "episode": n, "cost": g.cost, "optimum": g.optimal_cost,
            "gap_pct": None if g.cost is None or not g.optimal_cost else
            round(100 * (g.cost - g.optimal_cost) / g.optimal_cost, 1),
            "feasible": g.feasible, "violations": {"count": len(viol), "first": [_short(v, 120) for v in viol[:3]]},
            "late_ships": late[:3], "ships_moved_off_published_section": sum(
                1 for r in rows if planned.get(r["ship"]) is not None and r["section"] != planned[r["ship"]]),
            "pinned": pinned,
            "vs_played": {"played_cost": played,
                          "delta": None if played is None or g.cost is None else g.cost - played},
            "replay": f"proposals/plans/plan{k}.json"}, limit=PORT_CHARS)

    def route_ship(self, episode: int, ship: Any, section: int | None = None, berth_hour: int | None = None,
                   cranes: int | None = None) -> str:
        """Route one ship (id or name) to a section and/or berth hour and/or crane count, rebuild the rest of the
        schedule with the exact solver and run the checker: make_plan with that one pin."""
        return self.make_plan(episode, [{"ship": ship, "section": section, "berth_hour": berth_hour,
                                         "cranes": cranes}])

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

    def optimize_playbook(self, episodes: int = 3) -> str:
        """Optimize my playbook now: the coach reads my last `episodes` episode logs and proposes one playbook change
        with evidence (about 30 s), and its verification on the held-out tasks starts at once in the background.
        Returns the proposal id, status (verifying), change, diagnosis and expected minutes."""
        try:
            return _dump(self.optimizer.optimize(int(episodes)))
        except ValueError as e:
            return _dump({"error": str(e)})

    def verify_proposal(self, id: int) -> str:   # noqa: A002, the tool argument name the model sees
        """Re-run the verification of proposal `id` (optimize_playbook already starts it) on the fixed verification
        tasks with the loop's gate, in the background. Returns at once; ask proposal_status later."""
        try:
            return _dump(self.optimizer.verify(int(id)))
        except ValueError as e:
            return _dump({"error": str(e)})

    def proposal_status(self, id: int | None = None) -> str:   # noqa: A002
        """Did it work: the latest (or given) playbook proposal with its status (proposed, verifying, accepted,
        rejected), verification mean against the accepted playbook's, and the verdict reason."""
        return _dump(self.optimizer.status(None if id is None else int(id)))

    # ------------------------------------------------------------ LangChain

    def langchain_tools(self) -> list:
        from langchain_core.tools import StructuredTool

        names = ["overview", "port_status", "late_ships", "make_plan", "route_ship", "run_status", "improvement", "coach_round", "playbook", "episode", "player_log", "ship", "what_if",
                 "reward_rules", "optimize_playbook", "verify_proposal", "proposal_status"]
        return [StructuredTool.from_function(getattr(self, n), name=n) for n in names]
