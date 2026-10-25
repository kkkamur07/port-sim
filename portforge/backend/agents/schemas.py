from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class AgentStatus(str, Enum):
    THINKING = "thinking"
    EXECUTING = "executing"
    EVALUATING = "evaluating"
    WAITING = "waiting"
    COMPLETED = "completed"


class Strategy(BaseModel):
    version: int = 1
    control_mode: Literal["baseline", "ai"] = "baseline"
    priority_rule: Literal["fcfs", "shortest_processing_time", "aging", "hybrid"] = "fcfs"
    crane_policy: Literal["fixed", "balanced", "adaptive"] = "fixed"
    max_cranes_per_vessel: int = Field(1, ge=1, le=4)
    aging_weight: float = Field(0.0, ge=0, le=3)
    label: str = "FCFS baseline"
    operating_instructions: str = "Serve vessels in first-come, first-served order with one crane per vessel."


class BerthAssignment(BaseModel):
    ship_id: str
    berth_id: str


class CraneAssignment(BaseModel):
    ship_id: str
    crane_ids: list[str]


class OperatorDecision(BaseModel):
    berth_assignments: list[BerthAssignment] = []
    crane_assignments: list[CraneAssignment] = []
    reasoning_summary: str


class Scenario(BaseModel):
    name: str
    description: str
    seed: int
    horizon_minutes: int = Field(720, ge=120, le=2880)
    arrival_count: int = Field(8, ge=3, le=30)
    arrival_spread: int = Field(240, ge=0, le=1000)
    cargo_min: int = Field(90, ge=20, le=1000)
    cargo_max: int = Field(320, ge=20, le=2000)
    disabled_cranes: list[str] = []
    crane_recovery_minute: int | None = Field(default=None, ge=1, le=2880)
    closed_berths: list[str] = []


class CandidateIdea(BaseModel):
    suggestion: str = Field(description="Complete operating instructions for the Operator under this idea.")
    rationale: str = Field("", description="Which measured weakness or scenario result this idea targets, and why.")


class SupervisorPlan(BaseModel):
    """What the Supervisor model returns: one diagnosis and several distinct ideas to test."""
    weakness: str
    candidates: list[CandidateIdea] = Field(min_length=1, max_length=3)


class CandidateProposal(BaseModel):
    suggestion: str
    rationale: str = ""
    proposed_strategy: Strategy


class EvaluatorProposal(BaseModel):
    scenario: Scenario
    weakness: str
    suggestion: str
    proposed_strategy: Strategy
    candidates: list[CandidateProposal] = []


class Metrics(BaseModel):
    average_turnaround_time: float
    average_waiting_time: float
    crane_utilization: float
    completed_vessels: int
    total_vessels: int
    horizon_minutes: int
    improvement_percentage: float = 0.0


class EpochRecord(BaseModel):
    epoch: int
    scenario: Scenario
    operator_strategy: Strategy
    evaluator_feedback: str
    proposed_modification: str
    previous_metrics: Metrics
    candidate_metrics: Metrics
    baseline_metrics: Metrics
    accepted: bool
    strategy_after: Strategy
    timestamp: str
    # Every idea tested this epoch with per-scenario benchmark results; empty for single-candidate epochs.
    candidates: list[dict] = []


class Event(BaseModel):
    type: str
    timestamp: str
    payload: dict
