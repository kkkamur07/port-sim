import type { EpochRecord, PortForgeEvent, PortForgeState, Strategy } from "./types";

/** Plain-English explanations built only from measured backend records. Nothing here invents a number. */

export const pct = (from: number, to: number) => (from > 0 ? ((from - to) / from) * 100 : 0);
export const fmt = (value: number, digits = 1) => value.toFixed(digits);

export interface EpochStory {
  record: EpochRecord;
  before: Strategy;
  headline: string;
  noticed: string;
  changed: string;
  result: string;
  verdict: string;
  overall: string;
  mistakes: { now?: number; previous?: number; sentence?: string };
  gainVsBest: number;
  gainVsBaseline: number;
}

export function strategyBefore(state: PortForgeState, index: number): Strategy {
  return index > 0 ? state.history[index - 1].strategy_after : state.starter_data.baseline_strategy;
}

export function buildStory(state: PortForgeState, index: number): EpochStory {
  const record = state.history[index];
  const before = strategyBefore(state, index);
  const prev = record.previous_metrics, cand = record.candidate_metrics, base = record.baseline_metrics;
  const gainVsBest = pct(prev.average_turnaround_time, cand.average_turnaround_time);
  const bestAfter = record.accepted ? cand : prev;
  const gainVsBaseline = pct(base.average_turnaround_time, bestAfter.average_turnaround_time);
  const fewerShips = cand.completed_vessels < prev.completed_vessels;

  const tried = record.candidates?.length ?? 0;
  const lead = tried > 1 ? `Tested ${tried} ideas. The best ` : "The new idea ";
  const headline = record.accepted
    ? `${lead}made ships ${fmt(gainVsBest)}% faster, so it was kept.`
    : gainVsBest > 0
      ? `${lead}was only ${fmt(gainVsBest)}% faster, too small to count, so it was thrown out.`
      : `${lead}was ${fmt(Math.abs(gainVsBest))}% slower than the current best, so it was thrown out.`;

  const result = `On the same 3 fixed test scenarios, an average ship took ${fmt(cand.average_turnaround_time)} min to get in and out, `
    + (Math.abs(prev.average_turnaround_time - base.average_turnaround_time) < 0.05
      ? `compared with ${fmt(prev.average_turnaround_time)} min for first-come-first-served, the plan it was competing against. `
      : `compared with ${fmt(prev.average_turnaround_time)} min for the plan it was competing against and ${fmt(base.average_turnaround_time)} min for first-come-first-served. `)
    + `Ships waited ${fmt(cand.average_waiting_time)} min on average (was ${fmt(prev.average_waiting_time)}), cranes were busy ${fmt(cand.crane_utilization)}% of the time (was ${fmt(prev.crane_utilization)}%), `
    + `and ${cand.completed_vessels}/${cand.total_vessels} ships finished${fewerShips ? `, fewer than the ${prev.completed_vessels} before` : ""}.`;

  const verdict = record.accepted
    ? `Accepted. Plan v${record.strategy_after.version} is now the one the Operator follows.`
    : fewerShips
      ? `Rejected. It finished fewer ships, and the rules never allow that. The Operator keeps plan v${record.strategy_after.version}.`
      : `Rejected. A change has to cut turnaround by more than 0.05 min to be kept. The Operator keeps plan v${record.strategy_after.version}.`;

  const overall = gainVsBaseline > 0.05
    ? `After this round, the port turns ships around ${fmt(gainVsBaseline)}% faster than first-come-first-served.`
    : `After this round, there's still no measured gain over first-come-first-served.`;

  const summary = state.replays.find((item) => item.epoch === record.epoch);
  const previous = state.replays.find((item) => item.epoch === record.epoch - 1);
  const now = summary?.rejected_actions, before_ = previous?.rejected_actions;
  const mistakes = {
    now,
    previous: before_,
    sentence: now == null ? undefined
      : before_ == null ? `The simulator blocked ${now} invalid Operator moves in the live run. These are passed to the Supervisor next round.`
      : now < before_ ? `The simulator blocked ${now} invalid Operator moves, down from ${before_} last round. It's learning from the mistakes reported back to it.`
      : now > before_ ? `The simulator blocked ${now} invalid Operator moves, up from ${before_} last round.`
      : `The simulator blocked ${now} invalid Operator moves, the same as last round.`,
  };

  return {
    record, before, headline,
    noticed: record.evaluator_feedback,
    changed: record.proposed_modification,
    result, verdict, overall, mistakes, gainVsBest, gainVsBaseline,
  };
}

export type Speaker = "supervisor" | "operator" | "simulator" | "judge" | "system";
export interface FeedLine { speaker: Speaker; text: string; tone?: "good" | "bad" | "neutral" }

const str = (value: unknown) => (value == null ? "" : String(value));

/** Turns backend events into a human-readable agent conversation. Returns null for events that aren't worth showing. */
export function describeEvent(event: PortForgeEvent): FeedLine | null {
  const p = event.payload ?? {};
  switch (event.type) {
    case "epoch_started": return { speaker: "system", text: `Epoch ${str(p.epoch)} started.` };
    case "evaluator_challenge": return { speaker: "supervisor", text: `I'm testing the port on "${str((p.scenario as { name?: string })?.name)}".` };
    case "evaluator_feedback": return { speaker: "supervisor", text: `Weakness I found: ${str(p.weakness)}` };
    case "strategy_proposed": {
      const count = Number((p as { candidate_count?: number }).candidate_count ?? 1);
      return { speaker: "supervisor", text: count > 1 ? `I have ${count} ideas. Test them all and we'll keep the best.` : `Operator, try these new instructions (v${str((p as { version?: number }).version)}).` };
    }
    case "candidates_tested": {
      const list = (p.candidates as Array<{ index: number; metrics: { average_turnaround_time: number }; selected: boolean }>) ?? [];
      return { speaker: "simulator", text: `Ideas scored ${list.map((c) => `${String.fromCharCode(65 + c.index)}: ${c.metrics.average_turnaround_time.toFixed(1)} min`).join(" · ")}. Best: ${String.fromCharCode(65 + (list.find((c) => c.selected)?.index ?? 0))}.` };
    }
    case "operator_decision": {
      const decision = p.decision as { reasoning_summary?: string } | undefined;
      return { speaker: "operator", text: decision?.reasoning_summary || "Made a berth and crane decision." };
    }
    case "decision_rejected": return { speaker: "simulator", text: `Blocked ${str(p.ship_id)}: ${str(p.reason)}.`, tone: "bad" };
    case "benchmark_progress": {
      const total = Number(p.total), ideas = Math.max(1, Math.round(total / 3));
      return { speaker: "simulator", text: `Test runs finished: ${str(p.completed)} of ${str(p.total)}${ideas > 1 ? ` (${ideas} ideas × 3 fixed scenarios)` : ""}.` };
    }
    case "strategy_accepted": return { speaker: "judge", text: `New plan beat the best. Accepted.`, tone: "good" };
    case "strategy_rejected": return { speaker: "judge", text: `New plan didn't beat the best. Rejected; keeping the old plan.`, tone: "bad" };
    case "agent_error": return { speaker: "system", text: `${str(p.agent)} call failed (${str(p.message).slice(0, 90)}). Used ${str(p.fallback) || "fallback"}.`, tone: "bad" };
    case "optimization_completed": return { speaker: "system", text: `Run finished after ${str(p.epochs)} epochs.` };
    default: return null;
  }
}
