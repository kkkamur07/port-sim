/*
 * OakYard: the container yard behind an Oakland quay (a stylised representation, not a survey-grade model).
 *
 * Contract: OakYard.makeYard(spec) -> {group, update(dt_s), setLights(on)} with spec = {length_m, depth_m: 450,
 * lines: [names], seed}. Origin at (0, QUAY_TOP, 0) of the scene; the yard fills x from -length_m/2 to +length_m/2 and
 * z from -40 to -depth_m. Container blocks with one rubber-tyred gantry (RTG) each, yard tractors on the lanes, light
 * masts, reefer racks, a gate canopy, two warehouses and trucks on the back road. update(dt) takes sim seconds.
 *
 * OakYard.layout(spec) is the pure layout maths (block grid, lanes, tractor loops, masts) and runs under node with
 * no THREE; makeYard is the only part that needs THREE.
 */
(function () {
  "use strict";

  const BLOCK_L = 60, BLOCK_W = 20, ROWS = 6, BAYS = 4;
  const PITCH_X = 78, PITCH_Z = 36;                 // block plus cross lane, block plus tractor/RTG lane
  const Z_FRONT = -52;                              // first block edge (yard starts at z = -40)
  const BACK_STRIP = 72;                            // road, gate and warehouses behind the last block row
  const MAST_STEP = 120;
  const BOX_40 = [12.19, 2.59, 2.44];
  const LINE_COLORS = {
    "ONE": "#d6008f", "Maersk": "#42b0d5", "MSC": "#f5c518", "Evergreen": "#1d8a3a", "CMA CGM": "#0b3b8c",
    "Matson": "#0b3e8a", "COSCO": "#0a3d91", "Hapag-Lloyd": "#f26b1d", "Yang Ming": "#0a4a8a", "HMM": "#e60b2c",
    "Wan Hai": "#c8102e", "OOCL": "#1c3f95", "Zim": "#2a2a86", "Pasha": "#0a5c36",
  };
  const LEASE_COLORS = ["#8c8c8c", "#b5543c", "#2f7f8f", "#6d5a46", "#9a9fa5"];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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

  function lineHex(name) {
    if (LINE_COLORS[name]) return LINE_COLORS[name];
    let h = 0;
    for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return LEASE_COLORS[h % LEASE_COLORS.length];
  }

  // ---------- pure layout ----------
  function layout(spec) {
    const s = spec || {};
    const L = s.length_m || 600, D = s.depth_m || 450;
    const r = rng((s.seed || 1) * 104729 + 7);
    const x0 = -L / 2, x1 = L / 2;
    const cols = Math.max(1, Math.floor((L - 20) / PITCH_X));
    const rows = Math.max(1, Math.floor((D - BACK_STRIP + Z_FRONT + (PITCH_Z - BLOCK_W)) / PITCH_Z));
    const gx0 = -cols * PITCH_X / 2 + PITCH_X / 2;
    const roadZ = -D + 14;
    const backZ = Z_FRONT - rows * PITCH_Z + (PITCH_Z - BLOCK_W);  // back edge of the last block row

    // warehouses at the two back corners, gate near the right end of the back road
    const whW = Math.min(110, L * 0.2), whD = 34;
    const warehouses = [
      { x: x0 + 20 + whW / 2, z: roadZ + 12 + whD / 2, w: whW, d: whD, h: 12 },
      { x: x1 - 20 - whW / 2 - (L > 900 ? 260 : 0), z: roadZ + 12 + whD / 2, w: whW, d: whD, h: 10 },
    ];
    const gate = { x: x1 - 20 - Math.min(80, L * 0.12), z: roadZ + 14, w: Math.min(70, L * 0.12), d: 16, h: 8, lanes: 6 };
    if (L <= 900) gate.x = (warehouses[0].x + warehouses[1].x) / 2;

    const hits = (b, o) => Math.abs(b.x - o.x) < (BLOCK_L + o.w) / 2 + 6 && Math.abs(b.z - o.z) < (BLOCK_W + o.d) / 2 + 6;
    const blocks = [];
    for (let j = 0; j < rows; j++) {
      const z = Z_FRONT - BLOCK_W / 2 - j * PITCH_Z;
      if (z - BLOCK_W / 2 < roadZ + 8) break;
      for (let i = 0; i < cols; i++) {
        const b = { i, j, x: gx0 + i * PITCH_X, z, l: BLOCK_L, w: BLOCK_W, rows: ROWS, bays: BAYS };
        if (warehouses.some((o) => hits(b, o)) || hits(b, gate)) continue;
        b.reefer = j === 0 && (i % 9 === 4);
        b.tiers = [];
        for (let k = 0; k < ROWS * BAYS; k++) b.tiers.push(b.reefer ? 1 + Math.floor(r() * 3) : 1 + Math.floor(r() * 5));
        b.rtgPhase = r() * Math.PI * 2;
        b.rtgSpeed = 0.006 + 0.006 * r();
        blocks.push(b);
      }
    }
    // lanes run along x between block rows (plus one in front and one behind the grid)
    const nRows = blocks.reduce((m, b) => Math.max(m, b.j + 1), 0);
    const lanes = [];
    for (let j = 0; j <= nRows; j++) {
      const z = Z_FRONT + (PITCH_Z - BLOCK_W) / 2 - j * PITCH_Z - (j === 0 ? 4 : 0);
      lanes.push({ z, x0: gx0 - PITCH_X / 2 + 6, x1: gx0 + (cols - 0.5) * PITCH_X - 6 });
    }
    // light masts every MAST_STEP along every other lane
    const masts = [];
    for (let j = 0; j < lanes.length; j += 2) {
      const ln = lanes[j];
      for (let x = ln.x0 + 20; x <= ln.x1; x += MAST_STEP) masts.push({ x, z: ln.z, h: 35 });
    }
    // yard tractors: 6 to 12, each on a racetrack loop between two neighbouring lanes
    const nTractors = clamp(Math.round(L / 180), 6, 12);
    const tractors = [];
    for (let k = 0; k < nTractors; k++) {
      const a = lanes.length > 1 ? Math.floor(r() * (lanes.length - 1)) : 0;
      tractors.push({ lane: a, u: r(), speed: 6 + 3 * r(), color: "#" + ["c23b22", "e0b020", "2c6fb5", "3a8a3a"][k % 4],
        load: r() < 0.7 ? lineHex((s.lines || [])[k % Math.max(1, (s.lines || []).length)] || "lease") : null });
    }
    const nTrucks = clamp(Math.round(L / 120), 4, 18);
    const trucks = [];
    for (let k = 0; k < nTrucks; k++) trucks.push({ u: r(), dir: k % 2 ? 1 : -1, speed: 10 + 4 * r() });
    return { L, D, x0, x1, cols, rows: nRows, roadZ, backZ, blocks, lanes, masts, tractors, trucks, warehouses, gate };
  }

  // Racetrack loop between lanes a and a+1: straight along lane a in +x, U-turn, straight back along lane a+1 in -x,
  // U-turn. u in [0, 1). Returns {x, z, heading} (heading in radians for rotation.y: 0 faces +x).
  function loopPath(lay, a, u) {
    const A = lay.lanes[a], B = lay.lanes[Math.min(a + 1, lay.lanes.length - 1)];
    const R = Math.max(4, Math.abs(A.z - B.z) / 2);
    const xs = Math.max(A.x0, B.x0) + R, xe = Math.min(A.x1, B.x1) - R;
    const S = Math.max(1, xe - xs), C = Math.PI * R, P = 2 * S + 2 * C;
    let d = (((u % 1) + 1) % 1) * P;
    const zm = (A.z + B.z) / 2, sgn = A.z > B.z ? 1 : -1;   // lane A nearer the quay
    if (d < S) return { x: xs + d, z: A.z, heading: 0 };
    d -= S;
    if (d < C) {
      const th = d / R;
      return { x: xe + R * Math.sin(th), z: zm + sgn * R * Math.cos(th), heading: sgn * th };
    }
    d -= C;
    if (d < S) return { x: xe - d, z: B.z, heading: Math.PI };
    d -= S;
    const th = d / R;
    return { x: xs - R * Math.sin(th), z: zm - sgn * R * Math.cos(th), heading: Math.PI + sgn * th };
  }

  function pathLength(lay, a) {
    const A = lay.lanes[a], B = lay.lanes[Math.min(a + 1, lay.lanes.length - 1)];
    const R = Math.max(4, Math.abs(A.z - B.z) / 2);
    const S = Math.max(1, Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0) - 2 * R);
    return 2 * S + 2 * Math.PI * R;
  }

  // ---------- geometry helpers ----------
  function Parts() { this.geos = []; }
  Parts.prototype.box = function (w, h, d, x, y, z) {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    g.translate(x, y, z);
    this.geos.push(g);
  };
  Parts.prototype.cyl = function (rt, rb, h, x, y, z, seg) {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg || 6, 1).toNonIndexed();
    g.translate(x, y, z);
    this.geos.push(g);
  };
  Parts.prototype.geometry = function () {
    let n = 0;
    for (const g of this.geos) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    let o = 0;
    for (const g of this.geos) {
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      o += g.attributes.position.count;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.computeBoundingSphere();
    this.geos = [];
    return geo;
  };
  Parts.prototype.mesh = function (mat) { return new THREE.Mesh(this.geometry(), mat); };

  function glowTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const x = c.getContext("2d");
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.25, "rgba(255,255,255,0.4)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  // ---------- the yard ----------
  function makeYard(spec) {
    const s = spec || {};
    const lay = layout(s);
    const r = rng((s.seed || 1) * 31337 + 3);
    const group = new THREE.Group();
    const lines = (s.lines && s.lines.length) ? s.lines : Object.keys(LINE_COLORS).slice(0, 8);
    const palette = lines.map(lineHex).concat(LEASE_COLORS);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const col = new THREE.Color();
    const Y = new THREE.Vector3(0, 1, 0);

    // ground: asphalt with painted lane lines
    const asphalt = new THREE.MeshLambertMaterial({ color: 0x5d6166 });
    const gnd = new THREE.Mesh(new THREE.PlaneGeometry(lay.L, lay.D - 40), asphalt);
    gnd.rotation.x = -Math.PI / 2;
    gnd.position.set(0, 0.02, -(40 + lay.D) / 2);
    group.add(gnd);
    const paint = new THREE.MeshBasicMaterial({ color: 0xd8d2b0 });
    const P = new Parts();
    for (const ln of lay.lanes) P.box(ln.x1 - ln.x0, 0.05, 0.3, (ln.x0 + ln.x1) / 2, 0.06, ln.z);
    P.box(lay.L, 0.05, 0.3, 0, 0.06, lay.roadZ);
    group.add(P.mesh(paint));

    // containers: one instance per stack (40 ft, 1 to 5 tiers), coloured by line
    const stackCount = lay.blocks.reduce((n, b) => n + b.tiers.length, 0);
    const boxMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const stacks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), boxMat, Math.max(1, stackCount));
    const rowW = BLOCK_W / ROWS, bayL = BLOCK_L / BAYS;
    let k = 0;
    for (const b of lay.blocks) {
      for (let row = 0; row < ROWS; row++) for (let bay = 0; bay < BAYS; bay++) {
        const t = b.tiers[row * BAYS + bay];
        const h = t * BOX_40[1];
        v.set(b.x - BLOCK_L / 2 + bayL * (bay + 0.5), h / 2, b.z - BLOCK_W / 2 + rowW * (row + 0.5));
        sc.set(BOX_40[0], h, BOX_40[2]);
        m4.compose(v, q.identity(), sc);
        stacks.setMatrixAt(k, m4);
        col.set(b.reefer ? "#eef1f3" : palette[Math.floor(r() * palette.length)]);
        col.multiplyScalar(0.85 + 0.25 * r());
        stacks.setColorAt(k, col);
        k++;
      }
    }
    stacks.count = k;
    if (stacks.instanceColor) stacks.instanceColor.needsUpdate = true;
    group.add(stacks);

    // reefer racks: steel frames with walkways over the reefer blocks + blue status LEDs
    const steel = new THREE.MeshLambertMaterial({ color: 0x7c848c });
    const reeferLedMat = new THREE.MeshBasicMaterial({ color: 0x00b8ff });
    const RR = new Parts();
    const RLED = new Parts();
    for (const b of lay.blocks) if (b.reefer) {
      for (let bay = 0; bay <= BAYS; bay++) {
        const x = b.x - BLOCK_L / 2 + bayL * bay;
        RR.box(0.4, 9, 0.4, x, 4.5, b.z - BLOCK_W / 2);
        RR.box(0.4, 9, 0.4, x, 4.5, b.z + BLOCK_W / 2);
        RR.box(0.3, 0.3, BLOCK_W, x, 8.8, b.z);
        if (bay < BAYS) {
          const bx = x + bayL * 0.5;
          for (let tier = 0; tier < 3; tier++) {
            const ly = 2.1 + tier * 2.6;
            RLED.box(0.45, 0.22, 0.22, bx, ly, b.z - BLOCK_W / 2 - 0.15);
            RLED.box(0.45, 0.22, 0.22, bx, ly, b.z + BLOCK_W / 2 + 0.15);
          }
        }
      }
      for (const z of [b.z - BLOCK_W / 2, b.z, b.z + BLOCK_W / 2]) RR.box(BLOCK_L, 0.3, 1.0, b.x, 8.6, z);
      RLED.box(BLOCK_L - 1.2, 0.18, 0.18, b.x, 8.95, b.z - BLOCK_W / 2 - 0.12);
      RLED.box(BLOCK_L - 1.2, 0.18, 0.18, b.x, 8.95, b.z + BLOCK_W / 2 + 0.12);
    }
    if (RR.geos.length) group.add(RR.mesh(steel));
    if (RLED.geos.length) group.add(RLED.mesh(reeferLedMat));

    // RTGs: one per block, straddling it, instanced (white frame, red trolley)
    const rtgFrame = new Parts();
    const span = BLOCK_W + 3, rh = 19;
    for (const dz of [-span / 2, span / 2]) {
      for (const dx of [-3.2, 3.2]) rtgFrame.box(0.9, rh, 0.9, dx, rh / 2 + 1.2, dz);
      rtgFrame.box(8, 1.2, 1.4, 0, 0.9, dz);                       // tyre beam
      for (const dx of [-3.2, 3.2]) rtgFrame.box(1.2, 1.6, 1.0, dx, 0.8, dz + Math.sign(dz) * 0.2);
    }
    rtgFrame.box(1.2, 1.6, span + 1.4, -3.2, rh + 1.2, 0);
    rtgFrame.box(1.2, 1.6, span + 1.4, 3.2, rh + 1.2, 0);
    rtgFrame.box(8, 1.4, 1.2, 0, rh + 1.2, -span / 2);
    rtgFrame.box(8, 1.4, 1.2, 0, rh + 1.2, span / 2);
    rtgFrame.box(2.2, 2.4, 2.6, 0, 6, span / 2 + 1.6);                // engine house
    const rtgTop = new Parts();
    rtgTop.box(5.6, 1.8, 4, 0, rh + 2.6, 0);                         // trolley
    rtgTop.box(12.2, 0.5, 2.4, 0, rh - 6, 0);                        // spreader
    const nb = Math.max(1, lay.blocks.length);
    const rtgA = new THREE.InstancedMesh(rtgFrame.geometry(), new THREE.MeshLambertMaterial({ color: 0xeceff1 }), nb);
    const rtgB = new THREE.InstancedMesh(rtgTop.geometry(), new THREE.MeshLambertMaterial({ color: 0xc0392b }), nb);
    rtgA.count = rtgB.count = lay.blocks.length;
    group.add(rtgA, rtgB);

    // light masts: pole instanced, heads glow at night
    const nm = Math.max(1, lay.masts.length);
    const MP = new Parts();
    MP.cyl(0.35, 0.6, 35, 0, 17.5, 0, 6);
    MP.box(4, 0.5, 0.5, 0, 34.5, 0);
    const masts = new THREE.InstancedMesh(MP.geometry(), steel, nm);
    const headMat = new THREE.MeshLambertMaterial({ color: 0x55585c, emissive: 0x000000 });
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(4.4, 1.2, 1.2), headMat, nm);
    lay.masts.forEach((m, i) => {
      m4.makeTranslation(m.x, 0, m.z);
      masts.setMatrixAt(i, m4);
      m4.makeTranslation(m.x, 35.4, m.z);
      heads.setMatrixAt(i, m4);
    });
    masts.count = heads.count = lay.masts.length;
    group.add(masts, heads);
    const glowTex = glowTexture();
    const glows = [];
    for (const m of lay.masts) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffd9a0, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true }));
      sp.scale.set(30, 30, 1);
      sp.position.set(m.x, 34.5, m.z);
      sp.visible = false;
      group.add(sp);
      glows.push(sp);
    }

    // yard tractors: chassis, cab, optional 40 ft box, plus headlights & red taillights
    const nt = Math.max(1, lay.tractors.length);
    const TP = new Parts();
    TP.box(14, 0.6, 2.4, -1.5, 1.1, 0);                               // chassis
    for (const dx of [-7, -4.5, 3.2]) for (const dz of [-1, 1]) TP.box(1.0, 1.0, 0.5, dx, 0.5, dz);
    const chassis = new THREE.InstancedMesh(TP.geometry(), new THREE.MeshLambertMaterial({ color: 0x2b2e33 }), nt);
    const cabs = new THREE.InstancedMesh(new THREE.BoxGeometry(2.6, 2.6, 2.5), new THREE.MeshLambertMaterial({ color: 0xffffff }), nt);
    const loads = new THREE.InstancedMesh(new THREE.BoxGeometry(BOX_40[0], BOX_40[1], BOX_40[2]), boxMat.clone(), nt);
    lay.tractors.forEach((t, i) => {
      cabs.setColorAt(i, col.set(t.color));
      loads.setColorAt(i, col.set(t.load || "#888888"));
    });
    group.add(chassis, cabs, loads);

    // back road trucks: cab + container on chassis, both directions
    const ntr = Math.max(1, lay.trucks.length);
    const KP = new Parts();
    KP.box(2.6, 3, 2.5, 7.6, 2.0, 0);
    KP.box(13, 0.5, 2.4, -0.6, 1.2, 0);
    for (const dx of [-5.5, -4.2, 5.2, 7.8]) for (const dz of [-1, 1]) KP.box(1.0, 1.0, 0.4, dx, 0.5, dz);
    const trucks = new THREE.InstancedMesh(KP.geometry(), new THREE.MeshLambertMaterial({ color: 0xffffff }), ntr);
    const truckBoxes = new THREE.InstancedMesh(new THREE.BoxGeometry(BOX_40[0], BOX_40[1], BOX_40[2]), boxMat.clone(), ntr);
    lay.trucks.forEach((t, i) => {
      trucks.setColorAt(i, col.setHSL(r(), 0.5, 0.45));
      truckBoxes.setColorAt(i, col.set(palette[Math.floor(r() * palette.length)]));
    });
    group.add(trucks, truckBoxes);

    // truck & tractor headlights + red taillights (illuminate when nightFactor > 0.2)
    const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff6d6, transparent: true, opacity: 0.0 });
    const headlightBeamMat = new THREE.MeshBasicMaterial({
      color: 0xfff0b8,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const taillightMat = new THREE.MeshBasicMaterial({ color: 0xff1e1e, transparent: true, opacity: 0.0 });

    const trHeadParts = new Parts();
    trHeadParts.box(0.22, 0.28, 0.42, 6.92, 1.65, -0.82);
    trHeadParts.box(0.22, 0.28, 0.42, 6.92, 1.65, 0.82);
    const trBeamParts = new Parts();
    trBeamParts.box(6.5, 0.08, 2.8, 10.6, 0.14, 0);
    const trTailParts = new Parts();
    trTailParts.box(0.22, 0.26, 0.45, -8.52, 1.15, -0.88);
    trTailParts.box(0.22, 0.26, 0.45, -8.52, 1.15, 0.88);

    const tractorHeadlights = new THREE.InstancedMesh(trHeadParts.geometry(), headlightMat, nt);
    const tractorBeams = new THREE.InstancedMesh(trBeamParts.geometry(), headlightBeamMat, nt);
    const tractorTaillights = new THREE.InstancedMesh(trTailParts.geometry(), taillightMat, nt);
    tractorHeadlights.visible = tractorBeams.visible = tractorTaillights.visible = false;
    group.add(tractorHeadlights, tractorBeams, tractorTaillights);

    const tkHeadParts = new Parts();
    tkHeadParts.box(0.22, 0.30, 0.44, 8.92, 1.55, -0.85);
    tkHeadParts.box(0.22, 0.30, 0.44, 8.92, 1.55, 0.85);
    const tkBeamParts = new Parts();
    tkBeamParts.box(7.5, 0.08, 3.0, 12.9, 0.14, 0);
    const tkTailParts = new Parts();
    tkTailParts.box(0.22, 0.26, 0.46, -7.12, 1.22, -0.88);
    tkTailParts.box(0.22, 0.26, 0.46, -7.12, 1.22, 0.88);

    const truckHeadlights = new THREE.InstancedMesh(tkHeadParts.geometry(), headlightMat, ntr);
    const truckBeams = new THREE.InstancedMesh(tkBeamParts.geometry(), headlightBeamMat, ntr);
    const truckTaillights = new THREE.InstancedMesh(tkTailParts.geometry(), taillightMat, ntr);
    truckHeadlights.visible = truckBeams.visible = truckTaillights.visible = false;
    group.add(truckHeadlights, truckBeams, truckTaillights);

    // Portwise-style glowing fading comet trails behind moving yard tractors and drayage gate trucks
    let trailsEnabled = true;
    const TRAIL_SEGS = 12;
    const totalVehicles = lay.tractors.length + lay.trucks.length;
    const vertsPerVeh = (TRAIL_SEGS + 1) * 2;
    const idxPerVeh = TRAIL_SEGS * 6;
    const trailPositions = new Float32Array(totalVehicles * vertsPerVeh * 3);
    const trailColors = new Float32Array(totalVehicles * vertsPerVeh * 3);
    const trailIndices = new Uint32Array(totalVehicles * idxPerVeh);
    for (let vIdx = 0; vIdx < totalVehicles; vIdx++) {
      const baseV = vIdx * vertsPerVeh;
      const baseI = vIdx * idxPerVeh;
      for (let s = 0; s < TRAIL_SEGS; s++) {
        const i0 = baseV + s * 2;
        const idx = baseI + s * 6;
        trailIndices[idx] = i0;
        trailIndices[idx + 1] = i0 + 1;
        trailIndices[idx + 2] = i0 + 2;
        trailIndices[idx + 3] = i0 + 1;
        trailIndices[idx + 4] = i0 + 3;
        trailIndices[idx + 5] = i0 + 2;
      }
    }
    const trailGeo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(trailPositions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(trailColors, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    trailGeo.setAttribute("position", posAttr);
    trailGeo.setAttribute("color", colAttr);
    trailGeo.setIndex(new THREE.BufferAttribute(trailIndices, 1));
    const trailMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const trailMesh = new THREE.Mesh(trailGeo, trailMat);
    trailMesh.frustumCulled = false;
    group.add(trailMesh);

    // back road, warehouses, gate canopy with booths + OCR gate lane status portals
    const roadMat = new THREE.MeshLambertMaterial({ color: 0x3f4247 });
    const road = new THREE.Mesh(new THREE.BoxGeometry(lay.L, 0.1, 16), roadMat);
    road.position.set(0, 0.06, lay.roadZ);
    group.add(road);
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xc9c2b4 });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x7d8a96 });
    const WP = new Parts(), RP = new Parts();
    for (const w of lay.warehouses) {
      WP.box(w.w, w.h, w.d, w.x, w.h / 2, w.z);
      RP.box(w.w + 1, 0.8, w.d + 1, w.x, w.h + 0.4, w.z);
      for (let x = w.x - w.w / 2 + 8; x < w.x + w.w / 2 - 4; x += 12) RP.box(5, 5, 0.3, x, 2.6, w.z - w.d / 2 - 0.1);
    }
    const g = lay.gate;
    const CP = new Parts();
    const OCR_FRAME = new Parts();
    const OCR_GREEN = new Parts();
    const OCR_RED = new Parts();
    const ocrZ = g.z - g.d / 2 - 4.2;
    CP.box(g.w, 1.2, g.d, g.x, g.h, g.z);
    for (let i = 0; i <= g.lanes; i++) {
      const x = g.x - g.w / 2 + g.w * i / g.lanes;
      CP.box(0.5, g.h, 0.5, x, g.h / 2, g.z - g.d / 2 + 1);
      CP.box(0.5, g.h, 0.5, x, g.h / 2, g.z + g.d / 2 - 1);
      // OCR portal legs
      OCR_FRAME.box(0.38, g.h - 0.6, 0.38, x, (g.h - 0.6) / 2, ocrZ);
      if (i < g.lanes) {
        WP.box(1.8, 2.6, 2.4, x + 0.8, 1.3, g.z);       // booth
        const laneW = g.w / g.lanes;
        const lx = x + laneW / 2;
        // OCR portal overhead crossbeam + camera pods
        OCR_FRAME.box(laneW, 0.55, 0.65, lx, g.h - 0.6, ocrZ);
        OCR_FRAME.box(0.45, 0.45, 0.8, lx - laneW * 0.25, g.h - 1.0, ocrZ);
        OCR_FRAME.box(0.45, 0.45, 0.8, lx + laneW * 0.25, g.h - 1.0, ocrZ);
        // Lane status LED bars on OCR portal & main canopy (open green / closed red lanes)
        const isClosedLane = (i === g.lanes - 2);
        const targetLED = isClosedLane ? OCR_RED : OCR_GREEN;
        targetLED.box(laneW * 0.68, 0.24, 0.18, lx, g.h - 0.58, ocrZ - 0.36);
        targetLED.box(laneW * 0.68, 0.24, 0.18, lx, g.h - 0.58, ocrZ + 0.36);
        targetLED.box(laneW * 0.62, 0.26, 0.2, lx, g.h - 0.2, g.z - g.d / 2 - 0.12);
        targetLED.box(laneW * 0.62, 0.26, 0.2, lx, g.h - 0.2, g.z + g.d / 2 + 0.12);
      }
    }
    group.add(WP.mesh(wallMat), RP.mesh(roofMat), CP.mesh(new THREE.MeshLambertMaterial({ color: 0xe8eaec })));
    if (OCR_FRAME.geos.length) group.add(OCR_FRAME.mesh(new THREE.MeshLambertMaterial({ color: 0x2c3540 })));
    if (OCR_GREEN.geos.length) group.add(OCR_GREEN.mesh(new THREE.MeshBasicMaterial({ color: 0x00e676 })));
    if (OCR_RED.geos.length) group.add(OCR_RED.mesh(new THREE.MeshBasicMaterial({ color: 0xff2d2d })));
    const gateBand = new THREE.Mesh(new THREE.BoxGeometry(g.w + 0.2, 0.5, g.d + 0.2), new THREE.MeshLambertMaterial({ color: 0x1f4f7a }));
    gateBand.position.set(g.x, g.h - 0.2, g.z);
    group.add(gateBand);

    // ---------- motion ----------
    let t = 0;
    let lastTimeArg = null;
    let manualLightsOn = false;
    let currentNightFactor = 0;
    const lens = lay.tractors.map((tr) => pathLength(lay, tr.lane));

    function syncNightLighting(nf) {
      const activeNight = manualLightsOn ? Math.max(nf, 1.0) : nf;
      const showTruckLights = activeNight > 0.2;
      tractorHeadlights.visible = tractorBeams.visible = tractorTaillights.visible = showTruckLights;
      truckHeadlights.visible = truckBeams.visible = truckTaillights.visible = showTruckLights;
      if (showTruckLights) {
        const strength = Math.min(1, (activeNight - 0.2) / 0.5);
        headlightMat.opacity = 0.65 + 0.35 * strength;
        headlightBeamMat.opacity = 0.12 + 0.22 * strength;
        taillightMat.opacity = 0.7 + 0.3 * strength;
      }
      const mastOn = manualLightsOn || activeNight > 0.35;
      headMat.emissive.setHex(mastOn ? 0xffe8c0 : 0x000000);
      for (const sp of glows) sp.visible = mastOn;
    }

    function updateCometTrails() {
      if (!trailsEnabled) return;
      const nightBoost = currentNightFactor > 0.2 ? 1.25 : 0.9;
      let vIdx = 0;

      // 1. Yard tractors comet trails
      for (let i = 0; i < lay.tractors.length; i++, vIdx++) {
        const tr = lay.tractors[i];
        const pathLen = lens[i] || 1;
        const uHead = tr.u + t * tr.speed / pathLen;
        const trailLenM = 28;
        const baseV = vIdx * vertsPerVeh;
        for (let s = 0; s <= TRAIL_SEGS; s++) {
          const frac = s / TRAIL_SEGS;
          const distBack = 5.5 + frac * trailLenM;
          const pt = loopPath(lay, tr.lane, uHead - distBack / pathLen);
          const nx = -Math.sin(pt.heading);
          const nz = Math.cos(pt.heading);
          const halfW = 1.15 * (1 - frac * 0.72);
          const y = 0.32 + (1 - frac) * 0.25;
          const vi = (baseV + s * 2) * 3;
          trailPositions[vi] = pt.x + nx * halfW;
          trailPositions[vi + 1] = y;
          trailPositions[vi + 2] = pt.z + nz * halfW;
          trailPositions[vi + 3] = pt.x - nx * halfW;
          trailPositions[vi + 4] = y;
          trailPositions[vi + 5] = pt.z - nz * halfW;

          const fade = Math.pow(1 - frac, 1.85) * nightBoost;
          // Portwise cyan-amber warm comet gradient for yard tractors
          const rC = Math.min(1, (0.22 + 0.78 * (1 - frac)) * fade);
          const gC = Math.min(1, (0.78 * (1 - frac * 0.35)) * fade);
          const bC = Math.min(1, (0.95 * (1 - frac * 0.15)) * fade);
          trailColors[vi] = trailColors[vi + 3] = rC;
          trailColors[vi + 1] = trailColors[vi + 4] = gC;
          trailColors[vi + 2] = trailColors[vi + 5] = bC;
        }
      }

      // 2. Drayage gate / road trucks comet trails
      const span = lay.L + 40;
      for (let i = 0; i < lay.trucks.length; i++, vIdx++) {
        const tk = lay.trucks[i];
        const dHead = (((tk.u * span + tk.dir * t * tk.speed) % span) + span) % span;
        const z = lay.roadZ + (tk.dir > 0 ? -3.5 : 3.5);
        const trailLenM = 34;
        const baseV = vIdx * vertsPerVeh;
        // Clamp trail so wraparound across span doesn't stretch across the map
        for (let s = 0; s <= TRAIL_SEGS; s++) {
          const frac = s / TRAIL_SEGS;
          const distBack = 6.2 + frac * trailLenM;
          const dSample = Math.max(0, Math.min(span, dHead - tk.dir * distBack));
          const x = -span / 2 + dSample;
          const halfW = 1.2 * (1 - frac * 0.72);
          const y = 0.35 + (1 - frac) * 0.25;
          const vi = (baseV + s * 2) * 3;
          trailPositions[vi] = x;
          trailPositions[vi + 1] = y;
          trailPositions[vi + 2] = z - halfW;
          trailPositions[vi + 3] = x;
          trailPositions[vi + 4] = y;
          trailPositions[vi + 5] = z + halfW;

          const fade = Math.pow(1 - frac, 1.85) * nightBoost;
          // Warm amber-orange comet trail for drayage trucks
          const rC = Math.min(1, 1.0 * fade);
          const gC = Math.min(1, (0.58 * (1 - frac * 0.4)) * fade);
          const bC = Math.min(1, (0.18 * (1 - frac * 0.7)) * fade);
          trailColors[vi] = trailColors[vi + 3] = rC;
          trailColors[vi + 1] = trailColors[vi + 4] = gC;
          trailColors[vi + 2] = trailColors[vi + 5] = bC;
        }
      }

      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    }

    function place() {
      lay.blocks.forEach((b, i) => {
        const x = b.x + Math.sin(t * b.rtgSpeed + b.rtgPhase) * (BLOCK_L / 2 - 6);
        m4.makeTranslation(x, 0, b.z);
        rtgA.setMatrixAt(i, m4);
        const zt = Math.sin(t * b.rtgSpeed * 3.1 + b.rtgPhase) * (BLOCK_W / 2 - 3);
        m4.makeTranslation(x, 0, b.z + zt);
        rtgB.setMatrixAt(i, m4);
      });
      rtgA.instanceMatrix.needsUpdate = rtgB.instanceMatrix.needsUpdate = true;
      lay.tractors.forEach((tr, i) => {
        const p = loopPath(lay, tr.lane, tr.u + t * tr.speed / lens[i]);
        q.setFromAxisAngle(Y, p.heading);
        v.set(p.x, 0, p.z);
        m4.compose(v, q, sc.set(1, 1, 1));
        chassis.setMatrixAt(i, m4);
        tractorHeadlights.setMatrixAt(i, m4);
        tractorBeams.setMatrixAt(i, m4);
        tractorTaillights.setMatrixAt(i, m4);
        const off = new THREE.Vector3(5.6, 2.7, 0).applyQuaternion(q);
        m4.compose(v.clone().add(off), q, sc);
        cabs.setMatrixAt(i, m4);
        const offB = new THREE.Vector3(-1.5, 1.4 + BOX_40[1] / 2, 0).applyQuaternion(q);
        m4.compose(v.clone().add(offB), q, tr.load ? sc : sc.set(0, 0, 0));
        loads.setMatrixAt(i, m4);
      });
      chassis.instanceMatrix.needsUpdate = cabs.instanceMatrix.needsUpdate = loads.instanceMatrix.needsUpdate = true;
      tractorHeadlights.instanceMatrix.needsUpdate = tractorBeams.instanceMatrix.needsUpdate = tractorTaillights.instanceMatrix.needsUpdate = true;
      lay.trucks.forEach((tk, i) => {
        const span = lay.L + 40;
        const d = (((tk.u * span + tk.dir * t * tk.speed) % span) + span) % span;
        const x = -span / 2 + d, z = lay.roadZ + (tk.dir > 0 ? -3.5 : 3.5);
        q.setFromAxisAngle(Y, tk.dir > 0 ? 0 : Math.PI);
        v.set(x, 0, z);
        m4.compose(v, q, sc.set(1, 1, 1));
        trucks.setMatrixAt(i, m4);
        truckHeadlights.setMatrixAt(i, m4);
        truckBeams.setMatrixAt(i, m4);
        truckTaillights.setMatrixAt(i, m4);
        const off = new THREE.Vector3(-0.6, 1.45 + BOX_40[1] / 2, 0).applyQuaternion(q);
        m4.compose(v.clone().add(off), q, sc);
        truckBoxes.setMatrixAt(i, m4);
      });
      trucks.instanceMatrix.needsUpdate = truckBoxes.instanceMatrix.needsUpdate = true;
      truckHeadlights.instanceMatrix.needsUpdate = truckBeams.instanceMatrix.needsUpdate = truckTaillights.instanceMatrix.needsUpdate = true;
      updateCometTrails();
    }
    place();

    return {
      group,
      layout: lay,
      update(dtOrTime, nightFactor) {
        if (typeof dtOrTime === "number" && Number.isFinite(dtOrTime)) {
          if (dtOrTime > 1.5 && lastTimeArg !== null && dtOrTime >= lastTimeArg && (dtOrTime - lastTimeArg) < 5) {
            t += dtOrTime - lastTimeArg;
          } else if (dtOrTime <= 1.5) {
            t += Math.max(0, dtOrTime);
          }
          lastTimeArg = dtOrTime;
        }
        if (typeof nightFactor === "number" && Number.isFinite(nightFactor)) {
          currentNightFactor = Math.max(0, Math.min(1, nightFactor));
        }
        syncNightLighting(currentNightFactor);
        place();
      },
      setLights(on) {
        manualLightsOn = !!on;
        syncNightLighting(currentNightFactor);
      },
      setTrails(enabled) {
        trailsEnabled = enabled !== false;
        trailMesh.visible = trailsEnabled;
        if (trailsEnabled) updateCometTrails();
      },
    };
  }

  window.OakYard = { makeYard, layout, loopPath, pathLength };
})();
