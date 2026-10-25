"""Ship positions around the Port of Oakland in the shape of AIS messages, from one of two sources.

    from feed import SyntheticAIS, AISStream, ais_source
    feed = SyntheticAIS(task)              # or SyntheticAIS(task, plan) to follow a submitted plan
    feed.positions(30.5)                   # every ship in the area at hour 30.5 (hour 0 = Monday 00:00 Pacific)
    feed.events(30.5)                      # eta_update notices issued by then

    live = AISStream()                     # real positions from aisstream.io when AISSTREAM_API_KEY is set
    live.positions()

SyntheticAIS: the ship calls of a task are GENERATED (not real records), and so are these positions. Each ship
follows a stylised route in lon/lat from the Golden Gate, across the Bay and the Oakland bar channel, to its
terminal's anchorage (reached at its arrival hour) and its berth (reached at its berth hour, from the plan when one is
given, else the published planned_hour), then leaves the same way after its departure. Routes, anchorages, speeds,
MMSIs and berth coordinates are a stylised representation, not survey-grade navigation data.

AISStream: real AIS position reports and static data for the box around the Bay from the aisstream.io websocket, in
a background thread, merged per MMSI into the same dict shape. It only connects when AISSTREAM_API_KEY is set; the
key is never logged or printed. `websockets` is an optional dependency, imported only inside this adapter.

Every position dict has the keys of POSITION_KEYS. Times are UTC: hour 0 is 2026-10-26 00:00 Pacific (07:00 UTC).
Standard library only, apart from the oakland_core package (and websockets for the real stream).
"""

from __future__ import annotations

import json
import math
import os
import threading
import zlib
from datetime import datetime, timedelta, timezone
from typing import Any

from oakland_core import Task, parse_plan
from oakland_core.check import work
from oakland_core.model import SHIFT_NAMES, CraneEntry

HOUR0_UTC = datetime(2026, 10, 26, 7, 0, tzinfo=timezone.utc)   # Monday 2026-10-26 00:00 Pacific (PDT)
DESTINATION = "US OAK"
SHIP_TYPE_CARGO = 70

POSITION_KEYS = ("mmsi", "imo", "name", "lat", "lon", "sog_kn", "cog_deg", "heading_deg", "nav_status", "eta",
                 "destination", "ship_type", "length_m", "beam_m", "draught_m", "ts", "source")

# route waypoints (lat, lon), from the sea
GOLDEN_GATE = (37.8199, -122.4786)
BAY = (37.8100, -122.4000)
BAR_CHANNEL = (37.8060, -122.3500)

# terminal berth coordinates (quay centre), a stylised anchorage off each, and the quay bearing (degrees true)
BERTHS: dict[str, tuple[float, float]] = {
    "OICT": (37.7985, -122.3210),
    "TraPac": (37.8120, -122.3160),
    "Everport": (37.8095, -122.3060),
    "Matson": (37.7950, -122.2850),
}
ANCHORAGES: dict[str, tuple[float, float]] = {
    "OICT": (37.8030, -122.3380),
    "TraPac": (37.8150, -122.3350),
    "Everport": (37.8140, -122.3250),
    "Matson": (37.7990, -122.3000),
}
QUAY_BEARING: dict[str, float] = {"OICT": 100.0, "TraPac": 85.0, "Everport": 85.0, "Matson": 120.0}

TRANSIT_KN = 10.0         # speed over ground in the Bay
APPROACH_H = 0.5          # anchorage to berth (and berth to anchorage on the way out), when there is time
KM_PER_NM = 1.852
EARTH_KM = 6371.0


def _hour_utc(t_h: float) -> datetime:
    return HOUR0_UTC + timedelta(hours=t_h)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _eta(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M")


def distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance between two (lat, lon) points."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * EARTH_KM * math.asin(math.sqrt(h))


def bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Initial course from a to b, degrees true."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    y = math.sin(lo2 - lo1) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(lo2 - lo1)
    return math.degrees(math.atan2(y, x)) % 360.0


def _offset(p: tuple[float, float], bearing: float, metres: float) -> tuple[float, float]:
    """A point `metres` from p along `bearing` (flat earth, fine over a quay length)."""
    north = metres * math.cos(math.radians(bearing))
    east = metres * math.sin(math.radians(bearing))
    return (p[0] + north / 111_320.0, p[1] + east / (111_320.0 * math.cos(math.radians(p[0]))))


def _lerp(a: tuple[float, float], b: tuple[float, float], f: float) -> tuple[float, float]:
    return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)


def mmsi_for(name: str, imo: str) -> int:
    """A stable made-up MMSI for a generated ship (MID 538, Marshall Islands, a common container ship flag)."""
    return 538_000_000 + zlib.crc32(f"{name}|{imo}".encode()) % 1_000_000


class _Track:
    """One ship's timed path: (t0, t1, p0, p1, nav_status) legs, in order, with no gaps."""

    def __init__(self) -> None:
        self.legs: list[tuple[float, float, tuple[float, float], tuple[float, float], str]] = []

    def add(self, t0: float, t1: float, p0: tuple[float, float], p1: tuple[float, float], status: str) -> None:
        if t1 > t0:
            self.legs.append((t0, t1, p0, p1, status))

    def path(self, t0: float, points: list[tuple[float, float]], speed_kn: float) -> float:
        """Sail through `points` from t0 at speed_kn; returns the time at the last point."""
        t = t0
        for a, b in zip(points, points[1:]):
            dt = distance_km(a, b) / (speed_kn * KM_PER_NM)
            self.add(t, t + dt, a, b, "under way")
            t += dt
        return t

    @property
    def start(self) -> float:
        return self.legs[0][0]

    @property
    def end(self) -> float:
        return self.legs[-1][1]

    def at(self, t: float) -> tuple[tuple[float, float], float, float, str] | None:
        """(lat/lon, sog_kn, cog_deg, nav_status) at time t, or None outside the track."""
        if not self.legs or t < self.start or t > self.end:
            return None
        for t0, t1, p0, p1, status in self.legs:
            if t0 <= t <= t1:
                if status == "under way":
                    f = (t - t0) / (t1 - t0)
                    sog = distance_km(p0, p1) / KM_PER_NM / (t1 - t0)
                    return _lerp(p0, p1, f), sog, bearing_deg(p0, p1), status
                return p0, 0.0, -1.0, status
        return None


def _counts(task: Task, entry: Any) -> dict[str, int]:
    if isinstance(entry, CraneEntry):
        return {"day": entry.day, "night": entry.night, "hoot": entry.hoot}
    c = task.cranes_of(entry)
    return {name: int(c) for name in SHIFT_NAMES} if c else {}


class SyntheticAIS:
    """AIS-shaped positions for the GENERATED ship calls of one task, optionally following a plan (any form
    parse_plan accepts). Deterministic: the same task and plan give the same positions."""

    source = "synthetic"

    def __init__(self, task: Task, plan: Any = None):
        self.task = task
        parsed: dict = {}
        if plan is not None:
            parsed, _ = parse_plan(task, plan)
        self.berth = BERTHS[task.terminal]
        self.anchorage = ANCHORAGES[task.terminal]
        self.quay_bearing = QUAY_BEARING[task.terminal]
        self.schedule: dict[int, dict] = {}
        self.tracks: dict[int, _Track] = {}
        for s in task.ships:
            sched = self._schedule(s, parsed.get(s.id))
            if sched is None:
                continue
            self.schedule[s.id] = sched
            self.tracks[s.id] = self._track(s, sched)

    def _schedule(self, s, entry) -> dict | None:
        """Arrival, berth hour, departure and first section of one ship (None: no berth known)."""
        t = self.task
        if entry is not None and not isinstance(entry, CraneEntry):
            hour, section = int(entry[0]), int(entry[1])
        else:
            hour, section = s.planned_hour, s.planned_section
        if hour is None or section is None:
            return None
        if entry is not None:
            finish, _ = work(t, s, hour, _counts(t, entry))
            dep = t.departure(s, finish)
        else:
            dep = s.due
        arrival = min(s.arrival, hour)
        return {"arrival": float(arrival), "berth": float(hour), "departure": float(max(dep, hour + 1)),
                "section": section}

    def _berth_point(self, s, section: int) -> tuple[float, float]:
        """The ship's midship at its sections, along the quay from the terminal's berth coordinate (quay centre)."""
        mid = section - 1 + s.sections / 2.0
        along = (mid - self.task.n_sections / 2.0) * self.task.section_m
        return _offset(self.berth, self.quay_bearing, along)

    def _track(self, s, sched: dict) -> _Track:
        tr = _Track()
        inbound = [GOLDEN_GATE, BAY, BAR_CHANNEL, self.anchorage]
        transit_h = sum(distance_km(a, b) for a, b in zip(inbound, inbound[1:])) / (TRANSIT_KN * KM_PER_NM)
        a, b, d = sched["arrival"], sched["berth"], sched["departure"]
        quay = self._berth_point(s, sched["section"])
        tr.path(a - transit_h, inbound, TRANSIT_KN)
        approach = min(APPROACH_H, (b - a) / 2.0)
        tr.add(a, b - approach, self.anchorage, self.anchorage, "at anchor")
        tr.add(b - approach, b, self.anchorage, quay, "under way")
        tr.add(b, d, quay, quay, "moored")
        tr.add(d, d + APPROACH_H, quay, BAR_CHANNEL, "under way")
        tr.path(d + APPROACH_H, [BAR_CHANNEL, BAY, GOLDEN_GATE], TRANSIT_KN)
        return tr

    def position(self, sid: int, t_h: float) -> dict | None:
        """One ship's AIS-shaped position at hour t_h, or None when it is outside the area."""
        tr = self.tracks.get(sid)
        state = tr.at(t_h) if tr else None
        if state is None:
            return None
        s = self.task.ship(sid)
        (lat, lon), sog, cog, status = state
        if status == "moored":
            cog = self.quay_bearing
        elif cog < 0:   # at anchor: swung to the last course in
            cog = bearing_deg(BAR_CHANNEL, self.anchorage)
        return {
            "mmsi": mmsi_for(s.name, s.imo),
            "imo": s.imo,
            "name": s.name,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "sog_kn": round(sog, 1),
            "cog_deg": round(cog, 1),
            "heading_deg": int(round(cog)) % 360,
            "nav_status": status,
            "eta": _eta(_hour_utc(self.schedule[sid]["arrival"])),
            "destination": DESTINATION,
            "ship_type": SHIP_TYPE_CARGO,
            "length_m": float(s.length_m),
            "beam_m": float(s.beam_m if s.beam_m is not None else round(s.length_m / 7.6, 1)),
            "draught_m": float(s.draught_m if s.draught_m is not None else 0.0),
            "ts": _iso(_hour_utc(t_h)),
            "source": self.source,
        }

    def positions(self, t_h: float) -> list[dict]:
        """Every ship in the area (between entering at the Golden Gate and leaving through it) at hour t_h."""
        out = [self.position(sid, t_h) for sid in self.tracks]
        return [p for p in out if p is not None]

    def events(self, t_h: float) -> list[dict]:
        """Arrival-delay notices: every ship arriving later than its planned hour, issued at the disruption's hour
        when the task records one for that ship, else at hour 0 (the task starts with the notice known)."""
        notice_hour: dict[int, float] = {}
        for d in self.task.disruptions or []:
            if isinstance(d, dict) and isinstance(d.get("ship"), int) and isinstance(d.get("hour"), (int, float)):
                notice_hour[d["ship"]] = float(d["hour"])
        out = []
        for s in self.task.ships:
            if s.planned_hour is None or s.arrival <= s.planned_hour:
                continue
            h = notice_hour.get(s.id, 0.0)
            if h <= t_h:
                out.append({"hour": h, "ship": s.name, "kind": "eta_update", "new_arrival": s.arrival})
        return sorted(out, key=lambda e: (e["hour"], e["new_arrival"], e["ship"]))


# the real stream

AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"
BAY_BOX = [[[37.70, -122.50], [37.90, -122.20]]]
NAV_STATUS = {1: "at anchor", 5: "moored"}   # every other AIS navigational status reads as "under way"


def _key_from_env() -> str | None:
    return os.environ.get("AISSTREAM_API_KEY") or None


class AISStream:
    """Latest real AIS position per MMSI around the Bay from aisstream.io, in a background thread. Without a key
    (argument or AISSTREAM_API_KEY) it never connects and positions() is empty."""

    source = "aisstream"

    def __init__(self, api_key: str | None = None, start: bool = True):
        self._key = api_key or _key_from_env()
        self._lock = threading.Lock()
        self._ships: dict[int, dict] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.connected = False
        self.error: str | None = None
        if self._key and start:
            self.start()

    def __repr__(self) -> str:   # never show the key
        return f"AISStream(enabled={self.enabled}, connected={self.connected}, ships={len(self._ships)})"

    @property
    def enabled(self) -> bool:
        return bool(self._key)

    def start(self) -> None:
        if not self._key or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="aisstream", daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()

    def subscription(self) -> dict:
        return {"APIKey": self._key, "BoundingBoxes": BAY_BOX,
                "FilterMessageTypes": ["PositionReport", "ShipStaticData"]}

    def _run(self) -> None:
        import asyncio

        try:
            asyncio.run(self._loop())
        except Exception as e:   # noqa: BLE001, reported via .error, never with the key
            self.error = type(e).__name__
        finally:
            self.connected = False

    async def _loop(self) -> None:
        import asyncio

        import websockets   # optional dependency, only for the real stream

        while not self._stop.is_set():
            try:
                async with websockets.connect(AISSTREAM_URL) as ws:
                    await ws.send(json.dumps(self.subscription()))
                    self.connected = True
                    while not self._stop.is_set():
                        try:
                            raw = await asyncio.wait_for(ws.recv(), 1.0)
                        except TimeoutError:
                            continue
                        self.handle(json.loads(raw))
            except Exception as e:   # noqa: BLE001, reconnect after a pause
                self.connected = False
                self.error = type(e).__name__
                if not self._stop.is_set():
                    await asyncio.sleep(5)

    def handle(self, msg: dict) -> None:
        """Merge one aisstream.io message (PositionReport or ShipStaticData) into the per-MMSI table."""
        meta = msg.get("MetaData") or {}
        mmsi = meta.get("MMSI")
        if mmsi is None:
            return
        kind = msg.get("MessageType")
        body = (msg.get("Message") or {}).get(kind) or {}
        with self._lock:
            rec = self._ships.setdefault(int(mmsi), {"mmsi": int(mmsi)})
            if meta.get("ShipName"):
                rec.setdefault("name", str(meta["ShipName"]).strip())
            rec["ts"] = meta.get("time_utc") or rec.get("ts")
            if kind == "PositionReport":
                rec["lat"] = body.get("Latitude", meta.get("latitude"))
                rec["lon"] = body.get("Longitude", meta.get("longitude"))
                rec["sog_kn"] = body.get("Sog")
                rec["cog_deg"] = body.get("Cog")
                hd = body.get("TrueHeading")
                rec["heading_deg"] = int(hd) if hd is not None and hd != 511 else None
                rec["nav_status"] = NAV_STATUS.get(body.get("NavigationalStatus"), "under way")
            elif kind == "ShipStaticData":
                if body.get("Name"):
                    rec["name"] = str(body["Name"]).strip()
                if body.get("ImoNumber"):
                    rec["imo"] = str(body["ImoNumber"])
                dim = body.get("Dimension") or {}
                if dim:
                    rec["length_m"] = float(dim.get("A", 0) + dim.get("B", 0))
                    rec["beam_m"] = float(dim.get("C", 0) + dim.get("D", 0))
                if body.get("MaximumStaticDraught") is not None:
                    rec["draught_m"] = float(body["MaximumStaticDraught"])
                if body.get("Destination"):
                    rec["destination"] = str(body["Destination"]).strip()
                if body.get("Type") is not None:
                    rec["ship_type"] = int(body["Type"])
                eta = body.get("Eta") or {}
                if eta.get("Month") and eta.get("Day"):
                    year = datetime.now(timezone.utc).year
                    rec["eta"] = (f"{year:04d}-{int(eta['Month']):02d}-{int(eta['Day']):02d}"
                                  f"T{int(eta.get('Hour', 0)) % 24:02d}:{int(eta.get('Minute', 0)) % 60:02d}")

    def positions(self) -> list[dict]:
        """The latest position of every ship seen, in the POSITION_KEYS shape (unknown fields None)."""
        with self._lock:
            rows = [dict(r) for r in self._ships.values() if r.get("lat") is not None]
        out = []
        for r in rows:
            p = {k: r.get(k) for k in POSITION_KEYS}
            p["source"] = self.source
            out.append(p)
        return sorted(out, key=lambda p: p["mmsi"])


def ais_source(task: Task | None = None, plan: Any = None) -> AISStream | SyntheticAIS:
    """The real stream when AISSTREAM_API_KEY is set, else the synthetic feed of `task`."""
    if _key_from_env():
        return AISStream()
    if task is None:
        raise ValueError("no AISSTREAM_API_KEY and no task: nothing to feed")
    return SyntheticAIS(task, plan)
