"""The AIS ship feed: synthetic positions for a generated OICT task, the aisstream.io adapter without a key, and the
GET /ais route. Ship calls and positions are GENERATED (not real records); no network is used."""

from __future__ import annotations

import http.client
import json
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import feed  # noqa: E402
from env import OaklandEnv  # noqa: E402
from feed import BERTHS, POSITION_KEYS, AISStream, SyntheticAIS, distance_km  # noqa: E402
from oakland_core import world  # noqa: E402
from server import make_server  # noqa: E402

DELAY_H = 4


@pytest.fixture(scope="module")
def task():
    return world.make_task(7, "OICT", 1, "berth")


@pytest.fixture(autouse=True)
def no_key(monkeypatch):
    monkeypatch.delenv("AISSTREAM_API_KEY", raising=False)


def _delayed_plan(task) -> list[dict]:
    """The published plan with ship 0 berthing DELAY_H hours late, so it waits at the anchorage."""
    plan = [{"ship": s.id, "berth_hour": s.planned_hour, "section": s.planned_section, "cranes": s.std_cranes}
            for s in task.ships]
    plan[0]["berth_hour"] += DELAY_H
    return plan


def test_every_position_has_every_key(task):
    f = SyntheticAIS(task)
    seen = 0
    for h in range(0, task.horizon_h, 6):
        for p in f.positions(h + 0.25):
            assert set(p) == set(POSITION_KEYS)
            assert p["source"] == "synthetic" and p["destination"] == "US OAK" and p["ship_type"] == 70
            assert p["nav_status"] in ("under way", "at anchor", "moored")
            assert isinstance(p["mmsi"], int) and isinstance(p["heading_deg"], int)
            assert 0 <= p["cog_deg"] < 360 and p["sog_kn"] >= 0
            assert 37.7 < p["lat"] < 37.9 and -122.5 < p["lon"] < -122.2
            assert len(p["eta"]) == 16 and p["ts"].endswith("Z")
            seen += 1
    assert seen > 0


def test_at_arrival_hour_near_terminal(task):
    f = SyntheticAIS(task)
    for s in task.ships:
        p = f.position(s.id, float(s.arrival))
        assert p is not None
        assert distance_km((p["lat"], p["lon"]), BERTHS["OICT"]) < 3.0


def test_nav_status_progression(task):
    f = SyntheticAIS(task, _delayed_plan(task))
    s = task.ships[0]
    sched = f.schedule[s.id]
    assert sched["berth"] == s.planned_hour + DELAY_H and sched["arrival"] == s.arrival
    statuses = []
    t = sched["arrival"] - 3.0
    while t < sched["departure"] + 3.0:
        p = f.position(s.id, t)
        if p is not None and (not statuses or statuses[-1] != p["nav_status"]):
            statuses.append(p["nav_status"])
        t += 0.1
    assert statuses == ["under way", "at anchor", "under way", "moored", "under way"]
    anchored = f.position(s.id, sched["arrival"] + 1.0)
    assert anchored["nav_status"] == "at anchor" and anchored["sog_kn"] == 0
    moored = f.position(s.id, sched["berth"] + 1.0)
    assert moored["nav_status"] == "moored"
    assert distance_km((moored["lat"], moored["lon"]), BERTHS["OICT"]) < 1.5


def test_hour_zero_is_monday_pacific(task):
    f = SyntheticAIS(task)
    s = task.ships[0]
    p = f.position(s.id, float(s.arrival))
    assert p["ts"] == (feed.HOUR0_UTC + feed.timedelta(hours=s.arrival)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert feed.HOUR0_UTC.isoformat() == "2026-10-26T07:00:00+00:00"


def test_events_from_late_arrivals(task):
    late = world.make_task(7, "OICT", 1, "berth")
    late.ships[1].arrival += 6
    ev = SyntheticAIS(late).events(0)
    assert ev == [{"hour": 0.0, "ship": late.ships[1].name, "kind": "eta_update",
                   "new_arrival": late.ships[1].arrival}]
    assert SyntheticAIS(task).events(100) == []


def test_aisstream_without_key_does_not_connect(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("must not connect without a key")

    monkeypatch.setattr(AISStream, "start", boom)
    s = AISStream()
    assert s.enabled is False and s.connected is False and s._thread is None
    assert s.positions() == []


def test_aisstream_merges_messages():
    s = AISStream(api_key="test-key", start=False)
    assert "test-key" not in repr(s)
    s.handle({"MessageType": "PositionReport", "MetaData": {"MMSI": 366123456, "ShipName": "TEST ",
              "time_utc": "2026-10-25 12:00:00"},
              "Message": {"PositionReport": {"Latitude": 37.80, "Longitude": -122.33, "Sog": 0.1, "Cog": 90.0,
                                             "TrueHeading": 91, "NavigationalStatus": 5}}})
    s.handle({"MessageType": "ShipStaticData", "MetaData": {"MMSI": 366123456},
              "Message": {"ShipStaticData": {"Name": "TEST SHIP", "ImoNumber": 9123456,
                                             "Dimension": {"A": 200, "B": 50, "C": 20, "D": 12},
                                             "MaximumStaticDraught": 11.5, "Destination": "US OAK", "Type": 71,
                                             "Eta": {"Month": 10, "Day": 26, "Hour": 8, "Minute": 30}}}})
    [p] = s.positions()
    assert set(p) == set(POSITION_KEYS) and p["source"] == "aisstream"
    assert p["name"] == "TEST SHIP" and p["imo"] == "9123456" and p["nav_status"] == "moored"
    assert p["length_m"] == 250.0 and p["beam_m"] == 32.0 and p["eta"].endswith("-10-26T08:30")


def _get(port: int, path: str) -> tuple[int, dict]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    conn.request("GET", path)
    r = conn.getresponse()
    status, payload = r.status, json.loads(r.read().decode() or "null")
    conn.close()
    return status, payload


def test_ais_route(task):
    srv = make_server(OaklandEnv([task]), "127.0.0.1", 0)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        s0 = task.ships[0]
        st, out = _get(port, f"/ais?hour={s0.arrival + 1}")
        assert st == 200 and out["source"] == "synthetic" and out["hour"] == s0.arrival + 1
        assert out["positions"] and isinstance(out["events"], list)
        assert all(set(p) == set(POSITION_KEYS) for p in out["positions"])
        assert s0.name in {p["name"] for p in out["positions"]}
        st, _ = _get(port, "/ais?hour=soon")
        assert st == 400
        st, listing = _get(port, "/tasks")
        assert st == 200 and listing[0]["task_id"] == task.task_id
    finally:
        srv.shutdown()
        srv.server_close()
