from __future__ import annotations

from typing import Awaitable, Callable, TypedDict

from langgraph.graph import END, START, StateGraph

from portforge.backend.agents.argon_client import ArgonClient, ArgonResult
from portforge.backend.agents.evaluator_agent import EvaluatorAgent
from portforge.backend.agents.operator_agent import OperatorAgent
from portforge.backend.agents.schemas import Metrics, OperatorDecision, Strategy
from portforge.backend.simulation.port_engine import PortEngine


StatusHook = Callable[[str, str], Awaitable[None]]


class EpochAgentState(TypedDict, total=False):
    epoch: int
    strategy: Strategy
    metrics: Metrics
    history: list[dict]
    best_by_scenario: list[dict]
    proposal_result: ArgonResult
    operator_result: ArgonResult
    operator_decision: OperatorDecision
    preview_state: dict


class AgentCoordinator:
    """A two-node LangGraph: Supervisor observes first, Operator executes second."""

    def __init__(self, client: ArgonClient, status_hook: StatusHook):
        self.client = client
        self.supervisor = EvaluatorAgent(client)
        self.operator = OperatorAgent(client)
        self.status_hook = status_hook
        graph = StateGraph(EpochAgentState)
        graph.add_node("supervisor", self._supervisor_node)
        graph.add_node("operator", self._operator_node)
        graph.add_edge(START, "supervisor")
        graph.add_edge("supervisor", "operator")
        graph.add_edge("operator", END)
        self.graph = graph.compile()

    async def _supervisor_node(self, state: EpochAgentState) -> dict:
        await self.status_hook("evaluator", "thinking" if self.client.mode == "argon" else "evaluating")
        result = await self.supervisor.propose(state["epoch"], state["strategy"], state["metrics"], state["history"], best_by_scenario=state.get("best_by_scenario"))
        await self.status_hook("evaluator", "completed")
        return {"proposal_result": result}

    async def _operator_node(self, state: EpochAgentState) -> dict:
        proposal = state["proposal_result"].value
        engine = PortEngine(proposal.scenario, state["strategy"])
        # Advance to the first real decision boundary without making a decision.
        first_arrival = min(v.arrival_time for v in engine.state.vessels)
        engine.state.simulation_time = first_arrival
        for vessel in engine.state.vessels:
            if vessel.arrival_time <= first_arrival:
                vessel.status = "waiting"
        await self.status_hook("operator", "thinking" if self.client.mode == "argon" else "executing")
        result = await self.operator.decide(engine.snapshot(), state["strategy"])
        if result.value is None:
            result.value = OperatorDecision(reasoning_summary=f"AI decision unavailable: {result.error}")
        engine.apply_decision(result.value)
        await self.status_hook("operator", "executing")
        return {
            "operator_result": result,
            "operator_decision": result.value,
            "preview_state": engine.snapshot(),
        }

    async def run(self, epoch: int, strategy: Strategy, metrics: Metrics, history: list[dict], best_by_scenario: list[dict] | None = None) -> EpochAgentState:
        return await self.graph.ainvoke({"epoch": epoch, "strategy": strategy, "metrics": metrics, "history": history, "best_by_scenario": best_by_scenario or []})
