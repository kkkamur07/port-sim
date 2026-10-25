/*
 * Oakland port operations dashboard: "how well is the port being operated", from replay JSON files.
 *
 * Sources, in order: ?run=../runs/<name> (a live oakland/loop run directory, re-polled every 3 s unless &live=0),
 * ?replays=a.json,b.json (one replay per episode), ?manifest=episodes.json (the default), or
 * files dropped on the page / picked with "Load JSON". From file:// the browser cannot fetch, so the page falls back
 * to the embedded viewer fixtures (window.PORTSIM_FIXTURES). All numbers come from metrics.js (window.OakMetrics);
 * nothing here recomputes the port rules. Ship calls in the demo replays are GENERATED, not real records.
 */
(function () {
  "use strict";

  const M = window.OakMetrics;
  const C = window.OakCharts;
  const R = window.OakRuns;

  // Line colours shared with the 3D scene (primary livery colour per line).
  const LINE_COLORS = {
    "ONE": "#d6008f",
    "Maersk": "#42b0d5",
    "MSC": "#f5c518",
    "Evergreen": "#1d8a3a",
    "CMA CGM": "#0b3b8c",
    "Matson": "#0b3e8a",
    "COSCO": "#0a3d91",
    "Hapag-Lloyd": "#f26b1d",
    "Yang Ming": "#0a4a8a",
    "HMM": "#e60b2c",
    "Wan Hai": "#c8102e",
    "OOCL": "#1c3f95",
    "Zim": "#2a2a86",
    "Pasha": "#0a5c36",
  };
  const COL = {
    reward: "#4cc3ff",
    best: "#5ad48a",
    avg: "#c9a6ff",
    gap: "#f2a93b",
    occ: "#4cc3ff",
    cranes: "#5ad48a",
    pool: "#8796a8",
    anchor: "#f2a93b",
    along: "#4cc3ff",
    fog: "rgba(190, 205, 220, 0.13)",
  };

  const $ = (id) => document.getElementById(id);
  const state = { episodes: [], selected: 0, source: "", run: null };
  const POLL_MS = 3000;

  function lineColor(line) {
    if (LINE_COLORS[line]) return LINE_COLORS[line];
    let h = 0;
    for (const ch of String(line || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return "hsl(" + (h % 360) + ", 55%, 50%)";
  }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmt(v, digits, suffix) {
    if (v === null || v === undefined || !isFinite(v)) return "n/a";
    return (digits === undefined ? String(v) : Number(v).toFixed(digits)) + (suffix || "");
  }

  function message(text, isError) {
    const el = $("message");
    el.textContent = text || "";
    el.classList.toggle("hidden", !text);
    el.classList.toggle("error", !!isError);
  }

  // ---------- loading ----------

  function baseName(p) {
    return String(p).split(/[\\/]/).pop().replace(/\.json$/i, "");
  }

  function fixture(path) {
    const fx = window.PORTSIM_FIXTURES || {};
    return fx[baseName(path)] || null;
  }

  function fetchJSON(url) {
    return fetch(url, { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error(url + ": HTTP " + r.status);
      return r.json();
    });
  }

  // Fetch a replay, falling back to the embedded fixture of the same name (file:// or offline).
  function loadReplay(url) {
    return fetchJSON(url).catch((err) => {
      const f = fixture(url);
      if (f) return f;
      throw err;
    });
  }

  function isReplay(o) {
    return o && typeof o === "object" && !Array.isArray(o) && o.task && Array.isArray(o.ships);
  }

  function fromManifest(entries, baseUrl) {
    const items = entries.map((e, i) => {
      const rel = typeof e === "string" ? e : e.replay;
      const url = new URL(rel, baseUrl).href;
      return loadReplay(url).then((r) => ({
        episode: e.episode !== undefined ? e.episode : i + 1,
        label: e.label || baseName(rel),
        reward: e.reward,
        replay: r,
        src: rel,
      }));
    });
    return Promise.all(items);
  }

  function embeddedEpisodes() {
    const fx = window.PORTSIM_FIXTURES || {};
    return Object.keys(fx).map((k, i) => ({ episode: i + 1, label: k + " (embedded)", replay: fx[k], src: k }));
  }

  // ---------- run mode (?run=<dir>) ----------

  function fetchText(url, optional) {
    return fetch(url, { cache: "no-store" }).then((r) => {
      if (!r.ok) {
        if (optional) return "";
        throw new Error(url + ": HTTP " + r.status);
      }
      return r.text();
    }).catch((err) => {
      if (optional) return "";
      throw err;
    });
  }

  function runName(dir) {
    return String(dir).replace(/\/+$/, "").split("/").pop() || String(dir);
  }

  function startRun(dir, live) {
    const base = new URL(dir.replace(/\/+$/, "") + "/", location.href);
    state.run = { dir: dir, name: runName(dir), base: base, live: live, sig: "", rows: [], evalRows: [], tree: null, md: {}, replays: {}, follow: true };
    state.source = "run " + state.run.name;
    $("run-panels").classList.remove("hidden");
    pollRun();
  }

  function pollRun() {
    const run = state.run;
    const u = (p) => new URL(p, run.base).href;
    Promise.all([fetchText(u("episodes.jsonl")), fetchText(u("eval.jsonl"), true), fetchText(u("playbooks/tree.json"), true)])
      .then(([epText, evText, treeText]) => {
        const sig = epText.length + ":" + evText.length + ":" + treeText.length + ":" + epText.slice(-200) + evText.slice(-200);
        if (sig === run.sig) return null;
        run.rows = R.parseJSONL(epText);
        run.evalRows = R.parseJSONL(evText);
        try { run.tree = treeText ? JSON.parse(treeText) : null; } catch (e) { /* half-written: keep the last one */ }
        return loadRunData(run).then(() => {
          run.sig = sig;
          applyRun(run);
        });
      })
      .catch((err) => {
        if (!run.rows.length) message("Waiting for run " + run.name + ": " + err.message + (run.live ? " (retrying every 3 s)" : ""), !run.live);
      })
      .then(() => {
        if (run.live) setTimeout(pollRun, POLL_MS);
      });
  }

  // Replays and playbook texts are written once and never change: fetch each a single time.
  function loadRunData(run) {
    const u = (p) => new URL(p, run.base).href;
    const jobs = run.rows.map((row, i) => {
      const ep = row.episode !== undefined ? row.episode : i + 1;
      const rel = row.replay || "replays/ep" + String(ep).padStart(3, "0") + ".json";
      if (run.replays[rel]) return Promise.resolve();
      return fetchJSON(u(rel)).then((rep) => { run.replays[rel] = rep; }).catch(() => {});
    });
    const pb = R.currentPlaybook(run.evalRows, run.tree);
    for (const v of [pb.version, pb.previous]) {
      if (v === null || v === undefined || run.md[v] !== undefined) continue;
      jobs.push(fetchText(u("playbooks/v" + v + ".md"), true).then((t) => { if (t) run.md[v] = t; }));
    }
    return Promise.all(jobs);
  }

  function applyRun(run) {
    const list = [];
    run.rows.forEach((row, i) => {
      const ep = row.episode !== undefined ? row.episode : i + 1;
      const rel = row.replay || "replays/ep" + String(ep).padStart(3, "0") + ".json";
      const rep = run.replays[rel];
      if (!rep) return;
      const pv = row.playbook_version !== undefined && row.playbook_version !== null ? "playbook v" + row.playbook_version + ", " : "";
      list.push({ episode: ep, label: pv + (row.task_id || baseName(rel)), reward: row.reward, replay: rep, src: rel });
    });
    message("");
    if (!list.length) {
      message("Run " + run.name + " has started; waiting for its first graded episode.");
      renderRun();
      return;
    }
    const prevLen = state.episodes.length;
    const following = !prevLen || state.selected === prevLen - 1;
    list.sort((a, b) => a.episode - b.episode);
    state.episodes = list;
    if (following) state.selected = list.length - 1;
    const sel = $("episode");
    sel.innerHTML = list.map((e, i) => '<option value="' + i + '">' + esc("Episode " + e.episode + ": " + e.label) + "</option>").join("");
    sel.value = String(state.selected);
    render();
  }

  function money(v) {
    return "$" + (v >= 1 ? v.toFixed(2) : v.toFixed(3));
  }

  function wrap(text, width) {
    const out = [];
    let line = "";
    for (const w of String(text || "").split(/\s+/)) {
      if (!w) continue;
      if (line && (line + " " + w).length > width) { out.push(line); line = w; } else line = line ? line + " " + w : w;
    }
    if (line) out.push(line);
    return out.join("\n");
  }

  function delta(a, b) {
    if (a === null || b === null) return "";
    const d = b - a;
    const cls = d > 0.0005 ? "up" : d < -0.0005 ? "down" : "muted";
    return ' <span class="' + cls + '">(' + (d >= 0 ? "+" : "") + d.toFixed(3) + ")</span>";
  }

  function arrow(a, b) {
    return fmt(a, 3) + " \u2192 " + fmt(b, 3) + delta(a, b);
  }

  function renderRunHeader(run) {
    const h = R.runHeader(run.rows, run.evalRows);
    const cost = h.cost_usd > 0 ? ", model cost " + money(h.cost_usd) : "";
    $("subtitle").innerHTML = '<span class="live-dot' + (run.live ? "" : " off") + '" title="' + (run.live ? "live: polling every 3 s" : "not polling") + '"></span>' +
      esc("run " + run.name + ": episode " + h.episode + ", playbook v" + h.playbook + ", Gemini 4 Argon" + cost);
  }

  const VERDICT_LEGEND = [
    { cls: "accepted", name: "accepted" },
    { cls: "rejected", name: "rejected" },
    { cls: "overfit", name: "overfit" },
    { cls: "minibatch", name: "minibatch" },
  ];

  function renderEvolution(run) {
    const ev = R.evolution(run.evalRows);
    const present = {};
    for (const p of ev.points) present[p.cls] = true;
    const leg = [
      { name: "verification reward in force (accepted lineage)", color: COL.reward, kind: "line" },
      { name: "baseline", color: C.THEME.muted, kind: "dash" },
    ];
    for (const v of VERDICT_LEGEND) if (present[v.cls] || v.cls === "accepted" || v.cls === "rejected") leg.push({ name: v.name, color: R.COLORS[v.cls], kind: "dot" });
    leg.push({ name: "episode reward of the candidate (hollow)", color: C.THEME.muted, kind: "ring" });
    const points = ev.points.map((p) => Object.assign({}, p, {
      tip: "v" + p.version + " from v" + (p.parent === null ? "?" : p.parent) + ", round " + p.round + "\n" +
        R.BADGES[p.cls] + (p.reason ? ": " + wrap(p.reason, 56) : "") + "\n" +
        "verification reward " + fmt(p.eval, 3) + ", episode reward " + fmt(p.train, 3) +
        (p.change ? "\n\nchange:\n" + wrap(p.change, 56) : ""),
    }));
    C.evolution($("c-evo"), {
      height: 320, rounds: ev.rounds, baseline: ev.baseline, lineage: ev.lineage, points: points,
      lineColor: COL.reward, legend: leg, xLabel: "coach round (base = starting playbook v0)", yLabel: "reward",
    });
  }

  function renderEpisodeRewards(run) {
    const x = run.rows.map((r, i) => (r.episode !== undefined ? r.episode : i + 1));
    const rw = run.rows.map((r) => (typeof r.reward === "number" ? r.reward : null));
    const markers = R.roundMarkers(run.evalRows, run.rows).map((m) => ({ x: m.episode, label: m.label, color: m.color }));
    C.line($("c-epi"), {
      height: 230,
      series: [
        { name: "Episode reward", color: COL.reward, values: rw, x: x, points: true },
        { name: "Moving average (3)", color: COL.avg, values: R.movingAverage(rw, 3), x: x, width: 1.5 },
      ],
      markers: markers,
      legend: true,
      yMin: 0, yMax: 1,
      xLabel: "episode", yLabel: "reward",
      xFormat: (v) => "Episode " + v,
    });
  }

  function renderCoach(run) {
    const rounds = R.coachRounds(run.evalRows);
    const open = {};
    for (const d of $("coach").querySelectorAll("details[open]")) open[d.dataset.key] = true;
    $("coach-sub").textContent = rounds.length ? rounds.length + " rounds, " + rounds.filter((r) => r.cls === "accepted").length + " accepted, newest first" : "no coach round yet";
    $("coach").innerHTML = rounds.length ? rounds.map((r) => {
      const key = "v" + r.version + "-" + r.round;
      const bars = r.perTask.map((t) => {
        const h = Math.max(2, Math.round((t.reward || 0) * 30));
        const cls = t.delta === null ? "" : t.delta > 0.0005 ? "up" : t.delta < -0.0005 ? "down" : "";
        return '<i class="' + cls + '" style="height:' + h + 'px" title="' + esc(t.task_id + ": " + fmt(t.reward, 3) + (t.delta !== null ? " (" + (t.delta >= 0 ? "+" : "") + t.delta.toFixed(3) + " vs parent)" : "")) + '"></i>';
      }).join("");
      return '<li><div class="row1"><span class="badge" style="color:' + r.color + '">' + esc(r.badge) + '</span>' +
        '<span class="ver">v' + esc(r.version) + " from v" + esc(r.parent === null ? "?" : r.parent) + '</span><span class="muted small">round ' + esc(r.round) +
        (r.cost > 0 ? ", " + money(r.cost) : "") + "</span></div>" +
        (r.reason ? '<div class="reason muted small">' + esc(r.reason) + "</div>" : "") +
        '<div class="nums small"><span class="muted">verification reward</span><span>' + arrow(r.evalBefore, r.evalAfter) + "</span>" +
        '<span class="muted">episode reward</span><span>' + arrow(r.trainBefore, r.trainAfter) + "</span></div>" +
        (r.change ? '<div class="change">' + esc(r.change) + "</div>" : "") +
        (r.diagnosis ? '<details data-key="' + esc(key) + '"' + (open[key] ? " open" : "") + "><summary>diagnosis</summary><p>" + esc(r.diagnosis) + "</p></details>" : "") +
        (bars ? '<div class="strip" aria-label="verification reward per task">' + bars + "</div>" : "") +
        "</li>";
    }).join("") + '<li class="strip-legend muted small"><span class="sw" style="background:var(--ok)"></span>task better than parent' +
      '<span class="sw" style="background:var(--late)"></span>worse<span class="sw" style="background:var(--muted)"></span>same; bar height = verification reward per task</li>'
      : '<li class="muted">The coach runs every few episodes; its rounds appear here.</li>';
  }

  function inline(t) {
    return esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  }

  // Minimal markdown: headings, bullet and numbered lists, paragraphs. Added lines carry the "added" class.
  function markdown(lines) {
    const out = [];
    let list = null;
    const close = () => { if (list) { out.push("</" + list + ">"); list = null; } };
    for (const ln of lines) {
      const t = ln.text;
      const cls = ln.added ? ' class="added"' : "";
      let m;
      if (!t.trim()) { close(); continue; }
      if ((m = t.match(/^#{1,6}\s+(.*)$/))) { close(); out.push("<h4" + cls + ">" + inline(m[1]) + "</h4>"); }
      else if ((m = t.match(/^\s*[-*]\s+(.*)$/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push("<li" + cls + ">" + inline(m[1]) + "</li>"); }
      else if ((m = t.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push("<li" + cls + ">" + inline(m[1]) + "</li>"); }
      else { close(); out.push("<p" + cls + ">" + inline(t) + "</p>"); }
    }
    close();
    return out.join("");
  }

  function renderPlaybook(run) {
    const pb = R.currentPlaybook(run.evalRows, run.tree);
    $("pb-title").textContent = "Playbook v" + pb.version;
    const cur = run.md[pb.version];
    if (cur === undefined) {
      $("pb-sub").textContent = "";
      $("playbook").innerHTML = '<p class="muted">playbooks/v' + esc(pb.version) + ".md is not readable yet.</p>";
      return;
    }
    const prev = pb.previous === null ? null : run.md[pb.previous];
    // the panel title already names the version: drop the file's own "# Playbook v<k>" heading
    const lines = R.playbookDiff(prev === undefined ? null : prev, cur).filter((l, i) => !(i < 2 && /^#\s+playbook v\d+\s*$/i.test(l.text)));
    const added = lines.filter((l) => l.added).length;
    $("pb-sub").textContent = pb.previous === null ? "starting playbook, in force now" : "in force now, " + added + " lines added since v" + pb.previous;
    $("playbook").innerHTML = markdown(lines) + (added ? '<div class="pb-legend muted small"><span class="sw"></span>added since v' + esc(pb.previous) + "</div>" : "");
  }

  function renderRun() {
    const run = state.run;
    if (!run) return;
    renderRunHeader(run);
    renderEvolution(run);
    renderEpisodeRewards(run);
    renderCoach(run);
    renderPlaybook(run);
  }

  function start() {
    const q = new URLSearchParams(location.search);
    if (q.get("run")) {
      startRun(q.get("run"), q.get("live") !== "0");
      return;
    }
    const replays = q.get("replays");
    const manifest = q.get("manifest") || "episodes.json";
    let p;
    if (replays) {
      const list = replays.split(",").map((s) => s.trim()).filter(Boolean);
      state.source = list.length + " replay file(s) from ?replays=";
      p = Promise.all(list.map((u, i) => loadReplay(new URL(u, location.href).href).then((r) => ({ episode: i + 1, label: baseName(u), replay: r, src: u }))));
    } else {
      const murl = new URL(manifest, location.href).href;
      state.source = "manifest " + manifest;
      p = fetchJSON(murl)
        .then((entries) => fromManifest(entries, murl))
        .catch((err) => {
          const emb = embeddedEpisodes();
          if (!emb.length) throw err;
          state.source = "embedded demo fixtures (could not fetch " + manifest + ")";
          if (location.protocol === "file:") message("Opened from disk: showing the embedded demo replays. Serve the folder (python3 -m http.server) to read a manifest, or drop JSON files here.");
          return emb;
        });
    }
    p.then(setEpisodes).catch((err) => message("Could not load replays: " + err.message, true));
  }

  function setEpisodes(list) {
    list = list.filter((e) => isReplay(e.replay));
    if (!list.length) {
      message("No replay JSON found. Drop replay files or an episodes.json manifest on the page.", true);
      return;
    }
    list.sort((a, b) => a.episode - b.episode);
    state.episodes = list;
    state.selected = list.length - 1;
    const sel = $("episode");
    sel.innerHTML = list.map((e, i) => '<option value="' + i + '">' + esc("Episode " + e.episode + ": " + e.label) + "</option>").join("");
    sel.value = String(state.selected);
    render();
  }

  // Dropped or picked files: replay objects become episodes in file-name order; a manifest array is resolved
  // against the embedded fixtures by file name (dropped files have no folder to fetch from).
  function readFiles(files) {
    const reads = Array.from(files).map((f) => f.text().then((t) => ({ name: f.name, json: JSON.parse(t) })));
    Promise.all(reads).then((items) => {
      items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const replays = items.filter((it) => isReplay(it.json));
      const manifest = items.find((it) => Array.isArray(it.json));
      let list = replays.map((it, i) => ({ episode: i + 1, label: baseName(it.name), replay: it.json, src: it.name }));
      if (manifest) {
        const byName = {};
        for (const it of replays) byName[baseName(it.name)] = it.json;
        list = manifest.json.map((e, i) => {
          const rel = typeof e === "string" ? e : e.replay;
          return { episode: e.episode !== undefined ? e.episode : i + 1, label: e.label || baseName(rel), reward: e.reward, replay: byName[baseName(rel)] || fixture(rel), src: rel };
        });
      }
      state.source = "dropped files";
      message("");
      setEpisodes(list);
    }).catch((err) => message("Could not read the dropped files: " + err.message, true));
  }

  // ---------- rendering ----------

  function tile(label, value, sub, cls, spark) {
    return '<div class="tile ' + (cls || "") + '"><div class="tile-label">' + esc(label) + '</div><div class="tile-value">' + esc(value) + "</div>" +
      '<div class="tile-sub">' + esc(sub || "") + "</div>" + (spark ? '<canvas class="spark" data-spark="' + spark + '"></canvas>' : "") + "</div>";
  }

  function renderTiles(m, ep) {
    const t = [];
    t.push(tile("Reward", fmt(m.reward, 3), ep.reward.length > 1 ? "best " + fmt(Math.max.apply(null, ep.reward.filter((v) => v !== null)), 3) + " over " + ep.reward.length + " episodes" : "0 to 1, higher is better", "", "reward"));
    t.push(tile("Cost vs optimal", fmt(m.cost) + " / " + fmt(m.optimal_cost), m.gap_pct === null ? "" : "gap " + fmt(m.gap_pct, 1, " %"), m.gap_pct > 25 ? "warn" : "", "gap"));
    t.push(tile("On time", fmt(m.on_time_pct, 1, " %"), m.on_time + " of " + m.ships_served + " ships", m.on_time_pct < 80 ? "warn" : ""));
    t.push(tile("Avg wait at anchor", fmt(m.avg_wait_h, 1, " h"), "max " + fmt(m.max_wait_h, 0, " h")));
    t.push(tile("Quay occupancy", fmt(m.occupancy_pct, 1, " %"), m.section_hours_used + " of " + m.section_hours_available + " section-hours", "", "occ"));
    t.push(tile("Crane utilisation", fmt(m.crane_util_pct, 1, " %"), m.crane_hours + " of " + m.crane_hours_available + " crane-hours", "", "cranes"));
    t.push(tile("Late ship-hours", fmt(m.total_late_h, 0, " h"), m.late_ships + " late ships, avg " + fmt(m.avg_late_h, 1, " h") + " per ship", m.total_late_h > 0 ? "bad" : "good"));
    t.push(tile("Feasible", m.feasible === null ? "n/a" : m.feasible ? "Yes" : "No", m.problems + " problems, " + m.moved_ships + " ships moved from plan", m.feasible === false ? "bad" : "good"));
    $("tiles").innerHTML = t.join("");
  }

  function renderSparks(ep, se) {
    for (const c of document.querySelectorAll("canvas.spark")) {
      const k = c.dataset.spark;
      if (k === "reward") C.sparkline(c, ep.reward, COL.reward);
      else if (k === "gap") C.sparkline(c, ep.gap, COL.gap);
      else if (k === "occ") C.sparkline(c, se.occupancy_pct, COL.occ);
      else if (k === "cranes") C.sparkline(c, se.cranes_working, COL.cranes);
    }
  }

  function renderImprovement(ep) {
    const x = ep.episode;
    C.line($("c-reward"), {
      height: 230,
      series: [
        { name: "Reward", color: COL.reward, values: ep.reward, x: x, points: true, labels: true },
        { name: "Best so far", color: COL.best, values: ep.best, x: x, step: true, dash: true },
        { name: "Moving average (3)", color: COL.avg, values: ep.avg3, x: x, width: 1.5 },
      ],
      legend: true,
      yMin: 0, yMax: 1,
      xLabel: "episode", yLabel: "reward",
      xFormat: (v) => "Episode " + v,
    });
    C.line($("c-gap"), {
      height: 230,
      series: [{ name: "Cost gap to optimal", color: COL.gap, values: ep.gap, x: x, points: true, labels: true }],
      legend: true,
      yMin: 0,
      xLabel: "episode", yLabel: "gap %", ySuffix: " %",
      xFormat: (v) => "Episode " + v,
    });
  }

  function renderGantt(r, rows) {
    const sec = M.sectionRange(r);
    const H = M.horizonOf(r);
    const lines = [];
    const bars = rows.map((s) => {
      if (lines.indexOf(s.line) < 0) lines.push(s.line);
      return {
        first: s.first_section, last: s.last_section, start: s.berth_hour, end: s.departure, due: s.due,
        color: lineColor(s.line), label: s.name,
        tip: s.name + " (" + s.line + ")\nsections " + s.first_section + "-" + s.last_section + "\nberthed " + C.hourLabel(s.berth_hour) +
          ", leaves " + C.hourLabel(s.departure) + "\ndue " + C.hourLabel(s.due) + (s.late_h ? ", late " + s.late_h + " h" : ", on time"),
      };
    });
    const blocks = r.blocks || [];
    const leg = lines.map((l) => ({ name: l, color: lineColor(l), kind: "fill", stroke: "rgba(255, 255, 255, 0.45)" }));
    leg.push({ name: "late (after due hour)", color: "#ff4d4d", kind: "fill" });
    if (blocks.some((b) => b.kind !== "shallow")) leg.push({ name: "closed", color: "rgba(255, 110, 110, 0.55)", fill: "rgba(255, 90, 90, 0.10)", kind: "hatch" });
    if (blocks.some((b) => b.kind === "shallow")) leg.push({ name: "shallow", color: "rgba(120, 190, 255, 0.10)", kind: "fill", stroke: "rgba(120, 190, 255, 0.35)" });
    if ((r.no_moves || []).length) leg.push({ name: "fog, no moves", color: COL.fog, kind: "fill" });
    C.gantt($("c-gantt"), { first: sec.first, last: sec.last, horizon: H, bars: bars, blocks: blocks, fog: r.no_moves || [], legend: leg });
    const t = r.task || {};
    $("gantt-sub").textContent = (t.terminal || "") + " berths " + (t.quay || "") + ", " + sec.count + " sections of 42 m, " + H + " h horizon";
  }

  function renderHourly(r, se) {
    const fog = (r.no_moves || []).map((n) => ({ start: n.start, end: n.end, color: COL.fog, name: "fog, no moves" }));
    C.line($("c-occ"), {
      height: 220,
      series: [{ name: "Occupancy", color: COL.occ, values: se.occupancy_pct, x: se.hours, step: true, fill: "rgba(76, 195, 255, 0.14)" }],
      bands: fog, legend: true,
      xMin: 0, xMax: se.hours[se.hours.length - 1], yMin: 0, yMax: 100, xTicks: "hours", ySuffix: " %",
      xFormat: C.hourLabel,
    });
    C.line($("c-cranes"), {
      height: 220,
      series: [
        { name: "Cranes working", color: COL.cranes, values: se.cranes_working, x: se.hours, step: true, fill: "rgba(90, 212, 138, 0.14)" },
        { name: "Crane pool", color: COL.pool, values: se.crane_pool, x: se.hours, step: true, dash: true },
      ],
      bands: fog,
      xMin: 0, xMax: se.hours[se.hours.length - 1], yMin: 0, xTicks: "hours",
      xFormat: C.hourLabel,
    });
    C.line($("c-queue"), {
      height: 220,
      series: [
        { name: "Ships at anchor", color: COL.anchor, values: se.ships_at_anchor, x: se.hours, step: true },
        { name: "Ships alongside", color: COL.along, values: se.ships_alongside, x: se.hours, step: true },
      ],
      bands: fog,
      xMin: 0, xMax: se.hours[se.hours.length - 1], yMin: 0, xTicks: "hours",
      xFormat: C.hourLabel,
    });
  }

  function renderShifts(m) {
    C.bar($("c-shifts"), {
      height: 220,
      categories: ["Day", "Night", "Hoot"],
      series: [{ name: "Crane-hours", color: COL.cranes, values: [m.shifts.day, m.shifts.night, m.shifts.hoot] }],
      yLabel: "crane-hours",
    });
  }

  function renderTable(rows, m) {
    $("ships").querySelector("tbody").innerHTML = rows.map((s) => {
      const late = s.late_h > 0;
      const secs = s.first_section + "-" + s.last_section;
      return "<tr>" +
        '<td><span class="dot" style="background:' + lineColor(s.line) + '"></span>' + esc(s.name) + "</td>" +
        "<td>" + esc(s.line) + "</td>" +
        '<td class="n">' + esc(C.hourLabel(s.arrival)) + "</td>" +
        '<td class="n">' + esc(C.hourLabel(s.berth_hour)) + "</td>" +
        '<td class="n' + (s.wait_h > 0 ? " warn" : "") + '">' + s.wait_h + "</td>" +
        '<td class="n">' + esc(C.hourLabel(s.departure)) + "</td>" +
        '<td class="n">' + esc(C.hourLabel(s.due)) + "</td>" +
        '<td class="n' + (late ? " bad" : "") + '">' + s.late_h + "</td>" +
        '<td class="n">' + s.crane_hours + " (" + s.max_cranes + ")</td>" +
        "<td>" + esc(secs) + "</td>" +
        "<td>" + (s.moved ? '<span class="warn">from ' + esc(s.planned_section) + "</span>" : '<span class="muted">no</span>') + "</td>" +
        "<td>" + (s.problems.length ? '<span class="bad">' + esc(s.problems.join("; ")) + "</span>" : '<span class="muted">none</span>') + "</td>" +
        "</tr>";
    }).join("");
    $("ships-sub").textContent = m.ships_served + " ships, " + m.late_ships + " late, " + m.moved_ships + " moved from their planned section";
  }

  function renderEvents(r) {
    const ev = M.events(r);
    $("events").innerHTML = ev.length ? ev.map((e) => {
      const when = e.start === null ? "" : C.hourLabel(e.start) + (e.end !== null && e.end !== undefined ? " to " + C.hourLabel(Math.min(e.end, M.horizonOf(r))) : "");
      return '<li><span class="tag tag-' + esc(e.kind) + '">' + esc(e.kind.replace("_", " ")) + '</span><span class="when">' + esc(when) + '</span><span class="what">' + esc(e.text) + "</span></li>";
    }).join("") : '<li class="muted">No events.</li>';
  }

  function render() {
    const cur = state.episodes[state.selected];
    if (!cur) return;
    const r = cur.replay;
    const m = M.summary(r);
    const se = M.series(r);
    const rows = M.shipRows(r);
    const ep = M.episodes(state.episodes);
    if (!state.run) $("subtitle").textContent = "Episode " + cur.episode + " of " + state.episodes.length + ": " + cur.label + " (" + m.terminal + ", " + m.task_id + "), source: " + state.source;
    renderTiles(m, ep);
    renderSparks(ep, se);
    renderImprovement(ep);
    renderGantt(r, rows);
    renderHourly(r, se);
    renderShifts(m);
    renderTable(rows, m);
    renderEvents(r);
    if (state.run) renderRun();
  }

  // ---------- interaction ----------

  function initTooltip() {
    const tip = $("tip");
    const show = (ev) => {
      const c = ev.target;
      const text = c && c.tagName === "CANVAS" && c._hit ? c._hit(ev.offsetX, ev.offsetY) : null;
      if (!text) {
        tip.classList.add("hidden");
        return;
      }
      tip.textContent = text;
      tip.classList.remove("hidden");
      const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      const y = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
      tip.style.left = Math.max(8, x) + "px";
      tip.style.top = Math.max(8, y) + "px";
    };
    document.addEventListener("mousemove", show);
    document.addEventListener("click", show);
  }

  function initDrop() {
    const drop = $("drop");
    let depth = 0;
    window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; drop.classList.remove("hidden"); });
    window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) drop.classList.add("hidden"); });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      drop.classList.add("hidden");
      if (e.dataTransfer && e.dataTransfer.files.length) readFiles(e.dataTransfer.files);
    });
    $("file").addEventListener("change", (e) => { if (e.target.files.length) readFiles(e.target.files); });
  }

  $("episode").addEventListener("change", (e) => {
    state.selected = Number(e.target.value);
    render();
  });
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => (state.episodes.length ? render() : renderRun()), 120);
  });
  initTooltip();
  initDrop();
  start();
})();
