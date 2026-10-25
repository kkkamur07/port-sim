/* Mirrors oakland/dashboard/runs.js on branch oak/demo (copied verbatim, keep in sync). */
/*
 * Oakland loop run builders: pure functions turning the files of a runs/<run>/ directory (oakland/loop) into what
 * the dashboard draws. No DOM. Every field is optional: rows written by older or newer loops (front, wins,
 * merged_from, minibatch rejects with a null eval_mean, ...) must not break anything.
 *
 * Exported as window.OakRuns in the browser and as CommonJS under node:
 *   parseJSONL(text)                  -> rows (blank and broken lines skipped)
 *   verdictClass(row)                 -> "baseline" | "accepted" | "rejected" | "overfit" | "minibatch"
 *   evolution(evalRows)               -> baseline, accepted lineage step values per round, candidate points
 *   coachRounds(evalRows)             -> candidate rounds, newest first, with before/after and per-task deltas
 *   currentPlaybook(evalRows, tree)   -> {version, previous}: the accepted version in force and its accepted parent
 *   playbookDiff(prevText, curText)   -> lines of the current text, each flagged added or not (line LCS)
 *   roundMarkers(evalRows, episodes)  -> one marker per coach round at the episode after which it ran
 *   movingAverage(values, n)          -> trailing mean of up to n values, nulls skipped
 *   runHeader(episodes, evalRows)     -> latest episode, playbook in force, total model cost in USD
 *   uiText(text)                      -> loop wording for the UI: eval -> verification, train -> episode
 */
(function (root) {
  "use strict";

  const COLORS = {
    accepted: "#5ad48a",
    rejected: "#ff5a5a",
    overfit: "#f2a93b",
    minibatch: "#8796a8",
    baseline: "#8796a8",
  };
  const BADGES = { accepted: "ACCEPTED", rejected: "REJECTED", overfit: "OVERFIT", minibatch: "MINIBATCH", baseline: "BASELINE" };

  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  function parseJSONL(text) {
    const out = [];
    for (const line of String(text || "").split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        if (o && typeof o === "object") out.push(o);
      } catch (e) {
        // a half-written last line while the loop is appending: skip it, the next poll will have it whole
      }
    }
    return out;
  }

  // Nothing is trained: the UI says "verification" for the held-out pack and "episode" for the played window.
  function uiText(text) {
    return String(text || "")
      .replace(/\beval(uation)?\b/g, "verification").replace(/\bEval(uation)?\b/g, "Verification")
      .replace(/\btrain(ing)?\b/g, "episode").replace(/\bTrain(ing)?\b/g, "Episode");
  }

  function verdictClass(row) {
    if (!row) return "rejected";
    if (row.role === "baseline") return "baseline";
    const reason = String(row.reason || "").toLowerCase();
    if (reason.startsWith("overfit")) return "overfit";
    if (reason.startsWith("minibatch")) return "minibatch";
    return row.verdict === "accepted" ? "accepted" : "rejected";
  }

  function isCandidate(row) {
    return row && row.role !== "baseline" && !(row.coach_round === undefined && row.parent === null);
  }

  // Candidate rounds in loop order: coach_round, then version.
  function candidates(rows) {
    return (rows || []).filter(isCandidate).map((r, i) => ({ r: r, i: i })).sort((a, b) => {
      const ra = num(a.r.coach_round), rb = num(b.r.coach_round);
      if (ra !== rb) return (ra === null ? Infinity : ra) - (rb === null ? Infinity : rb);
      const va = num(a.r.version), vb = num(b.r.version);
      if (va !== vb) return (va === null ? 0 : va) - (vb === null ? 0 : vb);
      return a.i - b.i;
    }).map((x) => x.r);
  }

  function baselineRow(rows) {
    return (rows || []).find((r) => r && r.role === "baseline") || null;
  }

  function roundOf(row, i) {
    const r = num(row.coach_round);
    return r === null ? i + 1 : r;
  }

  function evolution(rows) {
    const base = baselineRow(rows);
    const baseline = base ? num(base.eval_mean) : null;
    const cands = candidates(rows);
    const nRounds = cands.reduce((m, r, i) => Math.max(m, roundOf(r, i)), 0);
    const points = cands.map((r, i) => {
      const cls = verdictClass(r);
      return {
        round: roundOf(r, i),
        version: r.version,
        parent: r.parent === undefined ? null : r.parent,
        cls: cls,
        color: COLORS[cls],
        verdict: r.verdict || null,
        reason: uiText(r.reason),
        change: uiText(r.change),
        eval: num(r.eval_mean),
        train: num(r.train_mean),
      };
    });
    // the value in force after each round: the last accepted eval mean so far (baseline before any acceptance)
    const lineage = [{ round: 0, value: baseline, version: base ? base.version : 0 }];
    let cur = baseline, curV = base ? base.version : 0;
    for (let k = 1; k <= nRounds; k++) {
      for (const p of points) {
        if (p.round === k && p.cls === "accepted" && p.eval !== null) {
          cur = p.eval;
          curV = p.version;
        }
      }
      lineage.push({ round: k, value: cur, version: curV });
    }
    return { baseline: baseline, rounds: nRounds, lineage: lineage, points: points };
  }

  function coachRounds(rows) {
    const byVersion = {};
    for (const r of rows || []) if (r && r.version !== undefined) byVersion[r.version] = r;
    const cands = candidates(rows);
    const list = cands.map((r, i) => {
      const cls = verdictClass(r);
      const parent = r.parent === undefined ? null : r.parent;
      const prow = parent !== null ? byVersion[parent] : null;
      const before = {};
      for (const t of (prow && prow.per_task) || []) if (t && t.task_id) before[t.task_id] = num(t.reward);
      return {
        round: roundOf(r, i),
        version: r.version,
        parent: parent,
        cls: cls,
        badge: BADGES[cls],
        color: COLORS[cls],
        reason: uiText(r.reason),
        change: uiText(r.change),
        diagnosis: uiText(r.diagnosis),
        evalBefore: num(r.current_eval_mean) !== null ? num(r.current_eval_mean) : prow ? num(prow.eval_mean) : null,
        evalAfter: num(r.eval_mean),
        trainBefore: num(r.current_train_mean),
        trainAfter: num(r.train_mean),
        cost: (num(r.coach_cost_usd) || 0) + (num(r.eval_cost_usd) || 0),
        perTask: ((r.per_task || []).filter((t) => t && t.task_id)).map((t) => {
          const b = before[t.task_id] === undefined ? null : before[t.task_id];
          const v = num(t.reward);
          return { task_id: t.task_id, reward: v, before: b, delta: v !== null && b !== null ? v - b : null };
        }),
      };
    });
    return list.reverse();
  }

  function currentPlaybook(rows, tree) {
    const nodes = tree && Array.isArray(tree.nodes) ? tree.nodes : [];
    const parentOf = {};
    let version = 0, found = false;
    const base = baselineRow(rows);
    if (base && base.version !== undefined) { version = base.version; found = true; }
    for (const r of candidates(rows)) {
      parentOf[r.version] = r.parent === undefined ? null : r.parent;
      if (verdictClass(r) === "accepted") { version = r.version; found = true; }
    }
    if (!found) {
      for (const n of nodes) if (n && n.verdict === "accepted" && num(n.version) !== null && n.version >= version) { version = n.version; found = true; }
    }
    for (const n of nodes) if (n && parentOf[n.version] === undefined) parentOf[n.version] = n.parent === undefined ? null : n.parent;
    const previous = parentOf[version] === undefined ? null : parentOf[version];
    return { version: version, previous: previous };
  }

  // Lines of curText, each {text, added}: added = not part of the longest common subsequence with prevText.
  function playbookDiff(prevText, curText) {
    const cur = String(curText || "").replace(/\r/g, "").split("\n");
    if (prevText === null || prevText === undefined) return cur.map((t) => ({ text: t, added: false }));
    const prev = String(prevText).replace(/\r/g, "").split("\n");
    const n = prev.length, m = cur.length;
    const L = [];
    for (let i = 0; i <= n; i++) L.push(new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i][j] = prev[i] === cur[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }
    const kept = new Array(m).fill(false);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (prev[i] === cur[j]) { kept[j] = true; i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) i++;
      else j++;
    }
    return cur.map((t, k) => ({ text: t, added: !kept[k] && t.trim() !== "" }));
  }

  // Each coach round runs after a window of training episodes. Use the row's own episode field when a loop writes
  // one; else walk the windows (train_per_task length); else spread the rounds evenly over the episodes.
  function roundMarkers(rows, episodes) {
    const cands = candidates(rows);
    const nEp = (episodes || []).reduce((m, e, i) => Math.max(m, num(e && e.episode) || i + 1), 0);
    const nR = cands.reduce((m, r, i) => Math.max(m, roundOf(r, i)), 0);
    const even = nR ? Math.max(1, Math.round(nEp / nR)) : 1;
    let cursor = 0, lastRound = 0;
    return cands.map((r, i) => {
      const round = roundOf(r, i);
      if (round !== lastRound) {
        const w = Array.isArray(r.train_per_task) && r.train_per_task.length ? r.train_per_task.length : even;
        cursor += w;
        lastRound = round;
      }
      const ep = num(r.episode) !== null ? num(r.episode) : num(r.after_episode) !== null ? num(r.after_episode) : cursor;
      const cls = verdictClass(r);
      return { episode: ep, round: round, version: r.version, cls: cls, color: COLORS[cls], label: "v" + r.version + " " + (cls === "accepted" ? "accepted" : cls) };
    });
  }

  function movingAverage(values, n) {
    const w = n || 3;
    return (values || []).map((_, i) => {
      const win = values.slice(Math.max(0, i - w + 1), i + 1).filter((v) => typeof v === "number" && isFinite(v));
      return win.length ? Math.round((win.reduce((a, b) => a + b, 0) / win.length) * 1000) / 1000 : null;
    });
  }

  function runHeader(episodes, rows) {
    const eps = episodes || [];
    const last = eps.length ? eps[eps.length - 1] : null;
    let cost = 0;
    for (const e of eps) cost += num(e && e.cost_usd) || 0;
    for (const r of rows || []) cost += (num(r && r.coach_cost_usd) || 0) + (num(r && r.eval_cost_usd) || 0);
    const pb = currentPlaybook(rows, null);
    const lastPb = last ? num(last.playbook_version) : null;
    return {
      episode: last ? (num(last.episode) !== null ? last.episode : eps.length) : 0,
      episodes: eps.length,
      playbook: (rows || []).length ? pb.version : lastPb !== null ? lastPb : 0,
      cost_usd: Math.round(cost * 10000) / 10000,
    };
  }

  const api = {
    COLORS: COLORS,
    BADGES: BADGES,
    parseJSONL: parseJSONL,
    verdictClass: verdictClass,
    evolution: evolution,
    coachRounds: coachRounds,
    currentPlaybook: currentPlaybook,
    playbookDiff: playbookDiff,
    roundMarkers: roundMarkers,
    movingAverage: movingAverage,
    runHeader: runHeader,
    uiText: uiText,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OakRuns = api;
})(typeof window !== "undefined" ? window : null);
