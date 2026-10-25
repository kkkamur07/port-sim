from __future__ import annotations

import json

from portforge.backend.agents.argon_client import ArgonClient
from portforge.backend.agents.prompts import EVALUATOR_SYSTEM
from portforge.backend.agents.schemas import CandidateProposal, EvaluatorProposal, Metrics, Strategy, SupervisorPlan
from portforge.backend.simulation.scenarios import scenario_for_epoch


class EvaluatorAgent:
    """Agent 1: supervises operations and improves Agent 2 from measured statistics."""
    def __init__(self, client: ArgonClient):
        self.client = client

    async def propose(self, epoch: int, current: Strategy, metrics: Metrics, history: list[dict], candidates: int = 3, best_by_scenario: list[dict] | None = None):
        scenario = scenario_for_epoch(epoch)
        prompt = json.dumps({
            "epoch": epoch,
            "current_strategy": current.model_dump(),
            "measured_metrics": metrics.model_dump(),
            "best_plan_by_benchmark_scenario": best_by_scenario or [],
            "recent_history": history[-3:],
            "required_scenario": scenario.model_dump(),
            "instruction": (
                f"Propose exactly {candidates} materially different improvements to the Operator's natural-language "
                "operating_instructions. Each suggestion must be complete instructions, not a diff. Use the per-scenario "
                "results of previously tested candidates in recent_history to avoid repeating ideas that lost and to target "
                "the scenarios where the best plan is weakest. Do not design a rule-based scheduler."
            ),
        })
        result = await self.client.structured(EVALUATOR_SYSTEM, prompt, SupervisorPlan)
        if result.value:
            ideas = []
            for idea in result.value.candidates:
                if idea.suggestion.strip() and all(idea.suggestion.strip() != seen.suggestion.strip() for seen in ideas):
                    ideas.append(idea)
            result.value = EvaluatorProposal(
                scenario=scenario,  # benchmark integrity: the server owns seed and scenario
                weakness=result.value.weakness,
                suggestion=ideas[0].suggestion,
                proposed_strategy=self._ai_strategy(current, ideas[0].suggestion),
                candidates=[CandidateProposal(suggestion=idea.suggestion, rationale=idea.rationale, proposed_strategy=self._ai_strategy(current, idea.suggestion)) for idea in ideas[:candidates]],
            )
            return result
        result.value = self._mock_proposal(epoch, current, metrics, scenario, candidates)
        return result

    @staticmethod
    def _ai_strategy(current: Strategy, instructions: str) -> Strategy:
        # Legacy rule fields stay neutral; only the instructions differ between candidates.
        return Strategy(
            version=current.version + 1,
            control_mode="ai",
            label=f"AI learned policy v{current.version + 1}",
            operating_instructions=instructions,
        )

    def _mock_proposal(self, epoch: int, current: Strategy, metrics: Metrics, scenario, candidates: int = 1) -> EvaluatorProposal:
        variants = [
            ("shortest_processing_time", "balanced", 2, 0.0, "Long vessels are monopolizing berth time.", "Prioritize shorter workloads and share cranes."),
            ("hybrid", "adaptive", 3, 0.55, "Queue aging appears during arrival peaks.", "Balance cargo size with waiting time and adapt crane counts."),
            ("aging", "balanced", 2, 1.0, "Older vessels remain exposed to starvation.", "Test a stronger aging rule under disruption."),
            ("hybrid", "adaptive", 4, 0.8, "Heavy vessels need bursts of extra crane capacity.", "Allow a fourth crane when reachability permits."),
        ]
        picks = [variants[(epoch - 1 + k) % len(variants)] for k in range(max(1, candidates))]
        built = []
        for priority, crane, max_cranes, aging, _weakness, suggestion in picks:
            built.append(CandidateProposal(suggestion=suggestion, rationale="Deterministic mock variant.", proposed_strategy=Strategy(
                version=current.version + 1,
                control_mode="ai",
                priority_rule=priority,
                crane_policy=crane,
                max_cranes_per_vessel=max_cranes,
                aging_weight=aging,
                label=f"{priority.replace('_', ' ').title()} + {crane.title()}",
                operating_instructions=suggestion,
            )))
        return EvaluatorProposal(
            scenario=scenario,
            weakness=picks[0][4],
            suggestion=built[0].suggestion,
            proposed_strategy=built[0].proposed_strategy,
            candidates=built,
        )
