from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from portforge.backend.agents.argon_client import ArgonClient
from portforge.backend.agents.operator_agent import available_resources
from portforge.backend.agents.schemas import BerthAssignment, CraneAssignment, Metrics, OperatorDecision, Scenario, Strategy
from portforge.backend.api.websocket import EventBroker
from portforge.backend.improvement.experiment_runner import ExperimentRunner
from portforge.backend.improvement.improvement_loop import ImprovementLoop
from portforge.backend.improvement.strategy_manager import StrategyManager
from portforge.backend.improvement.persistence import PersistenceStore
from portforge.backend.simulation.port_engine import PortEngine
from portforge.backend.simulation.scenarios import benchmark_scenarios


def decision(berths=None, cranes=None):
    return OperatorDecision(berth_assignments=berths or [], crane_assignments=cranes or [], reasoning_summary="test")


class SimulationConstraintsTest(unittest.TestCase):
    def engine(self):
        return PortEngine(Scenario(name="test", description="test", seed=9, arrival_count=4, arrival_spread=0), Strategy())

    def test_ship_cannot_occupy_occupied_berth(self):
        e = self.engine()
        for v in e.state.vessels[:2]: v.status = "waiting"
        e.apply_decision(decision(berths=[BerthAssignment(ship_id=e.state.vessels[0].id, berth_id="B2")]))
        e.apply_decision(decision(berths=[BerthAssignment(ship_id=e.state.vessels[1].id, berth_id="B2")]))
        self.assertEqual(e.state.berths[1].vessel_id, e.state.vessels[0].id)
        self.assertEqual(e.state.vessels[1].status, "waiting")

    def test_crane_cannot_serve_two_vessels(self):
        e = self.engine()
        a, b = e.state.vessels[:2]
        a.status = b.status = "waiting"
        a.size = b.size = "feeder"
        e.apply_decision(decision(berths=[BerthAssignment(ship_id=a.id, berth_id="B1"), BerthAssignment(ship_id=b.id, berth_id="B2")]))
        e.apply_decision(decision(cranes=[CraneAssignment(ship_id=a.id, crane_ids=["STS-01"]), CraneAssignment(ship_id=b.id, crane_ids=["STS-01"])]))
        self.assertEqual(next(c for c in e.state.cranes if c.id == "STS-01").vessel_id, a.id)

    def test_restating_own_crane_is_not_a_rejection(self):
        e = self.engine()
        v = e.state.vessels[0]; v.status = "waiting"; v.size = "feeder"
        e.apply_decision(decision(berths=[BerthAssignment(ship_id=v.id, berth_id="B1")]))
        e.apply_decision(decision(cranes=[CraneAssignment(ship_id=v.id, crane_ids=["STS-01"])]))
        e.apply_decision(decision(cranes=[CraneAssignment(ship_id=v.id, crane_ids=["STS-01"])]))
        self.assertEqual(v.assigned_cranes, ["STS-01"])
        self.assertFalse([x for x in e.state.events if x["type"] == "decision_rejected"])

    def test_available_actions_match_simulator_rules(self):
        e = self.engine()
        a, b = e.state.vessels[:2]
        a.status = b.status = "waiting"; a.size = "feeder"
        e.apply_decision(decision(berths=[BerthAssignment(ship_id=a.id, berth_id="B1")]))
        e.apply_decision(decision(cranes=[CraneAssignment(ship_id=a.id, crane_ids=["STS-01"])]))
        actions = available_resources(e.snapshot())
        berthed = next(x for x in actions["berthed_vessels"] if x["ship_id"] == a.id)
        self.assertEqual(berthed["cranes_already_working"], ["STS-01"])
        self.assertNotIn("STS-01", berthed["idle_cranes_that_can_reach"])
        self.assertNotIn("STS-01", actions["idle_crane_ids"])
        offered = next(x for x in actions["waiting_vessels"] if x["ship_id"] == b.id)["compatible_free_berths"]
        self.assertNotIn("B1", offered)
        for berth_id in offered:  # every offered berth is accepted by the simulator
            trial = self.engine(); t = trial.state.vessels[1]; t.status = "waiting"; t.size = b.size
            trial.apply_decision(decision(berths=[BerthAssignment(ship_id=t.id, berth_id=berth_id)]))
            self.assertEqual(t.berth_id, berth_id)

    def test_disabled_crane_cannot_be_assigned(self):
        s = Scenario(name="outage", description="test", seed=2, arrival_count=3, arrival_spread=0, disabled_cranes=["STS-02"])
        e = PortEngine(s, Strategy())
        v = e.state.vessels[0]; v.status = "waiting"; v.size = "feeder"
        e.apply_decision(decision(berths=[BerthAssignment(ship_id=v.id, berth_id="B1")]))
        e.apply_decision(decision(cranes=[CraneAssignment(ship_id=v.id, crane_ids=["STS-02"])]))
        self.assertIsNone(next(c for c in e.state.cranes if c.id == "STS-02").vessel_id)

    def test_ships_unload_and_depart(self):
        s = Scenario(name="small", description="test", seed=3, arrival_count=3, arrival_spread=0, cargo_min=20, cargo_max=20)
        result = PortEngine(s, Strategy(crane_policy="adaptive", max_cranes_per_vessel=3)).run()
        self.assertEqual(result["metrics"].completed_vessels, 3)
        self.assertTrue(all(v.departure_time is not None for v in result["state"].vessels))

    def test_fixed_seed_is_reproducible(self):
        r = ExperimentRunner(); s = benchmark_scenarios()[0]
        a = r.run_once(s, Strategy())["metrics"]
        b = r.run_once(s, Strategy())["metrics"]
        self.assertEqual(a, b)

    def test_crane_failure_and_recovery_are_logged(self):
        scenario = Scenario(name="recover", description="test", seed=4, horizon_minutes=120, arrival_count=3, disabled_cranes=["STS-04"], crane_recovery_minute=5)
        engine = PortEngine(scenario, Strategy())
        for _ in range(7):
            engine.step()
        kinds = [event["type"] for event in engine.state.events]
        self.assertIn("crane_failed", kinds)
        self.assertIn("crane_recovered", kinds)
        self.assertFalse(next(crane for crane in engine.state.cranes if crane.id == "STS-04").disabled)

    def test_comparison_uses_identical_benchmark(self):
        r = ExperimentRunner(); candidate = Strategy(priority_rule="hybrid", crane_policy="adaptive", max_cranes_per_vessel=3)
        baseline, previous, _ = r.compare(candidate, Strategy())
        self.assertEqual(baseline.average_turnaround_time, previous.average_turnaround_time)
        self.assertEqual(baseline.total_vessels, previous.total_vessels)
        self.assertEqual(baseline.horizon_minutes, previous.horizon_minutes)


class ImprovementTest(unittest.IsolatedAsyncioTestCase):
    def sample(self, turnaround, completed=27):
        return Metrics(average_turnaround_time=turnaround, average_waiting_time=20, crane_utilization=60, completed_vessels=completed, total_vessels=27, horizon_minutes=720)

    async def test_worse_strategy_is_rejected(self):
        m = StrategyManager(); m.best_metrics = self.sample(200)
        self.assertFalse(m.consider(Strategy(version=2), self.sample(220)))
        self.assertEqual(m.best.version, 1)

    async def test_better_strategy_is_promoted(self):
        m = StrategyManager(); m.best_metrics = self.sample(200)
        candidate = Strategy(version=2, priority_rule="hybrid")
        self.assertTrue(m.consider(candidate, self.sample(180)))
        self.assertEqual(m.best.version, 2)

    async def test_missing_argon_key_is_explicit_mock(self):
        client = ArgonClient(); client.api_key = None; client.mode = "mock"
        result = await client.structured("system", "prompt", OperatorDecision)
        self.assertEqual(result.mode, "mock")
        self.assertIn("GEMINI_API_KEY", result.error)

    async def test_events_match_real_loop_transition(self):
        broker = EventBroker(); loop = ImprovementLoop(broker, persistence=False)
        await loop.start(1); await loop.task
        kinds = [event["type"] for event in broker.recent]
        self.assertIn("epoch_started", kinds)
        self.assertIn("operator_decision", kinds)
        self.assertIn("metrics_updated", kinds)
        self.assertIn("epoch_completed", kinds)
        self.assertTrue({"strategy_accepted", "strategy_rejected"}.intersection(kinds))

    async def test_epoch_tests_three_candidates_and_keeps_the_best_measured(self):
        broker = EventBroker(); loop = ImprovementLoop(broker, persistence=False)
        await loop.start(1); await loop.task
        record = loop.history.records[-1]
        self.assertEqual(len(record.candidates), 3)
        self.assertEqual(sum(c["selected"] for c in record.candidates), 1)
        for c in record.candidates:
            self.assertEqual(len(c["per_scenario"]), len(benchmark_scenarios()))
        key = lambda c: (-c["metrics"]["completed_vessels"], c["metrics"]["average_turnaround_time"])
        chosen = next(c for c in record.candidates if c["selected"])
        self.assertEqual(key(chosen), min(key(c) for c in record.candidates))
        self.assertEqual(record.candidate_metrics.average_turnaround_time, chosen["metrics"]["average_turnaround_time"])
        self.assertEqual(record.proposed_modification, chosen["suggestion"])

    async def test_agent_controlled_run_decides_on_multiple_events_and_streams_ticks(self):
        runner = ExperimentRunner()
        scenario = Scenario(name="event loop", description="test", seed=22, horizon_minutes=180, arrival_count=4, arrival_spread=20, cargo_min=20, cargo_max=20)
        triggers = []
        ticks = []

        async def decide(state, fallback, reasons):
            triggers.append(reasons)
            return fallback

        async def tick(snapshot, events):
            ticks.append(snapshot["simulation_time"])

        result = await runner.run_agent_controlled(scenario, Strategy(), decide, tick, tick_delay=0)
        self.assertGreaterEqual(len(triggers), 2)
        self.assertGreater(len(ticks), 10)
        self.assertEqual(result["metrics"].completed_vessels, 4)

    async def test_persistence_round_trip_includes_replay_data(self):
        with tempfile.TemporaryDirectory() as directory:
            store = PersistenceStore(Path(directory) / "state.json")
            payload = {"epoch": 3, "replays": {"3": {"candidate_frames": [{"simulation_time": 10}]}}}
            store.save(payload)
            self.assertEqual(store.load(), payload)
            store.clear()
            self.assertEqual(store.load(), {})

    async def test_rejected_agent_action_is_logged_and_corrected(self):
        runner = ExperimentRunner()
        scenario = Scenario(name="correction", description="test", seed=8, horizon_minutes=120, arrival_count=3, arrival_spread=0, cargo_min=20, cargo_max=20)
        calls = 0

        async def decide(state, fallback, reasons):
            nonlocal calls
            calls += 1
            if calls == 1:
                return decision(berths=[BerthAssignment(ship_id="missing-vessel", berth_id="B1")])
            return fallback

        async def tick(snapshot, events):
            return None

        result = await runner.run_agent_controlled(scenario, Strategy(), decide, tick, tick_delay=0)
        self.assertGreaterEqual(calls, 2)
        self.assertTrue(any(event["type"] == "decision_rejected" for event in result["events"]))
        self.assertEqual(result["metrics"].completed_vessels, 3)


if __name__ == "__main__":
    unittest.main()
