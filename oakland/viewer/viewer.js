/*
 * Oakland berth replay: a stylised 3D replay of one berth plan at a Port of Oakland terminal.
 *
 * Input is a replay JSON (docs/replay_schema.md). The viewer never recomputes rules: ship states, crane counts,
 * closures and fog windows all come from the file. Ship calls in the demo fixtures are GENERATED, not real records;
 * terminal geometry, fleets, depths and shifts follow the real terminals. The scene is not a survey-grade twin.
 *
 * Classic script with the global THREE build (r147) so that double-clicking index.html works on file://.
 *
 * Optional asset modules (assets/*.js, each a window global) are feature-detected: OakGeo places the terminal on its
 * real quay line inside a map of the Port of Oakland, OakShips, OakCranes and OakYard replace the box ships, gantries
 * and yard. Without them the viewer keeps its single-terminal layout and box geometry. KPIs come from kpi.js.
 */
(function () {
  "use strict";

  // ---------- constants ----------
  const SECTION_M = 42;
  const APRON_DEPTH = 70;           // quay apron from z = -APRON_DEPTH to z = 0 (water edge)
  const QUAY_TOP = 3;
  const ANCHOR_Z = 1300;
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const SPEEDS = { 1: 0.25, 4: 1, 16: 4, 64: 16 };   // sim hours per real second
  const LINE_COLORS = {
    "ONE": "#e4007f",
    "Maersk": "#42b0d5",
    "MSC": "#d9b200",
    "CMA CGM": "#1f4fa0",
    "Evergreen": "#00843d",
    "Hapag-Lloyd": "#f26722",
    "OOCL": "#c8102e",
    "COSCO": "#005bac",
    "Yang Ming": "#f5a300",
    "Wan Hai": "#e03a3e",
    "Matson": "#2a6fdb",
  };
  const YARD_COLORS = Object.values(LINE_COLORS).concat(["#8c8c8c", "#b5543c", "#2f7f8f"]);
  const TERMINAL_TRIM = { OICT: "#5aa0d8", TraPac: "#e4262c", Everport: "#1d8a3a", Matson: "#f2b705" };
  const TERMINALS = ["OICT", "TraPac", "Everport", "Matson"];
  const SEA_IN = [-6500, 300];      // world [x, z] where ships enter the scene, west toward the Golden Gate
  const MAX_CRANE_SPEEDUP = 60;     // asset cranes animate at most 60x real time so the trolley stays readable

  // asset modules are optional window globals
  const has = (name) => typeof window[name] !== "undefined";
  const GEO = has("OakGeo"), SHIPS = has("OakShips"), CRANES = has("OakCranes"), YARD = has("OakYard"),
    PORT_LIFE = has("OakPortLife"), HUD = has("OakControlPanel");

  // ---------- small helpers ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, u) => a + (b - a) * u;
  const smooth = (u) => u * u * (3 - 2 * u);

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

  function lineColor(line) {
    if (LINE_COLORS[line]) return LINE_COLORS[line];
    let h = 0;
    for (const ch of String(line || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return "hsl(" + (h % 360) + ", 60%, 50%)";
  }

  function hourText(h) {
    const hh = Math.floor(h);
    const d = DAYS[Math.floor(hh / 24) % 7];
    return d + " " + String(hh % 24).padStart(2, "0") + ":00";
  }

  function clockText(t) {
    const total = Math.floor(t * 60 + 1e-6);
    const hh = Math.floor(total / 60);
    const mm = Math.floor((total % 60) / 15) * 15;
    const d = DAYS[Math.floor(hh / 24) % 7];
    return d + " " + String(hh % 24).padStart(2, "0") + ":" + String(mm).padStart(2, "0") + ", hour " + hh;
  }

  function shiftName(h) {
    const hd = Math.floor(h) % 24;
    if (hd === 17) return "meal hour, cranes stop";
    if (hd >= 8 && hd < 17) return "day shift";
    if (hd >= 3 && hd < 8) return "hoot shift";
    return "night shift";
  }

  function makeLabel(text, opts) {
    const o = Object.assign({ height: 30, bg: "rgba(12,18,28,0.82)", fg: "#ffffff", font: 600, border: null }, opts);
    const pad = 18, fontPx = 44;
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    ctx.font = o.font + " " + fontPx + "px -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    c.width = w;
    c.height = fontPx + pad * 1.4;
    ctx.font = o.font + " " + fontPx + "px -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
    ctx.fillStyle = o.bg;
    roundRect(ctx, 0, 0, c.width, c.height, 14);
    ctx.fill();
    if (o.border) {
      ctx.strokeStyle = o.border;
      ctx.lineWidth = 6;
      roundRect(ctx, 3, 3, c.width - 6, c.height - 6, 12);
      ctx.stroke();
    }
    ctx.fillStyle = o.fg;
    ctx.textBaseline = "middle";
    ctx.fillText(text, pad, c.height / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, fog: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(o.height * c.width / c.height, o.height, 1);
    sp.renderOrder = 10;
    return sp;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function stripeTexture(c1, c2) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    ctx.fillStyle = c1;
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = c2;
    ctx.lineWidth = 14;
    for (let i = -64; i < 128; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i, 64);
      ctx.lineTo(i + 64, 0);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  function glowTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,240,200,1)");
    g.addColorStop(0.3, "rgba(255,220,150,0.6)");
    g.addColorStop(1, "rgba(255,200,120,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  // Tileable wave normal map: a height field summed from sines with integer frequencies (so it wraps), then turned
  // into normals by finite differences.
  function waveNormalTexture(seed) {
    const N = 128;
    const r = rng(seed);
    const waves = [];
    for (let i = 0; i < 14; i++) {
      waves.push({ fx: Math.floor(r() * 7) - 3, fz: 1 + Math.floor(r() * 6), ph: r() * Math.PI * 2,
        a: 1 / (1 + i * 0.35) });
    }
    const hgt = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let v = 0;
        for (const w of waves) v += w.a * Math.sin(2 * Math.PI * (w.fx * x + w.fz * y) / N + w.ph);
        hgt[y * N + x] = v;
      }
    }
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(N, N);
    const k = 0.9;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = hgt[y * N + (x + 1) % N] - hgt[y * N + (x + N - 1) % N];
        const dy = hgt[((y + 1) % N) * N + x] - hgt[((y + N - 1) % N) * N + x];
        const nx = -dx * k, ny = -dy * k, nz = 1;
        const l = Math.hypot(nx, ny, nz);
        const o = (y * N + x) * 4;
        img.data[o] = (nx / l * 0.5 + 0.5) * 255;
        img.data[o + 1] = (ny / l * 0.5 + 0.5) * 255;
        img.data[o + 2] = (nz / l * 0.5 + 0.5) * 255;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  // a V-shaped foam trail, apex at the right edge (the stern), fading toward the left
  function wakeTexture() {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext("2d");
    for (let x = 0; x < 256; x++) {
      const u = x / 255;
      const half = 4 + (1 - u) * 28;
      const a = Math.pow(u, 0.7) * 0.85;
      const g = ctx.createLinearGradient(0, 32 - half, 0, 32 + half);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.15, "rgba(255,255,255," + a + ")");
      g.addColorStop(0.5, "rgba(255,255,255," + a * 0.35 + ")");
      g.addColorStop(0.85, "rgba(255,255,255," + a + ")");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x, 32 - half, 1, half * 2);
    }
    return new THREE.CanvasTexture(c);
  }

  function glowSprite(tex, color, size) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true }));
    sp.scale.set(size, size, 1);
    return sp;
  }

  function castShadows(obj, receive) {
    obj.traverse((m) => {
      if (m.isMesh || m.isInstancedMesh) {
        m.castShadow = true;
        if (receive) m.receiveShadow = true;
      }
    });
    return obj;
  }

  function box(w, h, d, mat, x, y, z) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x || 0, y || 0, z || 0);
    return m;
  }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const ui = {
    scene: $("scene"), title: $("title"), subtitle: $("subtitle"), grade: $("grade"), banner: $("banner"),
    tbody: document.querySelector("#ships tbody"), legend: $("legend"), play: $("play"), scrub: $("scrub"),
    clock: $("clock"), file: $("file"), fixture: $("fixture"), error: $("error"), kpis: $("kpis"),
    spark: $("spark"),
  };

  function showError(msg) {
    ui.error.textContent = msg;
    ui.error.classList.remove("hidden");
  }

  function clearError() {
    ui.error.classList.add("hidden");
  }

  // ---------- renderer, camera, environment ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  ui.scene.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x8ec5ea, 2500, 18000);
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 5, 60000);
  camera.position.set(0, 1600, 2600);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 60;
  controls.maxDistance = 24000;

  // the hemisphere light takes the sky colour from above, which reads as a soft sky reflection on the water
  const hemi = new THREE.HemisphereLight(0xdfefff, 0x334455, 0.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(-2000, 3000, 1500);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  // water: an opaque plane and a thin transparent layer, each with its own scrolling wave normal map
  const waveA = waveNormalTexture(11), waveB = waveNormalTexture(23);
  waveA.repeat.set(220, 220);
  waveB.repeat.set(90, 90);
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x1d5f7a, roughness: 0.25, metalness: 0.1,
    normalMap: waveA, normalScale: new THREE.Vector2(0.55, 0.55) });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.receiveShadow = true;
  scene.add(water);
  const swellMat = new THREE.MeshStandardMaterial({ color: 0x1d5f7a, roughness: 0.2, metalness: 0.1,
    normalMap: waveB, normalScale: new THREE.Vector2(0.4, 0.4), transparent: true, opacity: 0.35, depthWrite: false });
  const swell = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), swellMat);
  swell.rotation.x = -Math.PI / 2;
  swell.position.y = 0.05;
  scene.add(swell);

  const landMat = new THREE.MeshLambertMaterial({ color: 0x4a4f55 });
  const land = new THREE.Mesh(new THREE.PlaneGeometry(60000, 6000), landMat);
  land.rotation.x = -Math.PI / 2;
  land.position.set(0, 2.5, -APRON_DEPTH - 3000);
  land.receiveShadow = true;
  scene.add(land);

  const horizon = buildHorizon();
  const stars = buildStars();

  // the real-port map (once), and the terminal root that carries the replay scene onto its real quay line
  const mapSprites = [];
  const mapGroup = GEO ? buildMapGroup() : null;
  if (mapGroup) {
    land.visible = false;      // the map carries the real shoreline, bridge and skyline direction
    horizon.visible = false;
  }
  const harborTraffic = (PORT_LIFE && GEO && typeof OakPortLife.makeHarborTraffic === "function")
    ? (() => {
        try {
          const ht = OakPortLife.makeHarborTraffic(OakGeo);
          scene.add(ht.group);
          return ht;
        } catch (e) {
          console.error("OakPortLife.makeHarborTraffic failed", e);
          return null;
        }
      })()
    : null;
  const terminalRoot = new THREE.Group();
  scene.add(terminalRoot);
  const GLOW = glowTexture(), WAKE = wakeTexture();

  // the dynamic world, rebuilt per replay
  let world = null;
  let replay = null;
  let L = 2100, X0 = -1050;
  let frame = null;            // OakGeo terminal frame of the current replay, null for the single-terminal layout

  const state = {
    t: 12, playing: false, speed: 4, dragging: false, anim: 0, lastHour: -1, kpiT: -1,
    forceNight: false, showAis: true, showTrails: true,
    activeScenario: (window.PORTSIM_SCENARIOS && Object.keys(window.PORTSIM_SCENARIOS)[0]) || "oict_berth_medium",
    activePlan: "optimal",
  };

  function buildMapGroup() {
    try {
      const g = OakGeo.buildMap({ detail: "full" });
      g.traverse((m) => {
        if (m.isMesh) m.receiveShadow = true;
        if (m.isSprite) mapSprites.push(m);
      });
      scene.add(g);
      return g;
    } catch (e) {
      console.error("OakGeo.buildMap failed, keeping the single-terminal layout", e);
      return null;
    }
  }

  function buildStars() {
    const r = rng(99);
    const pts = [];
    for (let i = 0; i < 1600; i++) {
      const az = r() * Math.PI * 2, el = Math.asin(0.05 + r() * 0.95);
      const R = 50000;
      pts.push(Math.cos(az) * Math.cos(el) * R, Math.sin(el) * R, Math.sin(az) * Math.cos(el) * R);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false,
      transparent: true, opacity: 0, depthWrite: false });
    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    scene.add(p);
    return p;
  }

  function buildHorizon() {
    const sil = new THREE.MeshLambertMaterial({ color: 0x2b3442 });
    const g = new THREE.Group();
    // San Francisco skyline, low and hazy across the bay
    const r = rng(7);
    for (let i = 0; i < 70; i++) {
      const x = -4200 + r() * 3600;
      const z = 9800 + r() * 900;
      const w = 40 + r() * 90;
      const h = 30 + Math.pow(r(), 2) * 220;
      g.add(box(w, h, w, sil, x, h / 2, z));
    }
    g.add(box(55, 326, 55, sil, -2500, 163, 9900));                      // tallest tower
    const pyr = new THREE.Mesh(new THREE.ConeGeometry(40, 260, 4), sil);  // pyramid tower
    pyr.position.set(-2750, 130, 10000);
    g.add(pyr);
    // Bay Bridge: deck from the Oakland side out to the city, suspension towers on the west span
    const a = new THREE.Vector3(-2600, 0, 2600), b = new THREE.Vector3(-6200, 0, 10200);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const yaw = Math.atan2(-dir.z, dir.x);
    const deck = box(len, 6, 30, sil, (a.x + b.x) / 2, 60, (a.z + b.z) / 2);
    deck.rotation.y = yaw;
    g.add(deck);
    const at = (u) => a.clone().lerp(b, u);
    const towers = [0.12, 0.58, 0.72, 0.86];
    const towerH = [170, 160, 160, 160];
    towers.forEach((u, i) => {
      const p = at(u);
      const tw = box(14, towerH[i], 30, sil, p.x, towerH[i] / 2, p.z);
      tw.rotation.y = yaw;
      g.add(tw);
    });
    const cableMat = new THREE.LineBasicMaterial({ color: 0x2b3442 });
    for (let k = 1; k < towers.length - 1; k++) {
      const pts = [];
      for (let s = 0; s <= 20; s++) {
        const u = lerp(towers[k], towers[k + 1], s / 20);
        const p = at(u);
        const sag = 4 * (s / 20) * (1 - s / 20);
        pts.push(new THREE.Vector3(p.x, 160 - sag * 90, p.z));
      }
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat));
    }
    // single-tower east span near Oakland
    const p0 = at(0.12);
    const pts = [at(0.02), p0, at(0.24)].map((p, i) => new THREE.Vector3(p.x, i === 1 ? 170 : 62, p.z));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat));
    scene.add(g);
    return g;
  }

  // ---------- real-port placement (OakGeo) ----------
  // A frame maps frame-local (lx along the quay from section 1's corner, lz toward the water) to world [x, z]:
  // [ox + lx cos h - lz sin h, oz + lx sin h + lz cos h], the same formula as OakGeo.toWorld.
  function frameOf(name) {
    if (!mapGroup || typeof OakGeo.terminalFrame !== "function") return null;
    try {
      const f = OakGeo.terminalFrame(name);
      if (!f || !f.origin) return null;
      const o = Array.isArray(f.origin) ? f.origin : [f.origin.x, f.origin.z];
      return { name, ox: o[0], oz: o[1], h: f.heading_rad || 0, side: f.water_side === -1 ? -1 : 1,
        sections: f.sections };
    } catch (e) {
      console.warn("OakGeo.terminalFrame(" + name + ") failed", e);
      return null;
    }
  }

  function frameToWorld(f, lx, lz) {
    const z = lz * f.side, c = Math.cos(f.h), s = Math.sin(f.h);
    return [f.ox + lx * c - z * s, f.oz + lx * s + z * c];
  }

  function worldToFrame(f, x, z) {
    const dx = x - f.ox, dz = z - f.oz, c = Math.cos(f.h), s = Math.sin(f.h);
    return [dx * c + dz * s, (-dx * s + dz * c) * f.side];
  }

  // world [x, z] to the coordinates of world.group (section 1 at x = X0, water at +z)
  function worldToGroup(x, z) {
    if (!frame) return new THREE.Vector3(x, 0, z);
    const [lx, lz] = worldToFrame(frame, x, z);
    return new THREE.Vector3(lx + X0, 0, lz);
  }

  const LAND = landPolys();

  function landPolys() {
    if (!GEO) return [];
    const src = OakGeo.land || (OakGeo.data && OakGeo.data.land) || [];
    return src.map((p) => (Array.isArray(p) ? p : p.points || []))
      .map((p) => p.map((q) => (Array.isArray(q) ? q : [q.x, q.z])))
      .filter((p) => p.length > 2);
  }

  function onLand(x, z) {
    for (const poly of LAND) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i], [xj, zj] = poly[j];
        if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  function placeTerminal(task) {
    frame = frameOf(task.terminal);
    terminalRoot.position.set(0, 0, 0);
    terminalRoot.rotation.set(0, 0, 0);
    terminalRoot.scale.set(1, 1, 1);
    world.group.position.set(0, 0, 0);
    if (frame) {
      terminalRoot.position.set(frame.ox, 0, frame.oz);
      terminalRoot.rotation.y = -frame.h;
      terminalRoot.scale.z = frame.side;
      world.group.position.x = -X0;            // section 1's corner on the frame origin
      if (frame.sections && frame.sections !== world.nSec) {
        console.warn(task.terminal + ": replay has " + world.nSec + " sections, the map frame " + frame.sections);
      }
    }
    terminalRoot.updateMatrixWorld(true);
    if (frame) {
      const p = world.group.localToWorld(new THREE.Vector3(X0, 0, 0));
      const want = typeof OakGeo.toWorld === "function" ? OakGeo.toWorld(frame.name, 0, 0) : [frame.ox, frame.oz];
      const err = Math.hypot(p.x - want[0], p.z - want[1]);
      if (err > 1) console.warn("terminal frame check: section 1 corner is " + err.toFixed(1) + " m off");
    }
  }

  // ---------- geometry of one terminal ----------
  const secX0 = (s) => X0 + (s - 1) * SECTION_M;                       // left edge of section s
  const spanCenter = (first, n) => X0 + (first - 1 + n / 2) * SECTION_M;

  function buildWorld(rep) {
    const task = rep.task || {};
    const nSec = (task.last_section || 0) - (task.first_section || 1) + 1 || inferSections(rep);
    L = nSec * SECTION_M;
    X0 = -L / 2;
    frame = frameOf(task.terminal);            // set early so anchorage and sea paths use the real bay
    const g = new THREE.Group();

    // quay apron, yard ground and section ticks
    const quayMat = new THREE.MeshStandardMaterial({ color: 0x666f7a, roughness: 0.88, metalness: 0.04 });
    const apron = box(L + 60, QUAY_TOP + 2, APRON_DEPTH, quayMat, 0, (QUAY_TOP - 2) / 2, -APRON_DEPTH / 2);
    apron.castShadow = apron.receiveShadow = true;
    g.add(apron);
    const ground = box(L + 60, QUAY_TOP + 2, 470, new THREE.MeshStandardMaterial({ color: 0x444b53, roughness: 0.95 }),
      0, (QUAY_TOP - 2) / 2 - 0.1, -APRON_DEPTH - 235);
    ground.receiveShadow = true;
    g.add(ground);
    const edgeMat = new THREE.MeshLambertMaterial({ color: 0xe8c547 });
    g.add(box(L, 0.4, 1.2, edgeMat, 0, QUAY_TOP + 0.2, -1));
    const tickMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (let s = 1; s <= nSec + 1; s++) {
      const major = (s - 1) % 5 === 0 || s === nSec + 1;
      g.add(box(major ? 1.6 : 0.8, 0.5, major ? 10 : 5, tickMat, secX0(s), QUAY_TOP + 0.25, major ? -6 : -3.5));
    }
    for (let s = 1; s <= nSec; s++) {
      if (s === 1 || s % 5 === 0) {
        const lab = makeLabel(String(s), { height: 18, bg: "rgba(20,26,34,0.7)" });
        lab.position.set(secX0(s) + SECTION_M / 2, QUAY_TOP + 12, -APRON_DEPTH + 8);
        g.add(lab);
      }
    }
    // rails
    const railMat = new THREE.MeshLambertMaterial({ color: 0x55595f });
    g.add(box(L + 40, 0.5, 1, railMat, 0, QUAY_TOP + 0.25, -6));
    g.add(box(L + 40, 0.5, 1, railMat, 0, QUAY_TOP + 0.25, -34));

    // floodlight masts behind the crane rails, lit at night
    const mastMat = new THREE.MeshLambertMaterial({ color: 0x7a8088 });
    const lamps = [];
    for (let x = X0 + 40; x <= X0 + L - 40; x += 150) {
      g.add(box(1.2, 32, 1.2, mastMat, x, QUAY_TOP + 16, -62));
      const sp = glowSprite(GLOW, 0xffe6b0, 46);
      sp.position.set(x, QUAY_TOP + 32, -60);
      sp.visible = false;
      g.add(sp);
      lamps.push(sp);
    }

    // yard: stacked container blocks behind the quay
    let yard = null;
    if (YARD) {
      try {
        const lines = Array.from(new Set((rep.ships || []).map((s) => s.line).filter(Boolean)));
        yard = OakYard.makeYard({ length_m: L, depth_m: 450, lines, seed: nSec * 13 + 1 });
        yard.group.position.set(0, QUAY_TOP, 0);
        g.add(castShadows(yard.group, true));
      } catch (e) {
        console.error("OakYard.makeYard failed, using the box yard", e);
        yard = null;
      }
    }
    if (!yard) g.add(castShadows(buildYard(nSec), true));

    // blocks: closed (red stripes), shallow (pale band), others (grey stripes)
    const blockObjs = [];
    for (const b of rep.blocks || []) {
      const x0 = secX0(b.first), x1 = secX0(b.last + 1), w = x1 - x0;
      let obj;
      if (b.kind === "shallow") {
        obj = new THREE.Group();
        const band = new THREE.Mesh(new THREE.PlaneGeometry(w, 90),
          new THREE.MeshBasicMaterial({ color: 0xd8f3f7, transparent: true, opacity: 0.45, depthWrite: false }));
        band.rotation.x = -Math.PI / 2;
        band.position.set((x0 + x1) / 2, 0.4, 45);
        obj.add(band);
        const lab = makeLabel(b.label || "shallow", { height: 20, bg: "rgba(216,243,247,0.9)", fg: "#103040" });
        lab.position.set((x0 + x1) / 2, 18, 95);
        obj.add(lab);
      } else {
        obj = new THREE.Group();
        const tex = b.kind === "closed" ? stripeTexture("#b3201c", "#f2f2f2") : stripeTexture("#6b7178", "#c9ced4");
        tex.repeat.set(Math.max(1, w / 30), 4);
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, APRON_DEPTH + 40),
          new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false }));
        plane.rotation.x = -Math.PI / 2;
        plane.position.set((x0 + x1) / 2, QUAY_TOP + 0.6, -APRON_DEPTH / 2 + 20);
        obj.add(plane);
        const lab = makeLabel((b.kind === "closed" ? "closed: " : b.kind + ": ") + (b.label || ""),
          { height: 22, bg: "rgba(179,32,28,0.92)" });
        lab.position.set((x0 + x1) / 2, 40, -APRON_DEPTH / 2);
        obj.add(lab);
      }
      g.add(obj);
      blockObjs.push({ b, obj });
    }

    // ships
    const shipObjs = (rep.ships || []).map((s, i) => {
      const o = buildShip(s, i, task);
      o.idx = i;
      o.group.userData = { pickType: "ship", pickIdx: i };
      return o;
    });
    shipObjs.forEach((o) => g.add(o.group));

    // cranes
    const pool = (task.rules && task.rules.crane_pool) || maxCranes(rep) || 4;
    const craneMat = new THREE.MeshLambertMaterial({ color: 0xd6dbe1 });
    const accentMat = new THREE.MeshLambertMaterial({ color: 0xc0392b });
    const trim = TERMINAL_TRIM[task.terminal] || "#5aa0d8";
    const cranes = [];
    for (let i = 0; i < pool; i++) {
      let c = null;
      if (CRANES) {
        try {
          const a = OakCranes.makeCrane({ rail_gauge_m: 28, height_m: 50, outreach_m: 65, seed: i + 1, color: trim });
          c = { group: a.group, asset: a, home: 0, x: 0, z: -20, working: null, idx: i };
        } catch (e) {
          console.error("OakCranes.makeCrane failed, using the box crane", e);
        }
      }
      if (!c) c = Object.assign(buildCrane(craneMat, accentMat, GLOW), { idx: i });
      c.home = X0 + L * (i + 0.5) / pool;
      c.group.position.set(c.home, QUAY_TOP, c.z);
      c.group.userData = { pickType: "crane", pickIdx: i };
      g.add(castShadows(c.group));
      cranes.push(c);
    }

    if (yard && yard.setTrails) yard.setTrails(state.showTrails);

    // World-space ambient Port of Oakland harbor layers (passive terminals, tractor tugs, 3D ECDIS AIS overlay)
    const worldSpaceGroup = new THREE.Group();
    scene.add(worldSpaceGroup);
    let passiveTerminals = null, tugFleet = null, aisOverlay = null;
    if (PORT_LIFE && GEO) {
      const rawFrame = typeof OakGeo.terminalFrame === "function" ? OakGeo.terminalFrame(task.terminal || "OICT") : null;
      try {
        if (typeof OakPortLife.makePassiveTerminals === "function") {
          passiveTerminals = OakPortLife.makePassiveTerminals(task.terminal || "OICT");
          worldSpaceGroup.add(passiveTerminals.group);
        }
      } catch (e) { console.error("makePassiveTerminals failed", e); }
      try {
        if (typeof OakPortLife.makeTugFleet === "function") {
          tugFleet = OakPortLife.makeTugFleet({ termFrame: rawFrame });
          worldSpaceGroup.add(tugFleet.group);
        }
      } catch (e) { console.error("makeTugFleet failed", e); }
      try {
        if (typeof OakPortLife.makeAisOverlay === "function") {
          aisOverlay = OakPortLife.makeAisOverlay(rep, rawFrame);
          aisOverlay.setVisible(state.showAis);
          worldSpaceGroup.add(aisOverlay.group);
        }
      } catch (e) { console.error("makeAisOverlay failed", e); }
    }

    terminalRoot.add(g);
    return { group: g, worldSpaceGroup, passiveTerminals, tugFleet, aisOverlay,
      ships: shipObjs, cranes, craneMat, blocks: blockObjs, nSec, lamps, yard,
      targets: new Map() };
  }

  function inferSections(rep) {
    let m = 1;
    for (const s of rep.ships || []) m = Math.max(m, s.first_section + s.sections - 1);
    for (const b of rep.blocks || []) m = Math.max(m, b.last);
    return m;
  }

  function maxCranes(rep) {
    let m = 0;
    for (const [, c] of rep.crane_pool_by_hour || []) m = Math.max(m, c);
    return m;
  }

  function buildYard(nSec) {
    const r = rng(nSec * 13 + 1);
    const rowsZ = [];
    for (let z = -APRON_DEPTH - 40; z > -APRON_DEPTH - 460; z -= 34) rowsZ.push(z);
    const items = [];
    for (const z of rowsZ) {
      for (let x = X0 + 20; x < X0 + L - 20; x += 14) {
        if (r() < 0.18) continue;                       // gaps between blocks
        if (((x - X0) % 280) < 22) continue;              // driving lanes
        items.push([x, z, 1 + Math.floor(r() * 5), YARD_COLORS[Math.floor(r() * YARD_COLORS.length)]]);
      }
    }
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(),
      items.length);
    const m = new THREE.Matrix4(), col = new THREE.Color();
    items.forEach(([x, z, tiers, c], i) => {
      const h = tiers * 2.6;
      m.makeScale(12.2, h, 24);
      m.setPosition(x, QUAY_TOP + h / 2, z);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, col.set(c));
    });
    return mesh;
  }

  function buildShip(s, i, task) {
    const ts = (task.ships || [])[s.id] || {};
    const len = s.length_m || s.sections * SECTION_M * 0.9;
    const beam = ts.beam_m || clamp(len / 7.3, 28, 60);
    const color = lineColor(s.line);
    const group = new THREE.Group();
    let asset = null;
    if (SHIPS) {
      try {
        asset = OakShips.makeShip({ name: s.name, line: s.line, length_m: len, beam_m: beam,
          draught_m: ts.draught_m || 14, sections: s.sections, seed: s.id });
        group.add(castShadows(asset.group));
      } catch (e) {
        console.error("OakShips.makeShip failed, using the box ship", e);
        asset = null;
      }
    }
    const lights = [];
    if (!asset) {
      const hull = new THREE.Group();
      const hullMat = new THREE.MeshLambertMaterial({ color: 0x23272e });
      const lineMat = new THREE.MeshLambertMaterial({ color });
      hull.add(box(len * 0.92, 12, beam, hullMat, -len * 0.04, 6, 0));
      const bow = box(beam * 0.72, 12, beam * 0.72, hullMat, len * 0.42, 6, 0);
      bow.rotation.y = Math.PI / 4;
      hull.add(bow);
      hull.add(box(len * 0.92, 2, beam + 0.4, new THREE.MeshLambertMaterial({ color: 0x8a2b2b }), -len * 0.04, 1, 0));
      // superstructure and funnel in the line colour
      hull.add(box(Math.max(12, len * 0.05), 26, beam * 0.86, lineMat, -len * 0.36, 25, 0));
      hull.add(box(Math.max(8, len * 0.03), 4, beam * 0.9, new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }),
        -len * 0.36, 39, 0));
      hull.add(box(10, 14, 10, lineMat, -len * 0.44, 21, 0));
      // deck containers
      const r = rng(1000 + i * 7);
      const bays = [];
      for (let x = -len * 0.31; x < len * 0.36; x += 13.5) bays.push(x);
      const cont = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(),
        bays.length);
      const m = new THREE.Matrix4(), col = new THREE.Color();
      bays.forEach((x, k) => {
        const h = (3 + Math.floor(r() * 5)) * 2.6;
        m.makeScale(12.2, h, beam * 0.9);
        m.setPosition(x, 12 + h / 2, 0);
        cont.setMatrixAt(k, m);
        const c = r() < 0.45 ? color : YARD_COLORS[Math.floor(r() * YARD_COLORS.length)];
        cont.setColorAt(k, col.set(c));
      });
      hull.add(cont);
      // night lights: bridge, bow and stern
      for (const [x, y] of [[-len * 0.36, 42], [len * 0.44, 16], [-len * 0.46, 16]]) {
        const sp = glowSprite(GLOW, 0xfff0d0, 22);
        sp.position.set(x, y, 0);
        sp.visible = false;
        hull.add(sp);
        lights.push(sp);
      }
      group.add(castShadows(hull));
    }
    // wake behind the stern, shown while the ship is under way
    const wakeLen = len * 1.1;
    const wake = new THREE.Mesh(new THREE.PlaneGeometry(wakeLen, beam * 2.6),
      new THREE.MeshBasicMaterial({ map: WAKE, transparent: true, opacity: 0, depthWrite: false }));
    wake.rotation.x = -Math.PI / 2;
    wake.position.set(-len / 2 - wakeLen / 2 + 8, 0.35, 0);
    wake.visible = false;
    group.add(wake);
    // late flag
    const flag = new THREE.Group();
    flag.add(box(1.2, 40, 1.2, new THREE.MeshLambertMaterial({ color: 0xdddddd }), 0, 20, 0));
    flag.add(box(18, 11, 0.6, new THREE.MeshBasicMaterial({ color: 0xff3b3b }), 9, 34, 0));
    flag.position.set(len * 0.4, 12, 0);
    flag.visible = false;
    group.add(flag);
    // labels (normal and late) — compact height so close-up Quayside views stay crisp
    const label = makeLabel(s.name, { height: 15, border: color });
    const lateLabel = makeLabel(s.name + "  late " + s.late_h + " h", { height: 15, bg: "rgba(190,30,30,0.95)" });
    label.position.set(0, 62, 0);
    lateLabel.position.set(0, 62, 0);
    lateLabel.visible = false;
    group.add(label, lateLabel);
    group.visible = false;
    const cbh = new Map();
    for (const [h, c] of s.cranes_by_hour || []) cbh.set(h, c);
    return { s, group, asset, lights, wake, flag, label, lateLabel, beam, len, cbh, keys: shipKeys(s, beam),
      load: -1, lit: null };
  }

  function buildCrane(mat, accent, glow) {
    const g = new THREE.Group();
    for (const x of [-11, 11]) {
      for (const z of [-6, -34]) g.add(box(2.5, 52, 2.5, mat, x, 26, z));
      g.add(box(2.5, 3, 30, mat, x, 50, -20));
    }
    g.add(box(24, 3, 2.5, mat, 0, 50, -6));
    g.add(box(24, 3, 2.5, mat, 0, 50, -34));
    g.add(box(5, 4, 132, mat, 0, 56, -4));                    // boom, outreach over the water
    g.add(box(5.4, 4.4, 10, accent, 0, 56, 57));             // boom tip
    g.add(box(14, 8, 14, mat, 0, 62, -42));                  // machinery house
    g.add(box(2, 26, 2, mat, -5, 70, -20));
    g.add(box(2, 26, 2, mat, 5, 70, -20));
    const tieMat = new THREE.LineBasicMaterial({ color: 0x9aa3ad });
    const tie = [new THREE.Vector3(0, 58, 60), new THREE.Vector3(0, 83, -20), new THREE.Vector3(0, 58, -68)];
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(tie), tieMat));
    const trolley = box(7, 3, 8, accent, 0, 53, -20);
    g.add(trolley);
    const spreader = box(5, 1.6, 13, new THREE.MeshLambertMaterial({ color: 0xf0c330 }), 0, 50, -20);
    g.add(spreader);
    const cableGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const cable = new THREE.Line(cableGeo, tieMat);
    g.add(cable);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
    const glows = [];
    for (const z of [8, 38, -30]) {
      g.add(box(3, 1.5, 3, lampMat, 0, 53.5, z));
      const sp = glowSprite(glow, 0xffe2a8, 38);
      sp.position.set(0, 52, z);
      sp.visible = false;
      g.add(sp);
      glows.push(sp);
    }
    return { group: g, trolley, spreader, cable, lampMat, glows, home: 0, x: 0, z: 0 };
  }

  // ---------- ship motion ----------
  // Keys are [hour, position, control]: with a control point the leg into that key is a quadratic curve.
  function anchorPos(id) {
    if (!frame) {
      const cols = 5;
      return new THREE.Vector3(X0 + L * ((id % cols) + 0.5) / cols + ((id * 37) % 60) - 30,
        0, ANCHOR_Z + Math.floor(id / cols) * 260 + ((id * 53) % 80));
    }
    // in the bay west of the terminal: frame-local x -600 to -1200, z +400 to +900, nudged off any land
    let lx = -600 - (id % 3) * 270 - ((id * 37) % 50), lz = 400 + (Math.floor(id / 3) % 3) * 220 + ((id * 53) % 50);
    for (let k = 0; k < 30; k++) {
      const [x, z] = frameToWorld(frame, lx, lz);
      if (!onLand(x, z)) break;
      lx -= 120;
      lz += 80;
    }
    return new THREE.Vector3(lx + X0, 0, lz);
  }

  function bend(a, b, side) {
    const m = a.clone().lerp(b, 0.55);
    const d = b.clone().sub(a);
    return m.add(new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(0.18 * side));
  }

  const SEA_LEG_H = 6;   // sim hours to sail in from sea to the anchorage, and out again after departure

  function shipKeys(s, beam) {
    const berth = new THREE.Vector3(spanCenter(s.first_section, s.sections), 0, beam / 2 + 5);
    let seaIn, seaOut;
    if (frame) {
      seaIn = worldToGroup(SEA_IN[0] - (s.id % 4) * 250, SEA_IN[1] + (s.id % 3) * 300);
      seaOut = worldToGroup(SEA_IN[0] - 400, SEA_IN[1] - 300 + (s.id % 3) * 250);
    } else {
      seaIn = new THREE.Vector3(X0 - 3200 - (s.id % 4) * 300, 0, 3800 + (s.id % 3) * 400);
      seaOut = new THREE.Vector3(X0 - 3600, 0, 4600 + (s.id % 3) * 300);
    }
    const anch = anchorPos(s.id);
    const approach = new THREE.Vector3(lerp(anch.x, berth.x, 0.7), 0, berth.z + 260);
    const k = [[s.arrival - SEA_LEG_H, seaIn]];
    if (s.berth_hour > s.arrival) {
      k.push([s.arrival, anch, bend(seaIn, anch, 1)]);
      if (s.berth_hour - 1 > s.arrival) k.push([s.berth_hour - 1, anch]);
      k.push([s.berth_hour, berth, approach]);
    } else {
      k.push([s.berth_hour, berth, anch]);       // straight through the anchorage to the berth
    }
    k.push([s.departure, berth]);
    k.push([s.departure + SEA_LEG_H, seaOut, new THREE.Vector3(berth.x - 300, 0, berth.z + 600)]);
    k.anch = anch;
    return k;
  }

  const _tan = new THREE.Vector3();

  // returns how fast the ship is moving, 0 (still) to 1 (mid leg)
  function placeShip(o, t) {
    const k = o.keys;
    if (t < k[0][0] || t > k[k.length - 1][0]) {
      o.group.visible = false;
      return 0;
    }
    o.group.visible = true;
    let j = 0;
    while (j < k.length - 2 && t >= k[j + 1][0]) j++;
    const [t0, p0] = k[j], [t1, p1, c] = k[j + 1];
    const u = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 1;
    const e = smooth(u);
    if (c) {
      const a = (1 - e) * (1 - e), b = 2 * (1 - e) * e, d = e * e;
      o.group.position.set(a * p0.x + b * c.x + d * p1.x, 0, a * p0.z + b * c.z + d * p1.z);
      _tan.set(2 * (1 - e) * (c.x - p0.x) + 2 * e * (p1.x - c.x), 0,
        2 * (1 - e) * (c.z - p0.z) + 2 * e * (p1.z - c.z));
    } else {
      o.group.position.lerpVectors(p0, p1, e);
      _tan.subVectors(p1, p0);
    }
    let yaw = 0, speed = 0;
    if (p1.distanceToSquared(p0) > 1 && _tan.lengthSq() > 1e-6) {
      const travel = Math.atan2(-_tan.z, _tan.x);
      const w = Math.min(1, 3 * Math.sin(Math.PI * u));
      yaw = lerpAngle(0, travel, w);
      speed = Math.sin(Math.PI * u);
    }
    // swinging at anchor: a few metres of drift and a few degrees of yaw, about 50 s a cycle at 4x, damped at higher speeds
    if (p0 === k.anch && p1 === k.anch) {
      const amp = Math.min(1, 1 / SPEEDS[state.speed]) * Math.min(1, (t - t0) / 0.5, (t1 - t) / 0.5);
      const ph = (2 * Math.PI * t) / 50 + o.s.id;
      o.group.position.x += 6 * amp * Math.sin(ph);
      o.group.position.z += 4 * amp * Math.sin(2 * ph);
      yaw += 0.07 * amp * Math.sin(ph + 1);
    }
    o.group.rotation.y = yaw;
    return speed;
  }

  function lerpAngle(a, b, u) {
    let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return a + d * u;
  }

  // ---------- crane assignment ----------
  // Cranes share one rail, so the working cranes keep their order: an order-preserving match of crane homes to
  // work spots (dynamic programming over N cranes and K spots), then idle cranes park near home between neighbours.
  function craneTargets(h) {
    if (world.targets.has(h)) return world.targets.get(h);
    const N = world.cranes.length;
    const spots = [];
    for (const o of world.ships) {
      const s = o.s;
      if (h < s.berth_hour || h >= s.departure) continue;
      const c = Math.min(o.cbh.get(h) || 0, N);
      const x0 = secX0(s.first_section), w = s.sections * SECTION_M;
      for (let k = 0; k < c; k++) spots.push({ x: x0 + w * (0.12 + 0.76 * (k + 0.5) / c), ship: s.id });
    }
    spots.sort((a, b) => a.x - b.x);
    const K = Math.min(spots.length, N);
    const homes = world.cranes.map((c) => c.home);
    const INF = 1e18;
    const dp = Array.from({ length: N + 1 }, () => new Array(K + 1).fill(INF));
    const pick = Array.from({ length: N + 1 }, () => new Array(K + 1).fill(false));
    for (let i = 0; i <= N; i++) dp[i][0] = 0;
    for (let i = 1; i <= N; i++) {
      for (let j = 1; j <= Math.min(i, K); j++) {
        const skip = dp[i - 1][j];
        const take = dp[i - 1][j - 1] + Math.abs(homes[i - 1] - spots[j - 1].x);
        if (take <= skip) { dp[i][j] = take; pick[i][j] = true; } else dp[i][j] = skip;
      }
    }
    const x = new Array(N).fill(null), working = new Array(N).fill(false);
    for (let i = N, j = K; i > 0; i--) {
      if (j > 0 && pick[i][j]) { x[i - 1] = spots[j - 1].x; working[i - 1] = true; j--; }
    }
    const GAP = 30;
    for (let i = 0; i < N; i++) {
      if (working[i]) continue;
      let lo = X0 - 10, hi = X0 + L + 10;
      for (let a = i - 1; a >= 0; a--) if (working[a]) { lo = x[a] + GAP * (i - a); break; }
      for (let b = i + 1; b < N; b++) if (working[b]) { hi = x[b] - GAP * (b - i); break; }
      x[i] = lo <= hi ? clamp(homes[i], lo, hi) : (lo + hi) / 2;
    }
    const res = { x, working };
    world.targets.set(h, res);
    return res;
  }

  // ---------- sky, fog, windows ----------
  const NIGHT = new THREE.Color(0x0a1222), DAY = new THREE.Color(0x8ec5ea);
  const DUSK = new THREE.Color(0xf0a070), DAWN = new THREE.Color(0xf3b7a0);
  const FOG_DAY = new THREE.Color(0xc9d1d8), FOG_NIGHT = new THREE.Color(0x3a4350);
  const WATER_DAY = new THREE.Color(0x1d5f7a), WATER_NIGHT = new THREE.Color(0x07161f);
  const SUN_HIGH = new THREE.Color(0xfff4e2), SUN_LOW = new THREE.Color(0xff9a58);
  const GROUND_DAY = new THREE.Color(0x3d5560), GROUND_NIGHT = new THREE.Color(0x0c141c);
  const WHITE = new THREE.Color(0xffffff);
  const _sky = new THREE.Color(), _fog = new THREE.Color(), _dir = new THREE.Vector3();

  function daylight(t) {
    const hd = ((t % 24) + 24) % 24;
    if (hd < 5.5 || hd >= 19.5) return 0;
    if (hd < 7.5) return smooth((hd - 5.5) / 2);
    if (hd < 17.5) return 1;
    return 1 - smooth((hd - 17.5) / 2);
  }

  function fogAmount(t) {
    let f = 0;
    for (const w of replay.no_moves || []) {
      if (t >= w.start && t < w.end) f = 1;
      else if (t >= w.start - 0.6 && t < w.start) f = Math.max(f, smooth((t - w.start + 0.6) / 0.6));
      else if (t >= w.end && t < w.end + 0.6) f = Math.max(f, 1 - smooth((t - w.end) / 0.6));
    }
    return f;
  }

  function activeNoMove(t) {
    return (replay.no_moves || []).find((w) => t >= w.start && t < w.end);
  }

  function updateSky(t, dt) {
    const d = state.forceNight ? 0.04 : daylight(t);
    const hd = ((t % 24) + 24) % 24;
    const tint = 4 * d * (1 - d);
    _sky.copy(NIGHT).lerp(DAY, d).lerp(hd < 12 ? DAWN : DUSK, tint * 0.55);
    const f = fogAmount(t);
    _fog.copy(FOG_NIGHT).lerp(FOG_DAY, d).lerp(hd < 12 ? DAWN : DUSK, tint * 0.25);
    const bg = scene.background && scene.background.isColor ? scene.background : (scene.background = new THREE.Color());
    bg.copy(_sky).lerp(_fog, f * 0.85);
    scene.fog.color.copy(bg);
    // fog distances follow the camera so the satellite view stays clear; the fog window closes them right in
    const camDist = camera.position.distanceTo(controls.target);
    scene.fog.near = lerp(Math.max(6000, camDist * 1.7), 60, f);
    scene.fog.far = lerp(Math.max(30000, camDist * 6), 1500, f);
    hemi.color.copy(_sky).lerp(WHITE, 0.35);
    hemi.groundColor.copy(GROUND_NIGHT).lerp(GROUND_DAY, d);
    hemi.intensity = 0.22 + 0.46 * d;
    // the sun rises in the east (+x), crosses the south (+z) and sets in the west
    const u = clamp((hd - 6) / 13.5, 0, 1);
    const el = Math.max(0.12, Math.sin(Math.PI * u) * 1.1);
    const az = Math.PI * u;
    _dir.set(Math.cos(az) * Math.cos(el), Math.sin(el), (0.35 + 0.55 * Math.sin(az)) * Math.cos(el)).normalize();
    sun.intensity = 0.08 + 1.12 * d * (1 - f * 0.6);
    sun.color.copy(SUN_LOW).lerp(SUN_HIGH, smooth(clamp((el - 0.12) / 0.6, 0, 1)));
    if (world && world.center) sun.target.position.copy(world.center);
    sun.position.copy(sun.target.position).addScaledVector(_dir, 4000);
    waterMat.color.copy(WATER_NIGHT).lerp(WATER_DAY, d).lerp(DUSK, tint * 0.12);
    swellMat.color.copy(waterMat.color);
    waveA.offset.x += dt * 0.0035;
    waveA.offset.y += dt * 0.0012;
    waveB.offset.x -= dt * 0.0016;
    waveB.offset.y += dt * 0.0028;
    stars.material.opacity = (1 - d) * (1 - f) * 0.9;
    stars.visible = d < 0.95;
    return d;
  }

  // ---------- per-frame update ----------
  function update(t, dt) {
    if (!world) return;
    dt = dt || 0;
    const d = updateSky(t, dt);
    const night = d < 0.4;
    const nightFactor = 1 - d;
    const h = Math.floor(t), frac = t - h;
    const meal = h % 24 === 17;

    // Hide high-altitude map labels when the camera is low (Quayside / Crane Cab) so they never block ships/cranes
    const showHighLabels = camera.position.y >= 175;
    for (let i = 0; i < mapSprites.length; i++) mapSprites[i].visible = showHighLabels;

    const shipStatesForHarbor = [];
    for (const o of world.ships) {
      const speed = placeShip(o, t);
      const late = o.s.late_h > 0 && t >= o.s.due && t < o.s.departure + SEA_LEG_H;
      const moored = t >= o.s.berth_hour && t < o.s.departure && speed < 0.05;
      const stKey = !o.group.visible ? "departed"
        : moored ? "alongside"
        : (Math.abs(t - o.s.berth_hour) <= 1.2 ? "arriving"
        : (Math.abs(t - o.s.departure) <= 1.2 ? "departing"
        : (t < o.s.berth_hour ? "waiting" : "departing")));

      o.flag.visible = late;
      o.label.visible = !late && !o.asset;
      o.lateLabel.visible = late;
      o.wake.visible = !o.asset && speed > 0.05;
      o.wake.material.opacity = 0.65 * speed;
      if (o.asset) {
        if (o.lit !== night) {
          o.asset.setLights(night);
          o.lit = night;
        }
        if (o.asset.setMoored) o.asset.setMoored(moored);
        if (o.asset.setWake) o.asset.setWake(speed);
        const load = 1 - window.OakKPI.progress(replay, o.s, t);
        if (Math.abs(load - o.load) > 0.01) {
          o.asset.setLoad(load);
          o.load = load;
        }
        if (o.group.visible) o.asset.update(dt, t);
      } else {
        o.lights.forEach((g) => (g.visible = night));
      }
      shipStatesForHarbor.push({
        id: o.s.id,
        name: o.s.name,
        group: o.group,
        visible: o.group.visible,
        status: stKey,
        length_m: o.len,
        beam_m: o.beam,
        sog: speed * 12.5,
      });
    }

    for (const blk of world.blocks) blk.obj.visible = t >= blk.b.start && t < blk.b.end;
    world.lamps.forEach((g) => (g.visible = night));
    if (world.yard && world.yard.update) world.yard.update(dt, nightFactor);
    if (world.passiveTerminals && world.passiveTerminals.update) world.passiveTerminals.update(t, nightFactor);
    if (world.tugFleet && world.tugFleet.update) world.tugFleet.update(t, nightFactor, shipStatesForHarbor);
    if (world.aisOverlay && world.aisOverlay.update) world.aisOverlay.update(t, shipStatesForHarbor);
    if (harborTraffic && harborTraffic.update) harborTraffic.update(t, nightFactor);

    const T0 = craneTargets(h), T1 = craneTargets(h + 1);
    const w = smooth(clamp((frac - 0.7) / 0.3, 0, 1));
    const dtSim = state.playing ? Math.min(dt * SPEEDS[state.speed] * 3600, dt * MAX_CRANE_SPEEDUP) : 0;
    world.craneMat.color.setRGB(meal ? 0.42 : 0.84, meal ? 0.44 : 0.86, meal ? 0.47 : 0.89);
    world.cranes.forEach((c, i) => {
      c.x = lerp(T0.x[i], T1.x[i], w);
      c.group.position.x = c.x;
      const working = T0.working[i] && !meal;
      const lit = (working && d < 0.6) || night;
      if (c.asset) {
        if (working !== c.working) {
          c.asset.setWorking(working);
          c.asset.setBoomUp(!working);
          c.working = working;
        }
        if (lit !== c.lit && c.asset.setLights) {
          c.asset.setLights(lit);
          c.lit = lit;
        }
        c.asset.update(dtSim);
        return;
      }
      let tz = -20, sy = 50;
      if (working) {
        const ph = state.anim * 0.35 + i * 0.37;
        tz = lerp(-24, 40, (Math.sin(ph * Math.PI * 2) + 1) / 2);
        sy = 50 - 34 * Math.pow(Math.max(0, Math.cos(ph * Math.PI * 4)), 2);
      }
      c.trolley.position.z = tz;
      c.spreader.position.set(0, sy, tz);
      const pos = c.cable.geometry.attributes.position;
      pos.setXYZ(0, 0, 52, tz);
      pos.setXYZ(1, 0, sy + 0.8, tz);
      pos.needsUpdate = true;
      c.lampMat.color.set(lit ? 0xfff0c0 : meal ? 0x222222 : 0x444444);
      c.glows.forEach((g) => (g.visible = lit));
    });

    const nm = activeNoMove(t);
    if (nm) {
      ui.banner.textContent = "Bar closed: " + (nm.label || "no movements") + " until " + hourText(nm.end);
      ui.banner.classList.remove("hidden");
    } else ui.banner.classList.add("hidden");

    ui.clock.textContent = clockText(t);
    ui.clock.title = shiftName(t);
    if (!state.dragging) ui.scrub.value = t.toFixed(2);
    if (Math.abs(t - state.kpiT) >= 0.05) {
      state.kpiT = t;
      updateList(t);
      updateKpis(t);
      if (HUD && window.OakControlPanel) {
        window.OakControlPanel.updateAtHour(replay, t);
      }
      if (window.OakLearning) window.OakLearning.onHour(replay, t);
    }
  }

  // ---------- KPI overlay ----------
  const KPI_TILES = [
    ["occ", "Berth occupancy"], ["cranes", "Cranes working"], ["along", "Alongside"],
    ["anchor", "At anchor"], ["dep", "Departed"], ["late", "Late ships"],
    ["lateh", "Late ship-hours"], ["cost", "Cost so far"], ["reward", "Reward"],
  ];
  let kpiCells = {}, sparkSeries = null;

  function buildKpis() {
    ui.kpis.innerHTML = "";
    kpiCells = {};
    for (const [key, name] of KPI_TILES) {
      const tile = document.createElement("div");
      tile.className = "kpi";
      tile.innerHTML = "<div class='kpi-name'></div><div class='kpi-val'></div><div class='kpi-sub'></div>";
      tile.querySelector(".kpi-name").textContent = name;
      ui.kpis.appendChild(tile);
      kpiCells[key] = { tile, val: tile.querySelector(".kpi-val"), sub: tile.querySelector(".kpi-sub") };
    }
    sparkSeries = window.OakKPI.series(replay);
  }

  function setKpi(key, val, sub, cls) {
    const c = kpiCells[key];
    if (!c) return;
    c.val.textContent = val;
    c.sub.textContent = sub || "";
    c.tile.className = "kpi" + (cls ? " " + cls : "");
  }

  function updateKpis(t) {
    const k = window.OakKPI.at(replay, t);
    const n = (replay.ships || []).length;
    setKpi("occ", Math.round(k.occupancy * 100) + "%", k.sections_occupied + " of " + k.sections + " sections");
    setKpi("cranes", k.cranes_working + " / " + k.cranes_pool, "pool this hour");
    setKpi("along", String(k.ships_alongside), k.ships_at_sea + " still at sea");
    setKpi("anchor", String(k.ships_anchored), "arrived, waiting", k.ships_anchored ? "warn" : "");
    setKpi("dep", String(k.ships_departed), "of " + n + " ships");
    setKpi("late", String(k.late_ships), "past their due hour", k.late_ships ? "bad" : "good");
    setKpi("lateh", String(k.late_ship_hours), "hours past due", k.late_ship_hours ? "bad" : "");
    setKpi("cost", String(k.cost_so_far), k.cost_final != null ? "final " + k.cost_final +
      (k.optimal_cost != null ? ", optimal " + k.optimal_cost : "") : "");
    setKpi("reward", k.reward != null ? k.reward.toFixed(3) : "n/a",
      k.feasible == null ? "" : k.feasible ? "feasible plan" : "infeasible plan", k.feasible === false ? "bad" : "");
    drawSpark(t);
  }

  function drawSpark(t) {
    const cv = ui.spark;
    if (!cv || !sparkSeries) return;
    const W = 240, H = 40, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== W * dpr) {
      cv.width = W * dpr;
      cv.height = H * dpr;
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const s = sparkSeries, n = s.hours.length;
    const X = (i) => 1 + (W - 2) * i / Math.max(1, n - 1);
    const Y = (v) => H - 3 - (H - 6) * clamp(v, 0, 1);
    for (const w of replay.no_moves || []) {
      ctx.fillStyle = "rgba(200,210,220,0.14)";
      ctx.fillRect(X(w.start), 0, X(w.end) - X(w.start), H);
    }
    const line = (vals, color) => {
      ctx.beginPath();
      vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    };
    line(s.occupancy, "#4cc3ff");
    line(s.cranes.map((c, i) => (s.pool[i] ? c / s.pool[i] : 0)), "#5ad48a");
    const x = X(clamp(t, 0, n - 1));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x - 0.75, 0, 1.5, H);
  }

  // ---------- side list and header ----------
  const STATUS_WORDS = { sea: "at sea", anchor: "anchored", alongside: "alongside", departed: "departed" };

  function shipStatus(s, t, cbh) {
    const h = Math.floor(t);
    if (t < s.arrival) return { key: "sea", text: STATUS_WORDS.sea };
    if (t < s.berth_hour) return { key: "anchor", text: STATUS_WORDS.anchor };
    if (t < s.departure) {
      const c = cbh.get(h) || 0;
      return { key: "alongside", text: STATUS_WORDS.alongside + (c ? ", " + c + " cr" : ", idle") };
    }
    return { key: "departed", text: STATUS_WORDS.departed };
  }

  function buildList() {
    ui.tbody.innerHTML = "";
    const tships = (replay.task && replay.task.ships) || [];
    const mpch = (replay.task && replay.task.rules && replay.task.rules.moves_per_crane_hour) || 26;
    world.ships.forEach((o) => {
      const s = o.s;
      const ts = tships[s.id] || {};
      const tr = document.createElement("tr");
      const late = s.late_h > 0;
      tr.innerHTML =
        "<td><span class='swatch'></span><span class='name'></span><div class='line'></div></td>" +
        "<td><div class='status'></div><div class='bar'><i></i></div><div class='moves'></div></td>" +
        "<td class='lt'></td>";
      tr.querySelector(".swatch").style.background = lineColor(s.line);
      tr.querySelector(".name").textContent = s.name;
      tr.querySelector(".line").textContent = s.line + ", " + Math.round(s.length_m) + " m, sec " + s.first_section +
        "-" + (s.first_section + s.sections - 1) + ", h" + s.berth_hour + " to h" + s.departure;
      tr.title = "arrives " + hourText(s.arrival) + ", berths " + hourText(s.berth_hour) + ", departs " +
        hourText(s.departure) + " (due " + hourText(s.due) + ")";
      const lt = tr.querySelector(".lt");
      lt.textContent = late ? "+" + s.late_h + " h" : "on time";
      lt.className = "lt " + (late ? "late" : "muted");
      tr.addEventListener("click", () => focusShip(o));
      o.statusCell = tr.querySelector(".status");
      o.barCell = tr.querySelector(".bar i");
      o.movesCell = tr.querySelector(".moves");
      o.moves = ts.workload ? Math.round(ts.workload * mpch) : 0;
      o.lastStatus = "";
      o.lastPct = -1;
      ui.tbody.appendChild(tr);
    });
  }

  function updateList(t) {
    for (const o of world.ships) {
      const st = shipStatus(o.s, t, o.cbh);
      const key = st.key + st.text;
      if (key !== o.lastStatus) {
        o.statusCell.textContent = st.text;
        o.statusCell.className = "status status-" + st.key;
        o.lastStatus = key;
      }
      const p = window.OakKPI.progress(replay, o.s, t);
      const pct = Math.round(p * 100);
      if (pct !== o.lastPct) {
        o.barCell.style.width = pct + "%";
        o.movesCell.textContent = o.moves ? Math.round(p * o.moves).toLocaleString("en-US") + " of " +
          o.moves.toLocaleString("en-US") + " moves" : pct + "% worked";
        o.lastPct = pct;
      }
    }
  }

  function buildHeader(rep) {
    const task = rep.task || {};
    const term = task.terminal || "Terminal";
    ui.title.textContent = term + ", week " + (task.week || 1) + ", " + (task.kind || "berth") + " plan";
    document.title = term + " Berth Replay";
    const start = task.week_start_utc ? " from " + String(task.week_start_utc).slice(0, 10) : "";
    ui.subtitle.textContent = (task.quay ? "berths " + task.quay + ", " : "") + (task.task_id || "replay") + start +
      ", " + (rep.ships || []).length + " ships. Ship calls are generated, not real records.";
    const gr = rep.grade || {};
    const chips = [];
    if (typeof gr.reward === "number") chips.push(["reward <b>" + gr.reward.toFixed(2) + "</b>", ""]);
    if (gr.cost != null) {
      chips.push(["cost <b>" + gr.cost + "</b>" + (gr.optimal_cost != null ? " vs optimal " + gr.optimal_cost : ""), ""]);
    }
    if (gr.feasible != null) chips.push([gr.feasible ? "feasible" : "infeasible", gr.feasible ? "good" : "bad"]);
    if (gr.violations && gr.violations.length) chips.push([gr.violations.length + " violations", "bad"]);
    ui.grade.innerHTML = chips.map(([h, cls]) => "<span class='chip " + cls + "'>" + h + "</span>").join("");
    const r = task.rules || {};
    const parts = [];
    if (r.crane_pool) parts.push(r.crane_pool + " cranes" + (r.hoot_pool ? ", " + r.hoot_pool + " in hoot hours" : ""));
    parts.push("shifts: day 08-17, night 18-03, hoot 03-08, meal 17-18");
    parts.push("red stripes: closed quay; pale band: shallow; red flag: running late");
    parts.push(frame ? "placed on its real quay line in a stylised Port of Oakland map" : "single-terminal layout");
    parts.push("stylised scene, not a survey-grade twin");
    ui.legend.textContent = parts.join(". ") + ".";
  }

  // ---------- camera presets ----------
  // Presets are written in terminal coordinates (quay along +x, water at +z) and carried into the world frame.
  const toWorld = (x, y, z) => world.group.localToWorld(new THREE.Vector3(x, y, z));

  function setCam(name) {
    if (!world) return;
    state.cam = name;
    const k = Math.max(L, 700) / 2100;
    if (name === "satellite") {
      satelliteView();
    } else if (name === "quayside") {
      camera.position.copy(toWorld(X0 - 160 * k, 70, 260 * k));
      controls.target.copy(toWorld(X0 + L * 0.35, 25, -10));
    } else if (name === "overhead") {
      camera.position.copy(toWorld(0, 2600 * k + 300, 400 * k));
      controls.target.copy(toWorld(0, 0, 350 * k));
    } else if (name === "crane-cab") {
      const activeCrane = world.cranes.find((c) => c.working) || world.cranes[Math.floor(world.cranes.length / 2)] || world.cranes[0];
      const cx = activeCrane ? activeCrane.x : 0;
      camera.position.copy(toWorld(cx - 18, 48, -8));
      controls.target.copy(toWorld(cx + 22, 16, 48));
    } else if (name === "bay-bridge") {
      camera.position.set(-2350, 290, 1950);
      controls.target.set(-600, 20, 180);
    } else {
      camera.position.copy(toWorld(-300 * k, 1300 * k + 200, 2400 * k + 400));
      controls.target.copy(toWorld(0, 0, 450 * k));
    }
    document.querySelectorAll("[data-cam]").forEach((b) => b.classList.toggle("on", b.dataset.cam === name));
    controls.update();
  }

  // The Google Maps satellite look: high above the port, about 60 degrees down, from the south-south-west, north up
  // on screen. Frames all four terminals when the map is loaded, else this terminal and its anchorage.
  function satelliteView() {
    const pts = [];
    if (frame) {
      for (const name of TERMINALS) {
        const f = frameOf(name);
        if (!f) continue;
        const len = (f.sections || 20) * SECTION_M;
        for (const [lx, lz] of [[0, 0], [len, 0], [0, -500], [len, -500], [len / 2, 350]]) {
          pts.push(frameToWorld(f, lx, lz));
        }
      }
    } else {
      for (const [x, z] of [[X0, -540], [X0 + L, -540], [X0, ANCHOR_Z + 600], [X0 + L, ANCHOR_Z + 600]]) {
        const p = toWorld(x, 0, z);
        pts.push([p.x, p.z]);
      }
    }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of pts) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const el = Math.PI / 3, az = Math.PI / 12;
    const tanV = Math.tan(camera.fov * Math.PI / 360);
    const dist = 1.2 * Math.max((z1 - z0) / 2 * Math.sin(el) / tanV, (x1 - x0) / 2 / (tanV * camera.aspect), 600);
    controls.target.set(cx, 0, cz);
    camera.position.set(cx - dist * Math.sin(az) * Math.cos(el), dist * Math.sin(el), cz + dist * Math.cos(az) * Math.cos(el));
  }

  function highlightSelection(type, idx) {
    if (!world) return;
    world.ships.forEach((o, i) => {
      if (o.asset && o.asset.setSelected) o.asset.setSelected(type === "ship" && i === idx);
    });
    world.cranes.forEach((c, i) => {
      if (c.asset && c.asset.setSelected) c.asset.setSelected(type === "crane" && i === idx);
    });
  }

  function focusShip(o) {
    if (!o) return;
    highlightSelection("ship", o.idx);
    const p = o.group.visible ? o.group.getWorldPosition(new THREE.Vector3())
      : world.group.localToWorld(o.keys[o.keys.length - 3][1].clone());
    const off = camera.position.clone().sub(controls.target).setLength(Math.max(480, o.len * 1.65));
    controls.target.copy(p);
    camera.position.copy(p).add(off);
    controls.update();
  }

  function focusCrane(c) {
    if (!c) return;
    highlightSelection("crane", c.idx);
    const p = c.group.getWorldPosition(new THREE.Vector3());
    p.y += 28;
    const off = camera.position.clone().sub(controls.target).setLength(280);
    controls.target.copy(p);
    camera.position.copy(p).add(off);
    controls.update();
  }

  document.querySelectorAll("[data-cam]").forEach((b) => b.addEventListener("click", () => setCam(b.dataset.cam)));

  // ---------- 3D Raycast Asset Picking ----------
  const raycaster = new THREE.Raycaster();
  const pointerDownPos = new THREE.Vector2();
  const pointerNdc = new THREE.Vector2();

  renderer.domElement.addEventListener("pointerdown", (ev) => {
    pointerDownPos.set(ev.clientX, ev.clientY);
  });

  renderer.domElement.addEventListener("pointerup", (ev) => {
    if (!world || Math.hypot(ev.clientX - pointerDownPos.x, ev.clientY - pointerDownPos.y) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);

    const targets = [];
    for (const o of world.ships) if (o.group.visible) targets.push(o.group);
    for (const c of world.cranes) targets.push(c.group);

    const hits = raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      let cur = hit.object;
      while (cur) {
        if (cur.userData && cur.userData.pickType) {
          const { pickType, pickIdx } = cur.userData;
          if (pickType === "ship") {
            if (HUD && window.OakControlPanel) window.OakControlPanel.selectShip(pickIdx, replay, state.t);
            else focusShip(world.ships[pickIdx]);
          } else if (pickType === "crane") {
            if (window.OakLearning) window.OakLearning.hideShipCard();
            if (HUD && window.OakControlPanel) {
              const st = world.cranes[pickIdx].asset && world.cranes[pickIdx].asset.getStatus
                ? world.cranes[pickIdx].asset.getStatus() : null;
              window.OakControlPanel.selectCrane(pickIdx, st, replay, state.t);
            } else {
              focusCrane(world.cranes[pickIdx]);
            }
          }
          return;
        }
        cur = cur.parent;
      }
    }
    if (window.OakLearning) window.OakLearning.hideShipCard();
  });

  // ---------- loading ----------
  function validate(rep) {
    if (!rep || typeof rep !== "object") throw new Error("not a JSON object");
    if (!Array.isArray(rep.ships)) throw new Error("missing 'ships' array");
    for (const s of rep.ships) {
      for (const k of ["id", "name", "sections", "first_section", "arrival", "berth_hour", "departure"]) {
        if (s[k] === undefined) throw new Error("ship " + (s.id ?? "?") + " lacks '" + k + "'");
      }
    }
  }

  function disposeGroup(grp) {
    if (!grp) return;
    grp.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose && m.dispose());
        else {
          if (obj.material.map) obj.material.map.dispose();
          obj.material.dispose();
        }
      }
    });
  }

  function load(rep, opts) {
    opts = opts || {};
    try {
      validate(rep);
    } catch (e) {
      showError("Cannot read replay: " + e.message);
      return;
    }
    clearError();
    if (world) {
      terminalRoot.remove(world.group);
      disposeGroup(world.group);
      if (world.worldSpaceGroup) {
        scene.remove(world.worldSpaceGroup);
        disposeGroup(world.worldSpaceGroup);
      }
    }
    replay = rep;
    world = buildWorld(rep);
    placeTerminal(rep.task || {});
    // sun shadows cover this terminal only, not the whole bay
    world.center = world.group.localToWorld(new THREE.Vector3(0, 0, -150));
    const R = L / 2 + 600, sc = sun.shadow.camera;
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R;
    sc.near = 100; sc.far = 9000;
    sc.updateProjectionMatrix();
    ui.scrub.max = String(window.OakKPI.horizon(rep));
    if (!opts.keepTime) {
      const urlT = new URLSearchParams(location.search).get("t");
      state.t = urlT !== null ? Number(urlT) : 12;
    }
    state.kpiT = -1;
    buildHeader(rep);
    buildList();
    buildKpis();
    if (!opts.keepCamera) setCam("overview");
    if (HUD && window.OakControlPanel) {
      const scEntry = window.PORTSIM_SCENARIOS && window.PORTSIM_SCENARIOS[state.activeScenario];
      window.OakControlPanel.setReplay(rep, state.activePlan, scEntry ? scEntry.plans : null);
    }
    update(state.t);
  }

  function populateScenarioSelect() {
    if (!window.PORTSIM_SCENARIOS) return;
    if (ui.fixture) {
      ui.fixture.innerHTML = "";
      for (const [scKey, sc] of Object.entries(window.PORTSIM_SCENARIOS)) {
        for (const planKey of ["optimal", "greedy", "naive"]) {
          if (!sc.plans || !sc.plans[planKey]) continue;
          const opt = document.createElement("option");
          opt.value = scKey + ":" + planKey;
          opt.textContent = sc.label + " — " + planKey.toUpperCase();
          ui.fixture.appendChild(opt);
        }
      }
    }
    if (HUD && window.OakControlPanel) {
      const list = Object.entries(window.PORTSIM_SCENARIOS).map(([key, sc]) => ({
        key,
        label: sc.label || key,
        terminal: sc.terminal,
        kind: sc.kind,
      }));
      window.OakControlPanel.setScenarioList(list, state.activeScenario, state.activePlan);
    }
  }

  if (HUD && window.OakControlPanel) {
    window.OakControlPanel.init({
      onSelectScenario(scKey, planKey) {
        state.activeScenario = scKey;
        state.activePlan = planKey || state.activePlan || "optimal";
        loadFixture(state.activeScenario + ":" + state.activePlan);
      },
      onSelectPlan(planKey, scKey) {
        state.activePlan = planKey;
        if (scKey) state.activeScenario = scKey;
        const sc = window.PORTSIM_SCENARIOS && window.PORTSIM_SCENARIOS[state.activeScenario];
        if (sc && sc.plans && sc.plans[planKey]) {
          load(sc.plans[planKey], { keepCamera: true, keepTime: true });
        }
      },
      onSelectShip(idx) {
        if (world && world.ships[idx]) focusShip(world.ships[idx]);
        if (window.OakLearning) window.OakLearning.showShipCard(idx, replay, state.t);
      },
      onSelectCrane(idx) {
        if (world && world.cranes[idx]) focusCrane(world.cranes[idx]);
      },
      onSelectCamera(cam) {
        setCam(cam);
      },
      onToggleLayer(layer, on) {
        if (layer === "ais") {
          state.showAis = on;
          if (world && world.aisOverlay) world.aisOverlay.setVisible(on);
        } else if (layer === "trucks") {
          state.showTrails = on;
          if (world && world.yard && world.yard.setTrails) world.yard.setTrails(on);
        } else if (layer === "night") {
          state.forceNight = on;
          update(state.t, 0);
        }
      },
      onScrub(newT) {
        state.t = newT;
        update(state.t, 0);
      },
      onLoadFile(f) {
        f.text().then((txt) => {
          try {
            load(JSON.parse(txt));
          } catch (e) {
            showError("Cannot parse " + f.name + ": " + e.message);
          }
        });
      },
    });
  }
  populateScenarioSelect();

  function loadUrl(url) {
    return fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(r.status + " " + r.statusText);
        return r.json();
      })
      .then(load)
      .catch((e) => showError("Could not load " + url + ": " + e.message +
        (location.protocol === "file:" ? ". Pages opened from disk cannot fetch files; serve with python -m http.server or use Load JSON." : "")));
  }

  function loadFixture(name) {
    if (name && name.includes(":") && window.PORTSIM_SCENARIOS) {
      const [scKey, planKey] = name.split(":");
      state.activeScenario = scKey;
      state.activePlan = planKey;
      const sc = window.PORTSIM_SCENARIOS[scKey];
      if (sc && sc.plans && sc.plans[planKey]) {
        load(sc.plans[planKey]);
        return;
      }
    }
    if (window.PORTSIM_SCENARIOS && window.PORTSIM_SCENARIOS[name]) {
      state.activeScenario = name;
      const sc = window.PORTSIM_SCENARIOS[name];
      const plan = (sc.plans && sc.plans[state.activePlan]) || (sc.plans && sc.plans.optimal);
      if (plan) {
        load(plan);
        return;
      }
    }
    const fx = window.PORTSIM_FIXTURES || {};
    if (fx[name]) load(fx[name]);
    else loadUrl("fixtures/" + name + ".json");
  }

  ui.file.addEventListener("change", () => {
    const f = ui.file.files && ui.file.files[0];
    if (!f) return;
    f.text().then((txt) => {
      try {
        load(JSON.parse(txt));
      } catch (e) {
        showError("Cannot parse " + f.name + ": " + e.message);
      }
    });
    ui.file.value = "";
  });
  ui.fixture.addEventListener("change", () => loadFixture(ui.fixture.value));

  // ---------- playback controls ----------
  function setPlaying(p) {
    state.playing = p;
    ui.play.textContent = p ? "Pause" : "Play";
  }
  ui.play.addEventListener("click", () => {
    if (!state.playing && state.t >= Number(ui.scrub.max) - 0.01) state.t = 0;
    setPlaying(!state.playing);
  });
  document.querySelectorAll("[data-speed]").forEach((b) => b.addEventListener("click", () => {
    state.speed = Number(b.dataset.speed);
    document.querySelectorAll("[data-speed]").forEach((x) => x.classList.toggle("on", x === b));
  }));
  ui.scrub.addEventListener("pointerdown", () => (state.dragging = true));
  window.addEventListener("pointerup", () => (state.dragging = false));
  ui.scrub.addEventListener("input", () => {
    state.t = Number(ui.scrub.value);
    update(state.t);
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && e.target === document.body) {
      e.preventDefault();
      ui.play.click();
    }
  });
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------- main loop ----------
  const clock = new THREE.Clock();
  function tick() {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (world && state.playing) {
      state.anim += dt;
      state.t += dt * SPEEDS[state.speed];
      const max = Number(ui.scrub.max);
      if (state.t >= max) {
        state.t = max;
        setPlaying(false);
      }
    }
    if (world) update(state.t, dt);
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  // learning.js drives which replay is shown when a loop run is loaded (?run=, default fixtures/run-demo)
  const CAMS = ["overview", "satellite", "quayside", "overhead", "crane-cab", "bay-bridge"];
  window.OakViewer = {
    load,
    play(p) { setPlaying(p === undefined ? !state.playing : !!p); },
    fallback() { loadFixture(state.activeScenario); },
    getT() { return state.t; },
    getReplay() { return replay; },
    seek(t) {
      if (!replay) return;
      state.t = Math.max(0, Math.min(Number(ui.scrub.max), t));
      update(state.t, 0);
    },
    selectShip(idx) {
      if (HUD && window.OakControlPanel) window.OakControlPanel.selectShip(idx, replay, state.t);
      else if (world && world.ships[idx]) focusShip(world.ships[idx]);
    },
    cycleCam() {
      const name = CAMS[(CAMS.indexOf(state.cam) + 1) % CAMS.length];
      setCam(name);
      document.querySelectorAll("#cam-rail [data-cam]").forEach((b) => b.classList.toggle("on", b.dataset.cam === name));
      return name;
    },
  };

  const params = new URLSearchParams(location.search);
  if (params.get("replay")) loadUrl(params.get("replay"));
  else if (params.get("scenario")) loadFixture(params.get("scenario"));
  else if (!window.OakLearning) loadFixture(state.activeScenario);
  if (window.OakLearning) window.OakLearning.start(window.OakViewer);
  requestAnimationFrame(tick);
})();
