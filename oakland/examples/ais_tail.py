"""Print the AIS ship feed: synthetic positions of a generated OICT task at hours 0, 12 and 24, or the real
aisstream.io stream around the Bay for 20 seconds when AISSTREAM_API_KEY is set.

    python examples/ais_tail.py [--seed 7] [--seconds 20]

One JSON position per line. Ship calls and synthetic positions are GENERATED (not real records); routes and berth
coordinates are a stylised representation.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from feed import AISStream, SyntheticAIS  # noqa: E402
from oakland_core import world  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="Print the AIS ship feed (synthetic, or real with AISSTREAM_API_KEY).")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--seconds", type=float, default=20.0)
    a = ap.parse_args()
    try:
        if os.environ.get("AISSTREAM_API_KEY"):
            stream = AISStream()
            print(f"# aisstream.io, Bay box, {a.seconds:.0f} s", flush=True)
            seen: dict[int, str] = {}
            end = time.time() + a.seconds
            while time.time() < end:
                for p in stream.positions():
                    if seen.get(p["mmsi"]) != p["ts"]:
                        seen[p["mmsi"]] = p["ts"]
                        print(json.dumps(p), flush=True)
                time.sleep(1)
            stream.close()
            if not seen:
                print(f"# no positions received ({stream.error or 'nothing in the box yet'})")
            return
        task = world.make_task(a.seed, "OICT", 1, "berth")
        feed = SyntheticAIS(task)
        for hour in (0, 12, 24):
            for p in feed.positions(hour):
                print(json.dumps(p))
            for e in feed.events(hour):
                print(json.dumps(e))
    except BrokenPipeError:   # piped into head
        sys.stdout = None


if __name__ == "__main__":
    main()
