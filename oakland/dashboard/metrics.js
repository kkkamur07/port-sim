/*
 * Oakland port operations metrics: pure functions computing every dashboard number from replay JSON
 * (docs/replay_schema.md). No DOM, no rules recomputed: everything comes from the replay file.
 *
 * Exported as window.OakMetrics in the browser and as CommonJS under node:
 *   summary(replay)   -> KPI numbers for one replay
 *   series(replay)    -> per-hour series, hours 0..horizon_h inclusive
 *   shipRows(replay)  -> one row per ship for the table
 *   shifts(replay)    -> crane-hours by shift (day, night, hoot)
 *   events(replay)    -> notices, disruptions, no-move windows and blocks as a flat, time-sorted list
 *   episodes(list)    -> reward, gap, best so far and moving average of 3 across replays
 */
(function (root) {
  "use strict";

  const DEFAULT_SHIFTS = { day: [8, 17], night: [18, 27], hoot: [3, 8] };

  function num(v, d) {
    return typeof v === "number" && isFinite(v) ? v : d;
  }

  function round(v, digits) {
    if (v === null || !isFinite(v)) return null;
    const f = Math.pow(10, digits === undefined ? 1 : digits);
    return Math.round(v * f) / f;
  }

  function horizonOf(r) {
    return num(r.horizon_h, (r.crane_pool_by_hour || []).length || 168);
  }

  function sectionRange(r) {
    const t = r.task || {};
    const first = num(t.first_section, 1);
    let last = num(t.last_section, first);
    for (const s of r.ships || []) last = Math.max(last, num(s.first_section, first) + num(s.sections, 1) - 1);
    return { first: first, last: last, count: last - first + 1 };
  }

  // pool[h] = cranes available in hour h (replay crane_pool_by_hour, else the task crane_pool)
  function poolArray(r) {
    const H = horizonOf(r);
    const base = num(((r.task || {}).rules || {}).crane_pool, 0);
    const pool = new Array(H).fill(base);
    for (const p of r.crane_pool_by_hour || []) if (p[0] >= 0 && p[0] < H) pool[p[0]] = p[1];
    return pool;
  }

  function shipCranes(s) {
    let total = 0, max = 0;
    for (const c of s.cranes_by_hour || []) {
      total += c[1];
      max = Math.max(max, c[1]);
    }
    return { total: total, max: max };
  }

  function taskShip(r, id) {
    for (const s of (r.task || {}).ships || []) if (s.id === id) return s;
    return null;
  }

  function closedBlocks(r) {
    return (r.blocks || []).filter((b) => b.kind !== "shallow");
  }

  function movedFromPlan(r, s) {
    const t = taskShip(r, s.id);
    if (!t || t.planned_section === undefined || t.planned_section === null) return false;
    return t.planned_section !== s.first_section;
  }

  // Shift of an hour of the week. Night 18..27 wraps past midnight; the meal hour is its own slot.
  function shiftOf(r, h) {
    const rules = (r.task || {}).rules || {};
    const sh = rules.shifts || DEFAULT_SHIFTS;
    const meal = rules.meal_hours || [17];
    const hd = ((h % 24) + 24) % 24;
    if (meal.indexOf(hd) >= 0) return "meal";
    for (const name of ["day", "night", "hoot"]) {
      const w = sh[name];
      if (!w) continue;
      if ((hd >= w[0] && hd < w[1]) || (hd + 24 >= w[0] && hd + 24 < w[1])) return name;
    }
    return "other";
  }

  function summary(r) {
    const g = r.grade || {};
    const H = horizonOf(r);
    const ships = r.ships || [];
    const sec = sectionRange(r);
    const pool = poolArray(r);

    let onTime = 0, waitSum = 0, waitMax = 0, lateSum = 0, lateShips = 0, moved = 0, problems = 0;
    let usedSecH = 0, craneH = 0;
    for (const s of ships) {
      const wait = Math.max(0, num(s.berth_hour, 0) - num(s.arrival, 0));
      waitSum += wait;
      waitMax = Math.max(waitMax, wait);
      const late = Math.max(0, num(s.late_h, 0));
      lateSum += late;
      if (late > 0) lateShips++;
      else onTime++;
      if (movedFromPlan(r, s)) moved++;
      problems += (s.problems || []).length;
      const a = Math.max(0, num(s.berth_hour, 0));
      const b = Math.min(H, num(s.departure, a));
      if (b > a) usedSecH += (b - a) * num(s.sections, 1);
      craneH += shipCranes(s).total;
    }
    problems += (g.violations || []).length;

    let closedSecH = 0;
    for (const b of closedBlocks(r)) {
      const w = Math.min(sec.last, b.last) - Math.max(sec.first, b.first) + 1;
      const d = Math.min(H, b.end) - Math.max(0, b.start);
      if (w > 0 && d > 0) closedSecH += w * d;
    }
    const availSecH = sec.count * H - closedSecH;
    const poolH = pool.reduce((a, b) => a + b, 0);

    const cost = num(g.cost, null);
    const opt = num(g.optimal_cost, null);
    const n = ships.length;
    return {
      reward: num(g.reward, null),
      feasible: g.feasible === undefined ? null : !!g.feasible,
      cost: cost,
      optimal_cost: opt,
      gap_pct: cost !== null && opt ? round(((cost - opt) / opt) * 100, 1) : null,
      ships_served: n,
      on_time: onTime,
      on_time_pct: n ? round((onTime / n) * 100, 1) : null,
      late_ships: lateShips,
      avg_wait_h: n ? round(waitSum / n, 2) : null,
      max_wait_h: waitMax,
      avg_late_h: n ? round(lateSum / n, 2) : null,
      total_late_h: lateSum,
      occupancy_pct: availSecH > 0 ? round((usedSecH / availSecH) * 100, 1) : null,
      section_hours_used: usedSecH,
      section_hours_available: availSecH,
      crane_util_pct: poolH > 0 ? round((craneH / poolH) * 100, 1) : null,
      crane_hours: craneH,
      crane_hours_available: poolH,
      moved_ships: moved,
      problems: problems,
      horizon_h: H,
      sections: sec.count,
      terminal: (r.task || {}).terminal || "",
      task_id: (r.task || {}).task_id || "",
      shifts: shifts(r),
    };
  }

  function series(r) {
    const H = horizonOf(r);
    const pool = poolArray(r);
    const sec = sectionRange(r);
    const hours = [], occupied = [], occupancy = [], cranes = [], poolS = [], anchor = [], alongside = [];
    const craneAt = new Array(H + 1).fill(0);
    for (const s of r.ships || []) for (const c of s.cranes_by_hour || []) if (c[0] >= 0 && c[0] <= H) craneAt[c[0]] += c[1];
    const closed = closedBlocks(r);
    for (let h = 0; h <= H; h++) {
      let occ = 0, anc = 0, along = 0;
      for (const s of r.ships || []) {
        if (h >= s.berth_hour && h < s.departure) {
          occ += num(s.sections, 1);
          along++;
        } else if (h >= s.arrival && h < s.berth_hour) anc++;
      }
      let shut = 0;
      for (const b of closed) {
        if (h >= b.start && h < b.end) shut += Math.max(0, Math.min(sec.last, b.last) - Math.max(sec.first, b.first) + 1);
      }
      const avail = sec.count - shut;
      hours.push(h);
      occupied.push(occ);
      occupancy.push(avail > 0 ? round((occ / avail) * 100, 1) : 0);
      cranes.push(craneAt[h]);
      poolS.push(h < H ? pool[h] : pool[H - 1] || 0);
      anchor.push(anc);
      alongside.push(along);
    }
    return {
      hours: hours,
      sections_occupied: occupied,
      occupancy_pct: occupancy,
      cranes_working: cranes,
      crane_pool: poolS,
      ships_at_anchor: anchor,
      ships_alongside: alongside,
    };
  }

  function shipRows(r) {
    return (r.ships || []).map((s) => {
      const c = shipCranes(s);
      const t = taskShip(r, s.id) || {};
      return {
        id: s.id,
        name: s.name,
        line: s.line,
        length_m: s.length_m,
        first_section: s.first_section,
        last_section: s.first_section + num(s.sections, 1) - 1,
        planned_section: t.planned_section === undefined ? null : t.planned_section,
        arrival: s.arrival,
        berth_hour: s.berth_hour,
        wait_h: Math.max(0, s.berth_hour - s.arrival),
        departure: s.departure,
        due: s.due,
        late_h: Math.max(0, num(s.late_h, 0)),
        crane_hours: c.total,
        max_cranes: c.max,
        moved: movedFromPlan(r, s),
        problems: (s.problems || []).slice(),
      };
    });
  }

  function shifts(r) {
    const out = { day: 0, night: 0, hoot: 0, meal: 0, other: 0 };
    for (const s of r.ships || []) for (const c of s.cranes_by_hour || []) out[shiftOf(r, c[0])] += c[1];
    return out;
  }

  function events(r) {
    const t = r.task || {};
    const out = [];
    for (const n of t.notices || []) out.push({ kind: "notice", start: null, end: null, text: String(n) });
    for (const d of t.disruptions || []) {
      const where = d.first !== undefined ? ", sections " + d.first + "-" + d.last : "";
      out.push({ kind: "disruption", start: d.start, end: d.end, text: (d.label || d.kind) + where });
    }
    for (const n of r.no_moves || []) out.push({ kind: "no_moves", start: n.start, end: n.end, text: n.label || "no ship movements" });
    for (const b of r.blocks || []) {
      out.push({ kind: b.kind || "block", start: b.start, end: b.end, text: "sections " + b.first + "-" + b.last + ": " + (b.label || b.kind) });
    }
    for (const v of (r.grade || {}).violations || []) {
      out.push({ kind: "violation", start: null, end: null, text: typeof v === "string" ? v : (v.ship !== undefined ? "ship " + v.ship + ": " : "") + (v.problem || JSON.stringify(v)) });
    }
    for (const s of r.ships || []) for (const p of s.problems || []) out.push({ kind: "problem", start: null, end: null, text: s.name + ": " + p });
    const key = (e) => (e.start === null ? -1 : e.start);
    return out.sort((a, b) => key(a) - key(b));
  }

  function episodes(list) {
    const reward = [], gap = [], best = [], avg3 = [], labels = [];
    let bestSoFar = -Infinity;
    list.forEach((item, i) => {
      const r = item && item.replay ? item.replay : item;
      const s = summary(r);
      const rw = s.reward !== null ? s.reward : num(item && item.reward, null);
      reward.push(rw);
      gap.push(s.gap_pct);
      if (rw !== null) bestSoFar = Math.max(bestSoFar, rw);
      best.push(isFinite(bestSoFar) ? bestSoFar : null);
      const win = reward.slice(Math.max(0, i - 2)).filter((v) => v !== null);
      avg3.push(win.length ? round(win.reduce((a, b) => a + b, 0) / win.length, 3) : null);
      labels.push(item && item.episode !== undefined ? item.episode : i + 1);
    });
    return { episode: labels, reward: reward, gap: gap, best: best, avg3: avg3 };
  }

  const api = {
    summary: summary,
    series: series,
    shipRows: shipRows,
    shifts: shifts,
    events: events,
    episodes: episodes,
    shiftOf: shiftOf,
    sectionRange: sectionRange,
    horizonOf: horizonOf,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OakMetrics = api;
})(typeof window !== "undefined" ? window : null);
