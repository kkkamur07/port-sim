/*
 * Oakland berth replay KPIs: pure functions over a replay JSON (docs/replay_schema.md), no DOM, no THREE.
 *
 * window.OakKPI.at(replay, t) -> how the port is being operated at hour t (berth occupancy, cranes, ship counts,
 * moves done, wait/turnaround times, ILWU shift multiplier, lateness, cost accrued so far, and reward delta).
 * window.OakKPI.series(replay) -> hourly arrays for the sparkline.
 *
 * Classic script; also loads under node with `global.window = {}` for testing.
 */
(function () {
  "use strict";

  const MOVE_PENALTY = 5;

  function sectionCount(rep) {
    const task = (rep && rep.task) || {};
    if (typeof rep.quay_length_m === "number" && rep.quay_length_m > 0) {
      const secM = task.section_m || 42;
      return Math.max(1, Math.round(rep.quay_length_m / secM));
    }
    const n = (task.last_section || 0) - (task.first_section || 1) + 1;
    if (n > 0) return n;
    let m = 1;
    for (const s of (rep && rep.ships) || []) {
      const first = s.first_section || 1;
      const secs = s.sections || Math.max(1, Math.round((s.length_m || 250) / 42));
      m = Math.max(m, first + secs - 1);
    }
    return m;
  }

  function horizon(rep) {
    if (!rep) return 168;
    if (rep.horizon_h) return rep.horizon_h;
    if (rep.horizon_hours) return rep.horizon_hours;
    let m = 24;
    for (const s of rep.ships || []) {
      const dep = s.departure != null ? s.departure : s.berth_end || 24;
      m = Math.max(m, dep + 2);
    }
    return m;
  }

  function poolAt(rep, h) {
    for (const [hh, c] of (rep && rep.crane_pool_by_hour) || []) if (hh === h) return c;
    const r = (rep && rep.task && rep.task.rules) || {};
    if (r.crane_pool) {
      if (isHoot(rep, h) && r.hoot_pool != null) return r.hoot_pool;
      return r.crane_pool;
    }
    return (rep && rep.num_cranes) || 0;
  }

  function shipCranesAt(s, h) {
    if (Array.isArray(s.cranes_by_hour)) {
      for (const pair of s.cranes_by_hour) {
        if (Array.isArray(pair) && pair[0] === h) return pair[1];
      }
      return 0;
    }
    const bStart = s.berth_hour != null ? s.berth_hour : s.berth_start;
    const bEnd = s.departure != null ? s.departure : s.berth_end;
    if (h >= bStart && h < bEnd) return s.cranes || s.cranes_assigned || 0;
    return 0;
  }

  function cranesAt(rep, h) {
    let n = 0;
    for (const s of (rep && rep.ships) || []) {
      n += shipCranesAt(s, h);
    }
    return n;
  }

  function taskShip(rep, id) {
    const ts = (rep && rep.task && rep.task.ships) || [];
    return ts.find((x) => x.id === id) || ts[id] || {};
  }

  function isHoot(rep, h) {
    const r = (rep && rep.task && rep.task.rules) || {};
    const hoot = (r.shifts && r.shifts.hoot) || [3, 8];
    const hd = ((h % 24) + 24) % 24;
    return hd >= hoot[0] && hd < hoot[1];
  }

  function shiftAt(rep, t) {
    const h = Math.floor(t);
    const hd = ((h % 24) + 24) % 24;
    const r = (rep && rep.task && rep.task.rules) || {};
    const baseMph = r.moves_per_crane_hour || 26;
    if (hd === 12 || hd === 17 || hd === 22) {
      const mealStop = hd === 17;
      return {
        code: "MEAL",
        label: "MEAL 0.50×",
        multiplier: 0.5,
        gross_mph: +(baseMph * (mealStop ? 0.0 : 0.5)).toFixed(1),
        effective_mph: +(baseMph * 0.5).toFixed(1),
        hour_of_day: hd,
        is_meal_stop: mealStop,
      };
    }
    if (hd >= 3 && hd < 8) {
      return {
        code: "HOOT",
        label: "HOOT 0.85×",
        multiplier: 0.85,
        gross_mph: +(baseMph * 0.85).toFixed(1),
        effective_mph: +(baseMph * 0.85).toFixed(1),
        hour_of_day: hd,
        is_meal_stop: false,
      };
    }
    if (hd >= 8 && hd < 17) {
      return {
        code: "DAY",
        label: "DAY 1.00×",
        multiplier: 1.0,
        gross_mph: +baseMph.toFixed(1),
        effective_mph: +baseMph.toFixed(1),
        hour_of_day: hd,
        is_meal_stop: false,
      };
    }
    return {
      code: "NIGHT",
      label: "NIGHT 0.96×",
      multiplier: 0.96,
      gross_mph: +(baseMph * 0.96).toFixed(1),
      effective_mph: +(baseMph * 0.96).toFixed(1),
      hour_of_day: hd,
      is_meal_stop: false,
    };
  }

  function workDone(s, t) {
    let w = 0;
    if (Array.isArray(s.cranes_by_hour) && s.cranes_by_hour.length) {
      for (const [h, c] of s.cranes_by_hour) {
        if (t >= h + 1) w += c;
        else if (t > h) w += c * (t - h);
      }
      return w;
    }
    const bStart = s.berth_hour != null ? s.berth_hour : s.berth_start || 0;
    const bEnd = s.departure != null ? s.departure : s.berth_end || bStart + 1;
    const c = s.cranes || s.cranes_assigned || 1;
    if (t <= bStart) return 0;
    return Math.min(bEnd - bStart, t - bStart) * c;
  }

  function progress(rep, s, t) {
    const ts = taskShip(rep, s.id);
    const bStart = s.berth_hour != null ? s.berth_hour : s.berth_start || 0;
    const bEnd = s.departure != null ? s.departure : s.berth_end || bStart + 1;
    if (t <= bStart) return 0;
    if (t >= bEnd) return 1;
    let total = ts.workload;
    if (!(total > 0)) total = workDone(s, Infinity);
    if (total > 0) return Math.min(1, workDone(s, t) / total);
    return Math.min(1, (t - bStart) / Math.max(1, bEnd - bStart));
  }

  function shipMovesTotal(rep, s) {
    const ts = taskShip(rep, s.id);
    const mpch = (rep && rep.task && rep.task.rules && rep.task.rules.moves_per_crane_hour) || 26;
    if (s.moves_total > 0) return Math.round(s.moves_total);
    if (s.moves > 0) return Math.round(s.moves);
    if (ts.workload > 0) return Math.round(ts.workload * mpch);
    const w = workDone(s, Infinity);
    if (w > 0) return Math.round(w * mpch);
    return Math.round(((s.sections || 6) * 220));
  }

  function lateSoFar(s, t) {
    const lateH = s.late_h != null ? s.late_h : Math.max(0, (s.departure || s.berth_end || 0) - (s.due || s.etd_hour || Infinity));
    if (!(lateH > 0)) return 0;
    const dep = s.departure != null ? s.departure : s.berth_end || 0;
    const due = s.due != null ? s.due : dep - lateH;
    return Math.max(0, Math.min(Math.min(t, dep) - due, lateH));
  }

  function costSoFar(rep, t) {
    const task = (rep && rep.task) || {};
    const crane = task.kind === "crane";
    const rate = crane ? Number((task.rules && task.rules.hoot_gang_cost) ?? 2) : 0;
    let cost = 0;
    for (const s of (rep && rep.ships) || []) {
      const ts = taskShip(rep, s.id);
      const bStart = s.berth_hour != null ? s.berth_hour : s.berth_start || 0;
      const secs = ts.sections || s.sections || Math.max(1, Math.round((s.length_m || 250) / 42));
      cost += secs * lateSoFar(s, t) * (ts.weight ?? 1);
      if (t >= bStart) {
        if (ts.berth_deadline != null && bStart > ts.berth_deadline) {
          cost += (ts.deadline_penalty || 0) * (bStart - ts.berth_deadline);
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
    let movesDone = 0, movesTotal = 0;
    let waitSum = 0, waitCount = 0, turnSum = 0, turnCount = 0;

    for (const s of (rep && rep.ships) || []) {
      const arr = s.arrival != null ? s.arrival : s.eta_hour || 0;
      const bStart = s.berth_hour != null ? s.berth_hour : s.berth_start || arr;
      const dep = s.departure != null ? s.departure : s.berth_end || bStart + 12;
      const due = s.due != null ? s.due : s.etd_hour != null ? s.etd_hour : dep;
      const secs = s.sections || Math.max(1, Math.round((s.length_m || 250) / 42));

      if (t < arr) atSea++;
      else if (t < bStart) anchored++;
      else if (t < dep) { alongside++; occupied += secs; }
      else departed++;

      const l = lateSoFar(s, t);
      const lateH = s.late_h != null ? s.late_h : Math.max(0, dep - due);
      if (lateH > 0 && t > due) lateShips++;
      lateHours += l;

      const mTot = shipMovesTotal(rep, s);
      const p = progress(rep, s, t);
      movesTotal += mTot;
      movesDone += Math.round(mTot * p);

      if (t >= arr) {
        const w = Math.max(0, Math.min(t, bStart) - arr);
        waitSum += w;
        waitCount++;
      }
      if (t >= bStart) {
        const turn = Math.max(0, Math.min(t, dep) - arr);
        turnSum += turn;
        turnCount++;
      }
    }

    const gr = (rep && rep.grade) || {};
    const ref = (rep && rep.task && rep.task.reference) || {};
    const sh = shiftAt(rep, t);
    const out = {
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
      moves_done: movesDone,
      moves_total: movesTotal,
      avg_wait_h: waitCount ? +(waitSum / waitCount).toFixed(1) : 0,
      avg_turn_h: turnCount ? +(turnSum / turnCount).toFixed(1) : 0,
      shift: sh,
      cost_so_far: costSoFar(rep, t),
      cost_final: gr.cost != null ? gr.cost : null,
      optimal_cost: gr.optimal_cost != null ? gr.optimal_cost : ref.optimal_cost != null ? ref.optimal_cost : null,
      greedy_cost: gr.greedy_cost != null ? gr.greedy_cost : ref.greedy_cost != null ? ref.greedy_cost : null,
      naive_cost: gr.naive_cost != null ? gr.naive_cost : ref.naive_cost != null ? ref.naive_cost : null,
      reward: typeof gr.reward === "number" ? gr.reward : null,
      feasible: gr.feasible != null ? gr.feasible : null,
    };

    if (typeof window !== "undefined" && window.OakControlPanel && typeof window.OakControlPanel._onKpiAt === "function") {
      try {
        window.OakControlPanel._onKpiAt(rep, t, out);
      } catch (_e) {
        /* ignore hook errors */
      }
    }
    return out;
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
    if (typeof window !== "undefined" && window.OakControlPanel && typeof window.OakControlPanel._onKpiSeries === "function") {
      try {
        window.OakControlPanel._onKpiSeries(rep, out);
      } catch (_e) {
        /* ignore hook errors */
      }
    }
    return out;
  }

  window.OakKPI = { at, series, progress, horizon, shiftAt, shipMovesTotal, shipCranesAt };
})();
