from __future__ import annotations

from portforge.backend.agents.schemas import Strategy
from portforge.backend.simulation.state import Crane, Vessel


def assignable_cranes(vessel: Vessel, cranes: list[Crane]) -> list[Crane]:
    return [c for c in cranes if not c.disabled and c.vessel_id is None and vessel.berth_id in c.reachable_berths]


def target_count(vessel: Vessel, queue_size: int, strategy: Strategy) -> int:
    if strategy.crane_policy == "fixed":
        return 1
    if strategy.crane_policy == "balanced":
        return min(strategy.max_cranes_per_vessel, 2 if queue_size > 1 else 3)
    wanted = 3 if vessel.cargo_remaining >= 220 else 2
    return min(strategy.max_cranes_per_vessel, wanted)
