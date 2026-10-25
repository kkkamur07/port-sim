from __future__ import annotations

from portforge.backend.agents.schemas import Scenario


def scenario_for_epoch(epoch: int, seed: int | None = None) -> Scenario:
    templates = [
        ("Peak Arrival Congestion", "Five vessels converge in a narrow arrival window.", 10, 95, [], []),
        ("Crane Outage", "A quay crane fails during a busy operating period.", 9, 200, ["STS-04"], []),
        ("Berth Closure", "Maintenance removes one berth from service.", 9, 190, [], ["B2"]),
        ("Heavy Cargo Mix", "Several high-workload vessels compete for crane capacity.", 8, 150, ["STS-14"], []),
    ]
    name, description, count, spread, cranes, berths = templates[(epoch - 1) % len(templates)]
    return Scenario(
        name=name,
        description=description,
        seed=seed if seed is not None else 7000 + epoch * 97,
        arrival_count=count,
        arrival_spread=spread,
        cargo_min=120 if name == "Heavy Cargo Mix" else 80,
        cargo_max=440 if name == "Heavy Cargo Mix" else 320,
        disabled_cranes=cranes,
        crane_recovery_minute=300 if name == "Crane Outage" else None,
        closed_berths=berths,
    )


def benchmark_scenarios() -> list[Scenario]:
    return [
        Scenario(name="Benchmark / Standard Flow", description="Fixed mixed arrivals.", seed=101, arrival_count=8, arrival_spread=260),
        Scenario(name="Benchmark / Arrival Surge", description="Fixed congested arrivals.", seed=211, arrival_count=10, arrival_spread=90),
        Scenario(name="Benchmark / Equipment Loss", description="Fixed crane disruption.", seed=307, arrival_count=9, arrival_spread=180, disabled_cranes=["STS-08"]),
    ]
