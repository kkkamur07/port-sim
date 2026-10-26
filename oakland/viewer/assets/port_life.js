// port_life.js — Bay Area & Port of Oakland ambient harbor life (classic script).
// Populates non-active Oakland terminals (OICT, TraPac, Everport, Matson),
// SF Bay tractor tug fleet, 3D ECDIS/AIS navigation overlay, and harbor traffic
// (USCG channel buoys, Bay Bridge East Span SAS tower + traffic, BNSF double-stack train).
(function () {
  "use strict";

  const QUAY_TOP = 3.0;
  const SECTION_M = 42.0;

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v || 0));
  }

  function inferNightFactor(hour, nightFactor) {
    if (typeof nightFactor === "number" && !Number.isNaN(nightFactor)) {
      return clamp01(nightFactor);
    }
    const h = ((Number(hour) || 0) % 24 + 24) % 24;
    // Smooth twilight transitions around 05:30-07:00 and 18:00-19:45
    if (h < 5.5 || h >= 19.75) return 1.0;
    if (h >= 7.0 && h < 18.0) return 0.0;
    if (h < 7.0) return 1.0 - (h - 5.5) / 1.5;
    return (h - 18.0) / 1.75;
  }

  function makeBadgeSprite(text, opts) {
    opts = opts || {};
    const fontSize = opts.fontSize || 28;
    const padX = opts.padX || 16;
    const padY = opts.padY || 8;
    const fg = opts.fg || "#e6f4ff";
    const bg = opts.bg || "rgba(8, 16, 26, 0.86)";
    const border = opts.border || "rgba(56, 189, 248, 0.85)";

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const font = "700 " + fontSize + "px 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width + padX * 2);
    const h = Math.ceil(fontSize + padY * 2);
    canvas.width = w * 2;
    canvas.height = h * 2;
    ctx.scale(2, 2);
    ctx.font = font;

    const r = 6;
    ctx.fillStyle = bg;
    ctx.strokeStyle = border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r, 1);
    ctx.lineTo(w - r, 1);
    ctx.quadraticCurveTo(w - 1, 1, w - 1, r);
    ctx.lineTo(w - 1, h - r);
    ctx.quadraticCurveTo(w - 1, h - 1, w - r, h - 1);
    ctx.lineTo(r, h - 1);
    ctx.quadraticCurveTo(1, h - 1, 1, h - r);
    ctx.lineTo(1, r);
    ctx.quadraticCurveTo(1, 1, r, 1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = fg;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(text, w / 2, h / 2 + 1);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(mat);
    const scale = opts.scale || 0.22;
    sprite.scale.set(w * scale, h * scale, 1);
    sprite.renderOrder = 950;
    return sprite;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. PASSIVE TERMINALS
  // ─────────────────────────────────────────────────────────────────────────
  const PASSIVE_PRESETS = {
    OICT: {
      seed: 101,
      craneCount: 5,
      craneColor: 0xc8102e,
      yardDepth: 220,
      ships: [
        { name: "CMA CGM SYMI", line: "CMA_CGM", length_m: 366, beam_m: 51, draught_m: 14.5, sections: 8, load: 0.78, fracX: 0.30, seed: 11 },
        { name: "MSC LAUREN", line: "MSC", length_m: 330, beam_m: 48, draught_m: 13.8, sections: 7, load: 0.65, fracX: 0.76, seed: 12 }
      ]
    },
    TraPac: {
      seed: 202,
      craneCount: 4,
      craneColor: 0x2563eb,
      yardDepth: 195,
      ships: [
        { name: "ONE AQUILA", line: "ONE", length_m: 364, beam_m: 51, draught_m: 14.2, sections: 8, load: 0.82, fracX: 0.36, seed: 21 },
        { name: "YM WELLNESS", line: "YANG_MING", length_m: 333, beam_m: 48, draught_m: 13.5, sections: 7, load: 0.60, fracX: 0.78, seed: 22 }
      ]
    },
    Everport: {
      seed: 303,
      craneCount: 4,
      craneColor: 0x059669,
      yardDepth: 180,
      ships: [
        { name: "EVER FORTUNE", line: "EVERGREEN", length_m: 334, beam_m: 48, draught_m: 13.6, sections: 7, load: 0.85, fracX: 0.52, seed: 31 }
      ]
    },
    Matson: {
      seed: 404,
      craneCount: 3,
      craneColor: 0xd97706,
      yardDepth: 165,
      ships: [
        { name: "DANIEL K. INOUYE", line: "MAERSK", length_m: 260, beam_m: 35, draught_m: 11.5, sections: 6, load: 0.74, fracX: 0.35, seed: 41 },
        { name: "LURLINE", line: "HAPAG", length_m: 265, beam_m: 35, draught_m: 11.5, sections: 6, load: 0.68, fracX: 0.75, seed: 42 }
      ]
    }
  };

  const BOX_PALETTE = [
    0xdc2626, // CMA red
    0x008060, // Evergreen green
    0xd9006c, // ONE magenta
    0x38bdf8, // Maersk light blue
    0xf97316, // Hapag orange
    0xeab308, // MSC gold
    0x2563eb, // Cosco blue
    0x94a3b8  // Reefer silver/white
  ];

  // Passive ships sail a repeating cycle that is a pure function of sim hour:
  // moored, cast off (+z), transit along x past the quay end, away, then the reverse.
  const SAIL_PERIOD_H = 36;
  const SAIL_CAST_H = 1.5;
  const SAIL_TRANSIT_H = 2.5;
  const SAIL_AWAY_H = 6;
  const SAIL_OFF_Z = 90;
  const SAIL_YAW = 0.18;

  function sailSmooth(v) {
    const c = Math.min(1, Math.max(0, v));
    return c * c * (3 - 2 * c);
  }

  function placeSailingShip(s, hour) {
    const away = SAIL_CAST_H + SAIL_TRANSIT_H;
    const moorEnd = SAIL_PERIOD_H - 2 * away - SAIL_AWAY_H;
    const u = (((hour + s.cycleOffset) % SAIL_PERIOD_H) + SAIL_PERIOD_H) % SAIL_PERIOD_H;
    // k: 0 moored .. 1 off the quay .. 2 at sea; mirrored on the way back
    let k;
    if (u < moorEnd) k = 0;
    else if (u < moorEnd + away) k = (u - moorEnd) <= SAIL_CAST_H ? (u - moorEnd) / SAIL_CAST_H : 1 + (u - moorEnd - SAIL_CAST_H) / SAIL_TRANSIT_H;
    else if (u < moorEnd + away + SAIL_AWAY_H) k = 2;
    else {
      const r = SAIL_PERIOD_H - u;
      k = r <= SAIL_CAST_H ? r / SAIL_CAST_H : 1 + (r - SAIL_CAST_H) / SAIL_TRANSIT_H;
    }
    const zOff = SAIL_OFF_Z * sailSmooth(Math.min(1, k));
    const xs = sailSmooth(k - 1);
    const yawAmt = k <= 1 ? sailSmooth(k) : 1 - sailSmooth((k - 1) * 2);
    s.ship.group.position.set(s.baseX + (s.seaX - s.baseX) * xs, 0, s.baseZ + zOff);
    s.ship.group.rotation.y = s.baseYaw - s.dir * SAIL_YAW * yawAmt;
    s.ship.group.visible = k < 2;
    s.ship.setMoored(k === 0);
    s.ship.setSpeed(k === 0 ? 0 : k < 1 ? 1 + 2 * k : 3 + 3 * Math.sin(Math.PI * Math.min(1, k - 1)));
  }

  function buildSinglePassiveTerminal(key, tf, preset) {
    const rng = mulberry32(preset.seed || 77);
    const termGroup = new THREE.Group();
    termGroup.name = "PassiveTerminal_" + key;

    // Align local frame with OakGeo.terminalFrame(key):
    // +x along berth [0, length_m], z = 0 quay face, +z water, -z inland yard
    termGroup.position.set(tf.origin[0], 0, tf.origin[1]);
    termGroup.rotation.y = -tf.heading_rad;
    if (tf.water_side === -1) {
      termGroup.scale.z = -1;
    }

    const L = tf.length_m || (tf.sections || 24) * SECTION_M;
    const D = preset.yardDepth || 190;

    // 1. Concrete quay wall, cap beam, and yard apron slab
    const apronMat = new THREE.MeshStandardMaterial({
      color: 0x4b545f,
      roughness: 0.88,
      metalness: 0.08
    });
    const apron = new THREE.Mesh(new THREE.BoxGeometry(L, QUAY_TOP + 2, D), apronMat);
    apron.position.set(L * 0.5, (QUAY_TOP - 2) * 0.5, -D * 0.5);
    apron.receiveShadow = true;
    termGroup.add(apron);

    const copeMat = new THREE.MeshStandardMaterial({
      color: 0x8a95a5,
      roughness: 0.65,
      metalness: 0.15
    });
    const copeBeam = new THREE.Mesh(new THREE.BoxGeometry(L, 0.45, 2.6), copeMat);
    copeBeam.position.set(L * 0.5, QUAY_TOP + 0.08, -1.3);
    termGroup.add(copeBeam);

    // Crane rail tracks along apron
    const railMat = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.5, metalness: 0.6 });
    [-6.0, -34.0].forEach(function (rz) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(L - 16, 0.14, 0.45), railMat);
      rail.position.set(L * 0.5, QUAY_TOP + 0.07, rz);
      termGroup.add(rail);
    });

    // Rubber quay fenders + mooring bollards
    const fenderCount = Math.max(12, Math.floor(L / 28));
    const fenderGeo = new THREE.BoxGeometry(2.2, 2.2, 0.9);
    const fenderMat = new THREE.MeshStandardMaterial({ color: 0x16191d, roughness: 0.9 });
    const fenders = new THREE.InstancedMesh(fenderGeo, fenderMat, fenderCount);
    const bollardGeo = new THREE.CylinderGeometry(0.28, 0.35, 0.85, 8);
    const bollardMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.5, metalness: 0.4 });
    const bollards = new THREE.InstancedMesh(bollardGeo, bollardMat, fenderCount);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < fenderCount; i++) {
      const fx = ((i + 0.5) / fenderCount) * L;
      dummy.position.set(fx, QUAY_TOP - 1.0, 0.45);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      fenders.setMatrixAt(i, dummy.matrix);

      dummy.position.set(fx, QUAY_TOP + 0.42, -1.2);
      dummy.updateMatrix();
      bollards.setMatrixAt(i, dummy.matrix);
    }
    fenders.instanceMatrix.needsUpdate = true;
    bollards.instanceMatrix.needsUpdate = true;
    termGroup.add(fenders);
    termGroup.add(bollards);

    // 2. ZPMC STS Cranes (3-5 per terminal)
    const cranes = [];
    const craneCount = preset.craneCount || 4;
    for (let i = 0; i < craneCount; i++) {
      const frac = (i + 0.7) / (craneCount + 0.4);
      const cx = L * frac + (rng() - 0.5) * 22;
      if (window.OakCranes && typeof window.OakCranes.makeCrane === "function") {
        const c = window.OakCranes.makeCrane({
          rail_gauge_m: 28,
          height_m: 50,
          outreach_m: 65,
          seed: preset.seed + i * 17,
          color: preset.craneColor
        });
        c.group.position.set(cx, QUAY_TOP, -20);
        const boomUp = i === craneCount - 1 && craneCount >= 4;
        c.setBoomUp(boomUp);
        c.setWorking(!boomUp);
        termGroup.add(c.group);
        cranes.push({ crane: c, baseX: cx, phase: rng() * Math.PI * 2, boomUp: boomUp });
      }
    }

    // 3. Yard Container Stacks (InstancedMesh)
    const boxL = 12.2;
    const boxW = 2.44;
    const boxH = 2.59;
    const rowsAlongX = Math.max(8, Math.floor((L - 80) / (boxL + 4.5)));
    const blocksZ = 4;
    const lanesPerBlock = 5;
    const maxTiers = 4;
    const maxBoxes = rowsAlongX * blocksZ * lanesPerBlock * maxTiers;

    const boxGeo = new THREE.BoxGeometry(boxL, boxH, boxW);
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.65,
      metalness: 0.18
    });
    const instBoxes = new THREE.InstancedMesh(boxGeo, boxMat, maxBoxes);
    instBoxes.castShadow = true;
    instBoxes.receiveShadow = true;

    let boxIdx = 0;
    const colorTmp = new THREE.Color();
    for (let r = 0; r < rowsAlongX; r++) {
      // Leave truck avenues every 4 bays
      if (r % 5 === 2) continue;
      const bx = 48 + r * (boxL + 4.2);
      if (bx > L - 48) break;
      for (let b = 0; b < blocksZ; b++) {
        const blockBaseZ = -52 - b * 32;
        if (Math.abs(blockBaseZ) > D - 24) continue;
        const blockColorHex = BOX_PALETTE[(r + b * 3) % BOX_PALETTE.length];
        for (let lane = 0; lane < lanesPerBlock; lane++) {
          if (rng() < 0.18) continue;
          const tiers = 1 + Math.floor(rng() * maxTiers);
          const bz = blockBaseZ - lane * (boxW + 0.65);
          for (let t = 0; t < tiers; t++) {
            const by = QUAY_TOP + (t + 0.5) * boxH;
            dummy.position.set(bx, by, bz);
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix();
            instBoxes.setMatrixAt(boxIdx, dummy.matrix);

            const pick = rng() < 0.65 ? blockColorHex : BOX_PALETTE[Math.floor(rng() * BOX_PALETTE.length)];
            colorTmp.setHex(pick).offsetHSL(0, 0, (rng() - 0.5) * 0.08);
            instBoxes.setColorAt(boxIdx, colorTmp);
            boxIdx++;
          }
        }
      }
    }
    instBoxes.count = boxIdx;
    instBoxes.instanceMatrix.needsUpdate = true;
    if (instBoxes.instanceColor) instBoxes.instanceColor.needsUpdate = true;
    termGroup.add(instBoxes);

    // 4. High-Mast Yard Light Towers
    const mastLights = [];
    const mastCount = Math.max(4, Math.floor(L / 190));
    const poleGeo = new THREE.CylinderGeometry(0.35, 0.55, 32, 8);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.5, metalness: 0.6 });
    const headGeo = new THREE.BoxGeometry(3.6, 0.7, 1.8);
    const coneGeo = new THREE.ConeGeometry(28, 32, 16, 1, true);

    for (let m = 0; m < mastCount; m++) {
      const mx = ((m + 0.5) / mastCount) * L;
      const mz = -44 - (m % 2) * 58;
      const mastGroup = new THREE.Group();
      mastGroup.position.set(mx, QUAY_TOP, mz);

      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.y = 16;
      mastGroup.add(pole);

      const headMat = new THREE.MeshStandardMaterial({
        color: 0xfff7d6,
        emissive: 0xffd27d,
        emissiveIntensity: 0.25,
        roughness: 0.3
      });
      const head = new THREE.Mesh(headGeo, headMat);
      head.position.y = 32;
      mastGroup.add(head);

      const coneMat = new THREE.MeshBasicMaterial({
        color: 0xffe4a0,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
      });
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.y = 16;
      mastGroup.add(cone);

      termGroup.add(mastGroup);
      mastLights.push({ headMat: headMat, coneMat: coneMat });
    }

    // 5. Moored Container Vessels (1-2 per terminal)
    const ships = [];
    (preset.ships || []).forEach(function (scfg, idx) {
      if (!window.OakShips || typeof window.OakShips.makeShip !== "function") return;
      const ship = window.OakShips.makeShip({
        name: scfg.name,
        line: scfg.line,
        length_m: scfg.length_m,
        beam_m: scfg.beam_m,
        draught_m: scfg.draught_m,
        sections: scfg.sections,
        seed: scfg.seed || (preset.seed + idx)
      });
      ship.setLoad(scfg.load != null ? scfg.load : 0.72);
      ship.setSpeed(0.15);
      const sx = L * (scfg.fracX || 0.5);
      const sz = (scfg.beam_m || 48) * 0.5 + 3.2;
      ship.group.position.set(sx, 0, sz);
      if (idx % 2 === 1) {
        ship.group.rotation.y = Math.PI;
      }
      termGroup.add(ship.group);
      const dir = idx % 2 === 1 ? -1 : 1;
      const halfLen = (scfg.length_m || 330) * 0.5;
      ships.push({
        ship: ship, name: scfg.name, baseX: sx, baseZ: sz, phase: idx * 1.9,
        baseYaw: ship.group.rotation.y, dir: dir,
        seaX: dir > 0 ? L + 520 + halfLen : -520 - halfLen,
        cycleOffset: (((scfg.seed || idx) * 7.37) % SAIL_PERIOD_H)
      });
    });

    return {
      key: key,
      group: termGroup,
      cranes: cranes,
      ships: ships,
      mastLights: mastLights,
      update: function (hour, nightFactor, dt) {
        const nf = inferNightFactor(hour, nightFactor);
        const lightsOn = nf > 0.35;
        const t = (Number(hour) || 0) * 3600;

        for (let i = 0; i < cranes.length; i++) {
          const entry = cranes[i];
          entry.crane.setLights(lightsOn);
          entry.crane.update(dt);
          if (!entry.boomUp) {
            entry.crane.group.position.x = entry.baseX + Math.sin(t * 0.0008 + entry.phase) * 3.5;
          }
        }

        for (let i = 0; i < ships.length; i++) {
          const s = ships[i];
          s.ship.setLights(lightsOn);
          placeSailingShip(s, Number(hour) || 0);
          s.ship.update(dt, hour || 0);
        }

        for (let i = 0; i < mastLights.length; i++) {
          const ml = mastLights[i];
          ml.headMat.emissiveIntensity = 0.2 + nf * 2.2;
          ml.coneMat.opacity = nf * 0.11;
        }
      }
    };
  }

  function makePassiveTerminals(activeTerminal, opts) {
    if (activeTerminal && typeof activeTerminal === "object") {
      opts = activeTerminal;
      activeTerminal = opts.activeTerminal || opts.active || "OICT";
    }
    opts = opts || {};
    const activeKey = typeof activeTerminal === "string" && activeTerminal ? activeTerminal : "OICT";
    const oakGeo = opts.oakGeo || window.OakGeo;

    const group = new THREE.Group();
    group.name = "OakPassiveTerminals";
    const built = {};
    const list = [];

    const allKeys = ["OICT", "TraPac", "Everport", "Matson"];
    allKeys.forEach(function (key) {
      if (key.toLowerCase() === activeKey.toLowerCase()) return;
      if (!oakGeo || typeof oakGeo.terminalFrame !== "function") return;
      const tf = oakGeo.terminalFrame(key);
      if (!tf) return;
      const preset = PASSIVE_PRESETS[key] || PASSIVE_PRESETS.Everport;
      const term = buildSinglePassiveTerminal(key, tf, preset);
      group.add(term.group);
      built[key] = term;
      list.push(term);
    });

    let lastHour = null;
    function update(hour, nightFactor) {
      const h = Number(hour) || 0;
      let dt = 0.05;
      if (lastHour !== null) {
        const dh = h - lastHour;
        if (dh > 0 && dh < 0.5) dt = Math.min(0.25, dh * 60);
      }
      lastHour = h;

      for (let i = 0; i < list.length; i++) {
        list[i].update(h, nightFactor, dt);
      }
    }

    const result = {
      group: group,
      terminals: built,
      update: update
    };
    window.OakPortLife.lastPassive = result;
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. SF BAY TRACTOR TUG FLEET
  // ─────────────────────────────────────────────────────────────────────────
  function buildTractorTug(spec) {
    const g = new THREE.Group();
    g.name = "TractorTug_" + spec.name;

    const L = 32;
    const B = 12.5;

    // Rounded dark-charcoal hull
    const hullShape = new THREE.Shape();
    const hw = B * 0.5;
    const hl = L * 0.5;
    hullShape.moveTo(-hl + 3, -hw);
    hullShape.lineTo(hl - 5, -hw);
    hullShape.quadraticCurveTo(hl, -hw, hl, 0);
    hullShape.quadraticCurveTo(hl, hw, hl - 5, hw);
    hullShape.lineTo(-hl + 3, hw);
    hullShape.quadraticCurveTo(-hl, hw, -hl, 0);
    hullShape.quadraticCurveTo(-hl, -hw, -hl + 3, -hw);

    const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 3.4, bevelEnabled: false });
    hullGeo.rotateX(-Math.PI / 2);
    const hullMat = new THREE.MeshStandardMaterial({
      color: 0x1b2028,
      roughness: 0.65,
      metalness: 0.25
    });
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.position.y = -0.5;
    hull.castShadow = true;
    hull.receiveShadow = true;
    g.add(hull);

    // Heavy cylindrical bow & stern rubber fenders
    const fenderGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 1.05, bevelEnabled: false });
    fenderGeo.rotateX(-Math.PI / 2);
    fenderGeo.scale(1.045, 1, 1.055);
    const fenderMat = new THREE.MeshStandardMaterial({ color: 0x0f1217, roughness: 0.92 });
    const fender = new THREE.Mesh(fenderGeo, fenderMat);
    fender.position.y = 1.65;
    g.add(fender);

    // Red/orange main deck
    const deckGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 0.25, bevelEnabled: false });
    deckGeo.rotateX(-Math.PI / 2);
    deckGeo.scale(0.95, 1, 0.94);
    const deckMat = new THREE.MeshStandardMaterial({
      color: spec.accentColor || 0xb91c1c,
      roughness: 0.72
    });
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.y = 2.85;
    g.add(deck);

    // Lower deckhouse (white)
    const houseMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.5 });
    const lowerHouse = new THREE.Mesh(new THREE.BoxGeometry(13.5, 2.8, 7.6), houseMat);
    lowerHouse.position.set(1.0, 4.3, 0);
    lowerHouse.castShadow = true;
    g.add(lowerHouse);

    // Red stripe trim on house
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(13.7, 0.55, 7.8),
      new THREE.MeshStandardMaterial({ color: spec.accentColor || 0xdc2626, roughness: 0.5 })
    );
    stripe.position.set(1.0, 3.3, 0);
    g.add(stripe);

    // 360-degree glass wheelhouse
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(7.8, 2.5, 6.2), houseMat);
    bridge.position.set(2.4, 6.8, 0);
    g.add(bridge);

    const winMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      emissive: 0xffd89b,
      emissiveIntensity: 0.2,
      roughness: 0.2
    });
    const winBand = new THREE.Mesh(new THREE.BoxGeometry(8.05, 1.05, 6.45), winMat);
    winBand.position.set(2.4, 7.1, 0);
    g.add(winBand);

    // Twin exhaust stacks aft of wheelhouse
    const stackGeo = new THREE.CylinderGeometry(0.65, 0.78, 3.6, 10);
    const stackMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 });
    [-2.1, 2.1].forEach(function (sz) {
      const st = new THREE.Mesh(stackGeo, stackMat);
      st.position.set(-3.2, 6.8, sz);
      g.add(st);
    });

    // Forward hawser winch
    const winch = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, 2.4, 10),
      new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.6, roughness: 0.4 })
    );
    winch.rotation.x = Math.PI / 2;
    winch.position.set(9.8, 3.7, 0);
    g.add(winch);

    // Mast + towing/navigation lights
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.28, 6.2, 8),
      new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.4 })
    );
    mast.position.set(2.5, 11.0, 0);
    g.add(mast);

    const mastLightMat = new THREE.MeshBasicMaterial({ color: 0xfffbeb });
    const mastLight = new THREE.Mesh(new THREE.SphereGeometry(0.48, 8, 8), mastLightMat);
    mastLight.position.set(2.5, 14.2, 0);
    g.add(mastLight);

    const towLightMat = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
    const towLight = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 8), towLightMat);
    towLight.position.set(2.5, 13.1, 0);
    g.add(towLight);

    const portLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2e2e })
    );
    portLight.position.set(2.4, 8.1, -3.3);
    g.add(portLight);

    const stbdLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x22c55e })
    );
    stbdLight.position.set(2.4, 8.1, 3.3);
    g.add(stbdLight);

    // Propwash foam ring & wake trail
    const foamMat = new THREE.MeshBasicMaterial({
      color: 0xe0f2fe,
      transparent: true,
      opacity: 0.45,
      depthWrite: false
    });
    const propWash = new THREE.Mesh(new THREE.RingGeometry(4.0, 9.5, 20), foamMat);
    propWash.rotation.x = -Math.PI / 2;
    propWash.position.set(-4.0, 0.18, 0);
    g.add(propWash);

    const wakeJet = new THREE.Mesh(new THREE.PlaneGeometry(24, 9), foamMat);
    wakeJet.rotation.x = -Math.PI / 2;
    wakeJet.position.set(-19, 0.16, 0);
    g.add(wakeJet);

    // Nameplate sprite above mast
    const badge = makeBadgeSprite(spec.name, {
      fontSize: 22,
      padX: 12,
      padY: 5,
      fg: "#fef08a",
      bg: "rgba(15, 23, 42, 0.85)",
      border: "rgba(250, 204, 21, 0.75)",
      scale: 0.16
    });
    badge.position.set(0, 18.5, 0);
    g.add(badge);

    return {
      name: spec.name,
      group: g,
      winMat: winMat,
      foamMat: foamMat,
      propWash: propWash,
      wakeJet: wakeJet,
      mastLight: mastLight,
      towLight: towLight,
      homePos: spec.homePos,
      homeHeading: spec.homeHeading || 0
    };
  }

  function extractActiveAssistTarget(shipStates, termFrame) {
    if (!shipStates) return null;
    const list = Array.isArray(shipStates)
      ? shipStates
      : typeof shipStates === "object"
      ? Object.keys(shipStates).map(function (k) { return shipStates[k]; })
      : [];

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s) continue;
      const status = String(s.status || s.state || s.phase || "").toLowerCase();
      const isMoving =
        status === "arriving" ||
        status === "departing" ||
        status === "approach" ||
        status === "unberthing" ||
        (typeof s.speed === "number" && s.speed > 0.35);
      if (!isMoving) continue;

      let wx = s.worldX != null ? s.worldX : s.x;
      let wz = s.worldZ != null ? s.worldZ : s.z;
      let heading = s.heading_rad != null ? s.heading_rad : (s.heading || s.rotY || 0);

      if (s.group && s.group.position) {
        if (s.group.parent && s.group.parent.position && (s.group.parent.position.x !== 0 || s.group.parent.position.z !== 0)) {
          const wp = new THREE.Vector3();
          s.group.getWorldPosition(wp);
          wx = wp.x;
          wz = wp.z;
          heading = (s.group.parent.rotation ? s.group.parent.rotation.y : 0) + s.group.rotation.y;
        } else {
          wx = s.group.position.x;
          wz = s.group.position.z;
          heading = s.group.rotation.y || 0;
        }
      } else if (termFrame && s.local && wx != null && wz != null) {
        const cos = Math.cos(termFrame.heading_rad || 0);
        const sin = Math.sin(termFrame.heading_rad || 0);
        const lx = wx;
        const lz = wz * (termFrame.water_side === -1 ? -1 : 1);
        wx = termFrame.origin[0] + lx * cos - lz * sin;
        wz = termFrame.origin[1] + lx * sin + lz * cos;
        heading = -(termFrame.heading_rad || 0) + (heading || 0);
      }

      if (typeof wx === "number" && typeof wz === "number") {
        return {
          x: wx,
          z: wz,
          heading: heading || 0,
          status: status || "arriving",
          length_m: s.length_m || 330,
          beam_m: s.beam_m || 48
        };
      }
    }
    return null;
  }

  function makeTugFleet(opts) {
    opts = opts || {};
    const group = new THREE.Group();
    group.name = "OakTugFleet";

    // Tug basin at the junction of Outer & Inner Harbor channels
    const tugSpecs = [
      {
        name: "BAY TITAN",
        accentColor: 0xdc2626,
        homePos: [-980, 140],
        homeHeading: 0.35
      },
      {
        name: "OAKLAND TRACTOR",
        accentColor: 0xea580c,
        homePos: [-925, 165],
        homeHeading: 0.35
      }
    ];

    const tugs = tugSpecs.map(function (spec) {
      const t = buildTractorTug(spec);
      t.group.position.set(spec.homePos[0], 0, spec.homePos[1]);
      t.group.rotation.y = spec.homeHeading;
      group.add(t.group);
      return t;
    });

    function update(hour, nightFactor, shipStates) {
      const h = Number(hour) || 0;
      const nf = inferNightFactor(h, nightFactor);
      const timeSec = h * 3600;
      const target = extractActiveAssistTarget(shipStates, opts.termFrame);

      for (let i = 0; i < tugs.length; i++) {
        const tug = tugs[i];
        tug.winMat.emissiveIntensity = 0.15 + nf * 1.6;
        tug.mastLight.visible = true;
        tug.towLight.visible = Boolean(target) || nf > 0.3;

        if (target) {
          // Position tugs on bow quarter (i=0) and stern quarter (i=1) of the active ship
          const along = (i === 0 ? 0.32 : -0.32) * target.length_m;
          const outZ = (target.beam_m * 0.5) + 14;
          const cosH = Math.cos(-target.heading);
          const sinH = Math.sin(-target.heading);

          const tx = target.x + along * cosH - outZ * sinH;
          const tz = target.z + along * sinH + outZ * cosH;
          tug.group.position.set(
            tx,
            Math.sin(timeSec * 0.04 + i * 1.7) * 0.22,
            tz
          );
          // Point bow nose-in toward the ship hull to push/escort
          tug.group.rotation.y = target.heading - Math.PI * 0.48 + (i === 0 ? 0.12 : -0.12);
          tug.group.rotation.z = Math.sin(timeSec * 0.05 + i) * 0.025;

          tug.foamMat.opacity = 0.58 + 0.18 * Math.sin(timeSec * 0.12 + i);
          const s = 1.0 + 0.15 * Math.sin(timeSec * 0.15 + i * 2);
          tug.propWash.scale.set(s, s, 1);
          tug.wakeJet.visible = true;
        } else {
          // Moored at tug basin with gentle harbor swell
          tug.group.position.set(
            tug.homePos[0] + Math.sin(timeSec * 0.008 + i) * 1.2,
            Math.sin(timeSec * 0.03 + i * 1.4) * 0.15,
            tug.homePos[1] + Math.cos(timeSec * 0.008 + i) * 1.2
          );
          tug.group.rotation.y = tug.homeHeading + Math.sin(timeSec * 0.006 + i) * 0.04;
          tug.group.rotation.z = Math.sin(timeSec * 0.025 + i) * 0.015;
          tug.foamMat.opacity = 0.14;
          tug.wakeJet.visible = false;
        }
      }
    }

    return {
      group: group,
      tugs: tugs,
      update: update
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. 3D ECDIS / AIS OVERLAY
  // ─────────────────────────────────────────────────────────────────────────
  function buildDashedTrack(points3d, colorHex, dashSize, gapSize) {
    const geom = new THREE.BufferGeometry().setFromPoints(points3d);
    const mat = new THREE.LineDashedMaterial({
      color: colorHex,
      dashSize: dashSize || 38,
      gapSize: gapSize || 20,
      transparent: true,
      opacity: 0.85,
      depthWrite: false
    });
    const line = new THREE.Line(geom, mat);
    line.computeLineDistances();
    return line;
  }

  function makeAisTargetMarker(name, colorHex) {
    const g = new THREE.Group();
    g.name = "AisTarget_" + name;

    // ECDIS diamond ring in horizontal plane
    const dPts = [
      new THREE.Vector3(0, 0, -26),
      new THREE.Vector3(18, 0, 0),
      new THREE.Vector3(0, 0, 26),
      new THREE.Vector3(-18, 0, 0),
      new THREE.Vector3(0, 0, -26)
    ];
    const dGeo = new THREE.BufferGeometry().setFromPoints(dPts);
    const dMat = new THREE.LineBasicMaterial({
      color: colorHex || 0x38bdf8,
      transparent: true,
      opacity: 0.95,
      depthTest: false
    });
    const diamond = new THREE.Line(dGeo, dMat);
    diamond.position.y = 44;
    diamond.renderOrder = 920;
    g.add(diamond);

    // Outer pulsing range ring
    const ringGeo = new THREE.RingGeometry(28, 30.5, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: colorHex || 0x38bdf8,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 4.2;
    g.add(ring);

    // Vertical drop leader line from diamond to waterline
    const stemGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 4.2, 0),
      new THREE.Vector3(0, 44, 0)
    ]);
    const stem = new THREE.Line(
      stemGeo,
      new THREE.LineDashedMaterial({ color: colorHex || 0x38bdf8, dashSize: 4, gapSize: 3, transparent: true, opacity: 0.65 })
    );
    stem.computeLineDistances();
    g.add(stem);

    // SOG/COG heading vector with arrowhead
    const vecGroup = new THREE.Group();
    vecGroup.position.y = 6.0;
    const vecLineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(160, 0, 0)
    ]);
    const vecMat = new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9 });
    const vecLine = new THREE.Line(vecLineGeo, vecMat);
    vecGroup.add(vecLine);

    const arrowGeo = new THREE.ConeGeometry(4.5, 14, 8);
    arrowGeo.rotateZ(-Math.PI / 2);
    const arrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0x22d3ee }));
    arrow.position.set(160, 0, 0);
    vecGroup.add(arrow);
    g.add(vecGroup);

    return {
      group: g,
      diamond: diamond,
      ring: ring,
      ringMat: ringMat,
      vecGroup: vecGroup,
      arrow: arrow,
      vecLine: vecLine
    };
  }

  function makeAisOverlay(replay, termFrame) {
    const group = new THREE.Group();
    group.name = "OakAisOverlay";

    const tf = termFrame || (window.OakGeo && window.OakGeo.terminalFrame ? window.OakGeo.terminalFrame("OICT") : {
      origin: [-852, -77],
      heading_rad: -0.775,
      length_m: 1470,
      water_side: 1
    });

    function localToWorld(lx, lz, y) {
      const cos = Math.cos(tf.heading_rad || 0);
      const sin = Math.sin(tf.heading_rad || 0);
      const sz = lz * (tf.water_side === -1 ? -1 : 1);
      return new THREE.Vector3(
        tf.origin[0] + lx * cos - sz * sin,
        y != null ? y : 4.5,
        tf.origin[1] + lx * sin + sz * cos
      );
    }

    // 1. SF Bay Main Ship Channel & Outer/Inner Harbor ECDIS Fairway Tracks
    const outerChannelPts = [
      new THREE.Vector3(-3400, 4.5, 420),
      new THREE.Vector3(-2500, 4.5, 480),
      new THREE.Vector3(-1750, 4.5, 560),
      new THREE.Vector3(-1150, 4.5, 520),
      new THREE.Vector3(-550, 4.5, 860),
      new THREE.Vector3(120, 4.5, 1350)
    ];
    group.add(buildDashedTrack(outerChannelPts, 0x38bdf8, 45, 22));

    const innerChannelPts = [
      new THREE.Vector3(-2500, 4.5, 480),
      new THREE.Vector3(-1650, 4.5, 180),
      new THREE.Vector3(-1050, 4.5, -180),
      new THREE.Vector3(-350, 4.5, -430),
      new THREE.Vector3(650, 4.5, -690),
      new THREE.Vector3(1650, 4.5, -920)
    ];
    group.add(buildDashedTrack(innerChannelPts, 0x22d3ee, 40, 20));

    // Active terminal approach & departure curved tracks
    const L = tf.length_m || 1200;
    const approachPts = [
      localToWorld(-650, 420, 4.8),
      localToWorld(-220, 240, 4.8),
      localToWorld(L * 0.18, 95, 4.8),
      localToWorld(L * 0.48, 32, 4.8)
    ];
    const departPts = [
      localToWorld(L * 0.52, 32, 4.8),
      localToWorld(L * 0.85, 110, 4.8),
      localToWorld(L + 280, 260, 4.8),
      localToWorld(L + 720, 460, 4.8)
    ];
    group.add(buildDashedTrack(approachPts, 0x34d399, 28, 16));
    group.add(buildDashedTrack(departPts, 0xf59e0b, 28, 16));

    // Waypoint rings along approach/departure
    const wpGeo = new THREE.RingGeometry(12, 15, 24);
    wpGeo.rotateX(-Math.PI / 2);
    const wpMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.65 });
    [approachPts[0], approachPts[1], departPts[2], outerChannelPts[2], innerChannelPts[3]].forEach(function (pt) {
      const m = new THREE.Mesh(wpGeo, wpMat);
      m.position.copy(pt);
      group.add(m);
    });

    // 2. Per-ship AIS target diamonds & SOG/COG vectors
    const markers = {};
    const shipsMeta = (replay && Array.isArray(replay.ships)) ? replay.ships : [];
    shipsMeta.forEach(function (sm, idx) {
      const id = sm.id != null ? String(sm.id) : (sm.name || ("VESSEL_" + (idx + 1)));
      const marker = makeAisTargetMarker(sm.name || id, idx % 2 === 0 ? 0x38bdf8 : 0x34d399);
      const midSec = ((sm.start_section || 2) + (sm.end_section || 8)) * 0.5;
      const p = localToWorld(midSec * SECTION_M, 28, 0);
      marker.group.position.copy(p);
      marker.vecGroup.rotation.y = -(tf.heading_rad || 0);
      group.add(marker.group);
      markers[id] = marker;
    });

    function ensureMarker(id, name, colorHex) {
      if (!markers[id]) {
        const m = makeAisTargetMarker(name || id, colorHex || 0x38bdf8);
        group.add(m.group);
        markers[id] = m;
      }
      return markers[id];
    }

    function setVisible(v) {
      group.visible = Boolean(v);
    }

    function update(hour, shipPositions) {
      if (!group.visible) return;
      const t = (Number(hour) || 0) * 3600;

      if (shipPositions) {
        const list = Array.isArray(shipPositions)
          ? shipPositions
          : typeof shipPositions === "object"
          ? Object.keys(shipPositions).map(function (k) {
              const item = shipPositions[k];
              if (item && typeof item === "object" && item.id == null) item.id = k;
              return item;
            })
          : [];

        for (let i = 0; i < list.length; i++) {
          const sp = list[i];
          if (!sp) continue;
          const id = String(sp.id != null ? sp.id : (sp.name || ("SHIP_" + i)));
          const m = ensureMarker(id, sp.name || id, 0x38bdf8);

          if (sp.visible === false || sp.status === "waiting" || sp.status === "departed") {
            m.group.visible = false;
            continue;
          }
          m.group.visible = true;

          let wx = sp.worldX != null ? sp.worldX : sp.x;
          let wz = sp.worldZ != null ? sp.worldZ : sp.z;
          let heading = sp.heading_rad != null ? sp.heading_rad : (sp.heading || 0);

          if (sp.group && sp.group.position) {
            const wp = new THREE.Vector3();
            sp.group.getWorldPosition(wp);
            wx = wp.x;
            wz = wp.z;
            heading = (sp.group.parent && sp.group.parent.rotation ? sp.group.parent.rotation.y : 0) + sp.group.rotation.y;
          } else if (sp.local && wx != null && wz != null) {
            const wp = localToWorld(wx, wz, 0);
            wx = wp.x;
            wz = wp.z;
            heading = -(tf.heading_rad || 0) + (heading || 0);
          }

          if (typeof wx === "number" && typeof wz === "number") {
            m.group.position.set(wx, 0, wz);
          }
          m.vecGroup.rotation.y = heading;

          const sog = sp.sog != null ? sp.sog : (sp.status === "arriving" || sp.status === "departing" ? 8.5 : 0.4);
          const vecScale = Math.max(0.22, Math.min(1.6, sog / 6.0));
          m.vecGroup.scale.set(vecScale, 1, 1);
        }
      }

      // Pulse AIS target rings & diamonds
      const keys = Object.keys(markers);
      for (let i = 0; i < keys.length; i++) {
        const m = markers[keys[i]];
        const pulse = 1.0 + 0.14 * Math.sin(t * 0.06 + i * 1.3);
        m.ring.scale.set(pulse, pulse, 1);
        m.diamond.rotation.y = Math.sin(t * 0.02 + i) * 0.25;
      }
    }

    return {
      group: group,
      markers: markers,
      setVisible: setVisible,
      update: update
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. HARBOR TRAFFIC (USCG Channel Buoys, Bay Bridge SAS Tower + Cars, BNSF Train)
  // ─────────────────────────────────────────────────────────────────────────
  function buildChannelBuoys() {
    const buoyGroup = new THREE.Group();
    buoyGroup.name = "USCG_ChannelBuoys";

    // Paired USCG lateral buoys along Oakland Bar Channel, Outer Harbor, and Inner Harbor
    const pairs = [
      // Bar channel entrance
      { green: [-2850, 340], red: [-2850, 560], period: 2.5, phase: 0.0 },
      { green: [-2150, 360], red: [-2150, 580], period: 2.5, phase: 0.7 },
      { green: [-1520, 390], red: [-1520, 610], period: 2.5, phase: 1.4 },
      // Outer Harbor turn
      { green: [-1080, 440], red: [-1220, 640], period: 4.0, phase: 0.4 },
      { green: [-620, 760], red: [-780, 940], period: 4.0, phase: 1.8 },
      // Inner Harbor entrance channel
      { green: [-1480, 70], red: [-1560, 230], period: 3.0, phase: 0.9 },
      { green: [-960, -240], red: [-1040, -90], period: 3.0, phase: 2.1 },
      { green: [-320, -490], red: [-380, -340], period: 3.0, phase: 1.1 }
    ];

    const floatGeo = new THREE.CylinderGeometry(2.6, 3.2, 2.2, 12);
    const towerGeo = new THREE.ConeGeometry(1.6, 5.2, 4);
    const beaconGeo = new THREE.SphereGeometry(1.15, 10, 10);
    const haloGeo = new THREE.RingGeometry(2.0, 5.5, 16);
    haloGeo.rotateX(-Math.PI / 2);

    const beacons = [];

    function addBuoy(xz, isRed, period, phase) {
      const g = new THREE.Group();
      g.position.set(xz[0], 0, xz[1]);

      const baseColor = isRed ? 0xdc2626 : 0x16a34a;
      const glowColor = isRed ? 0xff2e2e : 0x19e66b;
      const bodyMat = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.55, metalness: 0.3 });

      const fl = new THREE.Mesh(floatGeo, bodyMat);
      fl.position.y = 0.8;
      g.add(fl);

      const tw = new THREE.Mesh(towerGeo, bodyMat);
      tw.position.y = 4.2;
      g.add(tw);

      const beaconMat = new THREE.MeshBasicMaterial({ color: glowColor });
      const beacon = new THREE.Mesh(beaconGeo, beaconMat);
      beacon.position.y = 7.2;
      g.add(beacon);

      const haloMat = new THREE.MeshBasicMaterial({
        color: glowColor,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const halo = new THREE.Mesh(haloGeo, haloMat);
      halo.position.y = 0.25;
      g.add(halo);

      buoyGroup.add(g);
      beacons.push({ group: g, beacon: beacon, haloMat: haloMat, period: period, phase: phase });
    }

    pairs.forEach(function (p) {
      addBuoy(p.green, false, p.period, p.phase);
      addBuoy(p.red, true, p.period, p.phase + 0.35);
    });

    return {
      group: buoyGroup,
      beacons: beacons,
      update: function (timeSec, nf) {
        for (let i = 0; i < beacons.length; i++) {
          const b = beacons[i];
          b.group.position.y = Math.sin(timeSec * 0.04 + b.phase) * 0.25;
          const cyc = ((timeSec * 0.05 + b.phase) % b.period) / b.period;
          const on = cyc < 0.38 || (cyc > 0.48 && cyc < 0.62);
          const scale = on ? (1.15 + nf * 0.45) : 0.45;
          b.beacon.scale.set(scale, scale, scale);
          b.haloMat.opacity = on ? (0.22 + nf * 0.5) : 0.04;
        }
      }
    };
  }

  function buildBayBridgeSASAndTraffic(oakGeo) {
    const bridgeGroup = new THREE.Group();
    bridgeGroup.name = "BayBridgeEastSpanSAS";

    const bridgePolys = (oakGeo && Array.isArray(oakGeo.bridge) && oakGeo.bridge.length > 0)
      ? oakGeo.bridge
      : [
          [[-3500, 1894], [-2562, 2170], [-1450, 2249], [1074, 2418], [3000, 2472]],
          [[-3500, 1919], [-2565, 2195], [-1435, 2274], [992, 2440], [3000, 2498]]
        ];

    // Iconic single-tower Self-Anchored Suspension (SAS) tower near Yerba Buena transition
    const towerX = -2562;
    const towerZ = 2182;
    const deckY = 18.0;
    const towerH = 160.0;
    const bridgeHeading = Math.atan2(2249 - 2170, -1450 - (-2562)); // ~0.07 rad

    const sasGroup = new THREE.Group();
    sasGroup.position.set(towerX, 0, towerZ);
    sasGroup.rotation.y = -bridgeHeading;

    // Concrete pile cap pedestal in the water
    const pedestalMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.75 });
    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(36, 8, 46), pedestalMat);
    pedestal.position.y = 3.5;
    sasGroup.add(pedestal);

    // 4-shaft tapered white steel SAS tower
    const towerMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      emissive: 0xdbeafe,
      emissiveIntensity: 0.12,
      roughness: 0.38,
      metalness: 0.25
    });
    const shaftOffsets = [
      [-3.6, -4.8],
      [3.6, -4.8],
      [-3.6, 4.8],
      [3.6, 4.8]
    ];
    shaftOffsets.forEach(function (off) {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.65, 2.85, towerH, 8), towerMat);
      shaft.position.set(off[0] * 0.65, towerH * 0.5 + 4, off[1] * 0.65);
      shaft.castShadow = true;
      sasGroup.add(shaft);
    });

    // Horizontal shear link cross-beams up the tower
    for (let y = 26; y <= towerH - 12; y += 26) {
      const link = new THREE.Mesh(new THREE.BoxGeometry(7.2, 2.6, 9.2), towerMat);
      link.position.set(0, y, 0);
      sasGroup.add(link);
    }

    // Saddle crown + red FAA aviation obstruction beacons
    const crown = new THREE.Mesh(new THREE.BoxGeometry(9.0, 5.5, 11.0), towerMat);
    crown.position.set(0, towerH + 5, 0);
    sasGroup.add(crown);

    const faaMat = new THREE.MeshBasicMaterial({ color: 0xff1e1e });
    const faaBeacon = new THREE.Mesh(new THREE.SphereGeometry(1.8, 10, 10), faaMat);
    faaBeacon.position.set(0, towerH + 9.5, 0);
    sasGroup.add(faaBeacon);

    // Main suspension cables & vertical/inclined suspender ropes
    const cableMat = new THREE.LineBasicMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.9 });
    const suspenderMat = new THREE.LineBasicMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.48 });

    const eastAnchorX = 385;
    const westAnchorX = -195;
    const topY = towerH + 4;

    [-16, 16].forEach(function (sideZ) {
      const eastCurvePts = [];
      const steps = 28;
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const x = u * eastAnchorX;
        // Parabolic sag from tower top down to eastern deck anchorage
        const sagY = deckY + (topY - deckY) * Math.pow(1 - u, 1.85);
        const z = sideZ * (0.25 + 0.75 * u);
        eastCurvePts.push(new THREE.Vector3(x, sagY, z));

        if (i > 0 && i < steps && i % 2 === 0) {
          const suspGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(x, sagY, z),
            new THREE.Vector3(x, deckY, sideZ)
          ]);
          sasGroup.add(new THREE.Line(suspGeo, suspenderMat));
        }
      }
      const eastCableGeo = new THREE.BufferGeometry().setFromPoints(eastCurvePts);
      sasGroup.add(new THREE.Line(eastCableGeo, cableMat));

      const westCurvePts = [];
      const wSteps = 16;
      for (let i = 0; i <= wSteps; i++) {
        const u = i / wSteps;
        const x = u * westAnchorX;
        const sagY = deckY + (topY - deckY) * Math.pow(1 - u, 1.55);
        const z = sideZ * (0.25 + 0.75 * u);
        westCurvePts.push(new THREE.Vector3(x, sagY, z));

        if (i > 0 && i < wSteps && i % 2 === 0) {
          const suspGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(x, sagY, z),
            new THREE.Vector3(x, deckY, sideZ)
          ]);
          sasGroup.add(new THREE.Line(suspGeo, suspenderMat));
        }
      }
      const westCableGeo = new THREE.BufferGeometry().setFromPoints(westCurvePts);
      sasGroup.add(new THREE.Line(westCableGeo, cableMat));
    });

    bridgeGroup.add(sasGroup);

    // Build polyline sampler for moving vehicle light streams across the bridge
    function makePolylineSampler(pts2d) {
      const segs = [];
      let total = 0;
      for (let i = 0; i < pts2d.length - 1; i++) {
        const a = pts2d[i];
        const b = pts2d[i + 1];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len > 0.1) {
          segs.push({
            ax: a[0],
            az: a[1],
            bx: b[0],
            bz: b[1],
            len: len,
            cum: total,
            heading: Math.atan2(dz, dx)
          });
          total += len;
        }
      }
      return {
        totalLength: total || 1,
        sample: function (dist) {
          const d = ((dist % total) + total) % total;
          for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            if (d <= s.cum + s.len || i === segs.length - 1) {
              const t = Math.max(0, Math.min(1, (d - s.cum) / s.len));
              return {
                x: s.ax + (s.bx - s.ax) * t,
                z: s.az + (s.bz - s.az) * t,
                heading: s.heading
              };
            }
          }
          return { x: 0, z: 0, heading: 0 };
        }
      };
    }

    const wbSampler = makePolylineSampler(bridgePolys[0]);
    const ebSampler = makePolylineSampler(bridgePolys[Math.min(1, bridgePolys.length - 1)]);

    const carsPerDir = 48;
    const carGeo = new THREE.BoxGeometry(6.8, 1.35, 2.2);
    const wbMat = new THREE.MeshBasicMaterial({ color: 0xfff8dc }); // headlights
    const ebMat = new THREE.MeshBasicMaterial({ color: 0xff3b3b }); // taillights
    const wbCars = new THREE.InstancedMesh(carGeo, wbMat, carsPerDir);
    const ebCars = new THREE.InstancedMesh(carGeo, ebMat, carsPerDir);
    bridgeGroup.add(wbCars);
    bridgeGroup.add(ebCars);

    const dummy = new THREE.Object3D();

    return {
      group: bridgeGroup,
      update: function (timeSec, nf) {
        towerMat.emissiveIntensity = 0.1 + nf * 0.55;
        const blink = Math.sin(timeSec * 0.12) > 0;
        faaBeacon.scale.setScalar(blink ? 1.35 : 0.65);

        const speed = 28; // m/s (~62 mph)
        for (let i = 0; i < carsPerDir; i++) {
          const laneOffset = ((i % 3) - 1) * 3.4;

          // Westbound (Oakland -> SF)
          const dW = wbSampler.totalLength - ((i / carsPerDir) * wbSampler.totalLength + timeSec * speed * 0.08) % wbSampler.totalLength;
          const pW = wbSampler.sample(dW);
          const nxW = -Math.sin(pW.heading) * laneOffset;
          const nzW = Math.cos(pW.heading) * laneOffset;
          dummy.position.set(pW.x + nxW, deckY + 1.1, pW.z + nzW);
          dummy.rotation.set(0, -pW.heading, 0);
          dummy.updateMatrix();
          wbCars.setMatrixAt(i, dummy.matrix);

          // Eastbound (SF -> Oakland)
          const dE = ((i / carsPerDir) * ebSampler.totalLength + timeSec * speed * 0.08) % ebSampler.totalLength;
          const pE = ebSampler.sample(dE);
          const nxE = -Math.sin(pE.heading) * laneOffset;
          const nzE = Math.cos(pE.heading) * laneOffset;
          dummy.position.set(pE.x + nxE, deckY + 1.1, pE.z + nzE);
          dummy.rotation.set(0, -pE.heading, 0);
          dummy.updateMatrix();
          ebCars.setMatrixAt(i, dummy.matrix);
        }
        wbCars.instanceMatrix.needsUpdate = true;
        ebCars.instanceMatrix.needsUpdate = true;
      }
    };
  }

  function buildBnsfTrain(oakGeo) {
    const trainGroup = new THREE.Group();
    trainGroup.name = "BNSF_DoubleStackTrain";

    // Find the longest rail polyline in OakGeo.rails
    const rails = (oakGeo && Array.isArray(oakGeo.rails)) ? oakGeo.rails : [];
    let bestPts = [
      [-37, -142],
      [6, -98],
      [253, 189],
      [409, 439],
      [482, 646],
      [496, 1086],
      [428, 1482]
    ];
    let bestLen = 0;

    for (let i = 0; i < rails.length; i++) {
      const r = rails[i];
      const pts = Array.isArray(r) ? r : (r && r.points);
      if (!Array.isArray(pts) || pts.length < 2) continue;
      let len = 0;
      for (let j = 0; j < pts.length - 1; j++) {
        len += Math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1]);
      }
      if (len > bestLen) {
        bestLen = len;
        bestPts = pts;
      }
    }

    const segs = [];
    let totalLen = 0;
    for (let i = 0; i < bestPts.length - 1; i++) {
      const a = bestPts[i];
      const b = bestPts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > 0.1) {
        segs.push({
          ax: a[0],
          az: a[1],
          bx: b[0],
          bz: b[1],
          len: len,
          cum: totalLen,
          heading: Math.atan2(b[1] - a[1], b[0] - a[0])
        });
        totalLen += len;
      }
    }
    if (totalLen < 1) totalLen = 1000;

    function sampleRail(dist) {
      const d = Math.max(0, Math.min(totalLen, dist));
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (d <= s.cum + s.len || i === segs.length - 1) {
          const t = Math.max(0, Math.min(1, (d - s.cum) / s.len));
          return {
            x: s.ax + (s.bx - s.ax) * t,
            z: s.az + (s.bz - s.az) * t,
            heading: s.heading
          };
        }
      }
      return { x: bestPts[0][0], z: bestPts[0][1], heading: 0 };
    }

    // Build train cars: 2 BNSF heritage orange/black locomotives + 10 double-stack well cars
    const cars = [];
    const locoOrange = new THREE.MeshStandardMaterial({ color: 0xea580c, roughness: 0.5, metalness: 0.25 });
    const locoBlack = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.65, metalness: 0.3 });
    const yellowStripe = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.4 });
    const wellMat = new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.7, metalness: 0.3 });
    const headLightMat = new THREE.MeshBasicMaterial({ color: 0xfffbeb });

    function makeLoco(isLead) {
      const g = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(22.5, 1.2, 3.2), locoBlack);
      frame.position.y = 1.1;
      g.add(frame);

      const hood = new THREE.Mesh(new THREE.BoxGeometry(19.5, 3.3, 3.0), locoOrange);
      hood.position.set(-0.8, 3.2, 0);
      hood.castShadow = true;
      g.add(hood);

      const cab = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3.7, 3.15), locoOrange);
      cab.position.set(6.8, 3.4, 0);
      g.add(cab);

      const roof = new THREE.Mesh(new THREE.BoxGeometry(14.0, 0.45, 2.8), locoBlack);
      roof.position.set(-2.5, 4.95, 0);
      g.add(roof);

      const stripe = new THREE.Mesh(new THREE.BoxGeometry(20.2, 0.35, 3.18), yellowStripe);
      stripe.position.set(-0.2, 2.0, 0);
      g.add(stripe);

      if (isLead) {
        const hl = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 8), headLightMat);
        hl.position.set(11.3, 3.8, 0);
        g.add(hl);
      }
      return g;
    }

    function makeDoubleStackCar(idx) {
      const g = new THREE.Group();
      const well = new THREE.Mesh(new THREE.BoxGeometry(19.5, 0.9, 3.1), wellMat);
      well.position.y = 0.95;
      g.add(well);

      const c1Mat = new THREE.MeshStandardMaterial({
        color: BOX_PALETTE[idx % BOX_PALETTE.length],
        roughness: 0.65
      });
      const c2Mat = new THREE.MeshStandardMaterial({
        color: BOX_PALETTE[(idx + 3) % BOX_PALETTE.length],
        roughness: 0.65
      });

      const bottomBox = new THREE.Mesh(new THREE.BoxGeometry(14.6, 2.6, 2.55), c1Mat);
      bottomBox.position.y = 2.4;
      bottomBox.castShadow = true;
      g.add(bottomBox);

      const topBox = new THREE.Mesh(new THREE.BoxGeometry(14.6, 2.6, 2.55), c2Mat);
      topBox.position.y = 5.05;
      topBox.castShadow = true;
      g.add(topBox);

      return g;
    }

    const carSpacing = 22.8;
    for (let i = 0; i < 12; i++) {
      const mesh = i < 2 ? makeLoco(i === 0) : makeDoubleStackCar(i);
      trainGroup.add(mesh);
      cars.push({ group: mesh, offset: i * carSpacing });
    }

    const trainLength = 12 * carSpacing;
    const travelSpan = Math.max(100, totalLen - trainLength);

    return {
      group: trainGroup,
      update: function (timeSec) {
        // Smooth ping-pong along the rail corridor
        const cycle = (timeSec * 0.012) % 2.0;
        const u = cycle <= 1.0 ? cycle : 2.0 - cycle;
        const headDist = trainLength + u * travelSpan;

        for (let i = 0; i < cars.length; i++) {
          const c = cars[i];
          const s = sampleRail(headDist - c.offset);
          c.group.position.set(s.x, QUAY_TOP + 0.15, s.z);
          c.group.rotation.y = -s.heading + (cycle > 1.0 ? Math.PI : 0);
        }
      }
    };
  }

  function makeHarborTraffic(oakGeo) {
    const geo = oakGeo || window.OakGeo;
    const group = new THREE.Group();
    group.name = "OakHarborTraffic";

    const buoys = buildChannelBuoys();
    const bridge = buildBayBridgeSASAndTraffic(geo);
    const train = buildBnsfTrain(geo);

    group.add(buoys.group);
    group.add(bridge.group);
    group.add(train.group);

    function update(hour, nightFactor) {
      const h = Number(hour) || 0;
      const nf = inferNightFactor(h, nightFactor);
      const timeSec = h * 3600;

      buoys.update(timeSec, nf);
      bridge.update(timeSec, nf);
      train.update(timeSec);
    }

    return {
      group: group,
      buoys: buoys,
      bridge: bridge,
      train: train,
      update: update
    };
  }

  window.OakPortLife = {
    makePassiveTerminals: makePassiveTerminals,
    makeTugFleet: makeTugFleet,
    makeAisOverlay: makeAisOverlay,
    makeHarborTraffic: makeHarborTraffic
  };
})();
