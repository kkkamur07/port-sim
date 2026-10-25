/*
 * Oakland berth replay: a stylised 3D replay of one berth plan at a Port of Oakland terminal.
 *
 * Input is a replay JSON (docs/replay_schema.md). The viewer never recomputes rules: ship states, crane counts,
 * closures and fog windows all come from the file. Ship calls in the demo fixtures are GENERATED, not real records;
 * terminal geometry, fleets, depths and shifts follow the real terminals. The scene is not a survey-grade twin.
 *
 * Classic script with the global THREE build (r147) so that double-clicking index.html works on file://.
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
    clock: $("clock"), file: $("file"), fixture: $("fixture"), error: $("error"),
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
  ui.scene.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x8ec5ea, 2500, 18000);
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 5, 40000);
  camera.position.set(0, 1600, 2600);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 60;
  controls.maxDistance = 14000;

  const hemi = new THREE.HemisphereLight(0xdfefff, 0x334455, 0.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(-2000, 3000, 1500);
  scene.add(sun);

  const waterMat = new THREE.MeshPhongMaterial({ color: 0x1d5f7a, shininess: 60, specular: 0x335566 });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), waterMat);
  water.rotation.x = -Math.PI / 2;
  scene.add(water);

  const landMat = new THREE.MeshLambertMaterial({ color: 0x4a4f55 });
  const land = new THREE.Mesh(new THREE.PlaneGeometry(60000, 6000), landMat);
  land.rotation.x = -Math.PI / 2;
  land.position.set(0, 2.5, -APRON_DEPTH - 3000);
  scene.add(land);

  buildHorizon();

  // the dynamic world, rebuilt per replay
  let world = null;
  let replay = null;
  let L = 2100, X0 = -1050;

  const state = { t: 0, playing: false, speed: 4, dragging: false, anim: 0, lastHour: -1 };

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
  }

  // ---------- geometry of one terminal ----------
  const secX0 = (s) => X0 + (s - 1) * SECTION_M;                       // left edge of section s
  const spanCenter = (first, n) => X0 + (first - 1 + n / 2) * SECTION_M;

  function buildWorld(rep) {
    const task = rep.task || {};
    const nSec = (task.last_section || 0) - (task.first_section || 1) + 1 || inferSections(rep);
    L = nSec * SECTION_M;
    X0 = -L / 2;
    const g = new THREE.Group();

    // quay apron and section ticks
    const quayMat = new THREE.MeshLambertMaterial({ color: 0x8d9298 });
    g.add(box(L + 60, QUAY_TOP + 2, APRON_DEPTH, quayMat, 0, (QUAY_TOP - 2) / 2, -APRON_DEPTH / 2));
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

    // yard: stacked container blocks behind the quay
    g.add(buildYard(nSec));

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
    const shipObjs = (rep.ships || []).map((s, i) => buildShip(s, i, task));
    shipObjs.forEach((o) => g.add(o.group));

    // cranes
    const pool = (task.rules && task.rules.crane_pool) || maxCranes(rep) || 4;
    const craneMat = new THREE.MeshLambertMaterial({ color: 0xd6dbe1 });
    const accentMat = new THREE.MeshLambertMaterial({ color: 0xc0392b });
    const glow = glowTexture();
    const cranes = [];
    for (let i = 0; i < pool; i++) {
      const c = buildCrane(craneMat, accentMat, glow);
      c.home = X0 + L * (i + 0.5) / pool;
      c.group.position.set(c.home, QUAY_TOP, 0);
      g.add(c.group);
      cranes.push(c);
    }

    scene.add(g);
    return { group: g, ships: shipObjs, cranes, craneMat, blocks: blockObjs, nSec, targets: new Map() };
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
    const hullMat = new THREE.MeshLambertMaterial({ color: 0x23272e });
    const lineMat = new THREE.MeshLambertMaterial({ color });
    group.add(box(len * 0.92, 12, beam, hullMat, -len * 0.04, 6, 0));
    const bow = box(beam * 0.72, 12, beam * 0.72, hullMat, len * 0.42, 6, 0);
    bow.rotation.y = Math.PI / 4;
    group.add(bow);
    group.add(box(len * 0.92, 2, beam + 0.4, new THREE.MeshLambertMaterial({ color: 0x8a2b2b }), -len * 0.04, 1, 0));
    // superstructure and funnel in the line colour
    group.add(box(Math.max(12, len * 0.05), 26, beam * 0.86, lineMat, -len * 0.36, 25, 0));
    group.add(box(Math.max(8, len * 0.03), 4, beam * 0.9, new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }),
      -len * 0.36, 39, 0));
    group.add(box(10, 14, 10, lineMat, -len * 0.44, 21, 0));
    // deck containers
    const r = rng(1000 + i * 7);
    const bays = [];
    for (let x = -len * 0.31; x < len * 0.36; x += 13.5) bays.push(x);
    const cont = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), bays.length);
    const m = new THREE.Matrix4(), col = new THREE.Color();
    bays.forEach((x, k) => {
      const h = (3 + Math.floor(r() * 5)) * 2.6;
      m.makeScale(12.2, h, beam * 0.9);
      m.setPosition(x, 12 + h / 2, 0);
      cont.setMatrixAt(k, m);
      const c = r() < 0.45 ? color : YARD_COLORS[Math.floor(r() * YARD_COLORS.length)];
      cont.setColorAt(k, col.set(c));
    });
    group.add(cont);
    // late flag
    const flag = new THREE.Group();
    flag.add(box(1.2, 40, 1.2, new THREE.MeshLambertMaterial({ color: 0xdddddd }), 0, 20, 0));
    flag.add(box(18, 11, 0.6, new THREE.MeshBasicMaterial({ color: 0xff3b3b }), 9, 34, 0));
    flag.position.set(len * 0.4, 12, 0);
    flag.visible = false;
    group.add(flag);
    // labels (normal and late)
    const label = makeLabel(s.name, { height: 26, border: color });
    const lateLabel = makeLabel(s.name + "  late " + s.late_h + " h", { height: 26, bg: "rgba(190,30,30,0.95)" });
    label.position.set(0, 72, 0);
    lateLabel.position.set(0, 72, 0);
    lateLabel.visible = false;
    group.add(label, lateLabel);
    group.visible = false;
    const cbh = new Map();
    for (const [h, c] of s.cranes_by_hour || []) cbh.set(h, c);
    return { s, group, flag, label, lateLabel, beam, len, cbh, keys: shipKeys(s, beam) };
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
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffe2a8, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true }));
      sp.scale.set(38, 38, 1);
      sp.position.set(0, 52, z);
      sp.visible = false;
      g.add(sp);
      glows.push(sp);
    }
    return { group: g, trolley, spreader, cable, lampMat, glows, home: 0, x: 0 };
  }

  // ---------- ship motion ----------
  function anchorPos(id) {
    const cols = 5;
    return new THREE.Vector3(X0 + L * ((id % cols) + 0.5) / cols + ((id * 37) % 60) - 30,
      0, ANCHOR_Z + Math.floor(id / cols) * 260 + ((id * 53) % 80));
  }

  function shipKeys(s, beam) {
    const berth = new THREE.Vector3(spanCenter(s.first_section, s.sections), 0, beam / 2 + 5);
    const seaIn = new THREE.Vector3(X0 - 3200 - (s.id % 4) * 300, 0, 3800 + (s.id % 3) * 400);
    const seaOut = new THREE.Vector3(X0 - 3600, 0, 4600 + (s.id % 3) * 300);
    const anch = anchorPos(s.id);
    const k = [[s.arrival - 2, seaIn]];
    if (s.berth_hour > s.arrival) {
      k.push([s.arrival, anch]);
      if (s.berth_hour - 1 > s.arrival) k.push([s.berth_hour - 1, anch]);
      k.push([s.berth_hour, berth]);
    } else {
      k.push([s.berth_hour, berth]);
    }
    k.push([s.departure, berth]);
    k.push([s.departure + 2, seaOut]);
    return k;
  }

  function placeShip(o, t) {
    const k = o.keys;
    if (t < k[0][0] || t > k[k.length - 1][0]) {
      o.group.visible = false;
      return;
    }
    o.group.visible = true;
    let j = 0;
    while (j < k.length - 2 && t >= k[j + 1][0]) j++;
    const [t0, p0] = k[j], [t1, p1] = k[j + 1];
    const u = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 1;
    const e = smooth(u);
    o.group.position.lerpVectors(p0, p1, e);
    const d = p1.clone().sub(p0);
    let yaw = 0;
    if (d.lengthSq() > 1) {
      const travel = Math.atan2(-d.z, d.x);
      const w = Math.min(1, 3 * Math.sin(Math.PI * u));
      yaw = lerpAngle(0, travel, w);
    }
    o.group.rotation.y = yaw;
  }

  function lerpAngle(a, b, u) {
    let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return a + d * u;
  }

  function shipStatus(s, t, cbh) {
    const h = Math.floor(t);
    if (t < s.arrival) return { key: "sea", text: "at sea" };
    if (t < s.berth_hour) return { key: "anchor", text: "at anchor" };
    if (t < s.departure) {
      const c = cbh.get(h) || 0;
      return { key: "alongside", text: c ? "alongside, " + c + " cr" : "alongside, idle" };
    }
    return { key: "departed", text: "departed" };
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
  const NIGHT = new THREE.Color(0x0a1222), DAY = new THREE.Color(0x8ec5ea), DUSK = new THREE.Color(0xf0a070);
  const FOG_DAY = new THREE.Color(0xc9d1d8), FOG_NIGHT = new THREE.Color(0x3a4350);
  const WATER_DAY = new THREE.Color(0x1d5f7a), WATER_NIGHT = new THREE.Color(0x07161f);

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

  function updateSky(t) {
    const d = daylight(t);
    const sky = NIGHT.clone().lerp(DAY, d).lerp(DUSK, 4 * d * (1 - d) * 0.55);
    const f = fogAmount(t);
    const fogCol = FOG_NIGHT.clone().lerp(FOG_DAY, d);
    const bg = sky.clone().lerp(fogCol, f * 0.85);
    scene.background = bg;
    scene.fog.color.copy(bg);
    scene.fog.near = lerp(2500, 60, f);
    scene.fog.far = lerp(18000, 1500, f);
    hemi.intensity = 0.22 + 0.6 * d;
    sun.intensity = 0.08 + 0.85 * d;
    const ang = ((t % 24) / 24) * Math.PI * 2 - Math.PI / 2;
    sun.position.set(Math.cos(ang) * 3000, 600 + Math.max(0, -Math.sin(ang)) * 3000, 1500);
    waterMat.color.copy(WATER_NIGHT).lerp(WATER_DAY, d);
    return d;
  }

  // ---------- per-frame update ----------
  function update(t) {
    if (!world) return;
    const d = updateSky(t);
    const h = Math.floor(t), frac = t - h;
    const meal = h % 24 === 17;

    for (const o of world.ships) {
      placeShip(o, t);
      const late = o.s.late_h > 0 && t >= o.s.due && t < o.s.departure + 2;
      o.flag.visible = late;
      o.label.visible = !late;
      o.lateLabel.visible = late;
    }

    for (const blk of world.blocks) blk.obj.visible = t >= blk.b.start && t < blk.b.end;

    const T0 = craneTargets(h), T1 = craneTargets(h + 1);
    const w = smooth(clamp((frac - 0.7) / 0.3, 0, 1));
    world.craneMat.color.setRGB(meal ? 0.42 : 0.84, meal ? 0.44 : 0.86, meal ? 0.47 : 0.89);
    world.cranes.forEach((c, i) => {
      c.x = lerp(T0.x[i], T1.x[i], w);
      c.group.position.x = c.x;
      const working = T0.working[i] && !meal;
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
      const lit = working && d < 0.6;
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
    updateList(t);
  }

  // ---------- side list and header ----------
  function buildList() {
    ui.tbody.innerHTML = "";
    world.ships.forEach((o) => {
      const s = o.s;
      const tr = document.createElement("tr");
      const late = s.late_h > 0;
      tr.innerHTML =
        "<td><span class='swatch'></span><span class='name'></span><div class='line'></div></td>" +
        "<td class='status'></td><td></td><td></td><td></td>";
      tr.querySelector(".swatch").style.background = lineColor(s.line);
      tr.querySelector(".name").textContent = s.name;
      tr.querySelector(".line").textContent = s.line + ", " + Math.round(s.length_m) + " m, sec " + s.first_section +
        "-" + (s.first_section + s.sections - 1);
      const tds = tr.querySelectorAll("td");
      tds[2].textContent = "h" + s.berth_hour;
      tds[2].title = hourText(s.berth_hour) + " (arrived h" + s.arrival + ")";
      tds[3].textContent = "h" + s.departure;
      tds[3].title = hourText(s.departure) + " (due h" + s.due + ")";
      tds[4].textContent = late ? "+" + s.late_h + " h" : "0";
      if (late) tds[4].className = "late";
      tr.addEventListener("click", () => focusShip(o));
      o.statusCell = tds[1];
      o.lastStatus = "";
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
    }
  }

  function buildHeader(rep) {
    const task = rep.task || {};
    const term = task.terminal || "Terminal";
    ui.title.textContent = term + (task.quay ? ", berths " + task.quay : "") + ", week " + (task.week || 1);
    document.title = term + " Berth Replay";
    const start = task.week_start_utc ? " from " + String(task.week_start_utc).slice(0, 10) : "";
    ui.subtitle.textContent = (task.task_id || "replay") + start + ", " + (rep.ships || []).length +
      " ships, " + (task.kind || "berth") + " plan. Ship calls are generated, not real records.";
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
    parts.push("stylised scene, not a survey-grade twin");
    ui.legend.textContent = parts.join(". ") + ".";
  }

  // ---------- camera presets ----------
  function setCam(name) {
    const k = Math.max(L, 700) / 2100;
    if (name === "quayside") {
      camera.position.set(X0 - 160 * k, 70, 260 * k);
      controls.target.set(X0 + L * 0.35, 25, -10);
    } else if (name === "overhead") {
      camera.position.set(0, 2600 * k + 300, 400 * k);
      controls.target.set(0, 0, 350 * k);
    } else {
      camera.position.set(-300 * k, 1300 * k + 200, 2400 * k + 400);
      controls.target.set(0, 0, 450 * k);
    }
    controls.update();
  }

  function focusShip(o) {
    const p = o.group.visible ? o.group.position : o.keys[o.keys.length - 3][1];
    const off = camera.position.clone().sub(controls.target).setLength(Math.max(500, o.len * 1.8));
    controls.target.copy(p);
    camera.position.copy(p).add(off);
    controls.update();
  }

  document.querySelectorAll("[data-cam]").forEach((b) => b.addEventListener("click", () => setCam(b.dataset.cam)));

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

  function load(rep) {
    try {
      validate(rep);
    } catch (e) {
      showError("Cannot read replay: " + e.message);
      return;
    }
    clearError();
    if (world) {
      scene.remove(world.group);
      world.group.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (obj.material.map) obj.material.map.dispose();
          obj.material.dispose();
        }
      });
    }
    replay = rep;
    world = buildWorld(rep);
    const horizon = rep.horizon_h || Math.max(...rep.ships.map((s) => s.departure + 2), 24);
    ui.scrub.max = String(horizon);
    state.t = 0;
    buildHeader(rep);
    buildList();
    setCam("overview");
    update(state.t);
  }

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
  function frame() {
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
    if (world) update(state.t);
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  const params = new URLSearchParams(location.search);
  if (params.get("replay")) loadUrl(params.get("replay"));
  else loadFixture("oict-demo");
  requestAnimationFrame(frame);
})();
