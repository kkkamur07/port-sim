from __future__ import annotations

from portforge.backend.agents.schemas import Strategy
from portforge.backend.simulation.state import Berth, Vessel


SIZE_RANK = {"feeder": 1, "panamax": 2, "neo-panamax": 3}


def compatible(vessel: Vessel, berth: Berth) -> bool:
    return not berth.closed and SIZE_RANK[vessel.size] <= SIZE_RANK[berth.max_size]


def rank_waiting(vessels: list[Vessel], now: int, strategy: Strategy) -> list[Vessel]:
    def score(v: Vessel):
        waiting = max(0, now - v.arrival_time)
        if strategy.priority_rule == "shortest_processing_time":
            return (v.cargo_remaining, v.arrival_time)
        if strategy.priority_rule == "aging":
            return (-(waiting * max(strategy.aging_weight, 1)), v.arrival_time)
        if strategy.priority_rule == "hybrid":
            return (v.cargo_remaining - waiting * max(strategy.aging_weight, 0.55), v.arrival_time)
        return (v.arrival_time, v.id)
    return sorted(vessels, key=score)
