/*
 * OakShips: procedural container ships for the Oakland berth replay (window.OakShips).
 *
 * A ship is built from a few numbers (length, beam, draught, line). The hull is lofted from cross-sections
 * (flared bow with a bulb, parallel midbody, transom stern); the deck carries hatch covers, lashing bridges and
 * instanced container stacks; the accommodation block, bridge, funnel, masts, lifeboats and anchor gear sit on top.
 * Ship calls in the demo fixtures are GENERATED, not real records, and the ships are a stylised representation,
 * not survey-grade models of real vessels.
 *
 * Contract: OakShips.makeShip(spec) -> {group, setLoad(f), setLights(on), setSpeed(mps), update(dt_s, t_h)}
 * with spec = {name, line, length_m, beam_m, draught_m, sections, seed}. Origin at the waterline, midship;
 * bow +x, starboard +z, y = 0 is the waterline. OakShips.layout(spec) is pure maths (no THREE) for node tests.
 *
 * Classic script, global THREE build (r147), no imports.
 */
(function () {
  "use strict";

  // ---------- constants ----------
  const BAY_PITCH = 13.2;          // one 40 ft bay plus lashing gap
  const ROW_PITCH = 2.5;
  const TIER_H = 2.59;             // 8 ft 6 in box
  const BOX_W = 2.44;
  const LEN_40 = 12.19;
  const LEN_20 = 6.06;
  const HATCH_H = 1.3;
  const DECK_H = 2.8;              // accommodation deck height
  const STATIONS = 24;
  const SECTION_PTS = 12;
  const MAX_BOXES = 4800;          // 10 triangles per box keeps a ship under 60k triangles
  const DARK_HULL = "#1f2a33";

  const LIVERIES = {
    "one": { hull: "#d6008f", funnel: "#d6008f", band: null, mark: "ONE", ink: "#ffffff" },
    "maersk": { hull: "#42b0d5", funnel: "#42b0d5", band: null, mark: "star", ink: "#ffffff" },
    "msc": { hull: DARK_HULL, funnel: "#f5c518", band: null, mark: "MSC", ink: "#1a1a1a" },
    "evergreen": { hull: "#1d8a3a", funnel: "#1d8a3a", band: "#ffffff", mark: "EG", ink: "#ffffff" },
    "cma cgm": { hull: DARK_HULL, funnel: "#0b3b8c", band: "#e4262c", mark: "CMA CGM", ink: "#ffffff" },
    "matson": { hull: "#0b3e8a", funnel: "#0b3e8a", band: "#f2b705", mark: "M", ink: "#f2b705" },
    "cosco": { hull: DARK_HULL, funnel: "#0a3d91", band: "#ffffff", mark: "COSCO", ink: "#ffffff" },
    "hapag-lloyd": { hull: DARK_HULL, funnel: "#f26b1d", band: null, mark: "HL", ink: "#ffffff" },
    "yang ming": { hull: DARK_HULL, funnel: "#0a4a8a", band: null, mark: "YM", ink: "#ffffff" },
    "hmm": { hull: DARK_HULL, funnel: "#e60b2c", band: null, mark: "HMM", ink: "#ffffff" },
    "wan hai": { hull: DARK_HULL, funnel: "#c8102e", band: null, mark: "WAN HAI", ink: "#ffffff" },
    "oocl": { hull: DARK_HULL, funnel: "#1c3f95", band: null, mark: "OOCL", ink: "#ffffff" },
    "zim": { hull: DARK_HULL, funnel: "#2a2a86", band: null, mark: "ZIM", ink: "#ffffff" },
    "pasha": { hull: DARK_HULL, funnel: "#0a5c36", band: null, mark: "PASHA", ink: "#ffffff" },
  };
  const BOX_COLORS = ["#d6008f", "#42b0d5", "#f5c518", "#1d8a3a", "#0b3b8c", "#e4262c", "#0b3e8a", "#0a3d91",
    "#f26b1d", "#0a4a8a", "#e60b2c", "#c8102e", "#1c3f95", "#2a2a86", "#0a5c36",
    "#8a3b1e", "#6f7a84", "#e8e8e8", "#1f4f9c", "#2e7d32"];

  // ---------- small helpers ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, u) => a + (b - a) * u;
  const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashStr(s) {
    let h = 2166136261;
    for (const ch of String(s || "")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return h >>> 0;
  }

  function seedOf(spec) {
    return spec.seed != null ? (spec.seed >>> 0) : hashStr((spec.name || "") + "|" + (spec.line || ""));
  }

  function livery(line) {
    const key = String(line || "").trim().toLowerCase();
    if (LIVERIES[key]) return LIVERIES[key];
    const h = hashStr(key);
    const words = String(line || "LINE").toUpperCase().split(/\s+/).filter(Boolean);
    return {
      hull: DARK_HULL, funnel: "hsl(" + (h % 360) + ", 60%, 42%)", band: null,
      mark: words.map((w) => w[0]).join("").slice(0, 3) || "X", ink: "#ffffff",
    };
  }

  // ---------- pure maths: hull ----------
  function shipClass(length_m) {
    if (length_m < 220) return "feeder";
    if (length_m < 330) return "panamax";
    return "neopanamax";
  }

  function hullDims(spec) {
    const L = +spec.length_m || 294;
    const B = +spec.beam_m || clamp(L * 0.135, 20, 61);
    const T = +spec.draught_m || clamp(L * 0.04, 7, 16);
    // Moulded depth about 0.085 x length (real feeders to neopanamaxes), so freeboard = depth - draught.
    const F = Math.max(0.085 * L - T, 0.45 * T);
    return { L, B, T, F, rake: 0.02 * L };
  }

  // Station parameters at u in [0, 1] (0 = transom, 1 = stem).
  function stationParams(u, dims) {
    const half = dims.B / 2;
    const p = { wDeck: half, wWL: half, keel: -dims.T, n: 7, rake: 0 };
    if (u > 0.8) {
      const q = (u - 0.8) / 0.2;
      p.wWL = Math.max(half * Math.pow(Math.max(0, 1 - Math.pow(q, 1.8)), 0.75), 0.25);
      p.wDeck = Math.max(half * Math.pow(Math.max(0, 1 - Math.pow(q, 2.6)), 0.6), 0.3);
      p.n = lerp(6, 1.3, Math.pow(q, 0.8));
      p.keel = -dims.T * (1 - 0.3 * smooth((q - 0.88) / 0.12));
      p.rake = dims.rake * smooth((q - 0.55) / 0.45);
    } else if (u < 0.18) {
      const q = 1 - u / 0.18;
      p.wDeck = half * (1 - 0.12 * q * q);
      p.wWL = half * (1 - 0.35 * Math.pow(q, 1.5));
      p.keel = -dims.T * (1 - 0.72 * Math.pow(q, 1.6));
      p.n = lerp(6, 2.2, q);
    }
    return p;
  }

  function stationX(u, dims) {
    return -dims.L / 2 + u * (dims.L - dims.rake);
  }

  function stationU(x, dims) {
    return clamp((x + dims.L / 2) / (dims.L - dims.rake), 0, 1);
  }

  // Half-width of the hull at station u and height y.
  function halfWidthAt(u, y, dims) {
    const p = stationParams(u, dims);
    if (y <= 0) {
      const h = clamp((y - p.keel) / (0 - p.keel), 0, 1);
      return p.wWL * Math.pow(Math.max(0, 1 - Math.pow(1 - h, p.n)), 1 / p.n);
    }
    const s = clamp(y / dims.F, 0, 1);
    return p.wWL + (p.wDeck - p.wWL) * Math.pow(s, 0.8);
  }

  // Half cross-section at station u: SECTION_PTS points {y, w, dx} from keel (w = 0) to deck edge.
  function sectionPoints(u, dims) {
    const p = stationParams(u, dims);
    const out = [];
    const under = 8;
    for (let k = 0; k < SECTION_PTS; k++) {
      let y;
      if (k < under) y = p.keel + (0 - p.keel) * Math.pow(k / (under - 1), 2.2);
      else y = dims.F * (k - under + 1) / (SECTION_PTS - under);
      const w = halfWidthAt(u, y, dims);
      const dx = p.rake * clamp((y - p.keel) / (dims.F - p.keel), 0, 1);
      out.push({ y, w, dx });
    }
    return out;
  }

  function stationList() {
    const us = [];
    for (let i = 0; i < STATIONS; i++) us.push(0.5 - 0.5 * Math.cos(Math.PI * i / (STATIONS - 1)));
    return us;
  }

  // ---------- pure maths: deck layout ----------
  function layout(spec) {
    const dims = hullDims(spec);
    const L = dims.L;
    const cls = shipClass(L);
    const bays = Math.max(3, Math.round(L / BAY_PITCH * 0.78));
    const rows = Math.max(3, Math.round(dims.B / ROW_PITCH));
    let tiers = cls === "feeder" ? 4 : cls === "panamax" ? 6 : 8;
    const decks = cls === "feeder" ? 6 : cls === "panamax" ? 8 : 10;
    const aftBays = Math.max(1, Math.round(bays * (cls === "neopanamax" ? 0.27 : 0.1)));
    const houseLen = clamp(0.065 * L, 14, 26);
    const rand = rng(seedOf(spec) ^ 0x5bd1e995);
    const twenty = [];
    for (let b = 0; b < bays; b++) twenty.push(rand() < 0.3);

    const xF = 0.41 * L;
    let build;
    for (;;) {
      build = { bayList: [], slots: [], house: null };
      let cursor = xF;
      for (let b = 0; b < bays; b++) {
        if (b === bays - aftBays) {
          build.house = { x1: cursor, x0: cursor - houseLen, decks };
          cursor -= houseLen;
        }
        const x = cursor - BAY_PITCH / 2;
        cursor -= BAY_PITCH;
        const uA = stationU(x - BAY_PITCH / 2, dims), uB = stationU(x + BAY_PITCH / 2, dims);
        const hw = Math.min(halfWidthAt(uA, dims.F, dims), halfWidthAt(uB, dims.F, dims));
        const bayRows = clamp(Math.floor((2 * hw - 0.8) / ROW_PITCH), 2, rows);
        let bayTiers = tiers;
        if (b === 0) bayTiers = tiers - 2;
        else if (b === 1 || b === bays - 1) bayTiers = tiers - 1;
        bayTiers = Math.max(1, bayTiers);
        const bay = { index: b, x, rows: bayRows, tiers: bayTiers, twenty: twenty[b] };
        build.bayList.push(bay);
        for (let t = 0; t < bayTiers; t++) {
          for (let r = 0; r < bayRows; r++) {
            const z = (r - (bayRows - 1) / 2) * ROW_PITCH;
            const y = dims.F + HATCH_H + t * TIER_H + TIER_H / 2;
            if (bay.twenty) {
              build.slots.push({ x: x - (LEN_20 + 0.07) / 2, y, z, len: LEN_20, tier: t, bay: b, row: r });
              build.slots.push({ x: x + (LEN_20 + 0.07) / 2, y, z, len: LEN_20, tier: t, bay: b, row: r });
            } else {
              build.slots.push({ x, y, z, len: LEN_40, tier: t, bay: b, row: r });
            }
          }
        }
      }
      build.aftEnd = cursor;
      if (build.slots.length <= MAX_BOXES || tiers <= 2) break;
      tiers -= 1;
    }
    // Bottom-up order: loading fills the lowest tier first, unloading empties the top tier first.
    build.slots.sort((a, b) => a.tier - b.tier || b.bay - a.bay || a.row - b.row || a.x - b.x);
    const teu = build.slots.reduce((s, c) => s + (c.len === LEN_40 ? 2 : 1), 0);
    return {
      cls, dims, bays, rows, tiers, decks, containers: build.slots.length, teu,
      bayList: build.bayList, slots: build.slots, house: build.house, deck: { fwd: xF, aft: build.aftEnd },
    };
  }

  // ---------- textures (lazy, cached where shared) ----------
  const cache = {};

  function canvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function glowTex() {
    if (cache.glow) return cache.glow;
    const c = canvas(64, 64);
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.2, "rgba(255,255,255,0.8)");
    g.addColorStop(0.5, "rgba(255,255,255,0.18)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    cache.glow = new THREE.CanvasTexture(c);
    return cache.glow;
  }

  function boxTex() {
    if (cache.box) return cache.box;
    const c = canvas(128, 32);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#e6e6e6";
    ctx.fillRect(0, 0, 128, 32);
    for (let i = 0; i < 128; i += 4) {
      ctx.fillStyle = (i / 4) % 2 ? "#ffffff" : "#c4c4c4";
      ctx.fillRect(i, 0, 2, 32);
    }
    ctx.fillStyle = "#8a8a8a";
    ctx.fillRect(0, 0, 128, 2);
    ctx.fillRect(0, 30, 128, 2);
    ctx.fillRect(0, 0, 2, 32);
    ctx.fillRect(126, 0, 2, 32);
    cache.box = new THREE.CanvasTexture(c);
    return cache.box;
  }

  function hullTex(color, dims) {
    const key = "hull" + color + Math.round(dims.T * 10) + "_" + Math.round(dims.F * 10);
    if (cache[key]) return cache[key];
    const H = 1024;
    const c = canvas(4, H);
    const ctx = c.getContext("2d");
    const row = (y) => (1 - (y + dims.T) / (dims.T + dims.F)) * H;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 4, H);
    ctx.fillStyle = "#e8e8e4";
    ctx.fillRect(0, row(0.6), 4, row(0) - row(0.6));
    ctx.fillStyle = "#9c2a22";
    ctx.fillRect(0, row(0), 4, H - row(0));
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(0, row(dims.F - 0.35), 4, Math.max(1, row(dims.F - 0.55) - row(dims.F - 0.35)));
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.LinearFilter;
    cache[key] = tex;
    return tex;
  }

  function textTex(text, color) {
    const fontPx = 96;
    const font = "700 " + fontPx + "px -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
    let c = canvas(16, 16);
    let ctx = c.getContext("2d");
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 24;
    c = canvas(w, 128);
    ctx = c.getContext("2d");
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, 12, 68);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return { tex, aspect: w / 128 };
  }

  // Window grid: day map (cream wall, dark glass) and emissive map (lit windows only).
  function windowTex(cols, rows, rand, tall) {
    const cw = 24, rh = 32;
    const W = Math.max(1, cols) * cw, H = Math.max(1, rows) * rh;
    const day = canvas(W, H), lit = canvas(W, H);
    const d = day.getContext("2d"), l = lit.getContext("2d");
    d.fillStyle = "#efede4";
    d.fillRect(0, 0, W, H);
    l.fillStyle = "#000000";
    l.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      const y0 = r * rh + (tall ? 6 : 12), hh = tall ? 20 : 10;
      if (tall) {
        d.fillStyle = "#1d2a33";
        d.fillRect(0, y0, W, hh);
        l.fillStyle = "rgba(255,214,150,0.55)";
        l.fillRect(0, y0, W, hh);
        continue;
      }
      for (let k = 0; k < cols; k++) {
        d.fillStyle = "#2b3640";
        d.fillRect(k * cw + 5, y0, cw - 10, hh);
        if (rand() < 0.55) {
          l.fillStyle = rand() < 0.8 ? "#ffd28a" : "#cfe6ff";
          l.fillRect(k * cw + 5, y0, cw - 10, hh);
        }
      }
    }
    return { map: new THREE.CanvasTexture(day), emissiveMap: new THREE.CanvasTexture(lit) };
  }

  function funnelTex(liv) {
    const W = 512, H = 256;
    const c = canvas(W, H);
    const ctx = c.getContext("2d");
    ctx.fillStyle = liv.funnel;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#151515";
    ctx.fillRect(0, 0, W, H * 0.14);
    if (liv.band) {
      ctx.fillStyle = liv.band;
      ctx.fillRect(0, H * 0.2, W, H * 0.07);
      ctx.fillRect(0, H * 0.82, W, H * 0.06);
    }
    for (const cx of [W * 0.25, W * 0.75]) {
      ctx.fillStyle = liv.ink;
      if (liv.mark === "star") {
        const R = H * 0.24, r = R * 0.42, cy = H * 0.55;
        ctx.beginPath();
        for (let i = 0; i < 14; i++) {
          const a = -Math.PI / 2 + i * Math.PI / 7;
          const rr = i % 2 ? r : R;
          ctx.lineTo(cx + rr * Math.cos(a) * 0.6, cy + rr * Math.sin(a));
        }
        ctx.closePath();
        ctx.fill();
      } else {
        const px = Math.min(H * 0.32, (W * 0.42) / Math.max(1, liv.mark.length) * 1.6);
        ctx.font = "800 " + Math.round(px) + "px -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.save();
        ctx.translate(cx, H * 0.55);
        ctx.scale(0.6, 1);
        ctx.fillText(liv.mark, 0, 0);
        ctx.restore();
      }
    }
    return new THREE.CanvasTexture(c);
  }

  function foamTex() {
    if (cache.foam) return cache.foam;
    const W = 256, H = 128;
    const c = canvas(W, H);
    const ctx = c.getContext("2d");
    const rand = rng(7);
    // u = 0 far astern, u = 1 at the transom; the V widens and fades astern.
    for (let i = 0; i < 2600; i++) {
      const u = rand();
      const spread = 0.12 + 0.38 * (1 - u);
      const side = rand() < 0.5 ? -1 : 1;
      const edge = rand() < 0.6;
      const v = 0.5 + side * (edge ? spread * (0.85 + 0.15 * rand()) : spread * rand() * 0.5);
      const a = 0.08 + 0.35 * u * u;
      ctx.fillStyle = "rgba(255,255,255," + a.toFixed(3) + ")";
      ctx.fillRect(u * W, v * H, 2 + rand() * 4, 1 + rand() * 2);
    }
    cache.foam = new THREE.CanvasTexture(c);
    return cache.foam;
  }

  // ---------- geometry builders ----------
  function hullGeometry(dims) {
    const us = stationList();
    const pos = [], uv = [], idx = [];
    const span = dims.T + dims.F;
    const push = (x, y, z) => {
      pos.push(x, y, z);
      uv.push((x + dims.L / 2) / dims.L, (y + dims.T) / span);
      return pos.length / 3 - 1;
    };
    const sections = us.map((u) => ({ x: stationX(u, dims), pts: sectionPoints(u, dims) }));
    // Sides: grid[side][i][k]
    const grid = [[], []];
    for (let s = 0; s < 2; s++) {
      const sign = s === 0 ? 1 : -1;
      for (const st of sections) grid[s].push(st.pts.map((p) => push(st.x + p.dx, p.y, sign * p.w)));
    }
    for (let i = 0; i < STATIONS - 1; i++) {
      for (let k = 0; k < SECTION_PTS - 1; k++) {
        let a = grid[0][i][k], b = grid[0][i + 1][k], c = grid[0][i + 1][k + 1], d = grid[0][i][k + 1];
        idx.push(a, b, c, a, c, d);
        a = grid[1][i][k]; b = grid[1][i + 1][k]; c = grid[1][i + 1][k + 1]; d = grid[1][i][k + 1];
        idx.push(a, c, b, a, d, c);
      }
    }
    // Transom: fan from the centre of the stern section.
    const st0 = sections[0];
    const yc = (st0.pts[0].y + dims.F) / 2;
    const cIdx = push(st0.x, yc, 0);
    const sb = st0.pts.map((p) => push(st0.x + p.dx, p.y, p.w));
    const pt = st0.pts.map((p) => push(st0.x + p.dx, p.y, -p.w));
    for (let k = 0; k < SECTION_PTS - 1; k++) {
      idx.push(cIdx, sb[k], sb[k + 1]);
      idx.push(cIdx, pt[k + 1], pt[k]);
    }
    idx.push(cIdx, sb[SECTION_PTS - 1], pt[SECTION_PTS - 1]);
    // Stem: close the last section.
    const stN = sections[STATIONS - 1];
    const sbN = stN.pts.map((p) => push(stN.x + p.dx, p.y, p.w));
    const ptN = stN.pts.map((p) => push(stN.x + p.dx, p.y, -p.w));
    for (let k = 0; k < SECTION_PTS - 1; k++) idx.push(sbN[k], ptN[k + 1], sbN[k + 1], sbN[k], ptN[k], ptN[k + 1]);
    const hullCount = idx.length;
    // Deck: strip between the two deck edges.
    const top = SECTION_PTS - 1;
    const dS = [], dP = [];
    for (const st of sections) {
      const p = st.pts[top];
      dS.push(push(st.x + p.dx, dims.F, p.w));
      dP.push(push(st.x + p.dx, dims.F, -p.w));
    }
    for (let i = 0; i < STATIONS - 1; i++) idx.push(dS[i], dS[i + 1], dP[i + 1], dS[i], dP[i + 1], dP[i]);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.addGroup(0, hullCount, 0);
    g.addGroup(hullCount, idx.length - hullCount, 1);
    g.computeVertexNormals();
    return g;
  }

  // Unit box without its bottom face (10 triangles) for container instances.
  function openBox() {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const index = Array.from(g.index.array);
    index.splice(18, 6);   // faces: +x, -x, +y, -y, +z, -z; drop -y
    g.setIndex(index);
    g.clearGroups();
    return g;
  }

  // Collects axis boxes (optional y rotation) into one InstancedMesh.
  function BoxBatch() {
    this.items = [];
  }
  BoxBatch.prototype.add = function (x, y, z, sx, sy, sz, color, ry) {
    this.items.push({ x, y, z, sx, sy, sz, color, ry: ry || 0 });
  };
  BoxBatch.prototype.build = function (material) {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, Math.max(1, this.items.length));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), col = new THREE.Color();
    const v = new THREE.Vector3(), s = new THREE.Vector3();
    this.items.forEach((it, i) => {
      q.setFromEuler(e.set(0, it.ry, 0));
      m.compose(v.set(it.x, it.y, it.z), q, s.set(it.sx, it.sy, it.sz));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, col.set(it.color));
    });
    mesh.count = this.items.length;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  function countTriangles(root) {
    let n = 0;
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const g = o.geometry;
      const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
      n += tris * (o.isInstancedMesh ? o.count : 1);
    });
    return Math.round(n);
  }

  // ---------- the ship ----------
  function makeShip(spec) {
    spec = spec || {};
    const lay = layout(spec);
    const dims = lay.dims;
    const { L, B, T, F } = dims;
    const liv = livery(spec.line);
    const rand = rng(seedOf(spec));
    const name = String(spec.name || "UNNAMED").toUpperCase();

    const group = new THREE.Group();
    group.name = "ship:" + name;
    const body = new THREE.Group();
    group.add(body);
    const lights = new THREE.Group();
    lights.visible = false;
    body.add(lights);
    const sprites = [];
    const glowMats = [];

    // Hull
    const hullMat = new THREE.MeshStandardMaterial({ map: hullTex(liv.hull, dims), roughness: 0.62, metalness: 0.25 });
    const deckMat = new THREE.MeshStandardMaterial({ color: "#56605e", roughness: 0.9, metalness: 0.1 });
    const hull = new THREE.Mesh(hullGeometry(dims), [hullMat, deckMat]);
    hull.castShadow = true;
    hull.receiveShadow = true;
    body.add(hull);
    // Bulbous bow
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshStandardMaterial({ color: "#9c2a22", roughness: 0.7 }));
    bulb.scale.set(0.035 * L, 0.26 * T, 0.075 * B);
    bulb.position.set(L / 2 - dims.rake - 0.012 * L, -0.62 * T, 0);
    body.add(bulb);

    const fx = new BoxBatch();
    const steelMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.75, metalness: 0.2 });

    // Rudder under the stern
    fx.add(-L / 2 + 0.012 * L, -0.55 * T, 0, 0.022 * L, 0.6 * T, 0.7, "#9c2a22");

    // Hatch covers and lashing bridges
    for (const bay of lay.bayList) {
      const w = bay.rows * ROW_PITCH + 0.6;
      const panels = bay.rows > 12 ? 3 : 2;
      const pw = w / panels;
      for (let p = 0; p < panels; p++) {
        fx.add(bay.x, F + HATCH_H / 2, -w / 2 + pw * (p + 0.5), BAY_PITCH - 1.3, HATCH_H, pw - 0.15, p % 2 ? "#5d6872" : "#58636c");
      }
      const xb = bay.x - BAY_PITCH / 2;
      if (bay.index === lay.bays - 1) continue;
      const hTop = Math.min(2, bay.tiers) * TIER_H;
      const base = F + HATCH_H;
      for (const hy of [TIER_H, hTop]) fx.add(xb, base + hy, 0, 0.8, 0.22, w, "#a3abb0");
      const posts = Math.max(2, Math.round(bay.rows / 3) + 1);
      for (let k = 0; k < posts; k++) fx.add(xb, base + hTop / 2, -w / 2 + k * w / (posts - 1), 0.35, hTop, 0.35, "#a3abb0");
    }

    // Forecastle breakwater and bow gear
    const fwdBay = lay.bayList[0];
    const bwX = fwdBay.x + BAY_PITCH / 2 + 2.5;
    const bwHw = halfWidthAt(stationU(bwX, dims), F, dims);
    for (const sgn of [1, -1]) {
      fx.add(bwX, F + 2.4, sgn * bwHw * 0.48, 0.5, 4.8, bwHw * 1.05, "#d7d9d6", -sgn * 0.35);
    }
    const anchorX = L / 2 - 0.045 * L;
    const aU = stationU(anchorX, dims);
    for (const sgn of [1, -1]) {
      const hwA = halfWidthAt(aU, F - 3, dims);
      fx.add(anchorX, F - 3.2, sgn * (hwA + 0.15), 2.4, 3.0, 0.5, "#232323");
      fx.add(anchorX, F - 1.6, sgn * (hwA + 0.05), 1.2, 1.0, 0.3, "#111111");
      // chain from hawse to windlass
      const wx = anchorX - 9, wz = sgn * 2.4, hz = sgn * (halfWidthAt(aU, F, dims) - 1.2);
      const ang = Math.atan2(hz - wz, anchorX - wx);
      for (let k = 0; k <= 12; k++) {
        const u = k / 12;
        fx.add(lerp(wx, anchorX, u), F + 0.18, lerp(wz, hz, u), 0.62, k % 2 ? 0.12 : 0.3, k % 2 ? 0.3 : 0.12, "#2a2a2a", -ang);
      }
      fx.add(wx - 0.6, F + 0.8, wz, 1.8, 1.6, 2.2, "#3c4a3f");
    }
    // Bow mast
    const bowMastX = L / 2 - 0.06 * L;
    fx.add(bowMastX, F + 6, 0, 0.5, 12, 0.5, "#e2e2dc");
    fx.add(bowMastX, F + 10.5, 0, 0.3, 0.3, 3, "#e2e2dc");

    // Accommodation block, bridge, funnel
    const house = lay.house;
    const slot = house.x1 - house.x0;
    const blockLen = slot * 0.55;
    const blockX = house.x1 - blockLen / 2 - 0.5;
    const houseU = stationU(blockX, dims);
    const deckHw = halfWidthAt(houseU, F, dims);
    const wHouse = Math.min(0.62 * B, 2 * deckHw - 4);
    const Hh = house.decks * DECK_H;
    const mkHouseMats = (lenX, lenZ, rows, tall) => {
      const fa = windowTex(Math.round(lenZ / 2.2), rows, rand, tall);
      const sd = windowTex(Math.round(lenX / 2.2), rows, rand, tall);
      const mk = (t) => new THREE.MeshStandardMaterial({ map: t.map, emissiveMap: t.emissiveMap, emissive: "#ffd9a0", emissiveIntensity: 0, roughness: 0.6 });
      const mFa = mk(fa), mSd = mk(sd);
      glowMats.push(mFa, mSd);
      const roof = new THREE.MeshStandardMaterial({ color: "#d9d9d2", roughness: 0.8 });
      return [mFa, mFa, roof, roof, mSd, mSd];
    };
    const block = new THREE.Mesh(new THREE.BoxGeometry(blockLen, Hh, wHouse), mkHouseMats(blockLen, wHouse, house.decks, false));
    block.position.set(blockX, F + Hh / 2, 0);
    block.castShadow = block.receiveShadow = true;
    body.add(block);
    const bridgeLen = Math.min(blockLen, 9);
    const bridgeX = house.x1 - bridgeLen / 2 - 0.3;
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(bridgeLen, 3, wHouse + 2), mkHouseMats(bridgeLen, wHouse + 2, 1, true));
    bridge.position.set(bridgeX, F + Hh + 1.5, 0);
    bridge.castShadow = true;
    body.add(bridge);
    const bridgeHw = halfWidthAt(stationU(bridgeX, dims), F, dims);
    fx.add(bridgeX + bridgeLen * 0.15, F + Hh + 0.3, 0, bridgeLen * 0.55, 0.6, 2 * bridgeHw, "#e6e6df");
    for (const sgn of [1, -1]) {
      fx.add(bridgeX + bridgeLen * 0.15, F + Hh + 1.6, sgn * (bridgeHw - 1.3), bridgeLen * 0.5, 2.0, 2.6, "#efede4");
      fx.add(bridgeX + bridgeLen * 0.15 + bridgeLen * 0.26, F + Hh + 1.9, sgn * (bridgeHw - 1.3), 0.1, 0.9, 2.4, "#1d2a33");
    }
    // Radar mast
    const roofY = F + Hh + 3;
    fx.add(bridgeX, roofY + 3.5, 0, 0.7, 7, 0.7, "#e2e2dc");
    fx.add(bridgeX, roofY + 5.5, 0, 0.5, 0.4, 7, "#e2e2dc");
    const radar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 5), new THREE.MeshStandardMaterial({ color: "#f0f0f0" }));
    radar.position.set(bridgeX, roofY + 7.4, 0);
    body.add(radar);
    // Funnel
    const fLen = slot * 0.3, fWid = Math.min(wHouse * 0.42, 9);
    const fH = Hh * 0.45 + 8;
    const fGeo = new THREE.CylinderGeometry(0.5, 0.56, 1, 24, 1, false, -Math.PI / 2);
    const funnel = new THREE.Mesh(fGeo, [
      new THREE.MeshStandardMaterial({ map: funnelTex(liv), roughness: 0.55 }),
      new THREE.MeshStandardMaterial({ color: "#111111", roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ color: "#111111", roughness: 0.9 }),
    ]);
    funnel.scale.set(fLen, fH, fWid);
    funnel.position.set(house.x0 + slot * 0.22, F + Hh * 0.62 + fH / 2, 0);
    funnel.castShadow = true;
    body.add(funnel);
    fx.add(house.x0 + slot * 0.22, F + Hh * 0.31, 0, slot * 0.36, Hh * 0.62, wHouse * 0.7, "#e4e3dc");
    // Lifeboats on davits
    const boatMat = new THREE.MeshStandardMaterial({ color: "#f26a1b", roughness: 0.6 });
    for (const sgn of [1, -1]) {
      const boat = new THREE.Mesh(new THREE.CapsuleGeometry(1.3, 5.2, 4, 10), boatMat);
      boat.rotation.z = Math.PI / 2;
      boat.position.set(blockX - blockLen * 0.1, F + DECK_H * 2.4, sgn * (wHouse / 2 + 1.5));
      boat.castShadow = true;
      body.add(boat);
      fx.add(blockX - blockLen * 0.1 - 2.6, F + DECK_H * 2.4 + 1.2, sgn * (wHouse / 2 + 0.9), 0.3, 2.8, 1.6, "#d8d8d2");
      fx.add(blockX - blockLen * 0.1 + 2.6, F + DECK_H * 2.4 + 1.2, sgn * (wHouse / 2 + 0.9), 0.3, 2.8, 1.6, "#d8d8d2");
    }
    body.add(fx.build(steelMat));

    // Containers (one InstancedMesh, ordered bottom-up)
    const own = new THREE.Color(liv.funnel);
    const boxMat = new THREE.MeshStandardMaterial({ map: boxTex(), roughness: 0.8, metalness: 0.15 });
    const boxes = new THREE.InstancedMesh(openBox(), boxMat, Math.max(1, lay.slots.length));
    {
      const m = new THREE.Matrix4(), col = new THREE.Color();
      lay.slots.forEach((s, i) => {
        m.makeScale(s.len, TIER_H - 0.06, BOX_W);
        m.setPosition(s.x, s.y, s.z);
        boxes.setMatrixAt(i, m);
        if (rand() < 0.35) col.copy(own);
        else col.set(BOX_COLORS[Math.floor(rand() * BOX_COLORS.length)]);
        col.offsetHSL(0, 0, (rand() - 0.5) * 0.06);
        boxes.setColorAt(i, col);
      });
    }
    boxes.frustumCulled = false;
    boxes.castShadow = true;
    boxes.receiveShadow = true;
    body.add(boxes);

    // Names on both bow quarters and the stern
    const nameH = clamp(L / 90, 1.8, 3.6);
    const nameTex = textTex(name, "#f4f4f0");
    const nameMat = new THREE.MeshBasicMaterial({ map: nameTex.tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const nameW = nameH * nameTex.aspect;
    const nameGeo = new THREE.PlaneGeometry(nameW, nameH);
    const nx = L / 2 - 0.12 * L, ny = F - nameH * 0.9;
    const nu = stationU(nx, dims);
    const nhw = halfWidthAt(nu, ny, dims);
    const slope = Math.atan2(halfWidthAt(stationU(nx + 2, dims), ny, dims) - halfWidthAt(stationU(nx - 2, dims), ny, dims), 4);
    for (const sgn of [1, -1]) {
      const pl = new THREE.Mesh(nameGeo, nameMat);
      pl.position.set(nx, ny, sgn * (nhw + 0.08));
      pl.rotation.y = sgn > 0 ? -slope : Math.PI + slope;
      body.add(pl);
    }
    const sternU = 0;
    const sternHw = halfWidthAt(sternU, ny, dims);
    const sternPl = new THREE.Mesh(nameGeo, nameMat);
    sternPl.scale.setScalar(Math.min(1, (sternHw * 1.6) / nameW));
    sternPl.position.set(stationX(0, dims) - 0.08, ny, 0);
    sternPl.rotation.y = -Math.PI / 2;
    body.add(sternPl);

    // Lights: sprite glows only (no PointLights)
    const addGlow = (x, y, z, size, color, opacity) => {
      const mat = new THREE.SpriteMaterial({ map: glowTex(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
      const sp = new THREE.Sprite(mat);
      sp.position.set(x, y, z);
      sp.scale.set(size, size, 1);
      lights.add(sp);
      sprites.push(sp);
      return sp;
    };
    const wingX = bridgeX + bridgeLen * 0.15;
    addGlow(wingX, F + Hh + 2.4, bridgeHw + 0.2, 4, "#33ff66", 1);    // starboard green
    addGlow(wingX, F + Hh + 2.4, -bridgeHw - 0.2, 4, "#ff2a2a", 1);   // port red
    addGlow(bowMastX, F + 12.3, 0, 4, "#ffffff", 1);                 // forward masthead
    addGlow(bridgeX, roofY + 7.2, 0, 4.5, "#ffffff", 1);              // aft masthead
    addGlow(stationX(0, dims) - 0.3, F + 1.5, 0, 3.5, "#ffffff", 0.9); // stern light
    for (const bay of lay.bayList) {
      if (bay.index % 3 !== 1) continue;
      const y = F + HATCH_H + Math.min(2, bay.tiers) * TIER_H + 0.6;
      for (const sgn of [1, -1]) addGlow(bay.x - BAY_PITCH / 2, y, sgn * (bay.rows * ROW_PITCH / 2 + 0.3), 9, "#ffd7a0", 0.32);
    }
    for (const sgn of [1, -1]) addGlow(house.x1 + 0.4, F + Hh * 0.7, sgn * wHouse * 0.35, 10, "#ffe2b8", 0.3);
    addGlow(bowMastX, F + 8, 0, 11, "#ffe2b8", 0.25);

    // Wake and bow wave (outer group, unaffected by roll)
    const foamMat = new THREE.MeshBasicMaterial({ map: foamTex(), transparent: true, opacity: 0, depthWrite: false });
    const wakeLen = 0.9 * L;
    const wake = new THREE.Mesh(new THREE.PlaneGeometry(wakeLen, B * 2.6), foamMat);
    wake.rotation.x = -Math.PI / 2;
    wake.position.set(-L / 2 - wakeLen / 2 + 3, 0.06, 0);
    wake.renderOrder = 2;
    group.add(wake);
    const bowMat = foamMat.clone();
    const bowWave = new THREE.Mesh(new THREE.PlaneGeometry(0.22 * L, B * 1.4), bowMat);
    bowWave.rotation.x = -Math.PI / 2;
    bowWave.position.set(L / 2 - 0.1 * L, 0.07, 0);
    bowWave.renderOrder = 2;
    group.add(bowWave);

    // ---------- behaviour ----------
    const state = { load: 1, speed: 0, foam: 0, t: rand() * 100, lightsOn: false };
    const phase1 = rand() * Math.PI * 2, phase2 = rand() * Math.PI * 2;
    const omega = 2 * Math.PI / 7;
    const rollAmp = 0.2 / (B / 2);
    let lift = 0;

    function setLoad(f) {
      state.load = clamp(+f || 0, 0, 1);
      boxes.count = Math.round(state.load * lay.slots.length);
      lift = (1 - state.load) * 0.2 * T;   // an empty ship floats higher, showing more antifouling
      body.position.y = lift;
    }

    function setLights(on) {
      state.lightsOn = !!on;
      lights.visible = state.lightsOn;
      for (const m of glowMats) m.emissiveIntensity = state.lightsOn ? 1 : 0;
    }

    function setSpeed(mps) {
      state.speed = Math.max(0, +mps || 0);
    }

    function update(dt_s, t_h) {
      const dt = Math.max(0, +dt_s || 0);
      state.t += dt;
      const t = state.t;
      body.position.y = lift + 0.2 * Math.sin(omega * t + phase1);
      body.rotation.x = rollAmp * Math.sin(omega * t + phase2);
      body.rotation.z = 0.0012 * Math.sin(omega * 0.7 * t + phase1);
      radar.rotation.y += dt * 2.5;
      const target = clamp(state.speed / 6, 0, 1);
      state.foam += (target - state.foam) * Math.min(1, dt * 0.4);
      foamMat.opacity = 0.75 * state.foam;
      bowMat.opacity = 0.6 * state.foam;
      wake.visible = bowWave.visible = state.foam > 0.01;
      const tw = state.lightsOn ? 0.85 + 0.15 * Math.sin(t * 9) : 1;
      sprites[0].material.opacity = tw;
      sprites[1].material.opacity = tw;
    }

    setLoad(1);
    setLights(false);
    update(0, 0);

    group.userData = { name, line: spec.line, sections: spec.sections, layout: { cls: lay.cls, bays: lay.bays, rows: lay.rows, tiers: lay.tiers, containers: lay.containers, teu: lay.teu } };
    const triangles = countTriangles(group);
    return { group, setLoad, setLights, setSpeed, update, layout: lay, triangles };
  }

  window.OakShips = {
    makeShip,
    layout,
    shipClass,
    hullDims,
    stationParams,
    sectionPoints,
    halfWidthAt,
    livery,
  };
})();
