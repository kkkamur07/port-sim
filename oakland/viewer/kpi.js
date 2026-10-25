/*
 * Oakland berth replay KPIs: pure functions over a replay JSON (docs/replay_schema.md), no DOM, no THREE.
 *
 * window.OakKPI.at(replay, t) -> how the port is being operated at hour t (berth occupancy, cranes, ship counts,
 * lateness and cost accrued so far). window.OakKPI.series(replay) -> hourly arrays for the sparkline.
 * Cost so far follows the kernel's price (oakland_core/check.py): sections x hours late x weight, plus emergency
 * berth-deadline penalties, plus MOVE_PENALTY per ship moved off its planned section (berth tasks), plus the hoot
 * gang cost per crane-hour worked in hoot hours (crane tasks). It accrues hour by hour and reaches the final cost at
 * the horizon. The ship calls in the demo fixtures are GENERATED, not real records.
 *
 * Classic script; also loads under node with `global.window = {}` for testing.
 */
(function () {
  "use strict";

  const MOVE_PENALTY = 5;

  function sectionCount(rep) {
    const task = rep.task || {};
    const n = (task.last_section || 0) - (task.first_section || 1) + 1;
    if (n > 0) return n;
    let m = 1;
    for (const s of rep.ships || []) m = Math.max(m, s.first_section + s.sections - 1);
    return m;
  }

  function horizon(rep) {
    if (rep.horizon_h) return rep.horizon_h;
    let m = 24;
    for (const s of rep.ships || []) m = Math.max(m, s.departure + 2);
    return m;
  }

  // crane pool at hour h: crane_pool_by_hour when present, else the rule's pool
  function poolAt(rep, h) {
    for (const [hh, c] of rep.crane_pool_by_hour || []) if (hh === h) return c;
    const r = (rep.task && rep.task.rules) || {};
    return r.crane_pool || 0;
  }

  function cranesAt(rep, h) {
    let n = 0;
    for (const s of rep.ships || []) {
      for (const [hh, c] of s.cranes_by_hour || []) if (hh === h) n += c;
    }
    return n;
  }

  function taskShip(rep, id) {
    const ts = (rep.task && rep.task.ships) || [];
    return ts.find((x) => x.id === id) || ts[id] || {};
  }

  function isHoot(rep, h) {
    const r = (rep.task && rep.task.rules) || {};
    const hoot = (r.shifts && r.shifts.hoot) || [3, 8];
    const hd = ((h % 24) + 24) % 24;
    return hd >= hoot[0] && hd < hoot[1];
  }

  // crane-hours worked on ship s before time t (partial hour counted pro rata)
  function workDone(s, t) {
    let w = 0;
    for (const [h, c] of s.cranes_by_hour || []) {
      if (t >= h + 1) w += c;
      else if (t > h) w += c * (t - h);
    }
    return w;
  }

  // fraction of the ship's work done at t: crane-hours over workload when known, else time between berth and departure
  function progress(rep, s, t) {
    const ts = taskShip(rep, s.id);
    if (t <= s.berth_hour) return 0;
    if (t >= s.departure) return 1;
    let total = ts.workload;
    if (!(total > 0)) total = workDone(s, Infinity);
    if (total > 0) return Math.min(1, workDone(s, t) / total);
    return Math.min(1, (t - s.berth_hour) / Math.max(1, s.departure - s.berth_hour));
  }

  function lateSoFar(s, t) {
    if (!(s.late_h > 0)) return 0;
    return Math.max(0, Math.min(Math.min(t, s.departure) - s.due, s.late_h));
  }

  function costSoFar(rep, t) {
    const task = rep.task || {};
    const crane = task.kind === "crane";
    const rate = crane ? Number((task.rules && task.rules.hoot_gang_cost) ?? 2) : 0;
    let cost = 0;
    for (const s of rep.ships || []) {
      const ts = taskShip(rep, s.id);
      cost += (ts.sections || s.sections) * lateSoFar(s, t) * (ts.weight ?? 1);
      if (t >= s.berth_hour) {
        if (ts.berth_deadline != null && s.berth_hour > ts.berth_deadline) {
          cost += (ts.deadline_penalty || 0) * (s.berth_hour - ts.berth_deadline);
        }
        if (!crane && ts.planned_section != null && s.first_section !== ts.planned_section) cost += MOVE_PENALTY;
      }
      if (rate) {
        for (const [h, c] of s.cranes_by_hour || []) {
          if (isHoot(rep, h)) cost += rate * c * Math.max(0, Math.min(1, t - h));
        }
      }
    }
    return Math.round(cost * 10) / 10;
  }

  function at(rep, t) {
    const h = Math.floor(t);
    const nSec = sectionCount(rep);
    let occupied = 0, alongside = 0, anchored = 0, atSea = 0, departed = 0, lateShips = 0, lateHours = 0;
    for (const s of rep.ships || []) {
      if (t < s.arrival) atSea++;
      else if (t < s.berth_hour) anchored++;
      else if (t < s.departure) { alongside++; occupied += s.sections; }
      else departed++;
      const l = lateSoFar(s, t);
      if (s.late_h > 0 && t > s.due) lateShips++;
      lateHours += l;
    }
    const gr = rep.grade || {};
    return {
      hour: h,
      occupancy: nSec ? Math.min(1, occupied / nSec) : 0,
      sections_occupied: occupied,
      sections: nSec,
      cranes_working: cranesAt(rep, h),
      cranes_pool: poolAt(rep, h),
      ships_at_sea: atSea,
      ships_alongside: alongside,
      ships_anchored: anchored,
      ships_departed: departed,
      late_ships: lateShips,
      late_ship_hours: Math.round(lateHours * 10) / 10,
      cost_so_far: costSoFar(rep, t),
      cost_final: gr.cost != null ? gr.cost : null,
      optimal_cost: gr.optimal_cost != null ? gr.optimal_cost : null,
      reward: typeof gr.reward === "number" ? gr.reward : null,
      feasible: gr.feasible != null ? gr.feasible : null,
    };
  }

  function series(rep) {
    const H = horizon(rep);
    const out = { hours: [], occupancy: [], cranes: [], pool: [], anchored: [] };
    for (let h = 0; h <= H; h++) {
      const k = at(rep, h);
      out.hours.push(h);
      out.occupancy.push(k.occupancy);
      out.cranes.push(k.cranes_working);
      out.pool.push(k.cranes_pool);
      out.anchored.push(k.ships_anchored);
    }
    return out;
  }

  window.OakKPI = { at, series, progress, horizon };
})();
