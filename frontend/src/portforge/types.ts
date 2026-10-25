export type AgentStatus = "thinking" | "executing" | "evaluating" | "waiting" | "completed";

export interface Strategy {
  version: number;
  control_mode: "baseline" | "ai";
  priority_rule: string;
  crane_policy: string;
  max_cranes_per_vessel: number;
  aging_weight: number;
  label: string;
  operating_instructions: string;
}

export interface Metrics {
  average_turnaround_time: number;
  average_waiting_time: number;
  crane_utilization: number;
  completed_vessels: number;
  total_vessels: number;
  horizon_minutes: number;
  improvement_percentage: number;
}

export interface LiveVessel {
  id: string;
  arrival_time: number;
  cargo_total: number;
  cargo_remaining: number;
  size: string;
  status: string;
  berth_id?: string;
  assigned_cranes: string[];
  berth_time?: number;
  departure_time?: number;
}

export interface LiveBerth { id: string; max_size: string; vessel_id?: string; closed: boolean }
export interface LiveCrane { id: string; reachable_berths: string[]; vessel_id?: string; disabled: boolean; capacity_per_minute: number }
export interface PortSnapshot { simulation_time: number; horizon_minutes: number; vessels: LiveVessel[]; berths: LiveBerth[]; cranes: LiveCrane[] }

export interface ReplayTrace {
  epoch: number;
  accepted: boolean;
  scenario: { name: string; description: string; seed: number };
  strategy: Strategy;
  baseline_frames: PortSnapshot[];
  candidate_frames: PortSnapshot[];
  operator_frames: PortSnapshot[];
  decisions: Array<{ simulation_time: number; triggers: string[]; decision: unknown }>;
}

export interface EpochRecord {
  epoch: number;
  scenario: { name: string; description: string; seed: number };
  evaluator_feedback: string;
  proposed_modification: string;
  previous_metrics: Metrics;
  candidate_metrics: Metrics;
  baseline_metrics: Metrics;
  accepted: boolean;
  operator_strategy: Strategy;
  strategy_after: Strategy;
  timestamp?: string;
  candidates?: CandidateResult[];
}

export interface CandidateResult {
  index: number;
  suggestion: string;
  rationale: string;
  metrics: Metrics;
  per_scenario: Array<{ scenario: string; average_turnaround_time: number; average_waiting_time: number; completed_vessels: number; total_vessels: number }>;
  selected: boolean;
}

export interface PortForgeState {
  status: string;
  epoch: number;
  stage: number;
  stage_name: string;
  progress: number;
  agent_mode: "argon" | "mock";
  model: string;
  ai_calls: { started: number; completed: number };
  current_operation: string;
  benchmark_progress: { completed: number; total: number };
  starter_data: {
    baseline_strategy: Strategy;
    benchmark_scenarios: Array<{ name: string; description: string; seed: number; horizon_minutes: number; arrival_count: number; arrival_spread: number; cargo_min: number; cargo_max: number; disabled_cranes: string[]; crane_recovery_minute?: number; closed_berths: string[] }>;
    evaluation_contract: { identical_seeds: boolean; identical_horizons: boolean; acceptance_metric: string; completion_must_not_regress: boolean };
  };
  operator: { status: AgentStatus; strategy: Strategy; latest_decision?: { berth_assignments: Array<{ship_id:string;berth_id:string}>; crane_assignments: Array<{ship_id:string;crane_ids:string[]}>; reasoning_summary: string } };
  evaluator: { status: AgentStatus; scenario?: { name: string; description: string; seed: number }; feedback: string; proposal: string };
  baseline_metrics?: Metrics;
  current_metrics?: Metrics;
  best_metrics?: Metrics;
  history: EpochRecord[];
  replays: Array<{ epoch: number; accepted: boolean; frames: number; operator_decisions?: number; rejected_actions?: number }>;
  port?: PortSnapshot;
}

export interface PortForgeEvent { type: string; timestamp?: string; payload: Record<string, unknown> }
