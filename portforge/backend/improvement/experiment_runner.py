from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from portforge.backend.agents.schemas import Metrics, OperatorDecision, Scenario, Strategy
from portforge.backend.improvement.metrics import improvement
from portforge.backend.improvement.metrics import calculate_metrics
from portforge.backend.simulation.port_engine import PortEngine
from portforge.backend.simulation.scenarios import benchmark_scenarios


class ExperimentRunner:
    def run_once(self, scenario: Scenario, strategy: Strategy) -> dict:
        return PortEngine(scenario.model_copy(deep=True), strategy.model_copy(deep=True)).run()

    def replay_snapshot(self, scenario: Scenario, strategy: Strategy, minute: int = 180) -> dict:
        """Return a genuine mid-simulation state for the 3D replay surface."""
        engine = PortEngine(scenario.model_copy(deep=True), strategy.model_copy(deep=True))
        target = min(minute, scenario.horizon_minutes)
        while engine.state.simulation_time < target:
            engine.step()
        return engine.snapshot()

    def build_replay(self, scenario: Scenario, strategy: Strategy, interval: int = 5) -> list[dict]:
        engine = PortEngine(scenario.model_copy(deep=True), strategy.model_copy(deep=True))
        frames = [engine.snapshot()]
        while engine.state.simulation_time < engine.state.horizon_minutes:
            before = len(engine.state.events)
            engine.step()
            if engine.state.simulation_time % interval == 0 or len(engine.state.events) > before:
                frames.append(engine.snapshot())
            if all(v.status == "completed" for v in engine.state.vessels):
                break
        return frames

    async def run_agent_controlled(
        self,
        scenario: Scenario,
        strategy: Strategy,
        decide: Callable[[dict, OperatorDecision, list[str]], Awaitable[OperatorDecision]],
        on_tick: Callable[[dict, list[dict]], Awaitable[None]],
        tick_delay: float = 0.004,
    ) -> dict:
        """Run the visible experiment with decisions at real event boundaries."""
        engine = PortEngine(scenario.model_copy(deep=True), strategy.model_copy(deep=True))
        frames: list[dict] = [engine.snapshot()]
        decision_trace: list[dict] = []
        queue_was_congested = False
        disruption_sent = False
        while engine.state.simulation_time < engine.state.horizon_minutes:
            event_start = len(engine.state.events)
            engine.step(auto_decide=False)
            new_events = engine.state.events[event_start:]
            triggers: list[str] = []
            event_types = {event["type"] for event in new_events}
            if "vessel_arrived" in event_types:
                triggers.append("vessel arrival")
            if "vessel_completed" in event_types:
                triggers.extend(["vessel departure", "berth became available"])
            if "crane_failed" in event_types:
                triggers.append("crane failure")
            if "crane_recovered" in event_types:
                triggers.append("crane recovery")
            if not disruption_sent and (scenario.disabled_cranes or scenario.closed_berths):
                triggers.append("evaluator disruption")
                disruption_sent = True
            waiting_count = sum(v.status == "waiting" for v in engine.state.vessels)
            congested = waiting_count >= 3
            if congested and not queue_was_congested:
                triggers.append("queue congestion threshold")
            queue_was_congested = congested
            waiting = [v for v in engine.state.vessels if v.status == "waiting"]
            free_berths = [b for b in engine.state.berths if not b.closed and b.vessel_id is None]
            free_cranes = [c for c in engine.state.cranes if not c.disabled and c.vessel_id is None]
            berth_actionable = any(
                any(b.max_size == "neo-panamax" or v.size != "neo-panamax" for b in free_berths)
                for v in waiting
            )
            crane_actionable = bool(free_cranes) and any(
                v.status == "unloading" and any(v.berth_id in c.reachable_berths for c in free_cranes)
                for v in engine.state.vessels
            )
            needs_resources = berth_actionable or crane_actionable
            # A sparse recovery request handles a prior AI no-op without polling
            # Gemini every few simulated minutes.
            if needs_resources and engine.state.simulation_time % 60 == 0 and not triggers:
                triggers.append("unassigned work retry")
            if triggers and needs_resources:
                fallback = engine._operator_decision() if strategy.control_mode == "baseline" else OperatorDecision(reasoning_summary="No deterministic fallback; AI must decide.")
                agent_state = {**engine.snapshot(), "recent_events": engine.state.events[-20:]}
                decision = await decide(agent_state, fallback, triggers)
                applied_event_start = len(engine.state.events)
                engine.apply_decision(decision)
                effective = decision
                decision_events = engine.state.events[applied_event_start:]
                rejections = [event for event in decision_events if event["type"] == "decision_rejected"]
                if rejections:
                    correction_triggers = ["correct rejected operator decision", *[event["payload"]["reason"] for event in rejections]]
                    correction_state = {**engine.snapshot(), "recent_events": engine.state.events[-20:]}
                    corrected = await decide(correction_state, fallback, correction_triggers)
                    correction_start = len(engine.state.events)
                    engine.apply_decision(corrected)
                    if any(event["type"] in {"berth_assignment", "crane_assignment"} for event in engine.state.events[correction_start:]):
                        effective = corrected
                        triggers = [*triggers, "agent correction"]
                decision_trace.append({"simulation_time": engine.state.simulation_time, "triggers": triggers, "decision": effective.model_dump()})
                new_events = engine.state.events[event_start:]
            snapshot = engine.snapshot()
            if engine.state.simulation_time % 5 == 0 or new_events:
                frames.append(snapshot)
            await on_tick(snapshot, new_events)
            if all(v.status == "completed" for v in engine.state.vessels):
                break
            if tick_delay:
                await asyncio.sleep(tick_delay)
        metrics = calculate_metrics(engine.state, engine.crane_busy_minutes, engine.crane_available_minutes)
        return {"metrics": metrics, "state": engine.state, "frames": frames, "decisions": decision_trace, "events": engine.state.events}

    def run_benchmark(self, strategy: Strategy) -> Metrics:
        results = [self.run_once(s, strategy)["metrics"] for s in benchmark_scenarios()]
        return Metrics(
            average_turnaround_time=round(sum(m.average_turnaround_time for m in results) / len(results), 1),
            average_waiting_time=round(sum(m.average_waiting_time for m in results) / len(results), 1),
            crane_utilization=round(sum(m.crane_utilization for m in results) / len(results), 1),
            completed_vessels=sum(m.completed_vessels for m in results),
            total_vessels=sum(m.total_vessels for m in results),
            horizon_minutes=results[0].horizon_minutes,
        )

    def compare(self, candidate: Strategy, incumbent: Strategy) -> tuple[Metrics, Metrics, Metrics]:
        baseline = self.run_benchmark(Strategy())
        previous = self.run_benchmark(incumbent)
        candidate_metrics = self.run_benchmark(candidate)
        previous.improvement_percentage = improvement(baseline, previous)
        candidate_metrics.improvement_percentage = improvement(baseline, candidate_metrics)
        return baseline, previous, candidate_metrics

    async def run_ai_benchmark(self, strategy: Strategy, decide, on_scenario_complete=None) -> tuple[Metrics, list[dict]]:
        """Evaluate a strategy using AI decisions on every benchmark scenario."""
        async def run_scenario(scenario):
            async def no_stream(_snapshot: dict, _events: list[dict]):
                return None
            run = await self.run_agent_controlled(scenario, strategy, decide, no_stream, tick_delay=0)
            if on_scenario_complete:
                await on_scenario_complete(scenario)
            return run["metrics"], {"scenario": scenario.model_dump(), "metrics": run["metrics"].model_dump(), "decisions": run["decisions"], "events": run["events"]}
        completed = await asyncio.gather(*(run_scenario(scenario) for scenario in benchmark_scenarios()))
        results = [item[0] for item in completed]
        traces = [item[1] for item in completed]
        return Metrics(
            average_turnaround_time=round(sum(m.average_turnaround_time for m in results) / len(results), 1),
            average_waiting_time=round(sum(m.average_waiting_time for m in results) / len(results), 1),
            crane_utilization=round(sum(m.crane_utilization for m in results) / len(results), 1),
            completed_vessels=sum(m.completed_vessels for m in results),
            total_vessels=sum(m.total_vessels for m in results),
            horizon_minutes=results[0].horizon_minutes,
        ), traces
