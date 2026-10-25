"""The Coach: reads the Player's episode event logs and proposes the next playbook. It only proposes; a code gate in
graph.py accepts or rejects the proposal on the held-out eval pack. The ship calls are GENERATED (not real records).

Input: the JSONL event logs of the last N episodes and nothing else from the episodes (every model call, tool call
and result, the violation texts and steering hints, the live feed events, and the stop event with the reward, the
gap to the hidden optimum and the port metrics), plus the current playbook (the latest accepted node) and the list of
changes already tried and rejected, plus the lessons of the parent playbook's ancestors (GEPA-style: verdict, reason
and change of each, newest first).

Output (structured): {diagnosis, mistakes: [{what, evidence: [{episode, event_idx}], rule}], playbook_md,
heuristic_code | None, change}. Every mistake needs evidence spans that point at real events, or code drops it. The
playbook is prose rules plus a short ordered checklist, at most 60 lines, and changes by one rule per round.

ScriptedCoach is deterministic and offline: it matches violation texts and the stop-event metrics against a fixed
catalogue of findings, ranks them by an estimated cost impact (rank_findings), and adds the rule of the highest ranked
finding that is neither in the playbook nor rejected before. GeminiCoach asks Gemini 4 Argon for the same structure.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Callable

from .player import MODEL_ID, estimate_cost, make_model
from .playbook import MAX_LINES, clamp_lines
from .tools import read_events

MAX_EVIDENCE = 5

# (key, what, rule, detector(event) -> bool), in priority order
FINDINGS: list[tuple[str, str, str, Callable[[dict], bool]]] = []


def _result_text(ev: dict) -> str:
    return str((ev.get("payload") or {}).get("result", ""))


def _check_result(ev: dict, needle: str) -> bool:
    return ev["type"] == "tool_result" and ev["payload"].get("tool") == "check_plan" and needle in _result_text(ev)


def _stop(ev: dict, test: Callable[[dict], bool]) -> bool:
    return ev["type"] == "stop" and test(ev["payload"])


def _feed_events(ev: dict) -> bool:
    return (ev["type"] == "tool_result" and ev["payload"].get("tool") == "live_ships"
            and '"eta_update"' in _result_text(ev))


FINDINGS += [
    ("no_moves", "berthed a ship inside a no-movement window (fog or bar closure)",
     "Before choosing a berth hour, read the no_moves windows in the rules; never berth inside a no-movement window, "
     "berth at its end.",
     lambda e: _check_result(e, "inside the no-movement window")),
    ("hoot_pool", "put more cranes to work in hoot hours than the smaller hoot pool allows",
     "Keep the cranes working in every hour within that hour's pool; the hoot pool (03:00-08:00) is smaller, so give "
     "fewer cranes in hoot hours or berth after the hoot shift.",
     lambda e: _check_result(e, "cranes over the pool") and "hoot hour" in _result_text(e)),
    ("pool", "put more cranes to work in some hours than the crane pool has",
     "Add up the cranes of every ship alongside in each hour and keep the total within the pool, less any crane "
     "outage; cut cranes on the ship with the most slack first.",
     lambda e: _check_result(e, "cranes over the pool")),
    ("move_limit", "berthed or released more ships in one hour than the movement limit allows",
     "Respect the movement limit (berthings plus departures per hour): when ships arrive together, stagger their "
     "berth hours by one hour.",
     lambda e: _check_result(e, "ships move (limit")),
    ("overlap", "placed two ships, or a ship and a closed block, on the same section-hour",
     "Never overlap another ship, a ship already alongside or a closed block on any section-hour: pick other sections "
     "or a later berth hour.",
     lambda e: _check_result(e, "overlaps")),
    ("shallow", "put a deep-draught ship on shallow sections",
     "Compare each ship's draught with the shallow blocks before choosing its sections; keep deep ships off them.",
     lambda e: _check_result(e, "too shallow")),
    ("arrival", "berthed a ship before it can arrive",
     "Never berth a ship before its arrival hour (use the updated arrival after any delay notice).",
     lambda e: _check_result(e, "cannot arrive before")),
    ("harness", "ran out of steps without submitting, so the harness submitted",
     "Always call submit_plan exactly once, with your best feasible checked plan, before running out of steps.",
     lambda e: _stop(e, lambda p: p.get("reason") == "harness_submit")),
    ("moved", "moved scheduled ships off their planned section (5 per ship moved)",
     "Keep every scheduled ship on its planned section (each ship moved off it costs 5): start from baseline_plan, "
     "move ships back to their planned section one at a time, screen each with ship_timeline, then check.",
     lambda e: _stop(e, lambda p: ((p.get("metrics") or {}).get("moved_ships") or 0) > 0)),
    ("meal", "left late ships idle through the meal hour (17:00-18:00, no crane work)",
     "Cranes stop in the meal hour (17:00-18:00): for a ship due shortly after it, add cranes before 17:00 so it "
     "finishes before the meal hour.",
     lambda e: _stop(e, lambda p: any(s.get("departure") is not None and s["departure"] % 24 == 18
                                      for s in p.get("late_ships") or []))),
    ("late", "left ships departing after their due hour",
     "For each late ship (departure past due), try more cranes up to its maximum or an earlier berth hour, screen "
     "with ship_timeline, then check; lateness costs sections x hours.",
     lambda e: _stop(e, lambda p: bool(p.get("late_ships")))),
    ("feed", "planned without the live feed's ETA updates",
     "Call live_ships at hour 0 and read the eta_update events: never plan a berth before a ship's updated ETA.",
     _feed_events),
]

CHECKLIST = """## Checklist
1. Read the situation (get_situation) and this playbook (read_playbook).
2. Read the live feed (live_ships at hour 0) for ETA updates.
3. Start from baseline_plan and apply every rule above, screening ships with ship_timeline (no check used).
4. check_plan; on a rejection read the violations and the playbook_hint, repair, check again.
5. Submit the cheapest feasible checked plan exactly once (submit_plan).
"""


def load_episode_logs(paths: list[tuple[int, str | Path]]) -> list[dict]:
    """[(episode, events.jsonl path)] -> [{episode, events}], the only episode data the coach reads."""
    return [{"episode": ep, "events": read_events(p)} for ep, p in paths]


def current_rules(playbook: str) -> list[str]:
    """The bullet rules under '## Rules' in a playbook."""
    out, inside = [], False
    for line in playbook.splitlines():
        if line.startswith("## "):
            inside = line.strip().lower() == "## rules"
            continue
        m = re.match(r"\s*[-*]\s+(.*\S)", line)
        if inside and m:
            out.append(m.group(1))
    return out


def render_playbook(version: int, rules: list[str]) -> str:
    head = (f"# Playbook v{version}\n\nRules learned from earlier episodes by the coach. Ship calls are GENERATED. "
            f"Follow every rule before each check.\n\n## Rules\n")
    body = "".join(f"- {r}\n" for r in rules) if rules else "- (none yet)\n"
    return clamp_lines(head + body + "\n" + CHECKLIST, MAX_LINES)


def validate_mistakes(mistakes: list[dict], logs: list[dict]) -> list[dict]:
    """Keep only findings whose evidence spans point at events that exist; drop the rest."""
    sizes = {l["episode"]: len(l["events"]) for l in logs}
    kept = []
    for m in mistakes:
        ev = [e for e in (m.get("evidence") or [])
              if isinstance(e, dict) and e.get("episode") in sizes
              and isinstance(e.get("event_idx"), int) and 0 <= e["event_idx"] < sizes[e["episode"]]]
        if ev and str(m.get("rule") or "").strip() and str(m.get("what") or "").strip():
            k = {"what": str(m["what"]), "evidence": ev, "rule": str(m["rule"]).strip()}
            if isinstance(m.get("impact"), (int, float)):
                k["impact"] = m["impact"]
            kept.append(k)
    return kept


def summarize_logs(logs: list[dict]) -> dict:
    """Rewards, gaps and checks per episode, from the stop events."""
    rows = []
    for l in logs:
        stop = next((e["payload"] for e in reversed(l["events"]) if e["type"] == "stop"), {})
        rows.append({"episode": l["episode"], "task_id": stop.get("task_id"), "reward": stop.get("reward"),
                     "gap_pct": stop.get("gap_pct"), "checks_used": stop.get("checks_used")})
    rewards = [r["reward"] for r in rows if r["reward"] is not None]
    return {"episodes": rows, "mean_reward": round(sum(rewards) / len(rewards), 4) if rewards else None}


VIOLATION_KEYS = ("no_moves", "hoot_pool", "pool", "move_limit", "overlap", "shallow", "arrival")
MOVE_COST = 5            # cost of one scheduled ship moved off its planned section
LOST_EPISODE = 1000      # impact of a lost episode (harness submit, or a violation never repaired)
LOST_REWARD = 0.21


def _rejected_check(ev: dict) -> bool:
    if ev.get("type") != "tool_result" or (ev.get("payload") or {}).get("tool") != "check_plan":
        return False
    res = ev["payload"].get("result")
    if isinstance(res, str):
        try:
            res = json.loads(res)
        except json.JSONDecodeError:
            return False
    return isinstance(res, dict) and res.get("feasible") is False


def _late_hours(stop: dict) -> tuple[float, float]:
    """(late ship-hours, the part from ships departing at hour 18 of a day) from one stop payload."""
    late = stop.get("late_ships") or []
    meal = sum(s.get("late_h") or 0 for s in late if s.get("departure") is not None and s["departure"] % 24 == 18)
    total = (stop.get("metrics") or {}).get("late_ship_hours")
    if total is None:
        total = sum(s.get("late_h") or 0 for s in late)
    return float(total or 0), float(meal)


def rank_findings(findings: list[dict], logs: list[dict]) -> list[dict]:
    """A new list of the findings (each a dict with "key"), each with an added "impact" number, highest first and
    catalogue order on ties. Impact is the estimated cost a finding caused over the window's episodes: moved ships x 5,
    late ship-hours (meal: those of ships departing at 18:00), 1000 per harness submit, and for a violation the
    checks it cost plus 1000 per episode lost with it still in the last rejected check (reward below 0.21
    and an infeasible submission: the player never recovered)."""
    stops = [next((e["payload"] for e in reversed(l["events"]) if e["type"] == "stop"), {}) for l in logs]
    moved = sum(int((s.get("metrics") or {}).get("moved_ships") or 0) for s in stops)
    late = [_late_hours(s) for s in stops]
    detect = {key: d for key, _w, _r, d in FINDINGS}
    impact: dict[str, float] = {
        "moved": MOVE_COST * moved,
        "late": sum(t for t, _m in late),
        "meal": sum(m for _t, m in late),
        "harness": LOST_EPISODE * sum(1 for s in stops if s.get("reason") == "harness_submit"),
        "feed": 0,
    }
    for key in VIOLATION_KEYS:
        total = 0
        for l, stop in zip(logs, stops):
            rejected = [e for e in l["events"] if _rejected_check(e)]
            total += sum(1 for e in rejected if detect[key](e))
            reward = stop.get("reward")
            lost = reward is not None and reward < LOST_REWARD and stop.get("feasible") is not True
            if rejected and lost and detect[key](rejected[-1]):
                total += LOST_EPISODE
        impact[key] = total
    order = {key: i for i, (key, *_rest) in enumerate(FINDINGS)}
    out = [dict(f, impact=round(impact.get(f["key"], 0), 2)) for f in findings]
    out.sort(key=lambda f: (-f["impact"], order.get(f["key"], len(order))))
    return out


def _impact_text(m: dict) -> str:
    if m.get("key") == "moved":
        n = m["impact"] // MOVE_COST
        return f"impact {m['impact']} = {n:g} ships x {MOVE_COST}"
    return f"impact {m.get('impact', 0):g}"


class ScriptedCoach:
    model_id = "scripted"

    def propose(self, logs: list[dict], playbook: str, version: int, rejected: list[str],
                lessons: list[str] | None = None) -> dict:
        """`lessons` (the ancestors' verdicts) is ignored: the catalogue and `rejected` decide."""
        findings = []
        for key, what, rule, detect in FINDINGS:
            ev = [{"episode": l["episode"], "event_idx": e["idx"]} for l in logs for e in l["events"] if detect(e)]
            if ev:
                findings.append({"key": key, "what": what, "evidence": ev[:MAX_EVIDENCE], "rule": rule,
                                 "count": len(ev)})
        ranked = rank_findings(findings, logs)
        keys = {f["rule"]: f["key"] for f in ranked}
        mistakes = validate_mistakes(ranked, logs)
        rules = current_rules(playbook)
        new = next((m for m in mistakes if m["rule"] not in rules and m["rule"] not in rejected), None)
        stats = summarize_logs(logs)
        if new is not None:
            rules = rules + [new["rule"]]
            diagnosis = (f"mean reward {stats['mean_reward']} over episodes "
                         f"{', '.join(str(r['episode']) for r in stats['episodes'])}; main new mistake: "
                         f"{new['what']} ({_impact_text(dict(new, key=keys[new['rule']]))}; "
                         f"{len(new['evidence'])} evidence events). One change: add its rule.")
        else:
            diagnosis = (f"mean reward {stats['mean_reward']}; no finding with a rule that is neither in the playbook "
                         f"nor rejected before, so the playbook is unchanged.")
        return {"diagnosis": diagnosis, "mistakes": mistakes, "playbook_md": render_playbook(version, rules),
                "heuristic_code": None, "change": new["rule"] if new else None,
                "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0, "wall_s": 0.0, "model": self.model_id}


def _brief_events(logs: list[dict], limit: int = 1500) -> str:
    """The logs as compact text for the model, each payload cut to `limit` characters."""
    out = []
    for l in logs:
        out.append(f"### episode {l['episode']}")
        for e in l["events"]:
            text = json.dumps(e["payload"])
            out.append(f"[{e['idx']}] {e['type']}: {text[:limit]}")
    return "\n".join(out)


COACH_PROMPT = """You coach a port planning agent on generated Port of Oakland tasks (the ship calls are GENERATED,
not real records). Read the event logs of its last episodes (event index in brackets), its current playbook, and the
changes already rejected. Make ONE change to the playbook (add, sharpen or remove one rule) that will raise its
reward on unseen tasks. Every mistake needs evidence spans {{episode, event_idx}} pointing at the events that show
it, and a rule written as an imperative sentence the agent can follow. The playbook is markdown: a title line
"# Playbook v{version}", a "## Rules" section of bullet rules and a "## Checklist" of at most 6 numbered steps, at
most 60 lines in all. Optionally give heuristic_code: Python defining heuristic(task, plan) -> plan (task is the
public task dict, plan a list of plan rows), standard library only; leave it null unless it clearly helps.

## Current playbook
{playbook}

## Rejected changes (do not propose these again)
{rejected}

## Lessons from this playbook's ancestors
Newest first, "v<k> (<verdict>, <reason>): <change>"; build on what was accepted, avoid what was rejected.
{lessons}

## Event logs
{events}
"""


class GeminiCoach:
    model_id = MODEL_ID

    def propose(self, logs: list[dict], playbook: str, version: int, rejected: list[str],
                lessons: list[str] | None = None) -> dict:
        from pydantic import BaseModel, Field

        class Evidence(BaseModel):
            episode: int
            event_idx: int

        class Mistake(BaseModel):
            what: str
            evidence: list[Evidence] = Field(default_factory=list)
            rule: str

        class CoachOutput(BaseModel):
            diagnosis: str
            mistakes: list[Mistake]
            playbook_md: str
            heuristic_code: str | None = None

        model = make_model(0.2).with_structured_output(CoachOutput, include_raw=True)
        prompt = COACH_PROMPT.format(version=version, playbook=playbook,
                                     rejected="\n".join(f"- {r}" for r in rejected) or "(none)",
                                     lessons="\n".join(f"- {l}" for l in lessons or []) or "(none)",
                                     events=_brief_events(logs))
        t0 = time.time()
        got = model.invoke(prompt)
        wall = time.time() - t0
        raw, parsed = got.get("raw"), got.get("parsed")
        usage = getattr(raw, "usage_metadata", None) or {}
        tin, tout = int(usage.get("input_tokens", 0)), int(usage.get("output_tokens", 0))
        if parsed is None:
            return {"diagnosis": f"coach output could not be parsed: {got.get('parsing_error')}", "mistakes": [],
                    "playbook_md": playbook, "heuristic_code": None, "change": None, "tokens_in": tin,
                    "tokens_out": tout, "cost_usd": estimate_cost(tin, tout), "wall_s": wall, "model": self.model_id}
        out = parsed.model_dump()
        mistakes = validate_mistakes(out["mistakes"], logs)
        md = out["playbook_md"]
        if not md.lstrip().startswith("#"):
            md = f"# Playbook v{version}\n\n" + md
        return {"diagnosis": out["diagnosis"], "mistakes": mistakes, "playbook_md": clamp_lines(md, MAX_LINES),
                "heuristic_code": out.get("heuristic_code") or None,
                "change": mistakes[0]["rule"] if mistakes else "playbook revision",
                "tokens_in": tin, "tokens_out": tout, "cost_usd": estimate_cost(tin, tout), "wall_s": wall,
                "model": self.model_id}
