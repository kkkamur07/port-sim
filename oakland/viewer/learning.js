/*
 * Learning panel and run follow mode (window.OakLearning).
 *
 * Reads a loop run directory (episodes.json or episodes.jsonl, eval.jsonl) through window.OakRuns and draws the
 * verification headline, the reward evolution chart, what the coach changed and four live KPIs.
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
  // v0 muted, the newest accepted version in the accent, anything between in a second hue
  const VERSION_COLORS = ["var(--hollow)", "var(--warn)", "var(--text)"];
  const ACCENT = "var(--accent)";

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

  // ---------- headline ----------
  function renderHeadline() {
    const evo = R().evolution(S.evalRows);
    const last = evo.lineage[evo.lineage.length - 1] || { value: null, version: 0 };
    const score = last.value;
    $("head-score").textContent = score == null ? "n/a" : f2(score);
    $("head-version").textContent = "v" + (last.version != null ? last.version : 0);
    const d = $("head-delta");
    if (score != null && evo.baseline != null && last.version !== 0 && last.version != null) {
      const delta = score - evo.baseline;
      d.innerHTML = "<b>" + (delta >= 0 ? "▲ +" : "▼ ") + delta.toFixed(2) + "</b> vs v0";
      d.className = "delta " + (delta >= 0 ? "up" : "down");
    } else {
      d.textContent = evo.baseline != null ? "v0, no change accepted yet" : "waiting for v0";
      d.className = "delta";
    }
  }

  // ---------- evolution chart ----------
  function versionColor(v, acceptedVersions) {
    const latest = acceptedVersions.length ? acceptedVersions[acceptedVersions.length - 1] : 0;
    if (v === 0 || v == null) return VERSION_COLORS[0];
    if (v === latest) return ACCENT;
    const i = acceptedVersions.indexOf(v);
    return VERSION_COLORS[1 + (Math.max(0, i) % (VERSION_COLORS.length - 1))];
  }

  function renderChart() {
    const el = $("evo-chart");
    const W = 328, H = 184, padL = 28, padR = 8, padT = 30, padB = 20;
    const eps = S.episodes;
    const evo = R().evolution(S.evalRows);
    const markers = R().roundMarkers(S.evalRows, eps);
    const acceptedVersions = [0].concat(evo.points.filter((p) => p.cls === "accepted").map((p) => p.version));
    const nEp = Math.max(eps.length ? eps[eps.length - 1].episode : 0, markers.reduce((m, k) => Math.max(m, k.episode || 0), 0), 4);
    const vals = eps.map((e) => num(e.reward)).concat(evo.lineage.map((l) => l.value)).filter((v) => v != null);
    const yMax = Math.min(1, Math.max(0.5, Math.ceil(((vals.length ? Math.max.apply(null, vals) : 0.5) + 0.05) * 10) / 10));
    const x = (ep) => padL + ((ep - 0.5) / nEp) * (W - padL - padR);
    const y = (v) => padT + (1 - v / yMax) * (H - padT - padB);
    const out = [];
    out.push('<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Reward per episode with coach rounds and verification score">');
    for (let g = 0; g <= yMax + 1e-9; g += yMax > 0.6 ? 0.2 : 0.1) {
      const gy = y(g).toFixed(1);
      out.push('<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + gy + '" y2="' + gy + '"/>');
      out.push('<text class="tick" x="' + (padL - 6) + '" y="' + (Number(gy) + 3) + '" text-anchor="end">' + g.toFixed(1) + "</text>");
    }
    const step = nEp > 12 ? Math.ceil(nEp / 8) : 1;
    for (let ep = 1; ep <= nEp; ep += step) {
      out.push('<text class="tick" x="' + x(ep).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + ep + "</text>");
    }
    // coach rounds: a rule after the episode window they read, tagged with the verdict (two rows so tags never collide)
    markers.forEach((mk, i) => {
      const cls = mk.cls;
      const color = cls === "accepted" ? "var(--accent)" : cls === "overfit" ? "var(--warn)" : "var(--muted)";
      const mx = x(mk.episode + 0.5).toFixed(1);
      const row = i % 2;
      const fresh = S.animateFrom != null && mk.round > S.animateFrom.rounds ? " rnew" : "";
      out.push('<line class="rround' + fresh + '" x1="' + mx + '" x2="' + mx + '" y1="' + (padT - 18 + row * 10 + 3) + '" y2="' + (H - padB) + '" stroke="' + color + '"/>');
      out.push('<text class="rtag' + fresh + '" x="' + mx + '" y="' + (padT - 18 + row * 10) + '" text-anchor="' + (Number(mx) > W - 48 ? "end" : Number(mx) < padL + 40 ? "start" : "middle") + '" fill="' + color + '">v' + esc(mk.version) + " " + VERDICT_TEXT[cls] + "</text>");
    });
    // verification mean of the playbook in force: a step that moves at each accepted round
    if (evo.baseline != null) {
      const pts = [];
      let cur = evo.lineage[0].value;
      pts.push([x(0.5), y(cur)]);
      for (let k = 1; k < evo.lineage.length; k++) {
        const mk = markers.find((m) => m.round === k);
        const mx = mk ? x(mk.episode + 0.5) : x(nEp + 0.5);
        const v = evo.lineage[k].value;
        if (v !== cur && v != null) {
          pts.push([mx, y(cur)]);
          pts.push([mx, y(v)]);
          cur = v;
        }
      }
      pts.push([x(nEp + 0.5), y(cur)]);
      out.push('<polyline class="vstep" points="' + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ") + '"/>');
    }
    for (const e of eps) {
      const r = num(e.reward);
      if (r == null) continue;
      const c = versionColor(e.playbook_version, acceptedVersions);
      const cur = S.shownEpisode === e.episode;
      const isNew = S.animateFrom != null && e.episode > S.animateFrom.episode;
      out.push('<circle class="dot' + (cur ? " cur" : "") + (isNew ? " new" : "") + '" tabindex="0" role="button" data-ep="' + e.episode + '" cx="' + x(e.episode).toFixed(1) +
        '" cy="' + y(r).toFixed(1) + '" r="' + (cur ? 5 : 4) + '" fill="' + c + '" aria-label="Play episode ' + e.episode + ", reward " + f2(r) +
        ", playbook v" + esc(e.playbook_version) + '"><title>Episode ' + e.episode + ": reward " + f2(r) + ", playbook v" + esc(e.playbook_version) + "</title></circle>");
    }
    if (!eps.length) out.push('<text class="empty" x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle">Waiting for the first episode</text>');
    out.push("</svg>");
    el.innerHTML = out.join("");
    el.querySelectorAll(".dot").forEach((d) => {
      const go = () => showEpisode(Number(d.dataset.ep), true);
      d.addEventListener("click", go);
      d.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
    });

    const used = [];
    for (const e of eps) if (!used.includes(e.playbook_version)) used.push(e.playbook_version);
    const leg = used.map((v) => '<span><i class="sw-dot" style="background:' + versionColor(v, acceptedVersions) + '"></i>episode, playbook v' + esc(v) + "</span>");
    if (evo.baseline != null) leg.push('<span><i class="sw-line"></i>verification score</span>');
    $("evo-legend").innerHTML = leg.join("");
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
    return Object.values(byV).filter((n) => num(n.eval_mean) !== null).map((n) => {
      if (!n.cls) n.cls = n.version === 0 ? "baseline" : n.verdict === "accepted" ? "accepted" : String(n.reason || "").startsWith("overfit") ? "overfit" : "rejected";
      if (n.version === 0 || n.parent == null) n.cls = "accepted";
      return n;
    }).sort((a, b) => a.version - b.version);
  }

  function renderFront(fresh) {
    const el = $("front");
    const nodes = frontNodes();
    const W = 320, H = 60, padL = 4, padR = 36, padT = 12, padB = 6;
    if (!nodes.length) {
      el.innerHTML = '<svg viewBox="0 0 ' + W + " 60" + '" role="img" aria-label="Evolution front"><text class="wait" x="0" y="30">waiting for the v0 verification</text></svg>';
      return;
    }
    const vals = nodes.map((n) => n.eval_mean);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const span = Math.max(0.04, hi - lo);
    lo -= span * 0.25; hi += span * 0.25;
    const nX = Math.max(nodes.length - 1, 1);
    const pos = {};
    nodes.forEach((n, i) => {
      pos[n.version] = [padL + 8 + (nodes.length === 1 ? 0 : (i / nX) * (W - padL - padR - 16)), padT + (1 - (n.eval_mean - lo) / (hi - lo)) * (H - padT - padB)];
    });
    const base = nodes.find((n) => n.version === 0) || nodes[0];
    const best = nodes.reduce((b, n) => (n.cls === "accepted" && n.eval_mean > b.eval_mean ? n : b), base);
    const o = ['<svg viewBox="0 0 ' + W + " " + H + '" role="group" aria-label="Evolution front: playbook versions by coach round, height is the verification score">'];
    const by = pos[base.version][1];
    if (nodes.length > 1) o.push('<line class="base" x1="0" x2="' + (W - padR + 8) + '" y1="' + by.toFixed(1) + '" y2="' + by.toFixed(1) + '"/>');
    o.push('<text class="ax" x="' + (W - padR + 12) + '" y="' + (by + 3).toFixed(1) + '">' + f2(base.eval_mean) + "</text>");
    if (best !== base) {
      const yy = pos[best.version][1];
      o.push('<text class="ax" x="' + (W - padR + 12) + '" y="' + (yy + 3).toFixed(1) + '" fill="var(--accent)" style="fill:var(--accent)">' + f2(best.eval_mean) + "</text>");
    }
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
      const tip = "v" + n.version + " · " + (n.version === 0 ? "start" : n.cls) + " · " + f2(n.eval_mean) + (n.change ? " · " + R().uiText(n.change).slice(0, 80) : "");
      const anim = fresh && n.version === newest ? " front-fresh" : "";
      o.push('<g class="node' + anim + '" tabindex="0" data-tip="' + esc(tip) + '" data-x="' + cx.toFixed(1) + '" data-y="' + cy.toFixed(1) + '" aria-label="' + esc(tip) + '">');
      if (n.front) o.push('<circle class="halo" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="8"/>');
      o.push('<circle class="n ' + n.cls + '" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="3.5"/>');
      if (n.cls === "accepted") o.push('<text class="vlab" x="' + cx.toFixed(1) + '" y="' + (cy - 8).toFixed(1) + '" text-anchor="middle">v' + n.version + "</text>");
      o.push("</g>");
    }
    if (nodes.length === 1) o.push('<text class="wait" x="20" y="' + (by + 4).toFixed(1) + '">waiting for the first coach round</text>');
    o.push("</svg>");
    el.innerHTML = o.join("");
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
    });
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
  function openPlaybook() {
    const v = inForce();
    const sheet = $("playbook-sheet");
    $("pb-title").textContent = "Playbook v" + v;
    $("pb-note").textContent = v ? "Highlighted lines were added since v0. The model is unchanged; only this text is." : "The starting playbook. The model is unchanged; only this text changes.";
    $("pb-text").textContent = "Loading";
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
    $("playbook-btn").focus();
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
    if (S.selectedShip != null) { S.selectedShip = null; renderPort(); }
  }

  function renderAll(fresh) {
    renderHeadline();
    renderFront(fresh);
    renderSay();
    renderChart();
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
        S.followNewest = !userPicked || epNum === S.episodes[S.episodes.length - 1].episode;
        S.api.load(rep);
        if (S.live) S.api.play(true);
        renderChart();
        S.lastHourKey = "";
        return true;
      })
      .catch((err) => toast("Could not load " + e.replay + ": " + err.message));
  }

  // ---------- top bar and KPIs, driven by the replay clock ----------
  function onHour(rep, t) {
    if (!rep) return;
    schedulePort(rep, t);
    const mine = rep === S.shownReplay && S.shownEpisode != null;
    const key = (mine ? "e" + S.shownEpisode : "x" + ((rep.task || {}).task_id || "")) + "|" + S.episodes.length;
    if (key === S.lastHourKey) return;
    S.lastHourKey = key;
    const task = rep.task || {};
    const parts = [];
    if (mine) {
      const e = S.episodes.find((x) => x.episode === S.shownEpisode) || {};
      const tw = taskWords(e.task_id || task.task_id).split(" ");
      parts.push("<b>Episode " + S.shownEpisode + " of " + S.episodes.length + "</b>");
      if (tw[0]) parts.push(esc(tw[0]));
      if (tw[1]) parts.push(esc(tw[1]));
      parts.push("playbook v" + esc(e.playbook_version != null ? e.playbook_version : "?"));
    } else {
      parts.push("<b>" + esc(task.terminal || "Terminal") + "</b>");
      if (task.difficulty) parts.push(esc(task.difficulty));
      parts.push("scenario, not a run episode");
    }
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
    if (ph) ph.textContent = "hour " + Math.floor(t);
    $("k-along").textContent = String(k.ships_alongside);
    $("k-cranes").textContent = k.cranes_working + "/" + k.cranes_pool;
    $("k-late").textContent = String(Math.round(k.late_ship_hours));
    $("k-cost").textContent = (k.cost_so_far != null ? k.cost_so_far : "n/a") + (k.optimal_cost != null ? "/" + k.optimal_cost : "");

    // quay strip
    const W = 320, Q = 46, barY = 18, barH = 22;
    const nSec = Math.max(1, k.sections || 1);
    const sx = (sec) => ((sec - 1) / nSec) * W;
    const o = ['<svg viewBox="0 -2 ' + W + " " + Q + '" aria-hidden="false">'];
    o.push('<rect class="bar" x="0.5" y="' + barY + '" width="' + (W - 1) + '" height="' + barH + '"/>');
    const step = nSec > 40 ? 5 : 1;
    for (let i = 1; i < nSec; i += step) o.push('<line class="tick" x1="' + sx(i + 1).toFixed(1) + '" x2="' + sx(i + 1).toFixed(1) + '" y1="' + (barY + barH - 4) + '" y2="' + (barY + barH) + '"/>');
    (rep.ships || []).forEach((s, idx) => {
      const secs = s.sections || 1;
      if (t >= s.berth_hour && t < s.departure) {
        const x0 = sx(s.first_section) + 1, w = Math.max(3, (secs / nSec) * W - 2);
        const late = s.due != null && t > s.due;
        const sel = S.selectedShip === idx;
        o.push('<rect class="ship' + (late ? " late" : "") + (sel ? " sel" : "") + '" data-idx="' + idx + '" x="' + x0.toFixed(1) + '" y="' + (barY + 2) + '" width="' + w.toFixed(1) + '" height="' + (barH - 4) + '"><title>' + esc(s.name) + (late ? ", past its due hour" : "") + "</title></rect>");
        const nm = String(s.name || "").split(" ").pop();
        if (nm.length * 5.6 + 6 < w) o.push('<text class="sname" x="' + (x0 + w / 2).toFixed(1) + '" y="' + (barY + barH / 2 + 3) + '" text-anchor="middle">' + esc(nm) + "</text>");
      } else if (t >= s.arrival && t < s.berth_hour) {
        o.push('<circle class="wait" cx="' + (sx(s.first_section) + (secs / nSec) * W / 2).toFixed(1) + '" cy="8" r="3"><title>' + esc(s.name) + " at anchor</title></circle>");
      }
    });
    o.push('<text class="ax" x="0" y="' + (Q - 1) + '">sec 1</text><text class="ax" x="' + W + '" y="' + (Q - 1) + '" text-anchor="end">' + nSec + "</text></svg>");
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
      const color = c.cls === "accepted" ? "var(--accent)" : c.cls === "overfit" ? "var(--warn)" : "var(--muted)";
      toast("Coach round " + c.round + ": playbook v" + esc(c.version) + ' <span class="tag" style="color:' + color + '">' + VERDICT_TEXT[c.cls] +
        "</span>, verification " + f2(c.evalBefore) + " → " + f2(c.evalAfter));
    } else if (newest > prevEp) {
      const e = S.episodes[S.episodes.length - 1];
      toast("Episode " + newest + " finished: reward " + f2(num(e.reward)) + " with playbook v" + esc(e.playbook_version));
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
    $("playbook-btn").addEventListener("click", openPlaybook);
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
      } else if (/^[1-9]$/.test(e.key)) {
        const ep = S.episodes[Number(e.key) - 1];
        if (ep) showEpisode(ep.episode, true);
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

    // for chat.js: which run and episode are on screen, and jumping to a ship of an episode
  function runName() { return S.base.split("/").filter(Boolean).pop() || S.base; }
  function currentEpisode() { return S.shownReplay && S.api && S.api.getReplay() === S.shownReplay ? S.shownEpisode : null; }
  function goTo(link) {
    const ep = link && link.episode != null ? Number(link.episode) : S.shownEpisode;
    const ready = ep === S.shownEpisode && S.api.getReplay() === S.shownReplay ? Promise.resolve(true) : showEpisode(ep, true);
    return Promise.resolve(ready).then(() => {
      const rep = S.api.getReplay();
      if (link.hour != null) S.api.seek(Number(link.hour));
      if (link.ship_id != null && rep) {
        const idx = (rep.ships || []).findIndex((x) => x.id === link.ship_id);
        if (idx >= 0) S.api.selectShip(idx);
      }
    });
  }
  function shipName(link) {
    if (link.ship_id == null) return null;
    const rep = link.episode === S.shownEpisode ? S.shownReplay : null;
    const s = rep && (rep.ships || []).find((x) => x.id === link.ship_id);
    return s ? s.name : "ship " + link.ship_id;
  }

  window.OakLearning = { start, onHour, showEpisode, showShipCard, hideShipCard, runName, currentEpisode, goTo, shipName, toast, _state: S };
})();
