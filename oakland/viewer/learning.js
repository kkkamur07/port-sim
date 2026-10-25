/*
 * The right panel and run follow mode (window.OakLearning).
 *
 * Reads a loop run directory (episodes.json or episodes.jsonl, eval.jsonl, playbooks/tree.json) through
 * window.OakRuns. Two tabs: Operator (Port now at the current hour, the chat, actions on the selected ship) and
 * Results (Optimize my playbook, the result cards, the playbook versions curve). The newest episode plays.
 *   ?run=<path>     run directory, relative to the viewer page (default fixtures/run-demo)
 *   &live=0         do not poll (polling every 5 s is on whenever ?run= is given)
 * viewer.js calls start(api) once and onHour(replay, t) as the replay plays.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const R = () => window.OakRuns;
  const POLL_MS = 5000;
  const VERDICT_TEXT = { accepted: "ACCEPTED", rejected: "REJECTED", overfit: "OVERFIT", minibatch: "MINIBATCH", baseline: "BASELINE" };

  const S = {
    api: null,
    base: "fixtures/run-demo",
    live: false,
    episodes: [],
    evalRows: [],
    shownEpisode: null,
    shownReplay: null,
    started: false,
    lastHourKey: "",
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  function f2(v) { return typeof v === "number" && isFinite(v) ? v.toFixed(2) : "n/a"; }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

  function fetchText(url) {
    return fetch(url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(), { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
  }

  // episodes.json is the manifest the loop writes at the end; episodes.jsonl grows per episode and has every field
  function loadRun() {
    return Promise.all([
      fetchText(S.base + "/episodes.json"),
      fetchText(S.base + "/episodes.jsonl"),
      fetchText(S.base + "/eval.jsonl"),
      fetchText(S.base + "/playbooks/tree.json"),
    ]).then(([manifest, lines, evalText, treeText]) => {
      let tree = null;
      try { tree = treeText ? JSON.parse(treeText) : null; } catch (e) { tree = null; }
      const byEp = {};
      let list = [];
      if (manifest) {
        try { list = JSON.parse(manifest) || []; } catch (e) { list = []; }
      }
      for (const e of list) if (e && e.episode != null) byEp[e.episode] = Object.assign({}, e);
      for (const e of R().parseJSONL(lines)) {
        if (e && e.episode != null) byEp[e.episode] = Object.assign(byEp[e.episode] || {}, e);
      }
      const eps = Object.values(byEp).sort((a, b) => a.episode - b.episode);
      for (const e of eps) {
        if (e.playbook_version == null && e.label) {
          const m = /playbook v(\d+)/.exec(e.label);
          if (m) e.playbook_version = Number(m[1]);
        }
        if (!e.task_id && e.label) {
          const m = /(oak-[\w-]+)/.exec(e.label);
          if (m) e.task_id = m[1];
        }
        if (!e.replay) e.replay = "replays/ep" + String(e.episode).padStart(3, "0") + ".json";
      }
      return { tree: tree, episodes: eps, evalRows: evalText ? R().parseJSONL(evalText) : [], ok: manifest !== null || lines !== null || evalText !== null };
    });
  }

  function taskWords(id) {
    // oak-trapac-berth-storm-6 -> TraPac storm
    const m = /^oak-([a-z]+)-(berth|crane)-([a-z]+)/.exec(String(id || ""));
    if (!m) return "";
    const names = { oict: "OICT", trapac: "TraPac", everport: "Everport", matson: "Matson", ssa: "SSA" };
    return (names[m[1]] || m[1]) + " " + m[3];
  }

  // ---------- evolution front: playbook versions by round, y = verification score ----------
  function frontNodes() {
    const byV = {};
    const nodes = S.tree && Array.isArray(S.tree.nodes) ? S.tree.nodes : [];
    for (const n of nodes) if (n && num(n.version) !== null) byV[n.version] = Object.assign({}, n);
    for (const r of S.evalRows || []) {
      if (!r || num(r.version) === null) continue;
      const n = byV[r.version] || (byV[r.version] = { version: r.version });
      if (n.parent === undefined) n.parent = r.parent;
      if (n.eval_mean == null) n.eval_mean = r.eval_mean;
      if (n.change == null) n.change = r.change;
      if (n.merged_from == null) n.merged_from = r.merged_from;
      n.cls = R().verdictClass(r);
      if (r.front !== undefined) n.front = r.front;
    }
    const all = Object.values(byV);
    const verified = all.some((n) => num(n.eval_mean) !== null);
    return all.filter((n) => verified && (num(n.eval_mean) !== null || n.parent != null)).map((n) => {
      if (num(n.eval_mean) === null) { n.hang = true; n.eval_mean = null; }
      if (!n.cls) n.cls = n.version === 0 ? "baseline" : n.verdict === "accepted" ? "accepted" : String(n.reason || "").startsWith("overfit") ? "overfit" : "rejected";
      if (n.version === 0 || n.parent == null) n.cls = "accepted";
      return n;
    }).sort((a, b) => a.version - b.version);
  }

  // the front in the Results tab, or (into, hl) a copy in the playbook sheet with version hl ringed
  function renderFront(fresh, into, hl) {
    const el = into || $("front");
    const nodes = frontNodes();
    const W = 320, H = 160, padL = 4, padR = 48, padT = 14, padB = 10;
    if (!nodes.length) {
      el.innerHTML = '<svg viewBox="0 0 ' + W + " 60" + '" role="img" aria-label="Playbook versions"><text class="wait" x="0" y="30">No verified playbook yet</text></svg>';
      return;
    }
    const vals = nodes.filter((n) => !n.hang).map((n) => n.eval_mean);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const span = Math.max(0.04, hi - lo);
    lo -= span * 0.25; hi += span * 0.25;
    const nX = Math.max(nodes.length - 1, 1);
    const pos = {};
    nodes.forEach((n, i) => {
      const px = padL + 8 + (nodes.length === 1 ? 0 : (i / nX) * (W - padL - padR - 16));
      // a proposal never verified hangs just under its parent
      const py = n.hang ? (pos[n.parent] ? pos[n.parent][1] : padT) + 16 : padT + (1 - (n.eval_mean - lo) / (hi - lo)) * (H - padT - padB);
      pos[n.version] = [px, Math.min(H - padB, py)];
    });
    const base = nodes.find((n) => n.version === 0) || nodes.find((n) => !n.hang);
    const o = ['<svg viewBox="0 0 ' + W + " " + H + '" role="group" aria-label="Evolution front: playbook versions by coach round, height is the verification score">'];
    const by = pos[base.version][1];
    if (nodes.length > 1) o.push('<line class="base" x1="0" x2="' + (W - padR + 8) + '" y1="' + by.toFixed(1) + '" y2="' + by.toFixed(1) + '"/>');
    for (const n of nodes) {
      const parents = (Array.isArray(n.merged_from) && n.merged_from.length ? n.merged_from : [n.parent]).filter((p) => p != null && pos[p]);
      for (const p of parents) {
        o.push('<line class="edge" x1="' + pos[p][0].toFixed(1) + '" y1="' + pos[p][1].toFixed(1) + '" x2="' + pos[n.version][0].toFixed(1) + '" y2="' + pos[n.version][1].toFixed(1) + '"/>');
      }
    }
    // accepted lineage: from the version in force back to v0
    const inForceV = R().currentPlaybook(S.evalRows, S.tree).version || 0;
    const chain = [];
    let cur = nodes.find((n) => n.version === inForceV);
    while (cur) { chain.unshift(cur); cur = cur.parent != null ? nodes.find((n) => n.version === cur.parent) : null; }
    if (chain.length > 1) o.push('<polyline class="lineage" points="' + chain.map((n) => pos[n.version][0].toFixed(1) + "," + pos[n.version][1].toFixed(1)).join(" ") + '"/>');
    const newest = nodes[nodes.length - 1].version;
    for (const n of nodes) {
      const [cx, cy] = pos[n.version];
      const tip = "v" + n.version + " · " + (n.version === 0 ? "start" : n.hang ? (n.verdict === "open" ? "checking" : "rejected before verification") : n.cls) + "" + (n.change ? " · " + R().uiText(n.change).slice(0, 80) : "");
      const anim = fresh && n.version === newest ? " front-fresh" : "";
      o.push('<g class="node' + anim + '" tabindex="0" role="button" data-v="' + n.version + '" data-tip="' + esc(tip) + '" data-x="' + cx.toFixed(1) + '" data-y="' + cy.toFixed(1) + '" aria-label="' + esc(tip) + '">');
      if (n.front) o.push('<circle class="halo" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="8"/>');
      if (hl != null && n.version === hl) o.push('<circle class="hl" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="8"/>');
      o.push('<circle class="n ' + (n.hang ? "rejected" : n.cls) + '" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="3.5"/>');
      o.push("</g>");
    }
    o.push("</svg>");
    el.innerHTML = o.join("");
    if (into) return;
    const pickEl = $("front-pick");
    if (pickEl && !pickEl.dataset.v) pickEl.textContent = chain.length > 1 ? "Click a version to read its playbook." : "No playbook change kept yet";
    const tipEl = $("front-tip");
    const show = (g) => {
      tipEl.textContent = g.dataset.tip;
      tipEl.classList.remove("hidden");
      const svg = el.querySelector("svg"), sc = svg.getBoundingClientRect().width / W;
      const x = Number(g.dataset.x) * sc, y = Number(g.dataset.y) * sc + el.offsetTop;
      tipEl.style.left = Math.max(0, Math.min(el.clientWidth - tipEl.offsetWidth, x - tipEl.offsetWidth / 2)) + "px";
      tipEl.style.top = (y - 34) + "px";
    };
    const hide = () => tipEl.classList.add("hidden");
    el.querySelectorAll(".node").forEach((g) => {
      g.addEventListener("mouseenter", () => show(g));
      g.addEventListener("focus", () => show(g));
      g.addEventListener("mouseleave", hide);
      g.addEventListener("blur", hide);
      const pick = () => pickVersion(nodes.find((n) => n.version === Number(g.dataset.v)));
      g.addEventListener("click", pick);
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
    });
  }

  // a clicked version: its change under the chart, its playbook in the sheet
  function pickVersion(n) {
    if (!n) return;
    const el = $("front-pick");
    if (el) el.dataset.v = n.version;
    if (el) el.textContent = "v" + n.version + " · " + (n.version === 0 ? "start" : n.cls) + " · " + (n.change ? R().uiText(n.change).split("\n")[0] : "the starting playbook");
    openPlaybook(n.version);
  }

  // the coach's own rounds from tree.json, one muted line each, newest first
  function renderRounds() {
    const el = $("rounds-list");
    if (!el) return;
    const nodes = (S.tree && Array.isArray(S.tree.nodes) ? S.tree.nodes : []).filter((n) => n && num(n.version) && n.version > 0);
    el.innerHTML = nodes.sort((a, b) => b.version - a.version).slice(0, 6).map((n) => {
      const word = n.verdict === "open" ? "checking" : n.verdict || "open";
      const m = /^(\w+): episodes ([-+]?\d*\.?\d+)/.exec(String(n.reason || ""));
      const why = m ? "training " + m[1] + (Number(m[2]) < 0 ? " down " : " up ") + Math.abs(Number(m[2])).toFixed(3) : n.reason;
      const txt = "v" + n.version + " " + word + (why ? ", " + why : "") + (n.eval_mean != null ? ", verification " + f2(n.eval_mean) : "");
      return '<li title="' + esc(n.change ? R().uiText(n.change) : txt) + '">' + esc(txt) + "</li>";
    }).join("");
  }

  // ---------- last coach decision, in the agent's voice ----------
  function clause(change) {
    let c = R().uiText(change || "").replace(/^(before|when|if|for each|after|once)\b[^,;]*[,;]\s*/i, "").split(/[:;(]|, then|\. /)[0].trim().replace(/[.,]+$/, "");
    if (c.length > 90) c = c.slice(0, 88).replace(/\s+\S*$/, "") + "…";
    return c.charAt(0).toLowerCase() + c.slice(1);
  }
  function renderSay() {
    const rounds = R().coachRounds(S.evalRows);
    const el = $("coach-say");
    if (!el) return;
    const r = rounds[0];
    if (!r) { el.textContent = "No coach round yet. I play with the starting playbook and the coach reads my logs after each window of episodes."; return; }
    const nums = '<span class="num">' + f2(r.evalBefore) + " → " + f2(r.evalAfter) + "</span>";
    const what = clause(r.change);
    let txt;
    if (r.cls === "accepted") txt = "Round " + r.round + ": I now " + esc(what) + ". Accepted, " + nums + ".";
    else if (r.cls === "overfit") txt = "Round " + r.round + ": tried to " + esc(what) + ". Overfit, better on my episodes only. Kept v" + esc(r.parent) + ".";
    else txt = "Round " + r.round + ": tried to " + esc(what) + ". Rejected, no gain.";
    el.innerHTML = txt;
    el.title = el.textContent;
  }

  // ---------- playbook sheet ----------
  function inForce() {
    return R().currentPlaybook(S.evalRows, null).version || 0;
  }
  function openPlaybook(pick) {
    const v = typeof pick === "number" ? pick : inForce();
    const sheet = $("playbook-sheet");
    $("pb-title").textContent = "Playbook v" + v;
    $("pb-note").textContent = v ? "Highlighted lines were added since v0. The model is unchanged; only this text is." : "The starting playbook. The model is unchanged; only this text changes.";
    $("pb-text").textContent = "Loading";
    setTab("learn");
    renderFront(false, $("pb-front"), v);
    sheet.classList.remove("hidden");
    $("pb-close").focus();
    Promise.all([fetchText(S.base + "/playbooks/v0.md"), fetchText(S.base + "/playbooks/v" + v + ".md")]).then(([t0, tv]) => {
      if (tv == null) { $("pb-text").textContent = "playbooks/v" + v + ".md not found in this run."; return; }
      const lines = R().playbookDiff(v ? t0 : null, tv);
      $("pb-text").innerHTML = lines.map((l) => (l.added && /^\s*[-*\d]/.test(l.text) && /rule/i.test(sectionOf(lines, l)) ? '<span class="add">' + esc(l.text) + "</span>" : esc(l.text) + "\n")).join("");
    });
  }
  // the heading a line sits under: only rule bullets count as what the coach added
  function sectionOf(lines, line) {
    let h = "";
    for (const l of lines) { if (/^#+\s/.test(l.text)) h = l.text; if (l === line) break; }
    return h;
  }
    function closePlaybook() {
    const sheet = $("playbook-sheet");
    if (sheet.classList.contains("hidden")) return false;
    sheet.classList.add("hidden");
    const pb = $("playbook-btn");
    if (pb && pb.offsetParent) pb.focus();
    return true;
  }

  // ---------- ship card ----------
  let lastPointer = { x: 0, y: 0 };
  window.addEventListener("pointerdown", (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);
  function hourTxt(h) {
    const d = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][Math.floor(h / 24) % 7];
    return d + " " + String(Math.floor(h % 24)).padStart(2, "0") + ":00";
  }
  function showShipCard(idx, rep, t) {
    const s = rep && rep.ships && rep.ships[idx];
    S.selectedShip = s ? idx : null;
    renderActs();
    if (S.pointer) { lastPointer = S.pointer; S.pointer = null; }
    renderPort();
    const card = $("ship-card");
    if (!s) { card.classList.add("hidden"); return; }
    let cranes = 0;
    for (const [, c] of s.cranes_by_hour || []) cranes = Math.max(cranes, c);
    const late = s.late_h != null ? s.late_h : Math.max(0, s.departure - (s.due != null ? s.due : s.departure));
    let cost = null;
    if (window.OakKPI) {
      const one = Object.assign({}, rep, { ships: [s] });
      cost = window.OakKPI.at(one, window.OakKPI.horizon(rep) + 1000).cost_so_far;
    }
    const last = s.first_section + (s.sections || 1) - 1;
    card.innerHTML = "<h3>" + esc(s.name) + '</h3><dl>' +
      "<dt>Line</dt><dd>" + esc(s.line || "n/a") + "</dd>" +
      "<dt>ETA</dt><dd>" + hourTxt(s.arrival) + "</dd>" +
      "<dt>Berthed</dt><dd>" + hourTxt(s.berth_hour) + "</dd>" +
      "<dt>Sections</dt><dd>" + s.first_section + " to " + last + "</dd>" +
      "<dt>Cranes</dt><dd>" + (cranes || "n/a") + "</dd>" +
      "<dt>Departure</dt><dd class=\"" + (late > 0 ? "late" : "ok") + "\">" + (late > 0 ? late + " h late" : "on time") + "</dd>" +
      (cost != null ? "<dt>Cost added</dt><dd>" + cost + "</dd>" : "") + "</dl>";
    card.classList.remove("hidden");
    const w = 240, h = card.offsetHeight || 220;
    const maxX = window.innerWidth - (document.body.classList.contains("learning-hidden") ? 0 : 360) - w - 16;
    card.style.left = Math.max(16, Math.min(maxX, lastPointer.x + 16)) + "px";
    card.style.top = Math.max(72, Math.min(window.innerHeight - 48 - h - 16, lastPointer.y - h / 2)) + "px";
  }
  function hideShipCard() {
    $("ship-card").classList.add("hidden");
    if (S.selectedShip != null) { S.selectedShip = null; renderPort(); renderActs(); }
  }

  function renderAll(fresh) {
    renderFront(fresh);
    renderSay();
    renderRounds();
  }

  // ---------- replay of an episode ----------
  function showEpisode(epNum, userPicked) {
    const e = S.episodes.find((x) => x.episode === epNum);
    if (!e || !S.api) return Promise.resolve(false);
    return fetch(S.base + "/" + e.replay, { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(r.status + " " + r.statusText); return r.json(); })
      .then((rep) => {
        S.shownEpisode = epNum;
        S.shownReplay = rep;
        S.planRep = null;
        S.followNewest = !userPicked || epNum === S.episodes[S.episodes.length - 1].episode;
        S.api.load(rep);
        if (S.live) S.api.play(true);
        S.lastHourKey = "";
        return true;
      })
      .catch((err) => toast("Could not load " + e.replay + ": " + err.message));
  }

  // ---------- top bar and KPIs, driven by the replay clock ----------
  function onHour(rep, t) {
    if (!rep) return;
    schedulePort(rep, t);
    if (S.planRep && rep === S.planRep) {
      if (S.lastHourKey !== "plan") { S.lastHourKey = "plan"; $("now").innerHTML = '<span class="muted">' + esc(S.planText) + "</span>"; }
      return;
    }
    const mine = rep === S.shownReplay && S.shownEpisode != null;
    const key = (mine ? "e" + S.shownEpisode : "x" + ((rep.task || {}).task_id || "")) + "|" + S.episodes.length;
    if (key === S.lastHourKey) return;
    S.lastHourKey = key;
    const task = rep.task || {};
    const parts = [];
    // at most two muted words: terminal and weather of the task on screen
    if (mine) {
      const e = S.episodes.find((x) => x.episode === S.shownEpisode) || {};
      taskWords(e.task_id || task.task_id).split(" ").filter(Boolean).forEach((w) => parts.push(esc(w)));
    }
    if (!parts.length) parts.push(esc(task.terminal || "Terminal"));
    const nowEl = $("now");
    const html = parts.join('<span class="sep">·</span>');
    if (nowEl.innerHTML !== html) {
      nowEl.innerHTML = html;
      crossfade(nowEl);
    }
  }

  // ---------- port now: what is happening at the quay this hour ----------
  let portTimer = null, portLast = 0, sparkCache = { rep: null, html: "", H: 0 };
  function schedulePort(rep, t) {
    S.portRep = rep; S.portT = t;
    const now = Date.now();
    if (now - portLast >= 100) { portLast = now; renderPort(); return; }
    clearTimeout(portTimer);
    portTimer = setTimeout(() => { portLast = Date.now(); renderPort(); }, 100);
  }

  function renderPort() {
    const rep = S.portRep, t = S.portT;
    if (!rep || !window.OakKPI) return;
    const K = window.OakKPI;
    const k = K.at(rep, t);
    const H = K.horizon(rep);
    const ph = $("port-hour");
    if (ph) ph.textContent = "Port now · " + hourTxt(Math.floor(t)) + ", hour " + Math.floor(t);
    const task = rep.task || {};
    const g = rep.grade || {};
    $("k-along").textContent = k.ships_alongside + " of " + (rep.ships || []).length;
    // pool of this hour from the replay's crane_pool_by_hour (hoot shifts and outages included)
    $("k-cranes").textContent = k.cranes_working + " of " + k.cranes_pool;
    $("k-late").textContent = String(Math.round(k.late_ship_hours));
    const cost = g.cost != null ? g.cost : k.final_cost;
    const best = g.optimal_cost != null ? g.optimal_cost : k.optimal_cost;
    const fmt = (v) => (typeof v === "number" ? v.toLocaleString("en-US") : "n/a");
    $("k-cost").textContent = fmt(cost) + (best != null ? ", best possible " + fmt(best) : ", best possible unknown");
    $("k-say").textContent = portSentence(rep, t);

    // quay strip: the terminal name on the left, ships alongside as named blocks, nothing else
    const W = 320, Q = 30, L0 = 84, barY = 4, barH = 22;
    const nSec = Math.max(1, k.sections || 1);
    const BW = W - L0;
    const sx = (sec) => L0 + ((sec - 1) / nSec) * BW;
    const along = (rep.ships || []).map((s, idx) => [s, idx]).filter(([s]) => t >= s.berth_hour && t < s.departure);
    const o = [];
    if (!along.length) o.push('<span class="none">No ship alongside at this hour</span>');
    else {
      o.push('<svg viewBox="0 0 ' + W + " " + Q + '" aria-hidden="false">');
      o.push('<text class="term" x="0" y="' + (barY + barH / 2 + 4) + '">' + esc((task.terminal || "Terminal") + " quay") + "</text>");
      o.push('<rect class="bar" x="' + L0 + '.5" y="' + barY + '" width="' + (BW - 1) + '" height="' + barH + '"/>');
      for (const [s, idx] of along) {
        const secs = s.sections || 1;
        const x0 = sx(s.first_section) + 1, w = Math.max(3, (secs / nSec) * BW - 2);
        const late = s.due != null && t > s.due;
        const sel = S.selectedShip === idx;
        o.push('<rect class="ship' + (late ? " late" : "") + (sel ? " sel" : "") + '" data-idx="' + idx + '" x="' + x0.toFixed(1) + '" y="' + (barY + 2) + '" width="' + w.toFixed(1) + '" height="' + (barH - 4) + '"><title>' + esc(s.name) + (late ? ", past its due hour" : "") + "</title></rect>");
        const full = String(s.name || ""), short = full.split(" ").pop();
        const fit = (txt) => txt.length * 5.5 + 6 < w;
        const nm = fit(full) ? full : fit(short) ? short : short.slice(0, Math.max(0, Math.floor((w - 6) / 5.5)));
        if (nm) o.push('<text class="sname" x="' + (x0 + w / 2).toFixed(1) + '" y="' + (barY + barH / 2 + 3) + '" text-anchor="middle">' + esc(nm) + "</text>");
      }
      o.push("</svg>");
    }
    const quay = $("quay");
    quay.innerHTML = o.join("");
    quay.querySelectorAll(".ship").forEach((r) => r.addEventListener("click", (e) => {
      const idx = Number(r.dataset.idx);
      S.pointer = { x: e.clientX, y: e.clientY };
      if (S.api && S.api.selectShip) S.api.selectShip(idx);
    }));

    // cranes in use per hour against the pool, fog bands, playhead
    const SW = 320, SH = 40;
    if (!$("cranes-spark")) return;
    if (sparkCache.rep !== rep) {
      const ser = K.series(rep);
      const maxC = Math.max(1, Math.max.apply(null, ser.pool.concat(ser.cranes)));
      const px = (h) => (h / Math.max(1, H)) * SW, py = (v) => SH - 2 - (v / maxC) * (SH - 6);
      const parts = [];
      for (const w of rep.no_moves || []) {
        const a = w.start != null ? w.start : w[0], b = w.end != null ? w.end : w[1];
        parts.push('<rect class="fog" x="' + px(a).toFixed(1) + '" y="0" width="' + Math.max(1, px(b) - px(a)).toFixed(1) + '" height="' + SH + '"><title>' + esc(w.label || "no movements") + "</title></rect>");
      }
      parts.push('<polyline class="pool" points="' + ser.hours.map((h, i) => px(h).toFixed(1) + "," + py(ser.pool[i]).toFixed(1)).join(" ") + '"/>');
      parts.push('<polyline class="use" points="' + ser.hours.map((h, i) => px(h).toFixed(1) + "," + py(ser.cranes[i]).toFixed(1)).join(" ") + '"/>');
      sparkCache = { rep: rep, html: parts.join(""), H: H };
    }
    const hx = ((t / Math.max(1, H)) * SW).toFixed(1);
    $("cranes-spark").innerHTML = '<svg viewBox="0 0 ' + SW + " " + (SH + 12) + '" role="img" aria-label="Cranes in use per hour against the pool, with the current hour">' + sparkCache.html +
      '<line class="head" x1="' + hx + '" x2="' + hx + '" y1="0" y2="' + SH + '"/>' +
      '<text class="ax" x="0" y="' + (SH + 11) + '">cranes in use</text><text class="ax" x="' + SW + '" y="' + (SH + 11) + '" text-anchor="end">pool, dashed · ' + Math.round(H / 24) + " days</text></svg>";
  }

  // one short sentence from the state at hour t
  function portSentence(rep, t) {
    const ships = rep.ships || [];
    const along = ships.filter((s) => t >= s.berth_hour && t < s.departure);
    const lateNow = ships.filter((s) => s.late_h > 0 && s.due != null && t > s.due && t < s.departure).sort((a, b) => b.late_h - a.late_h);
    const lateTxt = lateNow.length ? lateNow[0].name + " " + lateNow[0].late_h + " h late" : "";
    if (!along.length) {
      const next = ships.filter((s) => s.arrival > t).sort((a, b) => a.arrival - b.arrival)[0];
      return "Quay idle this hour" + (next ? ", next arrival " + hourTxt(next.arrival) : "") + (lateTxt ? ", " + lateTxt : "");
    }
    return along.length + " ship" + (along.length === 1 ? "" : "s") + " working" + (lateTxt ? ", " + lateTxt : ", all on time");
  }

  function crossfade(el) {
    el.classList.remove("fade-in");
    void el.offsetWidth;
    el.classList.add("fade-in");
  }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(html) {
    const el = $("toast");
    el.innerHTML = html;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
  }

  // ---------- polling ----------
  function apply(run, first) {
    const prevEp = S.episodes.length ? S.episodes[S.episodes.length - 1].episode : 0;
    const prevRounds = S.evalRows.filter((r) => r && r.role !== "baseline").length;
    S.animateFrom = first ? null : { episode: prevEp, rounds: prevRounds };
    S.episodes = run.episodes;
    S.tree = run.tree;
    S.evalRows = run.evalRows;
    renderAll(!first && S.evalRows.filter((r) => r && r.role !== "baseline").length > prevRounds);
    S.animateFrom = null;
    S.lastHourKey = "";
    const newest = S.episodes.length ? S.episodes[S.episodes.length - 1].episode : 0;
    if (first) {
      if (newest) showEpisode(newest, false);
      return;
    }
    const cands = R().coachRounds(S.evalRows);
    if (cands.length > prevRounds && cands[0]) {
      const c = cands[0];
      const color = c.cls === "accepted" ? "var(--accent-text)" : "var(--muted)";
      toast('Coach round: <span class="tag" style="color:' + color + '">' + VERDICT_TEXT[c.cls] +
        "</span>, verification " + f2(c.evalBefore) + " → " + f2(c.evalAfter));
    } else if (newest > prevEp) {
      const e = S.episodes[S.episodes.length - 1];
      toast("New shift planned, reward " + f2(num(e.reward)));
    }
    if (newest > prevEp && S.followNewest !== false) showEpisode(newest, false);
  }

  function poll() {
    loadRun().then((run) => apply(run, false)).finally(() => setTimeout(poll, POLL_MS));
  }

  function setMode() {
    const pill = $("mode-pill");
    pill.dataset.mode = S.live ? "live" : "replay";
    $("mode-text").textContent = S.live ? "LIVE" : "REPLAY";
  }

  // ---------- menus ----------
  function wireMenu(btnId, menuId) {
    const btn = $(btnId), menu = $(menuId);
    if (!btn || !menu) return;
    const set = (open) => {
      menu.classList.toggle("hidden", !open);
      btn.setAttribute("aria-expanded", String(open));
      if (open) { const f = menu.querySelector("select, button, input"); if (f) f.focus(); }
    };
    btn.addEventListener("click", (e) => { e.stopPropagation(); set(menu.classList.contains("hidden")); });
    menu.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => set(false));
    menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { set(false); btn.focus(); } });
  }

  // light by default; an explicit choice is remembered, else the OS preference decides
  function isDark() {
    const t = document.documentElement.dataset.theme;
    if (t) return t === "dark";
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function wireTheme() {
    const sync = () => document.documentElement.classList.toggle("is-dark", isDark());
    sync();
    const btn = $("theme-btn");
    if (btn) btn.addEventListener("click", () => {
      const next = isDark() ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("oak-theme", next); } catch (e) { /* private mode: not remembered */ }
      sync();
      renderAll(false);
    });
    if (window.matchMedia) {
      try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", sync); } catch (e) { /* old browsers */ }
    }
  }

  function start(api) {
    if (S.started) return;
    S.started = true;
    S.api = api;
    const params = new URLSearchParams(location.search);
    S.base = (params.get("run") || "fixtures/run-demo").replace(/\/+$/, "");
    S.live = params.has("run") && params.get("live") !== "0";
    setMode();
    wireMenu("scenario-btn", "scenario-menu");
    wireMenu("view-btn", "cam-rail");
    wireTheme();
    const back = $("back-to-run");
    if (back) back.addEventListener("click", () => { if (S.episodes.length) showEpisode(S.shownEpisode || S.episodes[S.episodes.length - 1].episode, true); });
    $("playbook-btn").addEventListener("click", () => openPlaybook());
    wireTabs();
    $("quay").addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      if (S.api && S.api.seek) S.api.seek(Math.round(S.api.getT()) + (e.key === "ArrowRight" ? 1 : -1));
    });
    $("pb-close").addEventListener("click", closePlaybook);
    window.addEventListener("keydown", (e) => {
      const src = (e.composedPath && e.composedPath()[0]) || e.target;
      const tag = (src && src.tagName) || "";
      if (["INPUT", "TEXTAREA", "SELECT", "DEEP-CHAT"].includes(tag) || (src && src.isContentEditable) || (e.target && e.target.tagName === "DEEP-CHAT") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (!closePlaybook()) hideShipCard();
      } else if (e.key === "l" || e.key === "L") {
        document.body.classList.toggle("learning-hidden");
      } else if (e.key === "c" || e.key === "C") {
        if (S.api.cycleCam) toast("Camera: " + esc(S.api.cycleCam()));
      } else if (e.key === "p" || e.key === "P") {
        if (!closePlaybook()) openPlaybook();
      }
    });
    const ownReplay = params.get("replay") || params.get("scenario");
    loadRun().then((run) => {
      if (!run.ok && !ownReplay) {
        api.fallback();
        toast("No run found at " + esc(S.base) + ", showing a scenario instead");
      }
      apply(run, !ownReplay);
      if (S.live) setTimeout(poll, POLL_MS);
    });
  }

  // ---------- actions on what is on screen: the selected ship, or back from a proposed plan ----------
  function renderActs() {
    const row = $("act-row");
    if (!row) return;
    const chips = [];
    const rep = S.api && S.api.getReplay();
    const s = S.selectedShip != null && rep && rep.ships ? rep.ships[S.selectedShip] : null;
    if (S.planRep && rep === S.planRep) chips.push(["Back to the run", "back"]);
    else if (s) {
      const ep = "";
      const nm = s.name;
      if (s.late_h > 0) chips.push(["Why is " + nm + " late?", "Why is " + nm + " late" + ep + "?"]);
      chips.push(["Route " + nm + " earlier", "Route " + nm + " earlier" + ep + "."]);
      chips.push(["What if " + nm + " berths elsewhere?", "What if " + nm + " berths elsewhere" + ep + "?"]);
    }
    row.innerHTML = chips.map((c, i) => '<button type="button" class="chip act" data-i="' + i + '">' + esc(c[0]) + "</button>").join("");
    row.querySelectorAll(".act").forEach((b) => b.addEventListener("click", () => {
      const q = chips[Number(b.dataset.i)][1];
      if (q === "back") { const ep = S.planBackEp; S.planRep = null; if (ep != null) showEpisode(ep, true); renderActs(); }
      else if (window.OakChat) window.OakChat.send(q);
    }));
  }

  // a plan the operator made (make_plan, route_ship): its replay in the scene, the cost in the top bar
  function showPlan(plan) {
    if (!plan || !plan.replay || !S.api) return Promise.resolve(false);
    return fetch(S.base + "/" + plan.replay, { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(r.status + " " + r.statusText); return r.json(); })
      .then((rep) => {
        if (!S.planRep || S.api.getReplay() !== S.planRep) S.planBackEp = S.shownEpisode;
        S.planRep = rep;
        const fmt = (v) => (typeof v === "number" ? v.toLocaleString("en-US") : "n/a");
        S.planText = "Proposed plan, cost " + fmt(plan.cost) + (plan.optimum != null ? " vs best " + fmt(plan.optimum) : "");
        S.api.load(rep);
        S.lastHourKey = "";
        renderActs();
        return true;
      })
      .catch((err) => toast("Could not load " + esc(plan.replay) + ": " + esc(err.message)));
  }

  // ---------- tabs: Operator and Learning, remembered ----------
  function setTab(which, focus) {
    const op = which !== "learn";
    $("tab-op").setAttribute("aria-selected", String(op));
    $("tab-learn").setAttribute("aria-selected", String(!op));
    $("tab-op").tabIndex = op ? 0 : -1;
    $("tab-learn").tabIndex = op ? -1 : 0;
    $("pane-op").hidden = !op;
    $("pane-learn").hidden = op;
    if (focus) $(op ? "tab-op" : "tab-learn").focus();
    try { localStorage.setItem("oak-tab", op ? "op" : "learn"); } catch (e) { /* private mode: not remembered */ }
    if (!op) renderFront(false);
  }
  function wireTabs() {
    let saved = "op";
    try { saved = localStorage.getItem("oak-tab") || "op"; } catch (e) { /* default */ }
    $("tab-op").addEventListener("click", () => setTab("op"));
    $("tab-learn").addEventListener("click", () => setTab("learn"));
    document.querySelector(".ptabs").addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        setTab($("tab-op").getAttribute("aria-selected") === "true" ? "learn" : "op", true);
      }
    });
    setTab(saved);
  }

  // replays by episode, for ship names in chat answers about an episode not on screen
  const replayCache = {};
  function replayFor(epNum) {
    const n = Number(epNum);
    if (n === S.shownEpisode && S.shownReplay) return Promise.resolve(S.shownReplay);
    if (replayCache[n]) return replayCache[n];
    const e = S.episodes.find((x) => x.episode === n);
    if (!e) return Promise.resolve(null);
    replayCache[n] = fetch(S.base + "/" + e.replay, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    return replayCache[n];
  }
  function lastEpisode() { return S.episodes.length ? S.episodes[S.episodes.length - 1].episode : null; }

    // for chat.js: which run and episode are on screen, and jumping to a ship of an episode
  function runName() { return S.base.split("/").filter(Boolean).pop() || S.base; }
  function currentEpisode() { return S.shownReplay && S.api && S.api.getReplay() === S.shownReplay ? S.shownEpisode : null; }
  function goTo(link) {
    const ep = link && link.episode != null ? Number(link.episode) : S.shownEpisode;
    const ready = ep === S.shownEpisode && S.api.getReplay() === S.shownReplay ? Promise.resolve(true) : showEpisode(ep, true);
    return Promise.resolve(ready).then((ok) => {
      if (ok === false || ok === undefined) return;
      const rep = S.api.getReplay();
      // a freshly loaded episode plays when live; stay on the hour the answer named
      if (ep !== null && link.hour != null) S.api.play(false);
      if (link.hour != null) S.api.seek(Number(link.hour));
      if (link.ship_id != null && rep) {
        const idx = (rep.ships || []).findIndex((x) => x.id === link.ship_id);
        if (idx >= 0) S.api.selectShip(idx);
      }
    });
  }
  function shipName(link) {
    if (link.ship_id == null) return null;
    const rep = link.episode === S.shownEpisode ? S.shownReplay : link.rep || null;
    const s = rep && (rep.ships || []).find((x) => x.id === link.ship_id);
    return s ? s.name : "ship " + link.ship_id;
  }

  window.OakLearning = { start, onHour, showEpisode, showShipCard, hideShipCard, runName, currentEpisode, goTo, shipName, showPlan, renderActs, replayFor, lastEpisode, setTab, toast, _state: S };
})();
