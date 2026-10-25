/*
 * OakCranes: ship-to-shore gantry cranes for the Oakland berth replay (a stylised representation of the ZPMC-style
 * cranes at the Port of Oakland terminals, not a survey-grade model).
 *
 * Contract: OakCranes.makeCrane(spec) -> {group, setWorking(bool), setBoomUp(bool), setLights(on), update(dt_s),
 * trolley: {z}} with spec = {rail_gauge_m: 28, height_m: 50, outreach_m: 65, seed, color}.
 * Origin at the quay top midway between the rails: local y 0 = QUAY_TOP, waterside legs at z = +14, landside legs at
 * z = -14, the boom reaching toward +z over the water by outreach_m. update(dt) takes sim seconds.
 *
 * Classic script with the global THREE build (r147). Nothing touches THREE until makeCrane is called, so the pure
 * work-cycle maths (OakCranes.workCycle) can be tested with node.
 */
(function () {
  "use strict";

  const CYCLE_S = 90;               // one full quay -> ship -> quay move
  const LUFF_DEG_S = 45 / 20;       // boom luffs 45 deg in 20 s
  const TROLLEY_MS = 4;             // trolley travel when repositioning
  const HOIST_MS = 2;               // hoist speed when repositioning
  const BOX_40 = [12.19, 2.59, 2.44];

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

  function dims(spec) {
    const s = spec || {};
    const gauge = s.rail_gauge_m || 28;
    const H = s.height_m || 50;
    const out = s.outreach_m || 65;
    return {
      gauge, H, out,
      zw: gauge / 2, zl: -gauge / 2,   // leg rows
      LX: 8.5,                          // half leg spacing along the rail
      GX: 3.2,                          // main girders at x = +-GX
      GD: 3,                            // girder depth
      yG: H + 6,                        // girder bottom
      BR: 22,                           // backreach beyond the landside legs
      yQuay: 4.6,                       // spreader centre when the box sits on a yard tractor
      ySpreadUp: H + 1,                 // spreader centre when fully raised
    };
  }

  // Pure work cycle: given time t in the 90 s cycle, where the trolley is (z), where the spreader is (y) and whether a
  // box hangs under it. zQ is the quay lane between the legs, zS the ship row, yS the deck stack top.
  function workCycle(t, d, zS, yS) {
    const u = ((t % CYCLE_S) + CYCLE_S) % CYCLE_S;
    const zQ = 0, up = d.ySpreadUp;
    const seg = (a, b) => smooth(clamp((u - a) / (b - a), 0, 1));
    if (u < 20) return { z: lerp(zQ, zS, seg(0, 20)), y: up, box: false };
    if (u < 32) return { z: zS, y: lerp(up, yS, seg(20, 32)), box: false };
    if (u < 44) return { z: zS, y: lerp(yS, up, seg(32, 44)), box: true };
    if (u < 64) return { z: lerp(zS, zQ, seg(44, 64)), y: up, box: true };
    if (u < 76) return { z: zQ, y: lerp(up, d.yQuay, seg(64, 76)), box: true };
    if (u < 88) return { z: zQ, y: lerp(d.yQuay, up, seg(76, 88)), box: false };
    return { z: zQ, y: up, box: false };
  }

  // ---------- geometry helpers (merged per material, so a crane is a handful of draw calls) ----------
  function Parts() { this.geos = []; }
  Parts.prototype.add = function (geo, m) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.applyMatrix4(m);
    this.geos.push(g);
    if (g !== geo) geo.dispose();
  };
  Parts.prototype.box = function (w, h, d, x, y, z) {
    this.add(new THREE.BoxGeometry(w, h, d), new THREE.Matrix4().makeTranslation(x, y, z));
  };
  // square tapering leg (4-sided cylinder turned 45 deg so its faces line up with the axes)
  Parts.prototype.leg = function (sBot, sTop, y0, y1, x, z) {
    const g = new THREE.CylinderGeometry(sTop * Math.SQRT1_2, sBot * Math.SQRT1_2, y1 - y0, 4, 1);
    g.rotateY(Math.PI / 4);
    this.add(g, new THREE.Matrix4().makeTranslation(x, (y0 + y1) / 2, z));
  };
  Parts.prototype.cyl = function (r, len, x, y, z, axis) {
    const g = new THREE.CylinderGeometry(r, r, len, 10, 1);
    if (axis === "x") g.rotateZ(Math.PI / 2);
    if (axis === "z") g.rotateX(Math.PI / 2);
    this.add(g, new THREE.Matrix4().makeTranslation(x, y, z));
  };
  Parts.prototype.bar = function (a, b, t) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q,
      new THREE.Vector3(1, 1, 1));
    this.add(new THREE.BoxGeometry(t, len, t), m);
  };
  // truss girder along z from z0 to z1 at x, bottom chord at y, depth dep
  Parts.prototype.truss = function (x, y, z0, z1, dep, panel) {
    const len = Math.abs(z1 - z0), zc = (z0 + z1) / 2, s = Math.sign(z1 - z0);
    this.box(0.9, 0.9, len, x, y + 0.45, zc);
    this.box(0.9, 0.7, len, x, y + dep - 0.35, zc);
    const n = Math.max(1, Math.round(len / panel));
    const V = (zz, yy) => new THREE.Vector3(x, yy, zz);
    for (let i = 0; i <= n; i++) {
      const z = z0 + s * len * i / n;
      this.box(0.5, dep - 1.4, 0.5, x, y + dep / 2, z);
      if (i < n) {
        const zn = z0 + s * len * (i + 1) / n;
        if (i % 2) this.bar(V(z, y + 0.8), V(zn, y + dep - 0.6), 0.35);
        else this.bar(V(z, y + dep - 0.6), V(zn, y + 0.8), 0.35);
      }
    }
  };
  Parts.prototype.mesh = function (mat) {
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
    return new THREE.Mesh(geo, mat);
  };

  let glowTex = null;
  function glowTexture() {
    if (glowTex) return glowTex;
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const x = c.getContext("2d");
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.25, "rgba(255,255,255,0.45)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
    glowTex = new THREE.CanvasTexture(c);
    return glowTex;
  }

  function glowSprite(color, size, x, y, z) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true }));
    sp.scale.set(size, size, 1);
    sp.position.set(x, y, z);
    sp.visible = false;
    return sp;
  }

  // ---------- the crane ----------
  function makeCrane(spec) {
    const s = spec || {};
    const d = dims(s);
    const r = rng((s.seed || 1) * 7919 + 13);
    const { zw, zl, LX, GX, GD, yG, BR, out } = d;
    const yTop = yG + GD;

    const white = new THREE.MeshLambertMaterial({ color: 0xf1f3f5 });
    const trim = new THREE.MeshLambertMaterial({ color: new THREE.Color(s.color || "#5aa0d8") });
    const dark = new THREE.MeshLambertMaterial({ color: 0x3a3f45 });
    const glass = new THREE.MeshLambertMaterial({ color: 0x1d3347, emissive: 0x000000 });
    const yellow = new THREE.MeshLambertMaterial({ color: 0xf2c230 });
    const floodMat = new THREE.MeshLambertMaterial({ color: 0x55585c, emissive: 0x000000 });
    const warnMat = new THREE.MeshLambertMaterial({ color: 0x7a1010, emissive: 0x000000 });

    const group = new THREE.Group();
    const W = new Parts(), T = new Parts(), D = new Parts(), F = new Parts(), R = new Parts();

    // portal: four tapering legs, bogies on the rails, sill beams, portal beams, upper ties
    for (const z of [zw, zl]) {
      for (const x of [-LX, LX]) {
        W.leg(2.2, 1.5, 2.2, yTop, x, z);
        D.box(7.5, 1.4, 1.8, x, 1.1, z);                         // equaliser bogie
        for (const dx of [-2.8, -0.95, 0.95, 2.8]) D.cyl(0.42, 0.5, x + dx, 0.42, z, "z");
      }
      T.box(2 * LX + 2.2, 1.7, 1.6, 0, 3.1, z);                  // sill beam, low along the rail
      W.box(2 * LX + 2.2, 2.6, 2.4, 0, yG - 1.3, z);             // upper tie under the girders
    }
    for (const x of [-LX, LX]) {
      T.box(1.8, 2.6, d.gauge - 1.5, x, 19, 0);                  // portal beam across the gauge
      W.bar(new THREE.Vector3(x, 20.3, zw - 1), new THREE.Vector3(x, yG - 2.6, 0), 0.8);
      W.bar(new THREE.Vector3(x, 20.3, zl + 1), new THREE.Vector3(x, yG - 2.6, 0), 0.8);
      W.bar(new THREE.Vector3(x, yG - 2.6, 0), new THREE.Vector3(x, yG - 2.6, zw), 0.6);
    }
    // fixed girders and backreach, trolley rails on top
    for (const x of [-GX, GX]) {
      W.truss(x, yG, zw, zl - BR, GD, 4);
      D.box(0.25, 0.25, zw - zl + BR, x - Math.sign(x) * 0.6, yTop + 0.12, (zw + zl - BR) / 2);
    }
    for (let z = zw; z >= zl - BR; z -= 8) W.box(2 * GX + 0.8, 0.5, 0.6, 0, yTop - 0.3, z);
    W.box(2 * GX + 1, 0.8, 1.2, 0, yTop - 0.4, zl - BR);
    // machinery house on the backreach, trim band
    W.box(13, 6.5, 14, 0, yTop + 3.25, zl - BR + 8);
    T.box(13.1, 1.1, 14.1, 0, yTop + 5.2, zl - BR + 8);
    D.box(3, 1.6, 4, -3, yTop + 7.3, zl - BR + 6);
    // A-frame: four struts from the leg tops to the apex, cross head
    const apexY = yTop + 26, apexZ = 6;
    for (const x of [-GX, GX]) {
      const apex = new THREE.Vector3(x, apexY, apexZ);
      W.bar(new THREE.Vector3(Math.sign(x) * LX, yTop, zw), apex, 1.3);
      W.bar(new THREE.Vector3(Math.sign(x) * LX, yTop, zl), apex, 1.3);
      T.bar(apex, new THREE.Vector3(x, yTop, zl - BR), 0.45);          // backstay
      W.box(1.4, 1.4, 1.4, x, apexY, apexZ);
    }
    W.box(2 * GX + 1.4, 1.2, 1.4, 0, apexY + 0.2, apexZ);
    D.box(1.4, 3, 1.4, 0, apexY + 2.2, apexZ);                         // luffing sheave block
    R.box(0.9, 0.9, 0.9, -GX, apexY + 1.3, apexZ);
    R.box(0.9, 0.9, 0.9, GX, apexY + 1.3, apexZ);
    // portal and backreach floods
    for (const z of [zw - 1, zl + 1]) for (const x of [-LX - 1.4, LX + 1.4]) F.box(0.6, 0.9, 1.4, x, 22, z);
    for (const z of [zl - 6, zl - BR + 2]) F.box(1.6, 0.6, 1.6, 0, yG - 0.3, z);

    group.add(W.mesh(white), T.mesh(trim), D.mesh(dark), F.mesh(floodMat), R.mesh(warnMat));

    // boom: hinged at the waterside legs, luffs about x
    const boom = new THREE.Group();
    boom.position.set(0, yG, zw);
    for (const x of [-GX, GX]) {
      W.truss(x, 0, 0, out, GD, 4);
      D.box(0.25, 0.25, out, x - Math.sign(x) * 0.6, GD + 0.12, out / 2);
    }
    for (let z = 4; z <= out; z += 8) W.box(2 * GX + 0.8, 0.5, 0.6, 0, GD - 0.3, z);
    W.box(2 * GX + 1.2, GD + 0.6, 2.2, 0, GD / 2, out + 0.6);                // boom tip head
    T.box(2 * GX + 1.3, 0.8, 2.3, 0, GD - 0.4, out + 0.6);
    R.box(0.8, 0.8, 0.8, 0, GD + 0.8, out + 0.6);
    for (let z = 8; z < out - 2; z += 14) F.box(1.6, 0.6, 1.6, 0, -0.3, z);
    boom.add(W.mesh(white), T.mesh(trim), F.mesh(floodMat), R.mesh(warnMat));
    group.add(boom);

    // forestays from the apex to two points on the boom (re-aimed every frame as the boom luffs)
    const stayGeo = new THREE.BoxGeometry(0.4, 1, 0.4);
    const stays = [];
    for (const x of [-GX, GX]) for (const f of [0.48, 0.86]) {
      const m = new THREE.Mesh(stayGeo, trim);
      group.add(m);
      stays.push({ m, a: new THREE.Vector3(x, apexY, apexZ), local: new THREE.Vector3(x, GD, out * f) });
    }

    // trolley, operator cab under it, cables, headblock, spreader, container
    const trolleyG = new THREE.Group();
    T.box(2 * GX - 0.4, 2.4, 6.5, 0, yTop + 1.0, 0);
    D.box(2 * GX - 0.6, 0.6, 5.6, 0, yTop + 2.5, 0);
    for (const x of [-GX + 0.6, GX - 0.6]) for (const z of [-2.4, 2.4]) D.cyl(0.4, 0.4, x, yTop + 0.2, z, "x");
    W.box(1.4, 3.2, 1.4, -GX - 1.4, yG - 0.4, 1.2);                          // cab hanger
    W.box(2.6, 2.8, 3.2, -GX - 1.6, yG - 3.2, 1.5);                          // cab
    trolleyG.add(T.mesh(trim), D.mesh(dark), W.mesh(white));
    const cabGlass = new THREE.Mesh(new THREE.BoxGeometry(2.7, 1.6, 2.2), glass);
    cabGlass.position.set(-GX - 1.6, yG - 3.6, 2.2);
    trolleyG.add(cabGlass);
    group.add(trolleyG);

    const cableGeo = new THREE.BoxGeometry(0.07, 1, 0.07);
    const cables = [];
    for (const x of [-1.3, -0.5, 0.5, 1.3]) for (const z of [-0.8, 0.8]) {
      const c = new THREE.Mesh(cableGeo, dark);
      c.position.set(x, 0, z);
      trolleyG.add(c);
      cables.push(c);
    }
    const hook = new THREE.Group();
    const head = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.0, 2.0), yellow);
    head.position.y = 1.1;
    const spreader = new THREE.Mesh(new THREE.BoxGeometry(BOX_40[0], 0.6, 2.4), yellow);
    const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(BOX_40[0], BOX_40[1], BOX_40[2]),
      new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(r(), 0.55, 0.42) }));
    boxMesh.position.y = -0.3 - BOX_40[1] / 2;
    boxMesh.visible = false;
    hook.add(head, spreader, boxMesh);
    trolleyG.add(hook);

    // night glows (sprites), off by day
    const glows = [];
    const addGlow = (parent, color, size, x, y, z) => { const g = glowSprite(color, size, x, y, z); parent.add(g); glows.push(g); };
    for (let z = 8; z < out - 2; z += 14) addGlow(boom, 0xffe2a8, 26, 0, -1.2, z);
    for (const z of [zl - 6, zl - BR + 2]) addGlow(group, 0xffe2a8, 24, 0, yG - 1.2, z);
    for (const z of [zw, zl]) addGlow(group, 0xffe2a8, 18, 0, 22, z);
    const warnGlows = [];
    const addWarn = (parent, x, y, z) => { const g = glowSprite(0xff2a1a, 9, x, y, z); parent.add(g); warnGlows.push(g); };
    addWarn(group, -GX, apexY + 1.3, apexZ);
    addWarn(group, GX, apexY + 1.3, apexZ);
    addWarn(boom, 0, GD + 0.8, out + 0.6);

    // ---------- state ----------
    const parkZ = zl - BR + 14;
    let working = false, boomUpIdle = true, lights = false;
    let angle = 45, cycleT = 0, mode = "idle", clock = r() * 10;
    let tz = parkZ, sy = d.ySpreadUp, carrying = false;
    let zS = zw + out * (0.45 + 0.2 * r()), yS = 14 + 3 * r();
    const api = { group, trolley: { z: tz } };

    function approach(z, y, dt) {
      tz += clamp(z - tz, -TROLLEY_MS * dt, TROLLEY_MS * dt);
      sy += clamp(y - sy, -HOIST_MS * dt, HOIST_MS * dt);
      return Math.abs(z - tz) < 0.01 && Math.abs(y - sy) < 0.01;
    }

    function pose() {
      boom.rotation.x = -angle * Math.PI / 180;
      boom.updateMatrix();
      const p = new THREE.Vector3();
      for (const st of stays) {
        p.copy(st.local).applyMatrix4(boom.matrix);
        const dir = p.clone().sub(st.a);
        const len = dir.length();
        st.m.position.copy(st.a).add(p).multiplyScalar(0.5);
        st.m.scale.set(1, len, 1);
        st.m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      }
      trolleyG.position.z = tz;
      hook.position.y = sy;
      const top = yG - 0.2, bot = sy + 1.6, len = Math.max(0.1, top - bot);
      for (const c of cables) { c.scale.y = len; c.position.y = (top + bot) / 2; }
      boxMesh.visible = carrying;
      api.trolley.z = tz;
    }

    function update(dt) {
      dt = Math.max(0, dt || 0);
      clock += dt;
      // never luff while the trolley is out on the boom
      const wantAngle = working ? 0 : (boomUpIdle ? 45 : 0);
      if (working) {
        if (angle > 0) {
          mode = "lowering";
          approach(parkZ, d.ySpreadUp, dt);
          angle = Math.max(0, angle - LUFF_DEG_S * dt);
        } else if (mode !== "cycle") {
          if (approach(0, d.ySpreadUp, dt)) { mode = "cycle"; cycleT = 0; }
        } else {
          const prev = cycleT % CYCLE_S;
          cycleT += dt;
          if (cycleT % CYCLE_S < prev) { zS = zw + out * (0.3 + 0.45 * r()); yS = 12 + 6 * r(); }
          const w = workCycle(cycleT, d, zS, yS);
          tz = w.z; sy = w.y; carrying = w.box;
        }
      } else {
        mode = "idle";
        carrying = false;
        const parked = approach(parkZ, d.ySpreadUp, dt);
        if (parked || tz < zw - 2) {
          if (angle < wantAngle) angle = Math.min(wantAngle, angle + LUFF_DEG_S * dt);
          else angle = Math.max(wantAngle, angle - LUFF_DEG_S * dt);
        }
      }
      // aircraft warning lights blink at night (1 s on, 1 s off)
      const blink = lights && Math.floor(clock) % 2 === 0;
      warnMat.emissive.setHex(blink ? 0xff2010 : (lights ? 0x300000 : 0x000000));
      for (const g of warnGlows) g.visible = blink;
      pose();
    }

    api.setWorking = function (on) { working = !!on; };
    api.setBoomUp = function (up) { boomUpIdle = !!up; };
    api.setLights = function (on) {
      lights = !!on;
      floodMat.emissive.setHex(lights ? 0xfff0c8 : 0x000000);
      glass.emissive.setHex(lights ? 0x6b5a2a : 0x000000);
      for (const g of glows) g.visible = lights;
      if (!lights) for (const g of warnGlows) g.visible = false;
    };
    api.update = update;
    pose();
    return api;
  }

  window.OakCranes = { makeCrane, workCycle, dims, CYCLE_S };
})();
