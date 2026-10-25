from __future__ import annotations

from dataclasses import dataclass, field, asdict


@dataclass
class Vessel:
    id: str
    arrival_time: int
    cargo_total: int
    cargo_remaining: float
    size: str
    status: str = "scheduled"
    berth_id: str | None = None
    assigned_cranes: list[str] = field(default_factory=list)
    berth_time: int | None = None
    departure_time: int | None = None


@dataclass
class Berth:
    id: str
    max_size: str
    vessel_id: str | None = None
    closed: bool = False


@dataclass
class Crane:
    id: str
    reachable_berths: list[str]
    vessel_id: str | None = None
    disabled: bool = False
    capacity_per_minute: float = 1.0


@dataclass
class PortState:
    simulation_time: int
    horizon_minutes: int
    vessels: list[Vessel]
    berths: list[Berth]
    cranes: list[Crane]
    events: list[dict] = field(default_factory=list)

    def public(self) -> dict:
        return {
            "simulation_time": self.simulation_time,
            "horizon_minutes": self.horizon_minutes,
            "vessels": [asdict(x) for x in self.vessels],
            "berths": [asdict(x) for x in self.berths],
            "cranes": [asdict(x) for x in self.cranes],
        }
