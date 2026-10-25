from __future__ import annotations

import json

from portforge.backend.agents.argon_client import ArgonClient
from portforge.backend.agents.prompts import OPERATOR_SYSTEM
from portforge.backend.agents.schemas import OperatorDecision, Strategy
from portforge.backend.simulation.berth_scheduler import SIZE_RANK


def available_resources(state: dict) -> dict:
    """Precomputed from the same snapshot so the Operator only picks among actions the simulator will accept."""
    vessels, berths, cranes = state.get("vessels", []), state.get("berths", []), state.get("cranes", [])
    free_berths = [b for b in berths if not b.get("closed") and not b.get("vessel_id")]
    idle_cranes = [c for c in cranes if not c.get("disabled") and not c.get("vessel_id")]
    waiting = [v for v in vessels if v.get("status") == "waiting"]
    berthed = [v for v in vessels if v.get("status") == "unloading" and v.get("berth_id")]
    return {
        "waiting_vessels": [{
            "ship_id": v["id"], "size": v["size"],
            "compatible_free_berths": [b["id"] for b in free_berths if SIZE_RANK.get(v["size"], 0) <= SIZE_RANK.get(b["max_size"], 0)],
        } for v in waiting],
        "berthed_vessels": [{
            "ship_id": v["id"], "berth_id": v["berth_id"], "cargo_remaining": v.get("cargo_remaining"),
            "cranes_already_working": v.get("assigned_cranes", []),
            "idle_cranes_that_can_reach": [c["id"] for c in idle_cranes if v["berth_id"] in c.get("reachable_berths", [])],
        } for v in berthed],
        "idle_crane_ids": [c["id"] for c in idle_cranes],
    }


class OperatorAgent:
    """Agent 2: executes berth and crane work under the Supervisor's strategy."""
    def __init__(self, client: ArgonClient):
        self.client = client
        self.decisions_executed = 0

    async def decide(self, state: dict, strategy: Strategy, fallback: OperatorDecision | None = None, triggers: list[str] | None = None):
        prompt = json.dumps({
            "decision_triggers": triggers or ["initial decision"],
            "available_actions": available_resources(state),
            "port_state": state,
            "learned_operating_strategy": {
                "version": strategy.version,
                "label": strategy.label,
                "operating_instructions": strategy.operating_instructions,
            },
        })
        result = await self.client.structured(OPERATOR_SYSTEM, prompt, OperatorDecision)
        if result.value:
            self.decisions_executed += 1
        elif fallback is not None:
            result.value = fallback
        return result
