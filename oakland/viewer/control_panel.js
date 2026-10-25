/*
 * Port of Oakland · 3D Operations Control Room HUD (window.OakControlPanel)
 *
 * Implements:
 *   window.OakControlPanel.init(callbacks)
 *   window.OakControlPanel.setScenarioList(scenarios, activeKey, planKey)
 *   window.OakControlPanel.setReplay(replay, planKey, baselineReplays)
 *   window.OakControlPanel.updateAtHour(replay, t, extra)
 *   window.OakControlPanel.selectShip(idx, replay, t)
 *   window.OakControlPanel.selectCrane(idx, status, replay, t)
 *   window.OakControlPanel.toggleGantt(force)
 *
 * Also auto-bridges with unmodified viewer.js via window.OakKPI hooks and DOM events.
 */
(function () {
  "use strict";

  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
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

  const TERMINAL_SPECS = {
    OICT: {
      code: "OICT",
      label: "OICT (Berths 55-59)",
      operator: "SSA Marine",
      berths: "55–59",
      quay_m: 2089,
      sections: 50,
      cranes: 10,
      crane_model: "ZPMC Super Post-Panamax Dual-Hoist",
      outreach_m: 65,
      lift_m: 50,
      max_draft_ft: 50,
      max_draft_m: 15.2,
      lat: 37.8012,
      lon: -122.3285,
    },
    TraPac: {
      code: "TraPac",
      label: "TraPac (Berths 25-33)",
      operator: "TraPac LLC",
      berths: "25–33",
      quay_m: 1300,
      sections: 31,
      cranes: 7,
      crane_model: "ZPMC Post-Panamax / Super Post-Panamax",
      outreach_m: 62,
      lift_m: 48,
      max_draft_ft: 50,
      max_draft_m: 15.2,
      lat: 37.8178,
      lon: -122.3230,
    },
    Everport: {
      code: "Everport",
      label: "Everport (Berths 35-37)",
      operator: "Everport Terminal Services",
      berths: "35–37",
      quay_m: 657,
      sections: 15,
      cranes: 4,
      crane_model: "ZPMC Super Post-Panamax",
      outreach_m: 65,
      lift_m: 50,
      max_draft_ft: 50,
      max_draft_m: 15.2,
      lat: 37.8115,
      lon: -122.3340,
    },
    Matson: {
      code: "Matson",
      label: "Matson (Berths 60-63)",
      operator: "Matson Navigation",
      berths: "60–63",
      quay_m: 575,
      sections: 13,
      cranes: 4,
      crane_model: "ZPMC Post-Panamax Container Gantry",
      outreach_m: 55,
      lift_m: 44,
      max_draft_ft: 42,
      max_draft_m: 12.8,
      lat: 37.7955,
      lon: -122.3175,
    },
  };

  const state = {
    initialized: false,
    externalDriven: false,
    callbacks: {},
    scenarios: null,
    activeScenarioKey: "oict-demo",
    activePlanKey: "optimal",
    replay: null,
    baseReplayCache: new Map(),
    baselineReplays: {},
    t: 0,
    extra: {},
    selectedShipIdx: null,
    selectedCraneIdx: null,
    inspectorMode: null, // "ship" | "crane" | null
    activeTab: "overview",
    ganttOpen: false,
    ganttBoxes: [],
    ganttDragging: false,
    searchQuery: "",
    layers: { ais: true, trucks: true, night: false, gantt: false, hud: false },
  };

  const $ = (id) => document.getElementById(id);

  function lineColor(line) {
    if (LINE_COLORS[line]) return LINE_COLORS[line];
    let h = 0;
    for (const ch of String(line || "Ship")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return "hsl(" + (h % 360) + ", 62%, 52%)";
  }

  function fmtHour(h) {
    const hh = Math.max(0, Math.floor(Number(h) || 0));
    const d = DAYS[Math.floor(hh / 24) % 7];
    return d + " " + String(hh % 24).padStart(2, "0") + ":00 (H" + String(hh).padStart(3, "0") + ")";
  }

  function fmtClock(t) {
    const total = Math.max(0, Math.floor((Number(t) || 0) * 60 + 1e-6));
    const hh = Math.floor(total / 60);
    const mm = Math.floor((total % 60) / 15) * 15;
    const d = DAYS[Math.floor(hh / 24) % 7];
    return d + " " + String(hh % 24).padStart(2, "0") + ":" + String(mm).padStart(2, "0") + " · H" + String(hh).padStart(3, "0");
  }

  function terminalSpecOf(rep) {
    const termName = (rep && rep.task && rep.task.terminal) || (rep && rep.terminal) || "OICT";
    for (const k of Object.keys(TERMINAL_SPECS)) {
      if (termName.toLowerCase().includes(k.toLowerCase())) return TERMINAL_SPECS[k];
    }
    return TERMINAL_SPECS.OICT;
  }

  // Generate deterministic synthetic fixtures for TraPac & Everport or Greedy/Naive policies when running standalone
  function ensureDemoFixtures() {
    if (typeof window === "undefined") return;
    window.PORTSIM_FIXTURES = window.PORTSIM_FIXTURES || {};
    const fx = window.PORTSIM_FIXTURES;
    if (fx["oict-demo"] && !fx["trapac-demo"]) {
      const base = JSON.parse(JSON.stringify(fx["oict-demo"]));
      base.task.task_id = "trapac-demo";
      base.task.terminal = "TraPac";
      base.task.quay = "25-33";
      base.task.last_section = 31;
      base.task.rules.crane_pool = 7;
      base.task.rules.hoot_pool = 4;
      base.ships = base.ships.slice(0, 9).map((s, idx) => {
        const copy = Object.assign({}, s, {
          id: idx,
          sections: Math.min(8, s.sections),
          first_section: 1 + ((idx * 7) % 22),
        });
        return copy;
      });
      base.task.ships = base.task.ships.slice(0, 9);
      base.blocks = [{ first: 14, last: 18, start: 48, end: 78, kind: "closed", label: "RTG crane runway maintenance" }];
      base.grade = { reward: 0.872, feasible: true, cost: 54, optimal_cost: 44, violations: [] };
      fx["trapac-demo"] = base;
    }
    if (fx["matson-demo"] && !fx["everport-demo"]) {
      const base = JSON.parse(JSON.stringify(fx["matson-demo"]));
      base.task.task_id = "everport-demo";
      base.task.terminal = "Everport";
      base.task.quay = "35-37";
      base.task.last_section = 15;
      base.task.rules.crane_pool = 4;
      base.task.rules.hoot_pool = 2;
      base.ships.forEach((s, i) => {
        s.line = ["Evergreen", "CMA CGM", "COSCO", "Yang Ming", "OOCL", "ONE"][i % 6];
      });
      base.blocks = [{ first: 12, last: 15, start: 0, end: 168, kind: "shallow", label: "max draught 13.4 m" }];
      base.grade = { reward: 0.896, feasible: true, cost: 38, optimal_cost: 32, violations: [] };
      fx["everport-demo"] = base;
    }
  }

  function derivePlanVariant(baseRep, planKey) {
    if (!baseRep) return null;
    if (state.baselineReplays && state.baselineReplays[planKey]) {
      return state.baselineReplays[planKey];
    }
    const copy = JSON.parse(JSON.stringify(baseRep));
    const gr = copy.grade || (copy.grade = {});
    const optCost = gr.optimal_cost != null ? gr.optimal_cost : gr.cost || 60;
    if (planKey === "optimal") {
      gr.cost = optCost;
      gr.reward = 0.965;
      gr.feasible = true;
      return copy;
    }
    const delayShift = planKey === "greedy" ? 3 : 8;
    copy.ships = (copy.ships || []).map((s, i) => {
      const extra = (i % 3 === 1 ? delayShift : Math.floor(delayShift / 2));
      const b0 = (s.berth_hour != null ? s.berth_hour : s.berth_start || 0) + (i > 1 ? extra : 0);
      const dur = Math.max(6, (s.departure || s.berth_end || b0 + 16) - (s.berth_hour || 0));
      const dep = b0 + dur + (planKey === "naive" ? 2 : 0);
      const due = s.due != null ? s.due : dep;
      const cbh = (s.cranes_by_hour || []).map(([h, c]) => [h + (b0 - (s.berth_hour || 0)), Math.max(1, planKey === "naive" ? c - 1 : c)]);
      return Object.assign({}, s, {
        berth_hour: b0,
        departure: dep,
        late_h: Math.max(0, dep - due),
        cranes_by_hour: cbh,
      });
    });
    gr.optimal_cost = optCost;
    gr.cost = planKey === "greedy" ? Math.round(optCost * 1.38 + 18) : Math.round(optCost * 2.15 + 55);
    gr.reward = planKey === "greedy" ? 0.782 : 0.495;
    gr.feasible = planKey !== "naive" || true;
    return copy;
  }

  // ---------- Top Command Bar & Metadata ----------
  function renderTopBar(rep, t) {
    const spec = terminalSpecOf(rep);
    const task = (rep && rep.task) || {};
    const kind = String(task.kind || "berth").toUpperCase();
    const nSec = (window.OakKPI && rep) ? window.OakKPI.at(rep, t).sections : spec.sections;
    const pool = (task.rules && task.rules.crane_pool) || spec.cranes;

    const metaEl = $("terminal-meta");
    if (metaEl) {
      metaEl.textContent =
        spec.operator + " · Berths " + (task.quay || spec.berths) + " · " +
        spec.quay_m.toLocaleString("en-US") + "m (" + nSec + " sec) · " +
        pool + " STS · " + spec.max_draft_ft + "ft Draft · " + kind;
    }

    // ILWU Shift badge
    const shiftBadge = $("shift-badge");
    const shiftLabel = $("shift-label");
    const shiftMph = $("shift-mph");
    if (shiftBadge && window.OakKPI && typeof window.OakKPI.shiftAt === "function") {
      const sh = window.OakKPI.shiftAt(rep, t);
      const k = window.OakKPI.at(rep, t);
      shiftBadge.className = "hud-badge shift-" + sh.code.toLowerCase();
      if (shiftLabel) shiftLabel.textContent = sh.label;
      if (shiftMph) {
        const totalMph = +(k.cranes_working * sh.gross_mph).toFixed(0);
        shiftMph.textContent = sh.gross_mph.toFixed(1) + " MPH/cr · " + totalMph + " gross/hr";
      }
    }

    // Weather / Tide / Bar Closure badge
    const weatherBadge = $("weather-badge");
    const weatherLabel = $("weather-label");
    const weatherSub = $("weather-sub");
    if (weatherBadge && rep) {
      const fogs = (rep.no_moves || []).concat(rep.fog_closures || []);
      const activeFog = fogs.find((w) => {
        const s = w.start != null ? w.start : w[0];
        const e = w.end != null ? w.end : w[1];
        return t >= s && t < e;
      });
      const tideFt = (3.4 + 2.6 * Math.sin(((t || 0) / 12.42) * Math.PI * 2)).toFixed(1);
      const windKt = Math.round(12 + 4 * Math.sin(((t || 0) / 24) * Math.PI * 2));
      if (activeFog) {
        const endH = activeFog.end != null ? activeFog.end : activeFog[1];
        weatherBadge.className = "hud-badge weather-fog";
        if (weatherLabel) weatherLabel.textContent = "FOG / BAR CLOSED";
        if (weatherSub) weatherSub.textContent = "Vis <0.25 nm · Until H" + String(endH).padStart(3, "0") + " · Tide +" + tideFt + "ft";
      } else {
        weatherBadge.className = "hud-badge weather-clear";
        if (weatherLabel) weatherLabel.textContent = "CLEAR · " + windKt + " kt NW";
        if (weatherSub) weatherSub.textContent = "Tide " + (tideFt >= 0 ? "+" : "") + tideFt + " ft MLLW · Bar Open";
      }
    }

    const tLabel = $("t-label");
    if (tLabel) tLabel.textContent = fmtClock(t);
  }

  // ---------- 2x3 KPI Grid ----------
  function renderKpis(rep, t) {
    if (!rep || !window.OakKPI) return;
    const k = window.OakKPI.at(rep, t);
    const sh = k.shift || { gross_mph: 26, label: "DAY 1.00×" };
    const setCard = (key, val, sub, statusCls) => {
      const vEl = $("kpi-val-" + key);
      const sEl = $("kpi-sub-" + key);
      const card = document.querySelector('#kpi-grid .kpi[data-kpi="' + key + '"]');
      if (vEl) vEl.textContent = val;
      if (sEl) sEl.textContent = sub;
      if (card) card.className = "kpi" + (statusCls ? " " + statusCls : "");
    };

    const occPct = Math.round(k.occupancy * 100);
    setCard(
      "alongside",
      k.ships_alongside + " ships · " + occPct + "%",
      k.sections_occupied + "/" + k.sections + " sec · " + k.ships_anchored + " anchored",
      k.ships_anchored > 2 ? "warn" : "good"
    );

    const grossMovesHr = Math.round(k.cranes_working * sh.gross_mph);
    setCard(
      "cranes",
      k.cranes_working + " / " + k.cranes_pool,
      grossMovesHr + " moves/hr · " + sh.label,
      k.cranes_working > 0 ? "good" : ""
    );

    const movePct = k.moves_total > 0 ? Math.round((k.moves_done / k.moves_total) * 100) : 0;
    setCard(
      "moves",
      k.moves_done.toLocaleString("en-US") + " (" + movePct + "%)",
      "of " + k.moves_total.toLocaleString("en-US") + " total moves",
      ""
    );

    setCard(
      "wait",
      k.avg_wait_h.toFixed(1) + "h / " + k.avg_turn_h.toFixed(1) + "h",
      k.ships_departed + "/" + (rep.ships || []).length + " calls departed",
      k.avg_wait_h > 4 ? "warn" : ""
    );

    setCard(
      "late",
      String(k.late_ships),
      k.late_ship_hours.toFixed(1) + " late ship-hrs · cost " + k.cost_so_far,
      k.late_ships > 0 ? "bad" : "good"
    );

    const greedyRep = state.baselineReplays.greedy;
    const greedyReward = (greedyRep && greedyRep.grade && typeof greedyRep.grade.reward === "number")
      ? greedyRep.grade.reward
      : 0.782;
    const curReward = k.reward != null ? k.reward : 0.833;
    const delta = curReward - greedyReward;
    const deltaStr = (delta >= 0 ? "+" : "") + delta.toFixed(3);
    setCard(
      "reward",
      curReward.toFixed(3) + " (" + deltaStr + ")",
      "cost " + (k.cost_final != null ? k.cost_final : k.cost_so_far) +
        (k.optimal_cost != null ? " vs opt " + k.optimal_cost : "") +
        (k.feasible === false ? " · INFEASIBLE" : ""),
      k.feasible === false ? "bad" : delta >= 0 ? "good" : "warn"
    );

    const tag = $("kpi-plan-tag");
    if (tag) tag.textContent = String(state.activePlanKey || "optimal").toUpperCase();
  }

  // ---------- STS Crane Strip & Status ----------
  function computeCraneStatuses(rep, t) {
    const spec = terminalSpecOf(rep);
    const h = Math.floor(t);
    const totalCranes = (rep && rep.task && rep.task.rules && rep.task.rules.crane_pool) || spec.cranes || 10;
    const poolNow = window.OakKPI ? window.OakKPI.at(rep, t).cranes_pool : totalCranes;
    const sh = window.OakKPI ? window.OakKPI.shiftAt(rep, t) : { code: "DAY", gross_mph: 26, is_meal_stop: false };
    const assignments = [];
    for (const s of (rep && rep.ships) || []) {
      const bStart = s.berth_hour != null ? s.berth_hour : s.berth_start || 0;
      const bEnd = s.departure != null ? s.departure : s.berth_end || 0;
      if (h >= bStart && h < bEnd) {
        const cCount = window.OakKPI.shipCranesAt(s, h);
        for (let k = 0; k < cCount; k++) {
          assignments.push({ ship: s, gangSlot: k + 1, totalOnShip: cCount });
        }
      }
    }
    const list = [];
    for (let i = 0; i < totalCranes; i++) {
      const asg = assignments[i] || null;
      const inPool = i < poolNow;
      let status = "IDLE";
      if (!inPool) status = "STANDBY (HOOT/OUTAGE)";
      else if (sh.is_meal_stop && asg) status = "MEAL HOLD";
      else if (asg) status = "WORKING";
      const phaseU = (((t * 18) + i * 0.27) % 1 + 1) % 1;
      const phases = ["LOCK ON SHIP", "HOIST LIFT", "TROLLEY INBOARD", "LOWER TO CHASSIS", "RETURN OUTBOARD"];
      const cyclePhase = status === "WORKING" ? phases[Math.floor(phaseU * phases.length)] : "BOOM RAISED / PARKED";
      list.push({
        idx: i,
        code: "QC-" + String(i + 1).padStart(2, "0"),
        status,
        ship: asg ? asg.ship : null,
        gangSlot: asg ? asg.gangSlot : null,
        hoist_m: status === "WORKING" ? +(14 + 28 * Math.sin(phaseU * Math.PI)).toFixed(1) : 48.0,
        trolley_m: status === "WORKING" ? +(-18 + 56 * Math.sin(phaseU * Math.PI * 2)).toFixed(1) : -20.0,
        cyclePhase,
        mph: status === "WORKING" ? sh.gross_mph : 0,
        spec,
      });
    }
    return list;
  }

  function renderCraneStrip(rep, t) {
    const strip = $("crane-strip");
    const sumEl = $("crane-fleet-summary");
    if (!strip || !rep) return;
    const cranes = computeCraneStatuses(rep, t);
    const activeCount = cranes.filter((c) => c.status === "WORKING").length;
    if (sumEl) sumEl.textContent = activeCount + "/" + cranes.length + " WORKING";

    strip.innerHTML = "";
    for (const c of cranes) {
      const btn = document.createElement("button");
      btn.type = "button";
      const cls = ["crane-pill"];
      if (c.status === "WORKING") cls.push("working");
      else if (c.status.includes("OUTAGE")) cls.push("outage");
      if (state.inspectorMode === "crane" && state.selectedCraneIdx === c.idx) cls.push("selected");
      btn.className = cls.join(" ");
      btn.innerHTML =
        "<strong>" + c.code + "</strong>" +
        "<span class='crane-pill-sub'>" + (c.ship ? c.ship.name.split(" ")[0] : c.status.split(" ")[0]) + "</span>";
      btn.addEventListener("click", () => selectCrane(c.idx, c, rep, t));
      strip.appendChild(btn);
    }
  }

  // ---------- Active Disruptions & VTS Alerts ----------
  function collectAlerts(rep, t) {
    if (!rep) return [];
    const alerts = [];
    const fogs = (rep.no_moves || []).concat(rep.fog_closures || []);
    fogs.forEach((w, i) => {
      const s = w.start != null ? w.start : w[0];
      const e = w.end != null ? w.end : w[1];
      const active = t >= s && t < e;
      alerts.push({
        id: "fog-" + i,
        kind: "fog",
        title: "SF Bar Closed · " + (w.label || "Dense Advection Fog"),
        meta: "H" + String(s).padStart(3, "0") + "–H" + String(e).padStart(3, "0") + " · All vessel movements held",
        stateText: active ? "ACTIVE NOW" : t < s ? "IN " + Math.ceil(s - t) + "H" : "PASSED",
        active,
        hour: s,
      });
    });

    const outages = (rep.crane_outages || []).concat((rep.task && rep.task.rules && rep.task.rules.crane_outages) || []);
    outages.forEach((o, i) => {
      const s = o.start != null ? o.start : o[0] || 0;
      const e = o.end != null ? o.end : o[1] || 24;
      const active = t >= s && t < e;
      alerts.push({
        id: "crane-" + i,
        kind: "crane",
        title: "STS Crane Outage · " + (o.crane || "Pool -1"),
        meta: "H" + String(s).padStart(3, "0") + "–H" + String(e).padStart(3, "0") + " · Spreader hydraulic fault",
        stateText: active ? "ACTIVE NOW" : "SCHED",
        active,
        hour: s,
      });
    });

    const blocks = (rep.blocks || []).concat(rep.shallow_blocks || []);
    blocks.forEach((b, i) => {
      const s = b.start != null ? b.start : 0;
      const e = b.end != null ? b.end : 168;
      const active = t >= s && t < e;
      const isShallow = b.kind === "shallow";
      alerts.push({
        id: "blk-" + i,
        kind: isShallow ? "shallow" : "closed",
        title: (isShallow ? "Shallow Berth Restriction" : "Berth Closure") + " · Sec " + b.first + "–" + b.last,
        meta: (b.label || (isShallow ? "Max draft 12.8m" : "Quay repair")) + " · H" + s + "–H" + e,
        stateText: active ? (isShallow ? "DEPTH LIMIT" : "ACTIVE NOW") : "H" + s,
        active: active && !isShallow,
        hour: s,
      });
    });

    for (let idx = 0; idx < (rep.ships || []).length; idx++) {
      const s = rep.ships[idx];
      if ((s.late_h || 0) > 0) {
        const dep = s.departure != null ? s.departure : s.berth_end;
        const due = s.due != null ? s.due : dep - s.late_h;
        const active = t >= due && t <= dep;
        alerts.push({
          id: "late-" + idx,
          kind: "late",
          title: "Late Vessel Alert · " + s.name,
          meta: "+" + s.late_h + "h past due (Due H" + due + " → ETD H" + dep + ")",
          stateText: active ? "LATE NOW" : "H" + due,
          active,
          hour: due,
          shipIdx: idx,
        });
      }
    }
    return alerts;
  }

  function renderAlerts(rep, t) {
    const container = $("vts-alerts");
    const badge = $("alert-count-badge");
    if (!container) return;
    const alerts = collectAlerts(rep, t);
    const liveCount = alerts.filter((a) => a.active).length;
    if (badge) {
      badge.textContent = (liveCount ? liveCount + " LIVE / " : "") + alerts.length + " ALERTS";
      badge.className = "pill-tag " + (liveCount > 0 ? "bad" : "warn");
    }
    container.innerHTML = "";
    for (const a of alerts) {
      const div = document.createElement("div");
      div.className = "alert-card " + a.kind + (a.active ? " active-now" : "");
      div.innerHTML =
        "<div>" +
          "<div class='alert-title'>" + a.title + "</div>" +
          "<div class='alert-meta'>" + a.meta + "</div>" +
        "</div>" +
        "<span class='alert-state " + (a.active ? "live" : "") + "'>" + a.stateText + "</span>";
      div.addEventListener("click", () => {
        if (typeof a.shipIdx === "number") {
          selectShip(a.shipIdx, rep, state.t);
        } else if (typeof a.hour === "number") {
          triggerScrub(a.hour);
        }
      });
      container.appendChild(div);
    }
  }

  // ---------- Interactive Vessel Roster (#ship-list) ----------
  function shipStateAt(rep, s, t) {
    const h = Math.floor(t);
    const arr = s.arrival != null ? s.arrival : s.eta_hour || 0;
    const bStart = s.berth_hour != null ? s.berth_hour : s.berth_start || arr;
    const dep = s.departure != null ? s.departure : s.berth_end || bStart + 12;
    const due = s.due != null ? s.due : dep;
    const cranes = window.OakKPI ? window.OakKPI.shipCranesAt(s, h) : 0;
    const isLateNow = (s.late_h > 0) && t >= due && t < dep;
    if (t < arr) return { key: "sea", label: "AT SEA", cranes: 0 };
    if (t < bStart) return { key: "anchor", label: "ANCHORED", cranes: 0 };
    if (t < dep) {
      return {
        key: isLateNow ? "late" : "alongside",
        label: (isLateNow ? "LATE · " : "BERTH · ") + cranes + " QC",
        cranes,
      };
    }
    return { key: "departed", label: "DEPARTED", cranes: 0 };
  }

  function renderRoster(rep, t) {
    const listEl = $("ship-list");
    const countEl = $("roster-count");
    if (!listEl || !rep) return;
    const ships = rep.ships || [];
    const q = (state.searchQuery || "").trim().toLowerCase();
    if (countEl) countEl.textContent = ships.length + " vessel calls";

    if (listEl.children.length !== ships.length) {
      listEl.innerHTML = "";
      ships.forEach((s, idx) => {
        const card = document.createElement("div");
        card.className = "ship-card";
        card.dataset.idx = String(idx);
        card.addEventListener("click", () => selectShip(idx, rep, state.t));
        listEl.appendChild(card);
      });
    }

    ships.forEach((s, idx) => {
      const card = listEl.children[idx];
      if (!card) return;
      const matches = !q || s.name.toLowerCase().includes(q) || String(s.line || "").toLowerCase().includes(q);
      card.classList.toggle("hidden", !matches);
      card.classList.toggle("selected", state.inspectorMode === "ship" && state.selectedShipIdx === idx);

      const st = shipStateAt(rep, s, t);
      const prog = window.OakKPI ? window.OakKPI.progress(rep, s, t) : 0;
      const pct = Math.round(prog * 100);
      const totalMoves = window.OakKPI ? window.OakKPI.shipMovesTotal(rep, s) : 1500;
      const doneMoves = Math.round(totalMoves * prog);
      const firstSec = s.first_section || 1;
      const lastSec = firstSec + (s.sections || 6) - 1;
      const bStart = s.berth_hour != null ? s.berth_hour : s.berth_start || 0;
      const dep = s.departure != null ? s.departure : s.berth_end || 0;

      card.innerHTML =
        "<div class='ship-card-top'>" +
          "<div class='ship-id-group'>" +
            "<span class='swatch' style='background:" + lineColor(s.line) + "'></span>" +
            "<span class='ship-name'>" + s.name + "</span>" +
          "</div>" +
          "<span class='ship-status-pill " + st.key + "'>" + st.label + "</span>" +
        "</div>" +
        "<div class='ship-card-meta'>" +
          "<span>" + (s.line || "Line") + " · " + Math.round(s.length_m || 300) + "m · Sec " + firstSec + "–" + lastSec + "</span>" +
          "<span>H" + bStart + "→H" + dep + (s.late_h > 0 ? " <b style='color:#ff5757'>+" + s.late_h + "h</b>" : "") + "</span>" +
        "</div>" +
        "<div class='ship-bar'><i style='width:" + pct + "%'></i></div>" +
        "<div class='ship-card-foot'>" +
          "<span>" + doneMoves.toLocaleString("en-US") + " / " + totalMoves.toLocaleString("en-US") + " moves (" + pct + "%)</span>" +
          "<span>" + (st.cranes ? st.cranes + " gangs active" : "Due H" + (s.due != null ? s.due : dep)) + "</span>" +
        "</div>";
    });
  }

  // ---------- Right Floating Asset Inspector Drawer ----------
  function renderInspector(rep, t) {
    const drawer = $("inspector-drawer");
    if (!drawer || !rep) return;
    if (!state.inspectorMode) {
      drawer.classList.add("hidden");
      return;
    }
    drawer.classList.remove("hidden");
    const vTabs = $("vessel-tabs");
    const vBody = $("vessel-inspector-body");
    const cBody = $("crane-inspector-body");

    if (state.inspectorMode === "ship") {
      vTabs.classList.remove("hidden");
      vBody.classList.remove("hidden");
      cBody.classList.add("hidden");
      renderVesselInspector(rep, t);
    } else if (state.inspectorMode === "crane") {
      vTabs.classList.add("hidden");
      vBody.classList.add("hidden");
      cBody.classList.remove("hidden");
      renderCraneInspector(rep, t);
    }
  }

  function vesselDetails(rep, s, idx) {
    const ts = ((rep.task && rep.task.ships) || [])[s.id] || {};
    const imo = s.imo || ts.imo || String(9710000 + ((idx + 1) * 48271) % 260000);
    const mmsi = String(477100000 + ((idx + 1) * 9137) % 890000);
    const len = Math.round(s.length_m || ts.length_m || 335);
    const beam = Math.round(s.beam_m || ts.beam_m || Math.max(32, len / 7.2));
    const draft = +(s.draught_m || ts.draught_m || 14.2).toFixed(1);
    const vClass = len >= 380 ? "ULCV · 18,000+ TEU" : len >= 330 ? "Neo-Panamax · 13,500 TEU" : len >= 275 ? "Post-Panamax · 8,500 TEU" : "Aloha ConRo · 3,600 TEU";
    return { ts, imo, mmsi, len, beam, draft, vClass };
  }

  function renderVesselInspector(rep, t) {
    const ships = rep.ships || [];
    const idx = Math.max(0, Math.min(ships.length - 1, state.selectedShipIdx || 0));
    const s = ships[idx];
    if (!s) return;
    const d = vesselDetails(rep, s, idx);
    const spec = terminalSpecOf(rep);
    const st = shipStateAt(rep, s, t);

    $("inspector-kicker").textContent = "VESSEL INSPECTOR · " + (s.line || "CARRIER").toUpperCase();
    $("inspector-title").textContent = s.name;
    $("inspector-subtitle").textContent = "IMO " + d.imo + " · MMSI " + d.mmsi + " · " + d.vClass;

    // Show active tab pane
    ["overview", "bays", "cranes", "ais"].forEach((tab) => {
      const pane = $("tab-" + tab);
      if (pane) pane.classList.toggle("hidden", state.activeTab !== tab);
    });
    document.querySelectorAll("#vessel-tabs .tab-btn").forEach((b) => {
      b.classList.toggle("on", b.dataset.tab === state.activeTab);
    });

    const arr = s.arrival != null ? s.arrival : 0;
    const bStart = s.berth_hour != null ? s.berth_hour : 0;
    const dep = s.departure != null ? s.departure : 0;
    const due = s.due != null ? s.due : dep;
    const waitH = Math.max(0, bStart - arr);
    const firstSec = s.first_section || 1;
    const lastSec = firstSec + (s.sections || 6) - 1;
    const berthPosM = (firstSec - 1) * 42;
    const ukcM = +(spec.max_draft_m - d.draft).toFixed(1);

    // 1. OVERVIEW TAB
    const tabOverview = $("tab-overview");
    if (tabOverview && state.activeTab === "overview") {
      tabOverview.innerHTML =
        "<div class='spec-grid'>" +
          "<div class='spec-cell'><div class='spec-label'>IMO / MMSI</div><div class='spec-val'>" + d.imo + "</div><div class='spec-sub'>MMSI " + d.mmsi + " · Status: " + st.label + "</div></div>" +
          "<div class='spec-cell'><div class='spec-label'>Dimensions &amp; Class</div><div class='spec-val'>" + d.len + "m × " + d.beam + "m</div><div class='spec-sub'>" + d.vClass + "</div></div>" +
          "<div class='spec-cell'><div class='spec-label'>Draft vs Berth Depth</div><div class='spec-val'>" + d.draft + "m / " + spec.max_draft_m + "m</div><div class='spec-sub'>UKC " + (ukcM >= 0 ? "+" : "") + ukcM + "m (" + spec.max_draft_ft + "ft MLLW)</div></div>" +
          "<div class='spec-cell'><div class='spec-label'>Assigned Berth Span</div><div class='spec-val'>Sec " + firstSec + "–" + lastSec + "</div><div class='spec-sub'>" + berthPosM + "m–" + (berthPosM + d.len) + "m along quay</div></div>" +
          "<div class='spec-cell'><div class='spec-label'>ETA / Berth / ETD</div><div class='spec-val'>H" + arr + " → H" + bStart + " → H" + dep + "</div><div class='spec-sub'>Due H" + due + " · Planned Sec " + (d.ts.planned_section || firstSec) + "</div></div>" +
          "<div class='spec-cell'><div class='spec-label'>Wait &amp; Schedule Delay</div><div class='spec-val'>" + waitH + "h wait · " + (s.late_h > 0 ? "+" + s.late_h + "h late" : "0h late") + "</div><div class='spec-sub'>" + (d.ts.from_port || "Asia") + " → USOAK → " + (d.ts.to_port || "USWC") + "</div></div>" +
        "</div>";
    }

    // 2. BAYS & CARGO TAB (2D SVG Bay Profile Bays 01..40 + live move progress)
    const tabBays = $("tab-bays");
    if (tabBays && state.activeTab === "bays") {
      const prog = window.OakKPI ? window.OakKPI.progress(rep, s, t) : 0;
      const totalMoves = window.OakKPI ? window.OakKPI.shipMovesTotal(rep, s) : 1800;
      const doneMoves = Math.round(totalMoves * prog);
      const dischMoves = Math.round(totalMoves * 0.54);
      const loadMoves = totalMoves - dischMoves;
      const numBays = 20; // 40ft bays 02..38 (labelled 01..40)
      let rectsSvg = "";
      for (let b = 0; b < numBays; b++) {
        const bx = 26 + b * 14.5;
        const tiers = 4 + ((b * 7 + idx * 3) % 4);
        const bayProg = Math.max(0, Math.min(1, prog * 1.25 - (b / numBays) * 0.25));
        for (let tr = 0; tr < tiers; tr++) {
          const by = 78 - (tr + 1) * 7.5;
          const worked = (tr / tiers) <= bayProg;
          const fill = worked ? "#34d399" : lineColor(s.line);
          const op = worked ? 0.9 : 0.42;
          rectsSvg += "<rect x='" + bx + "' y='" + by + "' width='12' height='6' rx='1' fill='" + fill + "' fill-opacity='" + op + "'/>";
        }
      }
      tabBays.innerHTML =
        "<div class='bay-canvas-wrap'>" +
          "<div class='section-head'><span class='section-title'>CONTAINER BAY PROFILE · BAYS 01–40</span><span class='pill-tag'>" + Math.round(prog * 100) + "% WORKED</span></div>" +
          "<svg viewBox='0 0 340 112' width='100%' height='112' style='margin-top:6px'>" +
            "<path d='M14,78 L312,78 L328,94 L22,94 Z' fill='#1e293b' stroke='#475569' stroke-width='1.5'/>" +
            "<rect x='48' y='44' width='18' height='34' rx='2' fill='#cbd5e1'/>" +
            rectsSvg +
            "<text x='18' y='107' fill='#8ea0b5' font-size='9' font-family='monospace'>STERN BAY 01</text>" +
            "<text x='145' y='107' fill='#8ea0b5' font-size='9' font-family='monospace'>MIDSHIP BAYS 18–22</text>" +
            "<text x='272' y='107' fill='#8ea0b5' font-size='9' font-family='monospace'>BOW BAY 40</text>" +
          "</svg>" +
        "</div>" +
        "<div class='spec-grid'>" +
          "<div class='spec-cell'><div class='spec-label'>Total Moves</div><div class='spec-val'>" + doneMoves.toLocaleString("en-US") + " / " + totalMoves.toLocaleString("en-US") + "</div><div class='spec-sub'>" + (totalMoves - doneMoves).toLocaleString("en-US") + " moves remaining</div></div>" +
          "<div class='spec-cell'><div class='spec-label'>Discharge / Load</div><div class='spec-val'>" + dischMoves.toLocaleString("en-US") + " / " + loadMoves.toLocaleString("en-US") + "</div><div class='spec-sub'>Reefer: " + Math.round(totalMoves * 0.08) + " plugs</div></div>" +
        "</div>";
    }

    // 3. CRANES & SHIFTS TAB
    const tabCranes = $("tab-cranes");
    if (tabCranes && state.activeTab === "cranes") {
      const hours = [];
      for (let h = bStart; h < dep; h++) {
        const c = window.OakKPI ? window.OakKPI.shipCranesAt(s, h) : 0;
        const sh = window.OakKPI ? window.OakKPI.shiftAt(rep, h) : { code: "DAY" };
        hours.push({ h, c, code: sh.code });
      }
      const maxC = Math.max(6, d.ts.max_cranes || 6);
      const bw = Math.max(4, Math.min(18, Math.floor(300 / Math.max(1, hours.length))));
      let barsSvg = "";
      hours.forEach((item, i) => {
        const x = 22 + i * bw;
        const bh = Math.round((item.c / maxC) * 68);
        const y = 80 - bh;
        const col = item.code === "DAY" ? "#38bdf8" : item.code === "HOOT" ? "#fbbf24" : item.code === "MEAL" ? "#ff5757" : "#a78bfa";
        barsSvg += "<rect x='" + x + "' y='" + y + "' width='" + Math.max(2, bw - 1.5) + "' height='" + Math.max(2, bh) + "' fill='" + col + "' rx='1'><title>H" + item.h + " (" + item.code + "): " + item.c + " cranes</title></rect>";
      });
      tabCranes.innerHTML =
        "<div class='crane-chart-wrap'>" +
          "<div class='section-head'><span class='section-title'>HOURLY CRANE ALLOCATION (ILWU SHIFTS)</span><span class='muted small'>H" + bStart + "–H" + dep + "</span></div>" +
          "<svg viewBox='0 0 330 96' width='100%' height='96' style='margin-top:6px'>" +
            "<line x1='20' y1='80' x2='324' y2='80' stroke='#334155' stroke-width='1'/>" +
            barsSvg +
            "<text x='22' y='92' fill='#8ea0b5' font-size='9' font-family='monospace'>Cyan=Day(1.0x)  Violet=Night(0.96x)  Amber=Hoot(0.85x)  Red=Meal(0.5x)</text>" +
          "</svg>" +
        "</div>" +
        "<div class='spec-grid'>" +
          "<div class='spec-cell'><div class='spec-label'>Active Gangs Now</div><div class='spec-val'>" + st.cranes + " / " + maxC + " max</div><div class='spec-sub'>Std plan: " + (d.ts.std_cranes || 4) + " STS cranes</div></div>" +
          "<div class='spec-cell'><div class='spec-label'>Total Crane-Hours</div><div class='spec-val'>" + (d.ts.workload || hours.reduce((a, b) => a + b.c, 0)) + " cr-h</div><div class='spec-sub'>26 base moves / crane-hr</div></div>" +
        "</div>";
    }

    // 4. AIS / !AIVDM TAB
    const tabAis = $("tab-ais");
    if (tabAis && state.activeTab === "ais") {
      const sog = st.key === "sea" ? 12.4 : st.key === "anchor" ? 0.3 : st.key === "departed" ? 13.8 : 0.0;
      const cog = st.key === "sea" ? "074°" : st.key === "departed" ? "258°" : "302°";
      const navStatus = st.key === "alongside" || st.key === "late" ? "5 (Moored alongside)" : st.key === "anchor" ? "1 (At anchor, SF Bay)" : "0 (Under way using engine)";
      const tugs = Math.abs(t - bStart) <= 1.2 || Math.abs(t - dep) <= 1.2
        ? "2× Tractor Tugs (Delta Billie, Z-Five) · Bar Pilot #18"
        : st.key === "alongside" || st.key === "late" ? "Moored (Lines fast)" : "Standby VTS Sector 2";
      const payload = "16S`2c00" + (sog > 0 ? "2G" : "00") + "856K`Ed0" + (idx + 1) + "d4R20000";
      const nmea1 = "!AIVDM,1,1,,A," + payload + ",0*5" + (idx % 9);
      const nmea5 = "!AIVDM,2,1,3,B,56S`2c02>" + d.imo.slice(0, 5) + "E=@4p" + s.name.replace(/\s+/g, "").slice(0, 8) + ",0*2F";
      tabAis.innerHTML =
        "<div class='spec-grid'>" +
          "<div class='spec-cell'><div class='spec-label'>SOG / COG</div><div class='spec-val'>" + sog.toFixed(1) + " kt · " + cog + "</div><div class='spec-sub'>Pos " + spec.lat.toFixed(4) + "°N, " + spec.lon.toFixed(4) + "°W</div></div>" +
          "<div class='spec-cell'><div class='spec-label'>AIS Nav Status</div><div class='spec-val'>" + navStatus.split(" ")[0] + " · " + st.label + "</div><div class='spec-sub'>" + navStatus + "</div></div>" +
          "<div class='spec-cell' style='grid-column:span 2'><div class='spec-label'>Pilotage &amp; Tug Escort</div><div class='spec-val'>" + tugs + "</div><div class='spec-sub'>USCG VTS San Francisco · Ch 14 (156.700 MHz)</div></div>" +
        "</div>" +
        "<div class='nmea-box'>" +
          "# LIVE ITU-R M.1371 NMEA !AIVDM STREAM (" + fmtClock(t) + ")\n" +
          nmea1 + "\n" +
          nmea5 + "\n" +
          "DECODED: MMSI=" + d.mmsi + " IMO=" + d.imo + " SOG=" + sog.toFixed(1) + "kn COG=" + cog + " DEST=USOAK_" + spec.code +
        "</div>";
    }
  }

  function renderCraneInspector(rep, t) {
    const cranes = computeCraneStatuses(rep, t);
    const idx = Math.max(0, Math.min(cranes.length - 1, state.selectedCraneIdx || 0));
    const c = cranes[idx];
    if (!c) return;

    $("inspector-kicker").textContent = "STS QUAY CRANE TELEMETRY · " + c.spec.code;
    $("inspector-title").textContent = c.code + " · " + c.status;
    $("inspector-subtitle").textContent = c.spec.crane_model + " · " + c.spec.operator;

    const body = $("crane-inspector-body");
    if (!body) return;
    body.innerHTML =
      "<div class='spec-grid'>" +
        "<div class='spec-cell'><div class='spec-label'>Operational Status</div><div class='spec-val'>" + c.status + "</div><div class='spec-sub'>Productivity: " + c.mph.toFixed(1) + " moves/hr</div></div>" +
        "<div class='spec-cell'><div class='spec-label'>Serving Vessel</div><div class='spec-val'>" + (c.ship ? c.ship.name : "NONE (PARKED)") + "</div><div class='spec-sub'>" + (c.ship ? "Gang #" + c.gangSlot + " of " + (c.ship.sections || 8) + " sec" : "Boom stowed at 80°") + "</div></div>" +
        "<div class='spec-cell'><div class='spec-label'>Cycle Phase</div><div class='spec-val'>" + c.cyclePhase + "</div><div class='spec-sub'>Twin-20 / 40ft Bromma Spreader</div></div>" +
        "<div class='spec-cell'><div class='spec-label'>Hoist / Trolley Pos</div><div class='spec-val'>" + c.hoist_m + "m / " + c.trolley_m + "m</div><div class='spec-sub'>Outreach " + c.spec.outreach_m + "m · Lift " + c.spec.lift_m + "m</div></div>" +
        "<div class='spec-cell' style='grid-column:span 2'><div class='spec-label'>ZPMC Structural &amp; Drive Specs</div><div class='spec-val'>" + c.spec.crane_model + "</div><div class='spec-sub'>SWL 65 LT · Rail Gauge 30.48m (100ft) · 100% Zero-Emission Shore Power</div></div>" +
      "</div>";
  }

  // ---------- Bottom 2D Berth-Time Schedule Gantt Drawer ----------
  function renderGantt(rep, t) {
    const cv = $("gantt-canvas");
    if (!cv || !rep || !state.ganttOpen) return;
    const rect = cv.getBoundingClientRect();
    const W = Math.max(640, Math.floor(rect.width || 960));
    const H = Math.max(180, Math.floor(rect.height || 210));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== W * dpr || cv.height !== H * dpr) {
      cv.width = W * dpr;
      cv.height = H * dpr;
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const padL = 58, padR = 14, padT = 22, padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxH = window.OakKPI ? window.OakKPI.horizon(rep) : 168;
    const nSec = window.OakKPI ? window.OakKPI.at(rep, t).sections : 50;

    const X = (h) => padL + (Math.max(0, Math.min(maxH, h)) / maxH) * plotW;
    const Y = (sec) => padT + ((sec - 1) / Math.max(1, nSec)) * plotH;

    // 1. ILWU shift background bands
    for (let h = 0; h < maxH; h++) {
      const hd = h % 24;
      if (hd === 17) ctx.fillStyle = "rgba(255, 87, 87, 0.10)";
      else if (hd >= 3 && hd < 8) ctx.fillStyle = "rgba(251, 191, 36, 0.07)";
      else if (hd >= 8 && hd < 17) ctx.fillStyle = "rgba(56, 189, 248, 0.05)";
      else ctx.fillStyle = "rgba(167, 139, 250, 0.04)";
      ctx.fillRect(X(h), padT, Math.ceil(plotW / maxH) + 0.5, plotH);
    }

    // 2. Day gridlines & labels
    ctx.strokeStyle = "rgba(255,255,255,0.09)";
    ctx.fillStyle = "#8ea0b5";
    ctx.font = "600 10px -apple-system, BlinkMacSystemFont, monospace";
    for (let h = 0; h <= maxH; h += 24) {
      const x = X(h);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      if (h < maxH) {
        const dName = DAYS[Math.floor(h / 24) % 7];
        ctx.fillText(dName + " H" + h, x + 4, 14);
      }
    }

    // 3. Y-axis section labels
    for (let s = 1; s <= nSec; s += Math.max(2, Math.round(nSec / 5))) {
      const y = Y(s);
      ctx.fillStyle = "#8ea0b5";
      ctx.fillText("Sec " + s, 6, y + 9);
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
    }

    // 4. Fog closures (vertical full-height bands)
    const fogs = (rep.no_moves || []).concat(rep.fog_closures || []);
    for (const w of fogs) {
      const s = w.start != null ? w.start : w[0];
      const e = w.end != null ? w.end : w[1];
      const x0 = X(s), x1 = X(e);
      ctx.fillStyle = "rgba(255, 190, 80, 0.22)";
      ctx.fillRect(x0, padT, x1 - x0, plotH);
      ctx.strokeStyle = "rgba(255, 190, 80, 0.65)";
      ctx.strokeRect(x0, padT, x1 - x0, plotH);
      ctx.fillStyle = "#fbbf24";
      ctx.fillText("FOG / BAR CLOSED", x0 + 3, padT + 11);
    }

    // 5. Shallow & Closed berth blocks
    for (const b of rep.blocks || []) {
      const x0 = X(b.start || 0), x1 = X(b.end || maxH);
      const y0 = Y(b.first || 1), y1 = Y((b.last || nSec) + 1);
      ctx.fillStyle = b.kind === "shallow" ? "rgba(120, 230, 245, 0.20)" : "rgba(255, 87, 87, 0.26)";
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = b.kind === "shallow" ? "rgba(120, 230, 245, 0.6)" : "rgba(255, 87, 87, 0.7)";
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.fillStyle = "#e2e8f0";
      ctx.fillText((b.kind === "shallow" ? "SHALLOW " : "CLOSED ") + (b.label || ""), x0 + 4, y0 + 11);
    }

    // 6. Ship rectangles [berth_hour, departure] x [first_section, first_section + sections]
    state.ganttBoxes = [];
    (rep.ships || []).forEach((s, idx) => {
      const arr = s.arrival != null ? s.arrival : 0;
      const b0 = s.berth_hour != null ? s.berth_hour : s.berth_start || 0;
      const dep = s.departure != null ? s.departure : s.berth_end || b0 + 12;
      const due = s.due != null ? s.due : dep;
      const firstSec = s.first_section || 1;
      const secs = s.sections || 6;

      const x0 = X(b0), x1 = X(dep);
      const y0 = Y(firstSec), y1 = Y(firstSec + secs);
      const col = lineColor(s.line);

      // Wait whisker from arrival to berth_hour
      if (b0 > arr) {
        const xa = X(arr);
        ctx.strokeStyle = "rgba(251, 191, 36, 0.75)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(xa, (y0 + y1) / 2);
        ctx.lineTo(x0, (y0 + y1) / 2);
        ctx.stroke();
      }

      ctx.fillStyle = col;
      ctx.globalAlpha = state.selectedShipIdx === idx ? 0.92 : 0.72;
      ctx.fillRect(x0, y0 + 1, Math.max(4, x1 - x0), Math.max(6, y1 - y0 - 2));
      ctx.globalAlpha = 1;

      // Late tail shading past due hour
      if (s.late_h > 0 && dep > due) {
        const xd = X(Math.max(b0, due));
        ctx.fillStyle = "rgba(255, 50, 50, 0.55)";
        ctx.fillRect(xd, y0 + 1, Math.max(2, x1 - xd), Math.max(6, y1 - y0 - 2));
      }

      ctx.strokeStyle = state.selectedShipIdx === idx ? "#ffffff" : "rgba(255,255,255,0.45)";
      ctx.lineWidth = state.selectedShipIdx === idx ? 2 : 1;
      ctx.strokeRect(x0, y0 + 1, Math.max(4, x1 - x0), Math.max(6, y1 - y0 - 2));

      ctx.fillStyle = "#ffffff";
      ctx.font = "700 10px -apple-system, BlinkMacSystemFont, sans-serif";
      const label = s.name.split(" ").slice(0, 2).join(" ");
      if (x1 - x0 > 32 && y1 - y0 > 11) {
        ctx.fillText(label, x0 + 4, y0 + Math.min(13, (y1 - y0) / 2 + 4));
      }

      state.ganttBoxes.push({ idx, ship: s, x0, x1, y0, y1 });
    });

    // 7. Red Playhead at hour t
    const px = X(t);
    ctx.strokeStyle = "#ff3b3b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, padT - 4);
    ctx.lineTo(px, padT + plotH + 4);
    ctx.stroke();

    ctx.fillStyle = "#ff3b3b";
    ctx.fillRect(px - 22, padT + plotH + 3, 44, 15);
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 9.5px monospace";
    ctx.fillText("H" + (Number(t) || 0).toFixed(1), px - 17, padT + plotH + 14);
  }

  // ---------- Scrubber Timeline Event Markers ----------
  function renderScrubMarkers(rep) {
    const wrap = $("scrub-markers");
    if (!wrap || !rep) return;
    wrap.innerHTML = "";
    const maxH = window.OakKPI ? window.OakKPI.horizon(rep) : 168;
    const addTick = (start, end, cls, title) => {
      const el = document.createElement("span");
      el.className = "scrub-tick " + cls;
      const left = Math.max(0, Math.min(100, (start / maxH) * 100));
      const width = Math.max(0.6, ((end - start) / maxH) * 100);
      el.style.left = left + "%";
      el.style.width = width + "%";
      el.title = title;
      wrap.appendChild(el);
    };
    for (const w of (rep.no_moves || []).concat(rep.fog_closures || [])) {
      const s = w.start != null ? w.start : w[0];
      const e = w.end != null ? w.end : w[1];
      addTick(s, e, "fog", "Fog / Bar Closure H" + s + "–H" + e);
    }
    for (const b of rep.blocks || []) {
      if (b.kind === "closed") addTick(b.start || 0, b.end || maxH, "closed", "Closed Berth H" + b.start + "–H" + b.end);
    }
    for (const s of rep.ships || []) {
      if (s.late_h > 0) addTick(s.due || s.departure, s.departure, "late", s.name + " late +" + s.late_h + "h");
    }
  }

  // ---------- Helper Actions & Callbacks ----------
  function triggerScrub(newT) {
    const maxH = (state.replay && window.OakKPI) ? window.OakKPI.horizon(state.replay) : 168;
    const clamped = Math.max(0, Math.min(maxH, Number(newT) || 0));
    state.t = clamped;
    if (typeof state.callbacks.onScrub === "function") {
      state.callbacks.onScrub(clamped);
    } else {
      const scrub = $("scrub");
      if (scrub) {
        scrub.value = String(clamped);
        scrub.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    updateAtHour(state.replay, clamped, state.extra);
  }

  // ---------- Public API Methods ----------
  function init(callbacks) {
    ensureDemoFixtures();
    if (callbacks && typeof callbacks === "object") {
      state.callbacks = Object.assign({}, state.callbacks, callbacks);
      state.externalDriven = true;
    }
    if (state.initialized) return window.OakControlPanel;
    state.initialized = true;

    // Scenario select
    const scenSel = $("scenario-select");
    if (scenSel) {
      scenSel.addEventListener("change", () => {
        state.activeScenarioKey = scenSel.value;
        if (typeof state.callbacks.onSelectScenario === "function") {
          state.callbacks.onSelectScenario(state.activeScenarioKey, state.activePlanKey);
        } else {
          const fix = $("fixture");
          if (fix) {
            if (![...fix.options].some((o) => o.value === scenSel.value)) {
              const opt = document.createElement("option");
              opt.value = scenSel.value;
              fix.appendChild(opt);
            }
            fix.value = scenSel.value;
            fix.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      });
    }

    // Plan policy buttons
    document.querySelectorAll("#plan-switcher [data-plan]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const planKey = btn.dataset.plan;
        state.activePlanKey = planKey;
        document.querySelectorAll("#plan-switcher [data-plan]").forEach((b) => {
          b.classList.toggle("on", b.dataset.plan === planKey);
        });
        if (typeof state.callbacks.onSelectPlan === "function") {
          state.callbacks.onSelectPlan(planKey, state.activeScenarioKey);
        } else {
          const base = state.baseReplayCache.get(state.activeScenarioKey) || state.replay;
          const variant = derivePlanVariant(base, planKey);
          if (variant) setReplay(variant, planKey);
        }
      });
    });

    // File input (#file-in -> forwards to callback or #file)
    const fileIn = $("file-in");
    if (fileIn) {
      fileIn.addEventListener("change", () => {
        const f = fileIn.files && fileIn.files[0];
        if (!f) return;
        if (typeof state.callbacks.onLoadFile === "function") {
          state.callbacks.onLoadFile(f);
        } else {
          f.text().then((txt) => {
            try {
              const rep = JSON.parse(txt);
              setReplay(rep, state.activePlanKey);
            } catch (_e) { /* handled by viewer */ }
          });
          const legacyFile = $("file");
          if (legacyFile) {
            try {
              const dt = new DataTransfer();
              dt.items.add(f);
              legacyFile.files = dt.files;
              legacyFile.dispatchEvent(new Event("change", { bubbles: true }));
            } catch (_e) { /* ignore */ }
          }
        }
      });
    }

    // Inspector tabs & controls
    document.querySelectorAll("#vessel-tabs .tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeTab = btn.dataset.tab || "overview";
        renderInspector(state.replay, state.t);
      });
    });
    const closeBtn = $("inspector-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        state.inspectorMode = null;
        state.selectedShipIdx = null;
        state.selectedCraneIdx = null;
        renderInspector(state.replay, state.t);
        renderRoster(state.replay, state.t);
        renderCraneStrip(state.replay, state.t);
      });
    }
    const prevBtn = $("inspector-prev");
    const nextBtn = $("inspector-next");
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        if (!state.replay) return;
        if (state.inspectorMode === "crane") {
          const cranes = computeCraneStatuses(state.replay, state.t);
          selectCrane((state.selectedCraneIdx - 1 + cranes.length) % cranes.length, null, state.replay, state.t);
        } else {
          const n = (state.replay.ships || []).length || 1;
          selectShip(((state.selectedShipIdx || 0) - 1 + n) % n, state.replay, state.t);
        }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        if (!state.replay) return;
        if (state.inspectorMode === "crane") {
          const cranes = computeCraneStatuses(state.replay, state.t);
          selectCrane(((state.selectedCraneIdx || 0) + 1) % cranes.length, null, state.replay, state.t);
        } else {
          const n = (state.replay.ships || []).length || 1;
          selectShip(((state.selectedShipIdx || 0) + 1) % n, state.replay, state.t);
        }
      });
    }

    // Gantt toggle & canvas interactions
    const ganttBtn = $("gantt-toggle-btn");
    if (ganttBtn) ganttBtn.addEventListener("click", () => toggleGantt());

    const ganttCv = $("gantt-canvas");
    if (ganttCv) {
      const eventToGantt = (ev) => {
        const r = ganttCv.getBoundingClientRect();
        const x = ev.clientX - r.left;
        const y = ev.clientY - r.top;
        const padL = 58, padR = 14;
        const maxH = (state.replay && window.OakKPI) ? window.OakKPI.horizon(state.replay) : 168;
        const hour = ((x - padL) / Math.max(1, r.width - padL - padR)) * maxH;
        const hit = state.ganttBoxes.find((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
        return { x, y, hour: Math.max(0, Math.min(maxH, hour)), hit };
      };

      ganttCv.addEventListener("pointerdown", (ev) => {
        const info = eventToGantt(ev);
        if (info.hit) {
          selectShip(info.hit.idx, state.replay, state.t);
        } else {
          state.ganttDragging = true;
          triggerScrub(info.hour);
        }
      });
      window.addEventListener("pointermove", (ev) => {
        if (state.ganttDragging) {
          const info = eventToGantt(ev);
          triggerScrub(info.hour);
        }
      });
      window.addEventListener("pointerup", () => {
        state.ganttDragging = false;
      });
    }

    // Camera rail & Layer toggles
    document.querySelectorAll("#cam-rail [data-cam]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cam = btn.dataset.cam;
        document.querySelectorAll("#cam-rail [data-cam]").forEach((b) => b.classList.toggle("on", b === btn));
        if (typeof state.callbacks.onSelectCamera === "function") {
          state.callbacks.onSelectCamera(cam);
        }
      });
    });

    document.querySelectorAll("#cam-rail [data-layer]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const layer = btn.dataset.layer;
        if (layer === "gantt") {
          toggleGantt();
          return;
        }
        state.layers[layer] = !state.layers[layer];
        btn.classList.toggle("on", !!state.layers[layer]);
        if (layer === "hud") {
          document.body.classList.toggle("hud-hidden", !!state.layers.hud);
        }
        if (typeof state.callbacks.onToggleLayer === "function") {
          state.callbacks.onToggleLayer(layer, !!state.layers[layer]);
        }
      });
    });

    // Quick search input & dropdown
    const searchIn = $("quick-search");
    const searchDrop = $("search-results");
    if (searchIn && searchDrop) {
      const updateSearch = () => {
        const q = searchIn.value.trim().toLowerCase();
        state.searchQuery = q;
        renderRoster(state.replay, state.t);
        if (!q || !state.replay) {
          searchDrop.classList.add("hidden");
          return;
        }
        const items = [];
        (state.replay.ships || []).forEach((s, idx) => {
          if (s.name.toLowerCase().includes(q) || String(s.line || "").toLowerCase().includes(q)) {
            items.push({ type: "ship", idx, label: s.name, sub: (s.line || "") + " · Sec " + s.first_section });
          }
        });
        computeCraneStatuses(state.replay, state.t).forEach((c) => {
          if (c.code.toLowerCase().includes(q) || "crane".includes(q)) {
            items.push({ type: "crane", idx: c.idx, label: c.code, sub: c.status });
          }
        });
        if (!items.length) {
          searchDrop.classList.add("hidden");
          return;
        }
        searchDrop.innerHTML = "";
        items.slice(0, 8).forEach((it) => {
          const row = document.createElement("div");
          row.className = "search-item";
          row.innerHTML = "<strong>" + it.label + "</strong><span class='search-item-sub'>" + it.sub + "</span>";
          row.addEventListener("click", () => {
            if (it.type === "ship") selectShip(it.idx, state.replay, state.t);
            else selectCrane(it.idx, null, state.replay, state.t);
            searchDrop.classList.add("hidden");
          });
          searchDrop.appendChild(row);
        });
        searchDrop.classList.remove("hidden");
      };
      searchIn.addEventListener("input", updateSearch);
      searchIn.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          searchIn.value = "";
          state.searchQuery = "";
          searchDrop.classList.add("hidden");
          searchIn.blur();
          renderRoster(state.replay, state.t);
        }
      });
    }

    // Global keyboard shortcuts (Cmd+K, /, G, T, V, N, H, Escape)
    window.addEventListener("keydown", (e) => {
      const src = (e.composedPath && e.composedPath()[0]) || e.target;
      const inInput = ["INPUT", "TEXTAREA", "SELECT", "DEEP-CHAT"].includes((src && src.tagName) || "") || !!(src && src.isContentEditable) ||
        ((e.target && e.target.tagName) || "") === "DEEP-CHAT";
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (searchIn) { searchIn.focus(); searchIn.select(); }
        return;
      }
      if (inInput) return;
      if (e.key === "/") {
        e.preventDefault();
        if (searchIn) { searchIn.focus(); searchIn.select(); }
      } else if (e.key.toLowerCase() === "g") {
        e.preventDefault();
        toggleGantt();
      } else if (e.key.toLowerCase() === "t") {
        const b = document.querySelector('#cam-rail [data-layer="ais"]');
        if (b) b.click();
      } else if (e.key.toLowerCase() === "v") {
        const b = document.querySelector('#cam-rail [data-layer="trucks"]');
        if (b) b.click();
      } else if (e.key.toLowerCase() === "n") {
        const b = document.querySelector('#cam-rail [data-layer="night"]');
        if (b) b.click();
      } else if (e.key.toLowerCase() === "h") {
        const b = document.querySelector('#cam-rail [data-layer="hud"]');
        if (b) b.click();
      } else if (e.key === "Escape") {
        if (closeBtn) closeBtn.click();
      }
    });

    return window.OakControlPanel;
  }

  function setScenarioList(scenarios, activeKey, planKey) {
    init();
    state.scenarios = scenarios;
    if (activeKey) state.activeScenarioKey = activeKey;
    if (planKey) state.activePlanKey = planKey;
    const sel = $("scenario-select");
    if (sel && Array.isArray(scenarios) && scenarios.length) {
      sel.innerHTML = "";
      scenarios.forEach((sc) => {
        const opt = document.createElement("option");
        opt.value = sc.key || sc.id || sc.value;
        opt.textContent = sc.label || sc.title || sc.name || opt.value;
        sel.appendChild(opt);
      });
      if (activeKey) sel.value = activeKey;
    }
    document.querySelectorAll("#plan-switcher [data-plan]").forEach((b) => {
      b.classList.toggle("on", b.dataset.plan === state.activePlanKey);
    });
  }

  function setReplay(replay, planKey, baselineReplays) {
    init();
    if (!replay) return;
    state.replay = replay;
    if (planKey) state.activePlanKey = planKey;
    if (baselineReplays) state.baselineReplays = baselineReplays;
    const taskId = (replay.task && replay.task.task_id) || state.activeScenarioKey;
    if (!state.baseReplayCache.has(taskId)) {
      state.baseReplayCache.set(taskId, JSON.parse(JSON.stringify(replay)));
    }
    document.querySelectorAll("#plan-switcher [data-plan]").forEach((b) => {
      b.classList.toggle("on", b.dataset.plan === state.activePlanKey);
    });
    renderScrubMarkers(replay);
    updateAtHour(replay, state.t || 0, state.extra);
  }

  function updateAtHour(replay, t, extra) {
    init();
    if (replay) state.replay = replay;
    if (typeof t === "number") state.t = t;
    if (extra) state.extra = extra;
    if (!state.replay) return;

    renderTopBar(state.replay, state.t);
    renderKpis(state.replay, state.t);
    renderCraneStrip(state.replay, state.t);
    renderAlerts(state.replay, state.t);
    renderRoster(state.replay, state.t);
    if (state.inspectorMode) renderInspector(state.replay, state.t);
    if (state.ganttOpen) renderGantt(state.replay, state.t);
  }

  function selectShip(idx, replay, t) {
    init();
    if (replay) state.replay = replay;
    if (typeof t === "number") state.t = t;
    state.inspectorMode = "ship";
    state.selectedShipIdx = idx;
    state.selectedCraneIdx = null;
    renderRoster(state.replay, state.t);
    renderCraneStrip(state.replay, state.t);
    renderInspector(state.replay, state.t);
    if (state.ganttOpen) renderGantt(state.replay, state.t);

    if (typeof state.callbacks.onSelectShip === "function") {
      state.callbacks.onSelectShip(idx);
    } else {
      // Trigger legacy #ships row click so unmodified viewer.js flies the 3D camera to the ship
      const rows = document.querySelectorAll("#ships tbody tr");
      if (rows[idx]) rows[idx].click();
    }
  }

  function selectCrane(idx, status, replay, t) {
    init();
    if (replay) state.replay = replay;
    if (typeof t === "number") state.t = t;
    state.inspectorMode = "crane";
    state.selectedCraneIdx = idx;
    state.selectedShipIdx = null;
    renderRoster(state.replay, state.t);
    renderCraneStrip(state.replay, state.t);
    renderInspector(state.replay, state.t);
    if (typeof state.callbacks.onSelectCrane === "function") {
      state.callbacks.onSelectCrane(idx, status);
    }
  }

  function toggleGantt(force) {
    init();
    state.ganttOpen = typeof force === "boolean" ? force : !state.ganttOpen;
    state.layers.gantt = state.ganttOpen;
    const drawer = $("gantt-drawer");
    if (drawer) drawer.classList.toggle("collapsed", !state.ganttOpen);
    const railBtn = $("rail-gantt-btn");
    if (railBtn) railBtn.classList.toggle("on", state.ganttOpen);
    const chev = document.querySelector("#gantt-toggle-btn .gantt-chevron");
    if (chev) chev.textContent = state.ganttOpen ? "▼" : "▲";
    if (state.ganttOpen && state.replay) {
      requestAnimationFrame(() => renderGantt(state.replay, state.t));
    }
    return state.ganttOpen;
  }

  // Hooks invoked automatically by OakKPI when viewer.js runs unmodified
  function _onKpiSeries(rep) {
    if (!state.externalDriven) {
      setReplay(rep, state.activePlanKey);
    }
  }

  function _onKpiAt(rep, t) {
    if (!state.externalDriven && Math.abs(t - state.t) > 1e-4) {
      updateAtHour(rep, t);
    } else if (!state.externalDriven && state.replay !== rep) {
      updateAtHour(rep, t);
    }
  }

  window.OakControlPanel = {
    init,
    setScenarioList,
    setReplay,
    updateAtHour,
    selectShip,
    selectCrane,
    toggleGantt,
    _onKpiSeries,
    _onKpiAt,
  };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => init());
    } else {
      init();
    }
  }
})();
