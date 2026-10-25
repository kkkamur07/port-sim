from __future__ import annotations

from portforge.backend.agents.schemas import Metrics
from portforge.backend.simulation.state import PortState


def calculate_metrics(state: PortState, crane_busy_minutes: int, crane_available_minutes: int) -> Metrics:
    completed = [v for v in state.vessels if v.departure_time is not None]
    turnarounds = [v.departure_time - v.arrival_time for v in completed]
    waiting = [(v.berth_time or v.arrival_time) - v.arrival_time for v in completed]
    return Metrics(
        average_turnaround_time=round(sum(turnarounds) / len(turnarounds), 1) if turnarounds else float(state.horizon_minutes),
        average_waiting_time=round(sum(waiting) / len(waiting), 1) if waiting else float(state.horizon_minutes),
        crane_utilization=round((crane_busy_minutes / crane_available_minutes * 100), 1) if crane_available_minutes else 0,
        completed_vessels=len(completed),
        total_vessels=len(state.vessels),
        horizon_minutes=state.horizon_minutes,
    )


def improvement(baseline: Metrics, other: Metrics) -> float:
    if baseline.average_turnaround_time <= 0:
        return 0.0
    return round((baseline.average_turnaround_time - other.average_turnaround_time) / baseline.average_turnaround_time * 100, 1)
