#!/usr/bin/env python3
"""
Bake the raw OpenStreetMap extracts in this folder into scene metres and write the dataset block of
../oakland_geo.js (between the BEGIN GEO DATA and END GEO DATA markers; the runtime code around it is hand-written).

Projection: equirectangular around lat 37.8000, lon -122.3200.
  x = (lon - lon0) * cos(lat0) * 111320      (east)
  z = -(lat - lat0) * 110574                 (z points SOUTH)
Polylines are simplified with Douglas-Peucker at 3 m. Standard library only.

Data (c) OpenStreetMap contributors, ODbL 1.0. The result is a stylised map, not a survey-grade twin.

Usage: python3 bake_geo.py
"""
import json
import math
import os
import re
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "oakland_geo.js")

LAT0, LON0 = 37.8000, -122.3200
COS0 = math.cos(math.radians(LAT0))
# scene box for clipping (metres): a little wider than the fetched bbox
XMIN, XMAX, ZMIN, ZMAX = -5200.0, 7600.0, -4000.0, 4600.0
# the port area, for picking terminal polygons and buildings
PORT = (-2300.0, 2700.0, -2700.0, 1000.0)
SECTION_M = 42.0


def proj(p):
    return ((p["lon"] - LON0) * COS0 * 111320.0, -(p["lat"] - LAT0) * 110574.0)


def load(name):
    path = os.path.join(HERE, name + ".json")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return json.load(f).get("elements", [])


# ---------------------------------------------------------------- geometry helpers

def dp(pts, tol=3.0):
    """Douglas-Peucker simplification (iterative)."""
    if len(pts) < 3:
        return list(pts)
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, az = pts[a]
        bx, bz = pts[b]
        dx, dz = bx - ax, bz - az
        ll = math.hypot(dx, dz)
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, pz = pts[i]
            if ll < 1e-9:
                d = math.hypot(px - ax, pz - az)
            else:
                d = abs(dx * (az - pz) - dz * (ax - px)) / ll
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def area(ring):
    s = 0.0
    for i in range(len(ring)):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % len(ring)]
        s += x1 * z2 - x2 * z1
    return s / 2.0


def centroid(ring):
    n = len(ring)
    return (sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n)


def inside(pt, ring):
    x, z = pt
    c = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, zi = ring[i]
        xj, zj = ring[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            c = not c
        j = i
    return c


def in_box(p, box=(XMIN, XMAX, ZMIN, ZMAX)):
    return box[0] <= p[0] <= box[1] and box[2] <= p[1] <= box[3]


def clip_line(pts):
    """Split a polyline into the runs that lie inside the scene box."""
    runs, cur = [], []
    for p in pts:
        if in_box(p):
            cur.append(p)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= 2]


def r1(pts):
    return [[round(x, 1), round(z, 1)] for x, z in pts]


# ---------------------------------------------------------------- coastline to land polygons

def perim_param(p):
    """Position of a point on the scene box perimeter, walking counter-clockwise on the map (north up)."""
    x, z = p
    w, h = XMAX - XMIN, ZMAX - ZMIN
    # distance to each edge; snap to the nearest
    d = {"S": ZMAX - z, "E": XMAX - x, "N": z - ZMIN, "W": x - XMIN}
    e = min(d, key=d.get)
    # map CCW with north up: south edge west to east, east edge south to north, north edge east to west, west edge north to south
    if e == "S":
        return x - XMIN
    if e == "E":
        return w + (ZMAX - z)
    if e == "N":
        return w + h + (XMAX - x)
    return 2 * w + h + (z - ZMIN)


CORNERS = None


def corners():
    w, h = XMAX - XMIN, ZMAX - ZMIN
    return [(w, (XMAX, ZMAX)), (w + h, (XMAX, ZMIN)), (2 * w + h, (XMIN, ZMIN)), (2 * w + 2 * h, (XMIN, ZMAX))]


def close_runs(runs):
    """OSM coastline keeps land on the left. Walk the box boundary CCW from each exit to the next entry."""
    per = 2 * (XMAX - XMIN) + 2 * (ZMAX - ZMIN)
    entries = [(perim_param(r[0]), i) for i, r in enumerate(runs)]
    used = [False] * len(runs)
    polys = []
    for start in range(len(runs)):
        if used[start]:
            continue
        ring = []
        i = start
        while not used[i]:
            used[i] = True
            ring.extend(runs[i])
            t_exit = perim_param(runs[i][-1])
            # next entry counter-clockwise from this exit
            best, bj = None, None
            for t_in, j in entries:
                dt = (t_in - t_exit) % per
                if best is None or dt < best:
                    best, bj = dt, j
            for tc, c in corners() + [(t + per, c) for t, c in corners()]:
                if t_exit < tc < t_exit + best:
                    ring.append(c)
            i = bj
        polys.append(ring)
    return polys


def coast_polygons():
    ways = [e for e in load("coast") if e["type"] == "way"]
    closed, open_ways = [], {}
    for w in ways:
        if w["nodes"][0] == w["nodes"][-1]:
            closed.append([proj(p) for p in w["geometry"]])
        else:
            open_ways[w["id"]] = w
    # join open ways end to start into chains
    by_start = {w["nodes"][0]: w for w in open_ways.values()}
    ends = {w["nodes"][-1] for w in open_ways.values()}
    chains = []
    done = set()
    heads = [w for w in open_ways.values() if w["nodes"][0] not in ends] or list(open_ways.values())[:1]
    for h in heads:
        chain, w = [], h
        while w and w["id"] not in done:
            done.add(w["id"])
            g = [proj(p) for p in w["geometry"]]
            chain.extend(g if not chain else g[1:])
            w = by_start.get(w["nodes"][-1])
        chains.append(chain)
    runs = []
    for c in chains:
        runs.extend(clip_line(c))
    polys = close_runs(runs) if runs else []
    out = []
    for ring in polys + closed:
        ring = dp(ring, 3.0)
        if abs(area(ring)) < 2000 or not any(in_box(p) for p in ring):
            continue
        out.append(ring)
    return out


# ---------------------------------------------------------------- terminals and their quay frames

TERMINAL_DEFS = {
    # quay line digitised from the OSM terminal polygons (way ids) and checked against the real facts:
    # a, b = the two ends of the straight quay face, section 1 starts at a. water_side +1 means the water is on
    # the local +z side, so for the north-west facing Outer Harbor quays section 1 sits at the north-east end.
    "OICT": {"label": "OICT (SSA Marine), berths 55-59", "berths": "55-59", "sections": 50,
             "a": (27234584, (-467, 133)), "b": (27234567, (1270, 694)), "harbor": "Middle Harbor"},
    "TraPac": {"label": "TraPac, berths 25-33", "berths": "25-33", "sections": 31,
               "a": (27234770, (599, -2140)), "b": (27234676, (-237, -1141)), "harbor": "Outer Harbor", "end_at_b": True},
    "Everport": {"label": "Everport (Ben E. Nutter), berths 35-38", "berths": "35-38", "sections": 15,
                 "a": (27234604, (-1450, -1010)), "b": (27234604, (-1991, -638)), "harbor": "Outer Harbor", "inset": 13},
    "Matson": {"label": "Matson, berths 61-63", "berths": "61-63", "sections": 13,
               "a": (27234534, (1560, 707)), "b": (27234534, (2106, 731)), "harbor": "Inner Harbor"},
}


def terminal_frames():
    out = {}
    for name, d in TERMINAL_DEFS.items():
        (ax, az), (bx, bz) = d["a"][1], d["b"][1]
        h = math.atan2(bz - az, bx - ax)
        L = d["sections"] * SECTION_M
        ux, uz = math.cos(h), math.sin(h)
        if d.get("end_at_b"):
            ox, oz = bx - ux * L, bz - uz * L
        else:
            ins = d.get("inset", 0)
            ox, oz = ax + ux * ins, az + uz * ins
        out[name] = {
            "origin": [round(ox, 1), round(oz, 1)], "heading_rad": round(h, 5), "sections": d["sections"],
            "water_side": 1, "label": d["label"], "berths": d["berths"], "harbor": d["harbor"],
            "length_m": L, "osm_ways": sorted({d["a"][0], d["b"][0]}),
        }
    return out


# ---------------------------------------------------------------- areas, lines, buildings, labels

PORT_KEEP = re.compile(r"Port Of Oakland|Intermodal|Oakland International Gateway|Outer Harbor|Caltrans .*Bay Bridge", re.I)


def areas():
    res = []
    for e in load("land"):
        if e["type"] != "way" or "geometry" not in e or e["nodes"][0] != e["nodes"][-1]:
            continue
        t = e.get("tags", {})
        ring = dp([proj(p) for p in e["geometry"]][:-1], 3.0)
        if len(ring) < 3:
            continue
        c = centroid(ring)
        a = abs(area(ring))
        kind = None
        if t.get("leisure") == "park" and a > 15000 and in_box(c):
            kind = "park"
        elif t.get("landuse") in ("industrial", "port", "railway") and (PORT_KEEP.search(t.get("name", "")) or
                                                                         (in_box(c, PORT) and a > 20000)):
            kind = "terminal"
        elif t.get("man_made") in ("pier", "breakwater") and a > 400 and in_box(c):
            kind = "pier"
        if kind:
            res.append({"kind": kind, "name": t.get("name", ""), "points": r1(ring)})
    return res


def lines(name, pick, tol=3.0, min_len=60.0):
    res = []
    for e in load(name):
        if e["type"] != "way" or "geometry" not in e:
            continue
        t = e.get("tags", {})
        k = pick(t)
        if not k:
            continue
        for run in clip_line([proj(p) for p in e["geometry"]]):
            run = dp(run, tol)
            ln = sum(math.hypot(run[i + 1][0] - run[i][0], run[i + 1][1] - run[i][1]) for i in range(len(run) - 1))
            if ln >= min_len:
                res.append({"kind": k, "name": t.get("name", ""), "points": r1(run)})
    return res


def piers_open():
    return lines("land", lambda t: t.get("man_made") if t.get("man_made") in ("pier", "breakwater") else None,
                 min_len=40.0)


def buildings():
    res = []
    for e in load("buildings"):
        if e["type"] != "way" or "geometry" not in e:
            continue
        ring = dp([proj(p) for p in e["geometry"]][:-1], 2.0)
        if len(ring) < 3 or abs(area(ring)) < 150 or not in_box(centroid(ring), PORT):
            continue
        hgt = 8 + (zlib.crc32(str(e["id"]).encode()) % 7)
        res.append({"h": hgt, "points": r1(ring)})
    return res


def water_polys():
    res = []
    for e in load("water"):
        if e["type"] != "way" or "geometry" not in e or e["nodes"][0] != e["nodes"][-1]:
            continue
        if e.get("tags", {}).get("natural") != "water":
            continue
        ring = dp([proj(p) for p in e["geometry"]][:-1], 3.0)
        if len(ring) >= 3 and abs(area(ring)) > 20000 and in_box(centroid(ring)):
            res.append(r1(ring))
    for e in load("water"):
        # Lake Merritt is a multipolygon relation: stitch its outer members in order
        if e["type"] == "relation" and e.get("tags", {}).get("natural") == "water":
            ring = []
            for m in e.get("members", []):
                if m.get("role") == "outer" and "geometry" in m:
                    g = [proj(p) for p in m["geometry"]]
                    if ring and math.hypot(ring[-1][0] - g[-1][0], ring[-1][1] - g[-1][1]) < 1:
                        g = g[::-1]
                    ring.extend(g)
            ring = dp(ring, 3.0)
            if len(ring) >= 3 and abs(area(ring)) > 20000 and in_box(centroid(ring)):
                res.append(r1(ring))
    return res


def labels(frames):
    lab = [
        {"text": "Outer Harbor", "x": -700, "z": -1550, "kind": "water"},
        {"text": "Middle Harbor Shoreline Park", "x": -780, "z": -220, "kind": "park"},
        {"text": "Oakland Estuary (Inner Harbor)", "x": 1300, "z": 1000, "kind": "water"},
        {"text": "Alameda", "x": 1300, "z": 2400, "kind": "place"},
        {"text": "San Francisco Bay", "x": -2800, "z": 300, "kind": "water"},
        {"text": "Bay Bridge (east span)", "x": -2300, "z": -1950, "kind": "bridge"},
        {"text": "West Oakland", "x": 2600, "z": -900, "kind": "place"},
        {"text": "Downtown Oakland", "x": 4900, "z": -400, "kind": "place"},
        {"text": "Howard Terminal (not modelled)", "x": 3200, "z": 420, "kind": "terminal"},
        {"text": "to San Francisco (8 km west)", "x": -4900, "z": -700, "kind": "direction"},
    ]
    for name, f in frames.items():
        mid = f["length_m"] / 2
        h = f["heading_rad"]
        lab.append({"text": f["label"], "x": round(f["origin"][0] + mid * math.cos(h) + 160 * math.sin(h)),
                    "z": round(f["origin"][1] + mid * math.sin(h) - 160 * math.cos(h)), "kind": "terminal"})
    seen = {l["text"] for l in lab}
    for e in load("places"):
        t = e.get("tags", {})
        if e["type"] == "node" and t.get("place") in ("island", "islet", "suburb", "quarter", "city") and t.get("name"):
            x, z = proj(e)
            if in_box((x, z)) and t["name"] not in seen:
                seen.add(t["name"])
                lab.append({"text": t["name"], "x": round(x), "z": round(z), "kind": "place"})
    return lab


def main():
    frames = terminal_frames()
    land = coast_polygons()
    # classify the coast polygons: Alameda is the big one south of the estuary
    land_info = []
    for ring in land:
        c = centroid(ring)
        a = abs(area(ring))
        if a > 4e6 and c[1] > 1500:
            kind = "alameda"
        elif a > 4e6:
            kind = "mainland"
        else:
            kind = "island"
        land_info.append({"kind": kind, "area_m2": round(a)})
    quays = []
    for name, f in frames.items():
        h = f["heading_rad"]
        ox, oz = f["origin"]
        L = f["length_m"]
        quays.append({"name": name, "berths": f["berths"],
                      "points": [[ox, oz], [round(ox + L * math.cos(h), 1), round(oz + L * math.sin(h), 1)]]})
    bridge = lines("bridge", lambda t: "deck" if ("I 80" in (t.get("ref") or "") or "Bay Bridge" in t.get("name", ""))
                   and t.get("highway") in ("motorway", "cycleway") else None, tol=4.0, min_len=200.0)
    bridge = [b for b in bridge if min(p[0] for p in b["points"]) < -600]
    roads = lines("roads", lambda t: t.get("highway") if t.get("highway") in ("motorway", "trunk", "primary") else None,
                  tol=4.0, min_len=80.0)
    rails = lines("rails", lambda t: "rail" if t.get("railway") == "rail" and
                  t.get("service") not in ("siding", "spur", "yard", "crossover") else None, tol=3.0, min_len=120.0)
    data = {
        "origin": {"lat": LAT0, "lon": LON0},
        "source": "OpenStreetMap contributors (ODbL 1.0), fetched via Overpass; terminal quay lines digitised from OSM terminal polygons",
        "land": [r1(r) for r in land],
        "landInfo": land_info,
        "areas": areas(),
        "water": water_polys(),
        "quays": quays,
        "piers": piers_open(),
        "bridge": bridge,
        "roads": roads,
        "rails": [{"points": r["points"]} for r in rails],
        "buildings": buildings(),
        "labels": labels(frames),
        "terminals": frames,
    }
    blob = json.dumps(data, separators=(",", ":"))
    with open(OUT) as f:
        js = f.read()
    a = js.index("/* BEGIN GEO DATA */")
    b = js.index("/* END GEO DATA */")
    js = js[:a] + "/* BEGIN GEO DATA */\n  var DATA = " + blob + ";\n  " + js[b:]
    with open(OUT, "w") as f:
        f.write(js)
    print("land", len(data["land"]), [i["kind"] for i in land_info], "areas", len(data["areas"]), "water", len(data["water"]),
          "bridge", len(bridge), "roads", len(roads), "rails", len(data["rails"]), "buildings", len(data["buildings"]),
          "labels", len(data["labels"]), "bytes", len(js))


if __name__ == "__main__":
    main()
