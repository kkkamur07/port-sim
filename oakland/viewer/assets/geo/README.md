# OakGeo source data

Raw map extracts and the bake script behind `../oakland_geo.js` (`window.OakGeo`), the Port of Oakland map used by
the 3D berth replay. The map is a stylised representation of the port, not a survey-grade digital twin. Ship calls
drawn on top of it are GENERATED, not real records.

## Licence

All `*.json` files here are OpenStreetMap data, (c) OpenStreetMap contributors, available under the
Open Database License (ODbL) 1.0: https://www.openstreetmap.org/copyright. The baked dataset inside
`../oakland_geo.js` is a derived database of that data and is under the same ODbL 1.0 terms. Any page that shows the
map must credit "(c) OpenStreetMap contributors".

## Source

Fetched on 2026-10-25 from the Overpass API (https://overpass-api.de/api/interpreter, fallback
https://overpass.kumi.systems/api/interpreter) for the bbox lat 37.760 to 37.835, lon -122.360 to -122.245, with
`out geom` (full way geometry, so ways crossing the bbox edge are complete).

| file | Overpass filter |
|---|---|
| `coast.json` | `way[natural=coastline]` |
| `land.json` | `way[landuse~industrial\|port\|railway]`, `relation[landuse~industrial\|port]`, `way[man_made~pier\|quay\|breakwater]`, `way/relation[leisure=park]` |
| `water.json` | `way/relation[natural=water]`, `way[waterway]` |
| `bridge.json` | `way[bridge][name~"Bay Bridge"]`, `way[highway=motorway][bridge]` |
| `roads.json` | `way[highway~motorway\|trunk\|primary]` (only present if the fetch succeeded, see below) |
| `rails.json` | `way[railway=rail]` |
| `buildings.json` | `way[building]` in lat 37.790 to 37.815, lon -122.335 to -122.270, then trimmed to ways whose centroid lies in the port area (scene x -2300 to 2700, z -2700 to 1000) |
| `places.json` | `node[place]`, `node[name][seamark:type]` |

## Baking

    python3 bake_geo.py

Standard library only. It projects to scene metres with an equirectangular projection around lat 37.8000,
lon -122.3200 (`x = (lon - lon0) cos(lat0) 111320`, `z = -(lat - lat0) 110574`, so z points south), simplifies
polylines with Douglas-Peucker at 3 m, joins the coastline ways into chains, clips them to the scene box and closes
them along the box edge (OSM keeps land on the left of a coastline way) into land polygons, and rewrites the block
between `/* BEGIN GEO DATA */` and `/* END GEO DATA */` in `../oakland_geo.js`.

## Terminal quay frames

`OakGeo.terminalFrame(name)` comes from `TERMINAL_DEFS` in `bake_geo.py`: each quay face is the straight edge of the
OSM terminal polygon named there, sized to `sections x 42 m` from the real facts (OICT 50, TraPac 31, Everport 15,
Matson 13):

- OICT (berths 55-59): the south face of the Middle Harbor fill (OSM "Hanjin Terminal" plus "Stevedoring Services Of
  America Terminal"), section 1 at the west corner by Middle Harbor Shoreline Park, water to the south (the Inner
  Harbor entrance channel). The 2,100 m run ends about 70 m past the polygon corner.
- TraPac (berths 25-33): the north-west face of the Outer Harbor wharf (OSM "Transbay Container Terminal" and
  "Maersk Sealand Terminal"), ending at the corner with the Seventh Street pier.
- Everport (berths 35-38, Ben E. Nutter): the north-west face of the Seventh Street pier tip.
- Matson (berths 61-63): the east part of the estuary face of the OSM "APL Terminal" polygon.

`water_side` is always +1 (water at local +z), so on the two north-west facing Outer Harbor quays section 1 sits at
the north-east end of the face rather than the west end.
