from __future__ import annotations

import random
from dataclasses import asdict
from typing import Callable

from portforge.backend.agents.schemas import (
    BerthAssignment,
    CraneAssignment,
    OperatorDecision,
    Scenario,
    Strategy,
)
from portforge.backend.improvement.metrics import calculate_metrics
from portforge.backend.simulation.berth_scheduler import compatible, rank_waiting
from portforge.backend.simulation.crane_scheduler import assignable_cranes, target_count
from portforge.backend.simulation.state import Berth, Crane, PortState, Vessel


DecisionHook = Callable[[dict], None]

SEED_VESSELS = [
    ("seastar-07", "panamax"), ("merlion-star", "feeder"),
    ("orient-lotus", "panamax"), ("jade-river", "panamax"),
    ("pacific-harmony", "neo-panamax"), ("coral-bay", "panamax"),
    ("nordic-spirit", "panamax"), ("blue-marlin", "feeder"),
    ("jakarta-express", "feeder"), ("asian-dawn", "panamax"),
]


class PortEngine:
    """Minute-step port simulator. All state mutations and constraints live here."""

    def __init__(self, scenario: Scenario, strategy: Strategy, event_hook: DecisionHook | None = None):
        self.scenario = scenario
        self.strategy = strategy
        self.event_hook = event_hook
        self.state = self._build_state()
        self.crane_busy_minutes = 0
        self.crane_available_minutes = 0
        self.decisions: list[dict] = []

    def _build_state(self) -> PortState:
        rng = random.Random(self.scenario.seed)
        arrivals = sorted(rng.randint(0, self.scenario.arrival_spread) for _ in range(self.scenario.arrival_count))
        vessels = []
        for i, arrival in enumerate(arrivals, 1):
            cargo = rng.randint(self.scenario.cargo_min, self.scenario.cargo_max)
            vessel_id, size = SEED_VESSELS[(i - 1) % len(SEED_VESSELS)]
            vessels.append(Vessel(vessel_id, arrival, cargo, float(cargo), size))
        berths = [Berth(f"B{i}", "neo-panamax" if i in (2, 4, 6, 8) else "panamax") for i in range(1, 9)]
        for b in berths:
            b.closed = b.id in self.scenario.closed_berths
        cranes = []
        # Match the imported Portwise geometry. Edge cranes can reach the
        # neighboring berth; the engine remains authoritative on reachability.
        positions = [1, 2, 2, 2, 3, 4, 5, 5, 6, 6, 7, 7, 8, 8]
        for i, berth_no in enumerate(positions, 1):
            reach = [f"B{berth_no}"]
            if i in (1, 5, 6, 8, 10, 12):
                neighbor = berth_no + (1 if berth_no < 8 else -1)
                reach.append(f"B{neighbor}")
            cranes.append(Crane(f"STS-{i:02d}", reach))
        for c in cranes:
            c.disabled = c.id in self.scenario.disabled_cranes
        return PortState(0, self.scenario.horizon_minutes, vessels, berths, cranes)

    def _emit(self, event_type: str, payload: dict) -> None:
        event = {"type": event_type, "simulation_time": self.state.simulation_time, "payload": payload}
        self.state.events.append(event)
        if self.event_hook:
            self.event_hook(event)

    def _operator_decision(self) -> OperatorDecision:
        now = self.state.simulation_time
        waiting = [v for v in self.state.vessels if v.status == "waiting"]
        free_berths = [b for b in self.state.berths if not b.closed and b.vessel_id is None]
        berth_assignments: list[BerthAssignment] = []
        crane_assignments: list[CraneAssignment] = []

        for vessel in rank_waiting(waiting, now, self.strategy):
            berth = next((b for b in free_berths if compatible(vessel, b)), None)
            if berth is None:
                continue
            berth_assignments.append(BerthAssignment(ship_id=vessel.id, berth_id=berth.id))
            free_berths.remove(berth)

        # Include docked vessels that currently have no crane so resources are rebalanced.
        projected = {a.ship_id: a.berth_id for a in berth_assignments}
        active = [v for v in self.state.vessels if v.status == "unloading"] + [
            v for v in waiting if v.id in projected
        ]
        available = [c for c in self.state.cranes if not c.disabled and c.vessel_id is None]
        for vessel in sorted(active, key=lambda v: (-v.cargo_remaining, v.id)):
            berth_id = vessel.berth_id or projected.get(vessel.id)
            original = vessel.berth_id
            vessel.berth_id = berth_id
            candidates = assignable_cranes(vessel, available)
            wanted = max(0, target_count(vessel, len(waiting), self.strategy) - len(vessel.assigned_cranes))
            picked = candidates[:wanted]
            vessel.berth_id = original
            if picked:
                crane_assignments.append(CraneAssignment(ship_id=vessel.id, crane_ids=[c.id for c in picked]))
                for c in picked:
                    available.remove(c)

        reason = {
            "fcfs": "Serving vessels by arrival order to preserve FCFS fairness.",
            "shortest_processing_time": "Prioritizing lower cargo workloads to release berths sooner.",
            "aging": "Prioritizing vessels that have accumulated the most waiting time.",
            "hybrid": "Balancing cargo workload against accumulated waiting time.",
        }[self.strategy.priority_rule]
        return OperatorDecision(
            berth_assignments=berth_assignments,
            crane_assignments=crane_assignments,
            reasoning_summary=reason,
        )

    def apply_decision(self, decision: OperatorDecision) -> None:
        """Validate every action against current state before mutating it."""
        berth_ids: set[str] = set()
        crane_ids: set[str] = set()
        vessel_by_id = {v.id: v for v in self.state.vessels}
        berth_by_id = {b.id: b for b in self.state.berths}
        crane_by_id = {c.id: c for c in self.state.cranes}

        for assignment in decision.berth_assignments:
            vessel = vessel_by_id.get(assignment.ship_id)
            berth = berth_by_id.get(assignment.berth_id)
            if not vessel:
                self._emit("decision_rejected", {"action": "berth_assignment", "ship_id": assignment.ship_id, "berth_id": assignment.berth_id, "reason": "unknown vessel"})
                continue
            if vessel.status != "waiting":
                self._emit("decision_rejected", {"action": "berth_assignment", "ship_id": vessel.id, "berth_id": assignment.berth_id, "reason": f"vessel status is {vessel.status}, not waiting"})
                continue
            if not berth:
                self._emit("decision_rejected", {"action": "berth_assignment", "ship_id": vessel.id, "berth_id": assignment.berth_id, "reason": "unknown berth"})
                continue
            if berth.vessel_id or berth.id in berth_ids:
                self._emit("decision_rejected", {"action": "berth_assignment", "ship_id": vessel.id, "berth_id": berth.id, "reason": "berth already occupied or reserved"})
                continue
            if not compatible(vessel, berth):
                self._emit("decision_rejected", {"action": "berth_assignment", "ship_id": vessel.id, "berth_id": berth.id, "reason": "berth closed or vessel incompatible"})
                continue
            vessel.status = "unloading"
            vessel.berth_id = berth.id
            vessel.berth_time = self.state.simulation_time
            berth.vessel_id = vessel.id
            berth_ids.add(berth.id)
            self._emit("berth_assignment", {"ship_id": vessel.id, "berth_id": berth.id})

        for assignment in decision.crane_assignments:
            vessel = vessel_by_id.get(assignment.ship_id)
            if not vessel or vessel.status != "unloading" or not vessel.berth_id:
                self._emit("decision_rejected", {"action": "crane_assignment", "ship_id": assignment.ship_id, "crane_ids": assignment.crane_ids, "reason": "vessel is not actively berthed"})
                continue
            for crane_id in assignment.crane_ids:
                crane = crane_by_id.get(crane_id)
                if not crane:
                    self._emit("decision_rejected", {"action": "crane_assignment", "ship_id": vessel.id, "crane_id": crane_id, "reason": "unknown crane"})
                    continue
                if crane.disabled:
                    self._emit("decision_rejected", {"action": "crane_assignment", "ship_id": vessel.id, "crane_id": crane.id, "reason": "crane disabled"})
                    continue
                if crane.vessel_id == vessel.id and crane.id not in crane_ids:
                    continue  # restating a crane that already works this ship changes nothing
                if crane.vessel_id or crane.id in crane_ids:
                    self._emit("decision_rejected", {"action": "crane_assignment", "ship_id": vessel.id, "crane_id": crane.id, "reason": "crane already assigned"})
                    continue
                if vessel.berth_id not in crane.reachable_berths:
                    self._emit("decision_rejected", {"action": "crane_assignment", "ship_id": vessel.id, "crane_id": crane.id, "reason": "crane cannot reach vessel berth"})
                    continue
                crane.vessel_id = vessel.id
                vessel.assigned_cranes.append(crane.id)
                crane_ids.add(crane.id)
            if vessel.assigned_cranes:
                self._emit("crane_assignment", {"ship_id": vessel.id, "crane_ids": list(vessel.assigned_cranes)})

        self.decisions.append(decision.model_dump())

    def step(self, auto_decide: bool = True) -> None:
        now = self.state.simulation_time
        if now == 0:
            for crane in [item for item in self.state.cranes if item.disabled]:
                self._emit("crane_failed", {"crane_id": crane.id})
        if self.scenario.crane_recovery_minute == now:
            for crane in [item for item in self.state.cranes if item.id in self.scenario.disabled_cranes and item.disabled]:
                crane.disabled = False
                self._emit("crane_recovered", {"crane_id": crane.id})
        for vessel in self.state.vessels:
            if vessel.status == "scheduled" and vessel.arrival_time <= now:
                vessel.status = "waiting"
                self._emit("vessel_arrived", {"ship_id": vessel.id})

        if auto_decide and (any(v.status == "waiting" for v in self.state.vessels) or any(
            v.status == "unloading" and not v.assigned_cranes for v in self.state.vessels
        )):
            decision = self._operator_decision()
            if decision.berth_assignments or decision.crane_assignments:
                self.apply_decision(decision)

        active_cranes = [c for c in self.state.cranes if not c.disabled and c.vessel_id]
        self.crane_busy_minutes += len(active_cranes)
        self.crane_available_minutes += len([c for c in self.state.cranes if not c.disabled])
        for vessel in [v for v in self.state.vessels if v.status == "unloading"]:
            n = len(vessel.assigned_cranes)
            if n:
                # Diminishing returns: the fourth crane contributes less than the first.
                rate = n ** 0.82
                vessel.cargo_remaining = max(0.0, vessel.cargo_remaining - rate)
            if vessel.cargo_remaining <= 0:
                vessel.status = "completed"
                vessel.departure_time = now + 1
                berth = next(b for b in self.state.berths if b.id == vessel.berth_id)
                berth.vessel_id = None
                for cid in list(vessel.assigned_cranes):
                    next(c for c in self.state.cranes if c.id == cid).vessel_id = None
                self._emit("vessel_completed", {"ship_id": vessel.id, "berth_id": vessel.berth_id})
                vessel.assigned_cranes.clear()

        self.state.simulation_time += 1

    def run(self) -> dict:
        while self.state.simulation_time < self.state.horizon_minutes:
            self.step()
            if all(v.status == "completed" for v in self.state.vessels):
                break
        metrics = calculate_metrics(self.state, self.crane_busy_minutes, self.crane_available_minutes)
        return {"metrics": metrics, "state": self.state, "decisions": self.decisions}

    def snapshot(self) -> dict:
        return self.state.public()
