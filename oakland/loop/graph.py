"""The player and coach loop as a LangGraph StateGraph. The ship calls of every task are GENERATED (not real records).

    pick_task -> player -> grade_and_log -> maybe_coach -> eval_candidate -> accept_or_reject -> pick_task
                                                      \\-> pick_task (no coach round this episode)

No model weights change; the playbook is the only state (in-context adaptation). The player plays the task stream
(the "train" pack in file and field names) and a fixed verification set (the "eval" pack) is what the gate scores.

Code decides, models propose: the coach only writes a candidate playbook (a new open node in the playbook tree).
GEPA-style candidate pool (github.com/gepa-ai/gepa): every scored version keeps its per-task eval rewards, the
coach's parent is sampled from the Pareto front (versions best on at least one eval task, weighted by the number of
tasks they win, seeded by run name and round) or is the latest accepted node with --select latest, the coach gets
the lessons of the parent's ancestors, and after a rejected round two front members that win different tasks are
merged instead of asking the coach. eval_candidate first plays the train tasks of the coach window (the minibatch
pre-screen: a candidate whose train mean falls below the window's by more than ACCEPT_MARGIN is rejected without
playing the eval pack), then the whole held-out eval pack, using the same frozen player, and accept_or_reject
applies a fixed gate on the kernel's reward v3 against the latest ACCEPTED version (the one the player uses):
- accept when the verification mean reward beats the current accepted version's by at least ACCEPT_MARGIN;
- else reject, as "overfit" when the episodes' mean rose by the margin but the verification mean did not, as
  "no verification gain" otherwise, and as "not comparable" when the player_version differs from the one the current
  version was scored with. Episode and verification means are reported side by side, never averaged.

State is checkpointed with SqliteSaver in runs/<run>/state.sqlite (thread id = run name).
"""

from __future__ import annotations

import json
import random
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, TypedDict

from env import load_tasks
from oakland_core import grade, plan_from_list
from oakland_core.solve import naive_plan

from .coach import GeminiCoach, ScriptedCoach, load_episode_logs
from .player import GeminiPlayer, ScriptedPlayer, player_version, run_episode
from .playbook import PlaybookStore, merge_playbooks

ACCEPT_MARGIN = 0.005
OAKLAND = Path(__file__).resolve().parents[1]
RUNS = OAKLAND / "runs"


@dataclass
class LoopConfig:
    run: str = "demo"
    episodes: int = 30
    coach_every: int = 4
    kind: str = "berth"                 # berth | crane | both
    train_pack: list[str] = field(default_factory=list)
    eval_pack: list[str] = field(default_factory=list)
    player: str = "scripted"            # scripted | gemini
    coach: str = "scripted"             # scripted | gemini
    tiers: list[str] = field(default_factory=list)   # difficulty tiers kept in both sets (empty = all)
    live_feed: bool = True
    scripted_mistakes: bool = False
    runs_dir: str = str(RUNS)
    trace: bool = True                  # print one [graph] line per node event
    select: str = "pareto"              # pareto | latest: how the coach's parent is chosen
    prescreen: bool = True              # reject on the train minibatch before playing the eval pack
    workers: int = 4                    # episodes played concurrently by score() (1 = sequential)


class LoopState(TypedDict, total=False):
    run_dir: str
    episode: int                 # episodes graded so far
    task_index: int
    playbook_version: int        # the latest accepted version, the one the player uses
    coach_round: int
    window: list[dict]           # episodes since the last coach round: {episode, task_index, reward, events}
    summaries: list[dict]        # every graded episode, short
    last: dict                   # the episode just played (no events)
    candidate: dict | None       # the pending candidate playbook
    last_verdict: str | None     # verdict of the previous coach round
    lines: list[str]             # what the node prints


def default_pack(kind: str, split: str) -> list[str]:
    kinds = ["berth", "crane"] if kind == "both" else [kind]
    return [str(OAKLAND / "tasks" / f"{k}-{split}.jsonl") for k in kinds]


def load_pack(paths: list[str], kind: str, tiers: list[str] | None = None, what: str = "pack") -> list:
    tasks = [t for p in paths for t in load_tasks(p)]
    if kind != "both":
        tasks = [t for t in tasks if getattr(t, "kind", "berth") == kind]
    if tiers:
        tasks = [t for t in tasks if getattr(t, "difficulty", None) in tiers]
    if not tasks:
        tier_txt = f" of tiers {','.join(tiers)}" if tiers else ""
        raise SystemExit(f"no {kind} tasks{tier_txt} in the {what} ({', '.join(paths)})")
    return tasks


def sanity_gates(tasks: list) -> None:
    """Every eval task: the reference plan scores 1.0 and the naive plan below 0.5, else abort naming the task."""
    for t in tasks:
        ref = (t.reference or {}).get("optimal_plan")
        if ref is None:
            raise SystemExit(f"sanity gate: eval task {t.task_id} has no reference plan")
        r_ref = grade(t, plan_from_list(ref)).reward
        if r_ref < 0.9999:
            raise SystemExit(f"sanity gate: the reference plan of eval task {t.task_id} scores {r_ref:.3f}, not 1.0")
        r_naive = grade(t, naive_plan(t)).reward
        if r_naive >= 0.5:
            raise SystemExit(f"sanity gate: the naive plan of eval task {t.task_id} scores {r_naive:.3f} (>= 0.5)")


def _append_jsonl(path: Path, row: dict) -> None:
    with path.open("a") as f:
        f.write(json.dumps(row) + "\n")


def _write_json_atomic(path: Path, obj: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1))
    tmp.replace(path)


def select_parent(wins: dict[int, int], seed: str) -> int:
    """One version of the front, sampled with weight = tasks won, reproducibly for a given seed."""
    versions = sorted(wins)
    return random.Random(seed).choices(versions, weights=[max(1, wins[v]) for v in versions])[0]


def _mean(xs: list) -> float | None:
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs), 4) if xs else None


class Loop:
    """Runtime objects of one run (tasks, player, coach, playbook store); the graph nodes are its methods."""

    def __init__(self, cfg: LoopConfig):
        self.cfg = cfg
        self.dir = Path(cfg.runs_dir) / cfg.run
        self.dir.mkdir(parents=True, exist_ok=True)
        for sub in ("replays", "events", "eval"):
            (self.dir / sub).mkdir(exist_ok=True)
        self.train = load_pack(cfg.train_pack or default_pack(cfg.kind, "train"), cfg.kind, cfg.tiers, "task stream")
        self.eval = load_pack(cfg.eval_pack or default_pack(cfg.kind, "eval"), cfg.kind, cfg.tiers,
                              "verification set")
        sanity_gates(self.eval)
        self.player = GeminiPlayer() if cfg.player == "gemini" else ScriptedPlayer(mistakes=cfg.scripted_mistakes)
        self.coach = GeminiCoach() if cfg.coach == "gemini" else ScriptedCoach()
        self.player_version = player_version(self.player.model_id)
        self.store = PlaybookStore(self.dir)
        self.episodes_path = self.dir / "episodes.jsonl"
        self.manifest_path = self.dir / "episodes.json"
        self.eval_path = self.dir / "eval.jsonl"
        self.coach_costs: list[dict] = []

    # scoring

    def score(self, tasks: list, indices: list[int], version: int, out_dir: Path) -> dict:
        """Play `indices` of `tasks` once each with playbook `version`; mean reward, feasibility, gap."""
        text, heur = self.store.text(version), self.store.heuristic(version)

        def one(i: int) -> dict:
            return run_episode(tasks, i, self.player, text, version, heuristic=heur, live_feed=self.cfg.live_feed,
                               events_path=out_dir / f"{tasks[i].task_id}.jsonl")

        if self.cfg.workers > 1 and len(indices) > 1:
            with ThreadPoolExecutor(max_workers=self.cfg.workers) as pool:
                results = list(pool.map(one, indices))   # map keeps task order, not completion order
        else:
            results = [one(i) for i in indices]
        rows = []
        for r in results:
            rows.append({"task_id": r["task_id"], "reward": r["reward"], "feasible": r["feasible"],
                         "gap_pct": r["gap_pct"], "checks_used": r["checks_used"],
                         "tokens_in": r["tokens_in"], "tokens_out": r["tokens_out"], "cost_usd": r["cost_usd"]})
        return {"mean": _mean([r["reward"] for r in rows]),
                "feasibility_rate": round(sum(1 for r in rows if r["feasible"]) / max(1, len(rows)), 4),
                "mean_gap_pct": _mean([r["gap_pct"] for r in rows]),
                "cost_usd": round(sum(r["cost_usd"] for r in rows), 6),
                "tokens": sum(r["tokens_in"] + r["tokens_out"] for r in rows), "per_task": rows}

    def baseline(self) -> list[str]:
        """Score the root playbook on the eval pack once, at startup."""
        v = self.store.latest_accepted()
        node = self.store.node(v)
        if node.get("eval_mean") is not None:
            return []
        s = self.score(self.eval, list(range(len(self.eval))), v, self.dir / "eval" / f"v{v}")
        self.store.update(v, eval_mean=s["mean"], feasibility_rate=s["feasibility_rate"],
                          mean_gap_pct=s["mean_gap_pct"], player_version=self.player_version,
                          eval_per_task={r["task_id"]: r["reward"] for r in s["per_task"]})
        self.store.refresh_front()
        _append_jsonl(self.eval_path, {"version": v, "parent": node["parent"], "role": "baseline",
                                       "player_version": self.player_version, "train_mean": None,
                                       "eval_mean": s["mean"], "feasibility_rate": s["feasibility_rate"],
                                       "mean_gap_pct": s["mean_gap_pct"], "comparable": True, "verdict": "accepted",
                                       "reason": "root", "per_task": s["per_task"], "eval_cost_usd": s["cost_usd"]})
        return [f"baseline | playbook v{v} | verification mean {s['mean']:.3f} | feasible {s['feasibility_rate']:.2f} | "
                f"gap {s['mean_gap_pct']:.1f}% | player {self.player_version}"]

    # nodes

    def pick_task(self, state: LoopState) -> dict:
        idx = state["episode"] % len(self.train)
        return {"task_index": idx, "lines": []}

    def play(self, state: LoopState) -> dict:
        ep = state["episode"] + 1
        v = state["playbook_version"]
        r = run_episode(self.train, state["task_index"], self.player, self.store.text(v), v,
                        heuristic=self.store.heuristic(v), live_feed=self.cfg.live_feed,
                        events_path=self.dir / "events" / f"ep{ep:03d}.jsonl",
                        replay_path=self.dir / "replays" / f"ep{ep:03d}.json")
        r.pop("events")
        return {"last": {**r, "episode": ep, "playbook_version": v}, "lines": []}

    def grade_and_log(self, state: LoopState) -> dict:
        r = state["last"]
        ep = r["episode"]
        row = {"episode": ep, "task_id": r["task_id"], "task_index": r["task_index"], "kind": r["kind"],
               "reward": r["reward"], "cost": r["cost"], "optimal_cost": r["optimal_cost"], "gap_pct": r["gap_pct"],
               "feasible": r["feasible"], "checks_used": r["checks_used"],
               "first_feasible_check": r["first_feasible_check"], "submitted_by": r["submitted_by"],
               "playbook_version": r["playbook_version"], "player_version": self.player_version,
               "replay": f"replays/ep{ep:03d}.json", "events": f"events/ep{ep:03d}.jsonl", "metrics": r["metrics"],
               "tokens_in": r["tokens_in"], "tokens_out": r["tokens_out"], "cost_usd": r["cost_usd"],
               "wall_s": r["wall_s"]}
        _append_jsonl(self.episodes_path, row)
        manifest = json.loads(self.manifest_path.read_text()) if self.manifest_path.exists() else []
        manifest = [m for m in manifest if m["episode"] != ep]
        manifest.append({"episode": ep, "replay": row["replay"], "reward": r["reward"],
                         "label": f"playbook v{r['playbook_version']}, {r['task_id']} (generated calls)"})
        _write_json_atomic(self.manifest_path, manifest)
        ff = r["first_feasible_check"]
        line = (f"episode {ep:3d} | task {r['task_id']} | reward {r['reward']:.3f} | checks {r['checks_used']} | "
                f"first feasible check {ff if ff is not None else '-'} | playbook v{r['playbook_version']} | "
                f"tokens {r['tokens_in'] + r['tokens_out']} | ${r['cost_usd']:.4f}")
        window = state.get("window", []) + [{"episode": ep, "task_index": r["task_index"], "reward": r["reward"],
                                             "events": row["events"]}]
        summaries = state.get("summaries", []) + [{"episode": ep, "reward": r["reward"], "cost_usd": r["cost_usd"]}]
        return {"episode": ep, "window": window, "summaries": summaries, "lines": [line]}

    def maybe_coach(self, state: LoopState) -> dict:
        if state["episode"] % self.cfg.coach_every != 0 or not state.get("window"):
            return {"candidate": None, "lines": []}
        accepted = state["playbook_version"]
        rnd = state.get("coach_round", 0) + 1
        parent, selected_by = accepted, "latest"
        ws = self.store.win_sets()
        if self.cfg.select == "pareto":
            selected_by = "pareto"
            if ws:
                parent = select_parent({v: len(w) for v, w in ws.items()}, f"{self.cfg.run}:{rnd}")
        version = max(n["version"] for n in self.store.nodes()) + 1
        pair = self.merge_pair(parent, ws) if state.get("last_verdict") == "rejected" else None
        if pair is not None:
            a, b = pair
            md = merge_playbooks(version, self.store.text(a), self.store.text(b))
            made = self.store.add(a, md, f"merge of v{a} and v{b}", f"merge v{a}+v{b}", self.store.heuristic_code(a))
            self.store.update(made, merged_from=[a, b], mistakes=[], coach_model="merge", coach_tokens_in=0,
                              coach_tokens_out=0, coach_cost_usd=0.0)
            cand = {"version": made, "parent": a, "change": f"merge v{a}+v{b}", "diagnosis": f"merge of v{a} and v{b}",
                    "mistakes": 0, "coach_tokens": 0, "coach_cost_usd": 0.0, "merged_from": [a, b],
                    "accepted_version": accepted, "parent_selected_by": selected_by}
            return {"candidate": cand, "coach_round": rnd, "lines": []}
        logs = load_episode_logs([(w["episode"], self.dir / w["events"]) for w in state["window"]])
        out = self.coach.propose(logs, self.store.text(parent), version, self.store.rejected_changes(),
                                 self.store.lessons(parent))
        made = self.store.add(parent, out["playbook_md"], out["diagnosis"], out["change"], out["heuristic_code"])
        self.store.update(made, mistakes=out["mistakes"], coach_model=out["model"], coach_tokens_in=out["tokens_in"],
                          coach_tokens_out=out["tokens_out"], coach_cost_usd=out["cost_usd"])
        cand = {"version": made, "parent": parent, "change": out["change"], "diagnosis": out["diagnosis"],
                "mistakes": len(out["mistakes"]), "coach_tokens": out["tokens_in"] + out["tokens_out"],
                "coach_cost_usd": out["cost_usd"], "merged_from": None, "accepted_version": accepted,
                "parent_selected_by": selected_by}
        return {"candidate": cand, "coach_round": rnd, "lines": []}

    def merge_pair(self, first: int, ws: dict[int, set[str]]) -> tuple[int, int] | None:
        """Two front members that win different task sets and were never merged: `first` (when on the front, else
        the lowest front version) and the lowest other such member; None when there is none."""
        if len(ws) < 2:
            return None
        done = self.store.merged_pairs()
        firsts = [first] if first in ws else []
        firsts += [v for v in sorted(ws) if v != first]
        for a in firsts:
            for b in sorted(ws):
                if b != a and ws[a] != ws[b] and frozenset((a, b)) not in done:
                    return a, b
        return None

    def eval_candidate(self, state: LoopState) -> dict:
        cand = dict(state["candidate"])
        v = cand["version"]
        idx = sorted({w["task_index"] for w in state["window"]})
        tr = self.score(self.train, idx, v, self.dir / "eval" / f"v{v}-train")
        cur_train = _mean([w["reward"] for w in state["window"]])
        cand.update(train_mean=tr["mean"], train_per_task=tr["per_task"], current_train_mean=cur_train)
        drop = round(tr["mean"] - cur_train, 4) if tr["mean"] is not None and cur_train is not None else 0.0
        if self.cfg.prescreen and -drop > ACCEPT_MARGIN:
            cand.update(eval_mean=None, feasibility_rate=None, mean_gap_pct=None, eval_per_task=[],
                        eval_cost_usd=tr["cost_usd"], prescreen={"verdict": "rejected",
                                                               "reason": f"minibatch: episodes {drop:+.3f}"})
            return {"candidate": cand, "lines": []}
        ev = self.score(self.eval, list(range(len(self.eval))), v, self.dir / "eval" / f"v{v}")
        cand.update(eval_mean=ev["mean"], feasibility_rate=ev["feasibility_rate"], mean_gap_pct=ev["mean_gap_pct"],
                    eval_per_task=ev["per_task"], eval_cost_usd=round(ev["cost_usd"] + tr["cost_usd"], 6))
        return {"candidate": cand, "lines": []}

    def accept_or_reject(self, state: LoopState) -> dict:
        cand = state["candidate"]
        v, parent = cand["version"], cand["parent"]
        accepted = cand.get("accepted_version", parent)
        cur = self.store.node(accepted)      # the gate is always against the latest accepted version
        cur_eval, cur_train = cur["eval_mean"], cand["current_train_mean"]
        comparable = cur.get("player_version") == self.player_version
        pre = cand.get("prescreen")
        eval_gain = 0.0 if pre else round(cand["eval_mean"] - cur_eval, 4)   # 4-decimal means: no float noise
        train_gain = round(cand["train_mean"] - cur_train, 4) if cur_train is not None else 0.0
        if pre:   # the minibatch pre-screen already rejected it, without playing the eval pack
            verdict, reason = pre["verdict"], pre["reason"]
        elif not comparable:
            verdict, reason = "rejected", (f"not comparable: player_version {self.player_version} differs from "
                                           f"{cur.get('player_version')}")
        elif cand["change"] is None and not self.store.heuristic_code(v):
            verdict, reason = "rejected", "no change proposed"
        elif eval_gain >= ACCEPT_MARGIN:
            verdict, reason = "accepted", f"verification +{eval_gain:.3f} (margin {ACCEPT_MARGIN})"
        elif train_gain >= ACCEPT_MARGIN:
            verdict, reason = "rejected", (f"overfit: episodes +{train_gain:.3f} but verification "
                                           f"{eval_gain:+.3f}")
        else:
            verdict, reason = "rejected", (f"no verification gain: verification {eval_gain:+.3f} "
                                           f"(needs +{ACCEPT_MARGIN})")
        self.store.update(v, verdict=verdict, reason=reason, eval_mean=cand["eval_mean"],
                          train_mean=cand["train_mean"], feasibility_rate=cand["feasibility_rate"],
                          mean_gap_pct=cand["mean_gap_pct"], player_version=self.player_version,
                          eval_per_task={r["task_id"]: r["reward"] for r in cand["eval_per_task"]},
                          train_per_task={r["task_id"]: r["reward"] for r in cand["train_per_task"]})
        self.store.refresh_front()
        rnd = state.get("coach_round", 1)
        _append_jsonl(self.eval_path, {
            "version": v, "parent": parent, "accepted_version": accepted, "role": "candidate", "coach_round": rnd,
            "parent_selected_by": cand.get("parent_selected_by", "latest"), "merged_from": cand.get("merged_from"),
            "prescreened": bool(pre),
            "player_version": self.player_version, "parent_player_version": cur.get("player_version"),
            "comparable": comparable, "change": cand["change"], "diagnosis": cand["diagnosis"],
            "train_mean": cand["train_mean"], "current_train_mean": cur_train, "eval_mean": cand["eval_mean"],
            "current_eval_mean": cur_eval, "feasibility_rate": cand["feasibility_rate"],
            "mean_gap_pct": cand["mean_gap_pct"], "verdict": verdict, "reason": reason,
            "per_task": cand["eval_per_task"], "train_per_task": cand["train_per_task"],
            "coach_tokens": cand["coach_tokens"], "coach_cost_usd": cand["coach_cost_usd"],
            "eval_cost_usd": cand["eval_cost_usd"]})
        self.coach_costs.append({"round": rnd, "coach_cost_usd": cand["coach_cost_usd"],
                                 "eval_cost_usd": cand["eval_cost_usd"]})
        word = "ACCEPT" if verdict == "accepted" else "REJECT"
        ct = f"{cur_train:.3f}" if cur_train is not None else "-"
        ce = f"{cand['eval_mean']:.3f}" if cand["eval_mean"] is not None else "-"
        line = (f"coach round {rnd} | v{v} from v{parent} | verification {cur_eval:.3f} -> {ce} | "
                f"episodes {ct} -> {cand['train_mean']:.3f} | {word} ({reason}) | coach tokens {cand['coach_tokens']} | "
                f"${cand['coach_cost_usd'] + cand['eval_cost_usd']:.4f}")
        if cand["change"]:
            line += f"\n    change: {cand['change']}"
        new_v = v if verdict == "accepted" else accepted
        return {"playbook_version": new_v, "candidate": None, "window": [], "last_verdict": verdict, "lines": [line]}

    # routing

    def _after_coach(self, state: LoopState) -> str:
        if state.get("candidate"):
            return "eval_candidate"
        return self._next(state)

    def _next(self, state: LoopState) -> str:
        return "pick_task" if state["episode"] < self.cfg.episodes else "__end__"


def build_graph(loop: Loop, checkpointer: Any = None) -> Any:
    from langgraph.graph import END, START, StateGraph

    g = StateGraph(LoopState)
    g.add_node("pick_task", loop.pick_task)
    g.add_node("player", loop.play)
    g.add_node("grade_and_log", loop.grade_and_log)
    g.add_node("maybe_coach", loop.maybe_coach)
    g.add_node("eval_candidate", loop.eval_candidate)
    g.add_node("accept_or_reject", loop.accept_or_reject)
    g.add_edge(START, "pick_task")
    g.add_edge("pick_task", "player")
    g.add_edge("player", "grade_and_log")
    g.add_edge("grade_and_log", "maybe_coach")
    g.add_conditional_edges("maybe_coach", loop._after_coach,
                            {"eval_candidate": "eval_candidate", "pick_task": "pick_task", "__end__": END})
    g.add_edge("eval_candidate", "accept_or_reject")
    g.add_conditional_edges("accept_or_reject", loop._next, {"pick_task": "pick_task", "__end__": END})
    return g.compile(checkpointer=checkpointer)


def run_loop(cfg: LoopConfig, out: Callable[[str], None] = print, resume: bool = False) -> dict:
    """Run the loop end to end, streaming node events to `out`; returns the final state."""
    from langgraph.checkpoint.sqlite import SqliteSaver

    loop = Loop(cfg)
    for line in loop.baseline():
        out(line)
    conn = sqlite3.connect(str(loop.dir / "state.sqlite"), check_same_thread=False)
    try:
        graph = build_graph(loop, SqliteSaver(conn))
        config = {"configurable": {"thread_id": cfg.run}, "recursion_limit": cfg.episodes * 8 + 20}
        start: Any = None if resume else {"run_dir": str(loop.dir), "episode": 0, "playbook_version":
                                          loop.store.latest_accepted(), "coach_round": 0, "window": [],
                                          "summaries": [], "candidate": None, "last_verdict": None, "lines": []}
        for update in graph.stream(start, config, stream_mode="updates"):
            for node, delta in update.items():
                if cfg.trace:
                    out(f"[graph] {node}")
                for line in (delta or {}).get("lines") or []:
                    out(line)
        final = graph.get_state(config).values
    finally:
        conn.close()
    summ = final.get("summaries", [])
    ep_cost = sum(s["cost_usd"] for s in summ)
    out(f"run {cfg.run} | {len(summ)} episodes | playbook v{final.get('playbook_version')} | "
        f"player {loop.player_version} | episode cost ${ep_cost:.4f} "
        f"(${ep_cost / max(1, len(summ)):.4f} per episode) | coach rounds {len(loop.coach_costs)} "
        f"(${sum(c['coach_cost_usd'] + c['eval_cost_usd'] for c in loop.coach_costs):.4f})")
    return final
