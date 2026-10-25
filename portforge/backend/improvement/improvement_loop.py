from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from portforge.backend.agents.argon_client import ArgonClient
from portforge.backend.agents.evaluator_agent import EvaluatorAgent
from portforge.backend.agents.graph import AgentCoordinator
from portforge.backend.agents.schemas import AgentStatus, CandidateProposal, EpochRecord, Metrics, OperatorDecision
from portforge.backend.api.websocket import EventBroker
from portforge.backend.improvement.experiment_runner import ExperimentRunner
from portforge.backend.improvement.history import HistoryStore
from portforge.backend.improvement.metrics import improvement
from portforge.backend.improvement.persistence import MemoryPersistence, PersistenceStore
from portforge.backend.improvement.strategy_manager import StrategyManager
from portforge.backend.simulation.port_engine import PortEngine
from portforge.backend.simulation.scenarios import benchmark_scenarios


STAGES = [
    "GENERATE CHALLENGE", "EXECUTE OPERATOR", "MEASURE PERFORMANCE", "EVALUATE RESULTS",
    "PROPOSE IMPROVEMENT", "TEST CANDIDATE", "ACCEPT OR REJECT", "NEXT EPOCH",
]


class ImprovementLoop:
    def __init__(self, broker: EventBroker, persistence: bool = True):
        self.broker = broker
        self.client = ArgonClient()
        self.evaluator = EvaluatorAgent(self.client)
        self.agent_graph = AgentCoordinator(self.client, self._agent_status)
        self.runner = ExperimentRunner()
        self.persistence = PersistenceStore() if persistence else MemoryPersistence()
        saved = self.persistence.load()
        self.strategies = StrategyManager()
        self.strategies.restore(saved.get("best_strategy"), saved.get("best_metrics"), saved.get("versions"))
        self.history = HistoryStore(saved.get("history"))
        self.replays: dict[str, dict] = saved.get("replays", {})
        self.epoch = int(saved.get("epoch", 0))
        restored = bool(self.history.records)
        last_record = self.history.records[-1] if restored else None
        self.status = "completed" if restored else "idle"
        self.stage = 7 if restored else 0
        self.progress = 100 if restored else 0
        self.operator_status = AgentStatus.COMPLETED if restored else AgentStatus.WAITING
        self.evaluator_status = AgentStatus.COMPLETED if restored else AgentStatus.WAITING
        self.current_scenario = last_record.scenario if last_record else None
        self.latest_feedback = last_record.evaluator_feedback if last_record else "Awaiting first experiment"
        self.latest_proposal = last_record.proposed_modification if last_record else "—"
        latest_decisions = self.replays.get(str(self.epoch), {}).get("decisions", [])
        self.latest_decision = latest_decisions[-1]["decision"] if latest_decisions else None
        latest_replay = self.replays.get(str(self.epoch), {})
        latest_frames = latest_replay.get("candidate_frames", [])
        self.visible_state = latest_frames[min(36, len(latest_frames) - 1)] if latest_frames else self.runner.replay_snapshot(benchmark_scenarios()[0], self.strategies.baseline)
        self.baseline_metrics: Metrics | None = Metrics.model_validate(saved["baseline_metrics"]) if saved.get("baseline_metrics") else None
        self.current_metrics: Metrics | None = Metrics.model_validate(saved["current_metrics"]) if saved.get("current_metrics") else None
        self.task: asyncio.Task | None = None
        self.current_operation = "Ready to start"
        self.benchmark_progress = {"completed": 0, "total": 0}
        self.pause_gate = asyncio.Event()
        self.pause_gate.set()

    def public(self) -> dict:
        return {
            "status": self.status,
            "epoch": self.epoch,
            "stage": self.stage,
            "stage_name": STAGES[self.stage] if 0 <= self.stage < len(STAGES) else "IDLE",
            "progress": self.progress,
            "agent_mode": self.client.mode,
            "model": self.client.model,
            "ai_calls": {"started": self.client.calls_started, "completed": self.client.calls_completed},
            "current_operation": self.current_operation,
            "benchmark_progress": self.benchmark_progress,
            "starter_data": {
                "baseline_strategy": self.strategies.baseline.model_dump(),
                "benchmark_scenarios": [scenario.model_dump() for scenario in benchmark_scenarios()],
                "evaluation_contract": {
                    "identical_seeds": True,
                    "identical_horizons": True,
                    "acceptance_metric": "average_turnaround_time",
                    "completion_must_not_regress": True,
                },
            },
            "operator": {
                "status": self.operator_status,
                "strategy": self.strategies.best.model_dump(),
                "latest_decision": self.latest_decision,
            },
            "evaluator": {
                "status": self.evaluator_status,
                "scenario": self.current_scenario.model_dump() if self.current_scenario else None,
                "feedback": self.latest_feedback,
                "proposal": self.latest_proposal,
            },
            "baseline_metrics": self.baseline_metrics.model_dump() if self.baseline_metrics else None,
            "current_metrics": self.current_metrics.model_dump() if self.current_metrics else None,
            "best_metrics": self.strategies.best_metrics.model_dump() if self.strategies.best_metrics else None,
            "history": self.history.public(),
            "replays": [{
                "epoch": int(epoch),
                "accepted": replay.get("accepted", False),
                "frames": len(replay.get("candidate_frames", [])),
                "operator_decisions": len(replay.get("decisions", [])),
                "rejected_actions": sum(event.get("type") == "decision_rejected" for event in replay.get("events", [])),
            } for epoch, replay in self.replays.items()],
            "port": self.visible_state,
        }

    def _best_by_scenario(self) -> list[dict]:
        """Per-scenario benchmark results of the plan currently in charge, when they were recorded."""
        for record in reversed(self.history.records):
            if record.accepted:
                return next((c["per_scenario"] for c in record.candidates if c.get("selected")), [])
        return []

    def persist(self) -> None:
        self.persistence.save({
            "epoch": self.epoch,
            "history": self.history.public(),
            "baseline_metrics": self.baseline_metrics.model_dump() if self.baseline_metrics else None,
            "current_metrics": self.current_metrics.model_dump() if self.current_metrics else None,
            "best_metrics": self.strategies.best_metrics.model_dump() if self.strategies.best_metrics else None,
            "best_strategy": self.strategies.best.model_dump(),
            "versions": [strategy.model_dump() for strategy in self.strategies.versions],
            "replays": self.replays,
        })

    async def emit(self, event_type: str, payload: dict) -> None:
        event = {
            "type": event_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "payload": payload,
        }
        await self.broker.publish(event)

    async def _agent_status(self, agent: str, status: str) -> None:
        if agent == "evaluator":
            self.evaluator_status = AgentStatus(status)
        else:
            self.operator_status = AgentStatus(status)
        await self.emit("agent_status", {"agent": agent, "status": status})

    async def set_stage(self, index: int) -> None:
        self.stage = index
        self.progress = round(index / (len(STAGES) - 1) * 100)
        await self.emit("loop_stage", {"stage": index, "name": STAGES[index], "progress": self.progress})
        await asyncio.sleep(0.35)

    async def start(self, epochs: int = 8) -> None:
        if self.task and not self.task.done():
            return
        self.status = "running"
        self.pause_gate.set()
        self.task = asyncio.create_task(self._run(epochs))

    async def pause(self) -> None:
        if self.status == "running":
            self.status = "paused"
            self.pause_gate.clear()
            await self.emit("optimization_paused", {"epoch": self.epoch})

    async def resume(self) -> None:
        if self.status == "paused":
            self.status = "running"
            self.pause_gate.set()
            await self.emit("optimization_resumed", {"epoch": self.epoch})

    async def reset(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
        self.strategies.reset()
        self.history.clear()
        self.replays.clear()
        self.persistence.clear()
        self.epoch = 0
        self.status = "idle"
        self.stage = 0
        self.progress = 0
        self.current_scenario = None
        self.latest_feedback = "Awaiting first experiment"
        self.latest_proposal = "—"
        self.latest_decision = None
        self.baseline_metrics = None
        self.current_metrics = None
        self.visible_state = self.runner.replay_snapshot(benchmark_scenarios()[0], self.strategies.baseline)
        self.operator_status = AgentStatus.WAITING
        self.evaluator_status = AgentStatus.WAITING
        await self.emit("optimization_reset", self.public())

    async def _run(self, epochs: int) -> None:
        try:
            if self.baseline_metrics is None:
                self.baseline_metrics = await asyncio.to_thread(self.runner.run_benchmark, self.strategies.baseline)
                self.strategies.best_metrics = self.baseline_metrics.model_copy(deep=True)
            for _ in range(epochs):
                await self.pause_gate.wait()
                self.epoch += 1
                await self.emit("epoch_started", {"epoch": self.epoch})

                await self.set_stage(0)
                self.current_operation = "Supervisor is reviewing measured evidence"
                agent_history = self.history.public()
                if agent_history:
                    previous_trace = self.replays.get(str(self.epoch - 1), {})
                    rejected = [event for event in previous_trace.get("events", []) if event.get("type") == "decision_rejected"]
                    agent_history[-1]["operational_evidence"] = {
                        "decision_count": len(previous_trace.get("decisions", [])),
                        "rejected_actions": rejected[-12:],
                    }
                graph_state = await self.agent_graph.run(
                    self.epoch, self.strategies.best, self.strategies.best_metrics, agent_history, self._best_by_scenario()
                )
                proposal_result = graph_state["proposal_result"]
                proposal = proposal_result.value
                self.current_scenario = proposal.scenario
                self.evaluator_status = AgentStatus.COMPLETED
                self.latest_feedback = proposal.weakness
                self.latest_proposal = proposal.suggestion
                if proposal_result.error:
                    await self.emit("agent_error", {"agent": "evaluator", "message": proposal_result.error, "fallback": "mock"})
                await self.emit("evaluator_challenge", {
                    "scenario": proposal.scenario.model_dump(), "mode": proposal_result.mode,
                })

                await self.pause_gate.wait()
                await self.set_stage(1)
                self.current_operation = "Operator is controlling the live port"
                self.operator_status = AgentStatus.EXECUTING
                operator_result = graph_state["operator_result"]
                self.latest_decision = graph_state["operator_decision"].model_dump()
                self.visible_state = graph_state["preview_state"]
                if operator_result.error:
                    await self.emit("agent_error", {"agent": "operator", "message": operator_result.error, "fallback": "validated policy"})
                await self.emit("operator_decision", {
                    "strategy": self.strategies.best.model_dump(), "decision": self.latest_decision,
                    "mode": operator_result.mode,
                })
                await self.emit("simulation_state", self.visible_state)

                initial_decision = graph_state["operator_decision"]
                initial_result = graph_state["operator_result"]
                use_initial = True

                async def decide_at_event(state: dict, fallback, triggers: list[str]):
                    nonlocal use_initial
                    if use_initial:
                        use_initial = False
                        result = initial_result
                        decision = initial_decision
                    else:
                        await self._agent_status("operator", "thinking" if self.client.mode == "argon" else "executing")
                        result = await self.agent_graph.operator.decide(
                            state, self.strategies.best, fallback=fallback, triggers=triggers
                        )
                        decision = result.value
                    self.latest_decision = decision.model_dump()
                    await self.emit("operator_decision", {
                        "strategy": self.strategies.best.model_dump(), "decision": self.latest_decision,
                        "mode": result.mode, "triggers": triggers,
                    })
                    if result.error:
                        await self.emit("agent_error", {"agent": "operator", "message": result.error, "fallback": "validated policy"})
                    await self._agent_status("operator", "executing")
                    return decision

                async def stream_tick(snapshot: dict, events: list[dict]):
                    self.visible_state = snapshot
                    await self.emit("simulation_tick", {"snapshot": snapshot, "events": events})

                incumbent_run = await self.runner.run_agent_controlled(
                    proposal.scenario, self.strategies.best, decide_at_event, stream_tick
                )

                await self.set_stage(2)
                await self.emit("metrics_updated", incumbent_run["metrics"].model_dump())

                await self.set_stage(3)
                self.evaluator_status = AgentStatus.EVALUATING
                await self.emit("evaluator_feedback", {"weakness": proposal.weakness, "suggestion": proposal.suggestion})

                await self.set_stage(4)
                await self.emit("strategy_proposed", {**proposal.proposed_strategy.model_dump(), "candidate_count": max(1, len(proposal.candidates))})

                await self.pause_gate.wait()
                await self.set_stage(5)
                candidates = proposal.candidates or [CandidateProposal(suggestion=proposal.suggestion, proposed_strategy=proposal.proposed_strategy)]
                self.current_operation = f"Operator is testing {len(candidates)} candidate ideas on fixed benchmarks"
                self.benchmark_progress = {"completed": 0, "total": len(benchmark_scenarios()) * len(candidates)}
                baseline = await asyncio.to_thread(self.runner.run_benchmark, self.strategies.baseline)
                previous = self.strategies.best_metrics.model_copy(deep=True)

                def candidate_decider(index: int, strategy):
                    async def candidate_decide(state: dict, _unused, triggers: list[str]):
                        await self._agent_status("operator", "thinking" if self.client.mode == "argon" else "executing")
                        result = await self.agent_graph.operator.decide(
                            state, strategy, triggers=["candidate evaluation", *triggers]
                        )
                        decision = result.value or OperatorDecision(reasoning_summary=f"AI decision unavailable: {result.error}")
                        await self.emit("candidate_operator_decision", {
                            "candidate": index, "strategy": strategy.model_dump(),
                            "decision": decision.model_dump(), "mode": result.mode, "triggers": triggers,
                        })
                        await self._agent_status("operator", "evaluating")
                        return decision
                    return candidate_decide

                async def benchmark_completed(_scenario):
                    self.benchmark_progress = {**self.benchmark_progress, "completed": self.benchmark_progress["completed"] + 1}
                    await self.emit("benchmark_progress", self.benchmark_progress)

                # Every idea runs on the identical fixed benchmark; the best measured one competes with the incumbent.
                runs = await asyncio.gather(*(
                    self.runner.run_ai_benchmark(c.proposed_strategy, candidate_decider(i, c.proposed_strategy), benchmark_completed)
                    for i, c in enumerate(candidates)
                ))
                ranked = sorted(range(len(candidates)), key=lambda i: (-runs[i][0].completed_vessels, runs[i][0].average_turnaround_time))
                chosen = ranked[0]
                candidate, candidate_evidence = runs[chosen]
                proposal.suggestion = candidates[chosen].suggestion
                proposal.proposed_strategy = candidates[chosen].proposed_strategy
                tested = []
                for i, (c, (metrics, traces)) in enumerate(zip(candidates, runs)):
                    metrics.improvement_percentage = improvement(baseline, metrics)
                    tested.append({
                        "index": i,
                        "suggestion": c.suggestion,
                        "rationale": c.rationale,
                        "metrics": metrics.model_dump(),
                        "per_scenario": [{"scenario": t["scenario"]["name"], **{k: t["metrics"][k] for k in ("average_turnaround_time", "average_waiting_time", "completed_vessels", "total_vessels")}} for t in traces],
                        "selected": i == chosen,
                    })
                await self.emit("candidates_tested", {"candidates": [{k: t[k] for k in ("index", "metrics", "selected")} for t in tested]})
                previous.improvement_percentage = improvement(baseline, previous)
                self.baseline_metrics = baseline
                self.current_metrics = candidate

                await self.set_stage(6)
                self.current_operation = "Supervisor is accepting or rejecting the measured candidate"
                accepted = self.strategies.consider(proposal.proposed_strategy, candidate)
                event_type = "strategy_accepted" if accepted else "strategy_rejected"
                await self.emit(event_type, {
                    "strategy": proposal.proposed_strategy.model_dump(),
                    "candidate_metrics": candidate.model_dump(),
                    "best_strategy": self.strategies.best.model_dump(),
                })

                record = EpochRecord(
                    epoch=self.epoch,
                    scenario=proposal.scenario,
                    operator_strategy=self.strategies.best if accepted else self.strategies.best,
                    evaluator_feedback=proposal.weakness,
                    proposed_modification=proposal.suggestion,
                    previous_metrics=previous,
                    candidate_metrics=candidate,
                    baseline_metrics=baseline,
                    accepted=accepted,
                    strategy_after=self.strategies.best,
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    candidates=tested,
                )
                self.history.add(record)
                baseline_frames, candidate_frames = await asyncio.gather(
                    asyncio.to_thread(self.runner.build_replay, proposal.scenario, self.strategies.baseline),
                    asyncio.to_thread(self.runner.build_replay, proposal.scenario, self.strategies.best),
                )
                self.replays[str(self.epoch)] = {
                    "epoch": self.epoch,
                    "accepted": accepted,
                    "scenario": proposal.scenario.model_dump(),
                    "strategy": self.strategies.best.model_dump(),
                    "baseline_frames": baseline_frames,
                    "candidate_frames": candidate_frames,
                    "operator_frames": incumbent_run["frames"],
                    "decisions": incumbent_run["decisions"],
                    "events": incumbent_run["events"],
                    "candidate_agent_evidence": candidate_evidence,
                }
                self.visible_state = candidate_frames[min(len(candidate_frames) - 1, 36)]
                self.operator_status = AgentStatus.COMPLETED
                self.evaluator_status = AgentStatus.COMPLETED
                self.persist()
                await self.emit("simulation_state", self.visible_state)
                await self.emit("epoch_completed", record.model_dump(mode="json"))
                await self.set_stage(7)
                self.current_operation = "Epoch complete"
            self.status = "completed"
            await self.emit("optimization_completed", {"epochs": self.epoch})
        except asyncio.CancelledError:
            return
        except Exception as exc:
            self.status = "error"
            await self.emit("agent_error", {"agent": "system", "message": str(exc)})
