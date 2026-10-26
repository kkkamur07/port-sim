/*
 * Ask the operator: the Deep Chat web component (deep-chat@2.5.0 from unpkg) in the right panel, wired to the chat
 * API (oakland/chat, POST http://127.0.0.1:8771/chat). The answer renders as text, then one muted line naming the
 * tools used, link chips that jump to an episode, ship and hour, and a small card for a what-if regrade. After
 * "Optimize my playbook" the answer carries a proposal; it is polled (GET /proposal) every 10 s until verified and
 * then one result card is added: before and after, the verdict, the rule.
 *   ?chat=<url>  another chat endpoint (default http://127.0.0.1:8771/chat); ?chatrun=<name> the run the server reads
 * Without the component (offline) a minimal list and input take its place.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const ENDPOINT = params.get("chat") || "http://127.0.0.1:8771/chat";
  const INTRO = "Ask me anything about running the port.";
  // turns the component's grey send icon crane orange
  const ACCENT_FILTER = "brightness(0) saturate(100%) invert(33%) sepia(86%) saturate(2272%) hue-rotate(352deg) brightness(88%) contrast(93%)";
  const history = []; // [{role: "user" | "assistant", content}], what the API gets
  let chatEl = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  const L = () => window.OakLearning;

  // the bundled fixtures/run-demo is a copy of runs/real-berth-gepa; ?chatrun= names another server run
  function runForApi() {
    if (params.get("chatrun")) return params.get("chatrun");
    const name = L() ? L().runName() : "live";
    return name === "run-demo" ? "real-berth-gepa" : name;
  }

  function ask(text, signal) {
    const msgs = history.concat([{ role: "user", content: text }]);
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run: runForApi(), messages: msgs, episode: L() ? L().currentEpisode() : null, hour: window.OakViewer && window.OakViewer.getReplay() ? Math.floor(window.OakViewer.getT()) : null,
        ship_id: L() && L()._state.selectedShip != null && window.OakViewer && window.OakViewer.getReplay() ? ((window.OakViewer.getReplay().ships || [])[L()._state.selectedShip] || {}).id : null }),
      signal: signal,
    }).then((r) => r.json().catch(() => ({ error: r.status + " " + r.statusText })).then((d) => {
      if (!r.ok || d.error) throw new Error(d.error || r.status + " " + r.statusText);
      history.push({ role: "user", content: text }, { role: "assistant", content: d.answer || "" });
      return d;
    }));
  }

  // "checked: the run, the coach": the tools used, in operator words, no ids or JSON
  const TOOL_WORDS = {
    ship: "the ship", port_status: "the quay", late_ships: "late ships", playbook: "the playbook", coach_round: "the coach",
    what_if: "the checker", make_plan: "the solver", route_ship: "the solver", improvement: "the run", run_status: "the run",
    reward_rules: "the rules", overview: "the overview", optimize_playbook: "the proposal", verify_proposal: "the proposal",
    proposal_status: "the proposal",
  };
  function stepsLine(steps) {
    const seen = [];
    for (const st of steps || []) {
      const t = TOOL_WORDS[st.tool] || String(st.tool || "").replace(/_/g, " ");
      if (t && !seen.includes(t)) seen.push(t);
    }
    return seen.length ? "checked: " + seen.join(", ") : "";
  }

  let linkStore = [];
  const chip = (lk, label) => '<button class="oak-link" data-link="' + (linkStore.push(lk) - 1) + '">' + esc(label) + "</button>";
  function epNums(text) {
    const out = [];
    String(text || "").replace(/\bepisodes?\s+(\d+)/gi, (m, n) => { if (!out.includes(Number(n))) out.push(Number(n)); });
    return out;
  }
  // reps: {episode: replay} fetched before rendering, so ships named in the answer get chips too
  function answerHtml(d, reps) {
    reps = reps || {};
    const out = ['<div class="oak-ans">' + esc(d.answer || "").replace(/\n/g, "<br>") + "</div>"];
    const line = stepsLine(d.steps);
    if (line) out.push('<div class="oak-steps">' + esc(line) + "</div>");
    const links = (Array.isArray(d.links) ? d.links : []).filter((lk) => lk && lk.episode != null).map((lk) => Object.assign({}, lk, { episode: Number(lk.episode) }));
    for (const n of epNums(d.answer)) if (!links.some((lk) => lk.episode === n)) links.push({ episode: n });
    // ship names in the answer text, matched against the replay of each named episode
    const text = String(d.answer || "").toUpperCase();
    for (const ep of Object.keys(reps).map(Number)) {
      // a name can call more than once a run; take its latest call
      const byName = {};
      for (const sh of (reps[ep] && reps[ep].ships) || []) {
        const nm = String(sh.name || "").toUpperCase();
        if (nm && text.includes(nm) && (!byName[nm] || (sh.late_h || 0) > (byName[nm].late_h || 0))) byName[nm] = sh;
      }
      for (const sh of Object.values(byName)) {
        if (!links.some((lk) => lk.episode === ep && lk.ship_id != null && (reps[ep].ships || []).some((x) => x.id === lk.ship_id && x.name === sh.name))) links.push({ episode: ep, ship_id: sh.id, hour: sh.due != null && sh.late_h > 0 ? sh.due : sh.berth_hour });
      }
    }
    const chips = [], seenEp = {}, seenShip = {};
    for (const lk of links) {
      if (!seenEp[lk.episode]) {
        seenEp[lk.episode] = 1;
        const h = links.find((x) => x.episode === lk.episode && x.ship_id == null && x.hour != null);
        chips.push(chip({ episode: lk.episode, hour: h ? h.hour : null }, "Show in 3D" + (h ? " at hour " + h.hour : "")));
      }
    }
    for (const lk of links) {
      if (lk.ship_id == null || seenShip[lk.episode + "|" + lk.ship_id]) continue;
      seenShip[lk.episode + "|" + lk.ship_id] = 1;
      const sh = reps[lk.episode] && (reps[lk.episode].ships || []).find((x) => x.id === lk.ship_id);
      const name = sh ? sh.name : L() ? L().shipName(lk) : "ship " + lk.ship_id;
      chips.push(chip(lk, name));
    }
    if (d.plan && d.plan.replay) chips.unshift('<button class="oak-link" data-plan="' + (linkStore.push({ plan: d.plan }) - 1) + '">Show plan in 3D</button>');
    if (chips.length) out.push('<div class="oak-links">' + chips.slice(0, 10).join("") + "</div>");
    const w = d.what_if;
    if (w && typeof w === "object" && !w.error) {
      const sub = w.submitted || {};
      const a = w.after || {};
      out.push('<div class="oak-whatif"><div class="oak-wi1">cost ' + esc(sub.cost) + " → " + (w.cost != null ? esc(w.cost) : "none") + " · " + esc(w.violation_count || 0) +
        " violation" + (w.violation_count === 1 ? "" : "s") + " · " + (w.feasible ? "feasible" : "infeasible") + "</div>" +
        '<div class="oak-wi2">' + esc(w.name || "ship " + w.ship) + ": berth h" + esc(a.berth_hour) + ", section " + esc(a.section) + ", " + esc(a.cranes) +
        " cranes" + (typeof w.delta_reward === "number" ? ", reward " + (w.delta_reward >= 0 ? "+" : "") + w.delta_reward.toFixed(3) : "") + "</div>" +
        (w.plan ? '<button class="oak-link" data-whatif="1">show in 3D</button>' : "") + "</div>");
      const i = linkStore.push({ episode: w.episode, ship_id: w.ship, hour: a.berth_hour }) - 1;
      out.push('<div class="oak-links"><button class="oak-link" data-link="' + i + '">' + esc(w.name || "ship " + w.ship) + " in 3D</button></div>");
    }
    return out.join("");
  }

  // ---------- optimize: poll the proposal, then one result card ----------
  const POLL_MS = 10000;
  const watched = {};
  const num2 = (v) => (typeof v === "number" ? v.toFixed(3) : "n/a");
  function resultHtml(p) {
    const ok = p.status === "accepted";
    const before = p.baseline_eval_mean != null ? p.baseline_eval_mean : p.baseline_mean;
    const after = p.eval_mean != null ? p.eval_mean : p.verification_mean;
    return '<div class="oak-res"><div class="oak-res-nums">' +
      '<div class="oak-res-n"><div class="oak-res-l">before</div><div class="oak-res-v">' + num2(before) + "</div></div>" +
      '<div class="oak-res-n"><div class="oak-res-l">after</div><div class="oak-res-v">' + num2(after) + "</div></div></div>" +
      '<div class="' + (ok ? "oak-res-ok" : "oak-res-no") + '">' + (ok ? "Accepted" : "Rejected, kept the old playbook") + "</div>" +
      (p.change ? '<div class="oak-res-rule">' + esc(String(p.change).split("\n")[0]) + "</div>" : "") + "</div>";
  }
  function addAi(html, text) {
    if (chatEl && chatEl.addMessage && chatEl.tagName) {
      try { chatEl.addMessage({ role: "ai", html: html }); return; } catch (e) { chatEl.addMessage({ role: "ai", text: text }); return; }
    }
    const list = $("fb-list");
    if (list) { list.insertAdjacentHTML("beforeend", '<div class="fb-ai">' + html + "</div>"); list.scrollTop = list.scrollHeight; }
  }
  // the Results tab: one card per proposal, the waiting line while the verifier runs
  function propCard(p) {
    const list = $("prop-list");
    if (!list || !p || p.id == null) return;
    let el = list.querySelector('[data-pid="' + p.id + '"]');
    if (!el) { el = document.createElement("div"); el.className = "prop-card"; el.dataset.pid = p.id; list.prepend(el); }
    const done = p.status === "accepted" || p.status === "rejected";
    el.innerHTML = done ? resultHtml(p) : '<div class="oak-res-rule">' + esc(String(p.change || "a new rule").split("\n")[0]) + '</div><div class="prop-st">Verifying</div>';
    waiting(done ? null : p);
  }
  function waiting(p) {
    const box = $("opt-wait"), btn = $("opt-btn");
    if (!box) return;
    box.classList.toggle("hidden", !p);
    if (btn) btn.disabled = !!p;
    if (p) {
      const m = typeof p.expected_minutes === "number" && p.expected_minutes > 0 ? Math.max(1, Math.round(p.expected_minutes)) : null;
      $("opt-wait-text").textContent = "Checking on 4 held-out tasks" + (m ? ", about " + m + " min" : "");
    }
  }
  function watchProposal(p, run) {
    if (!p || p.id == null || watched[p.id]) return;
    propCard(p);
    if (p.status === "accepted" || p.status === "rejected") { watched[p.id] = 1; addAi(resultHtml(p), p.status); return; }
    watched[p.id] = 1;
    const url = ENDPOINT.replace(/\/chat\/?$/, "") + "/proposal?run=" + encodeURIComponent(run) + "&id=" + encodeURIComponent(p.id);
    const tick = () => fetch(url).then((r) => r.json().then((d) => {
      if (!r.ok || d.error) throw new Error(d.error || r.status + " " + r.statusText);
      return d;
    })).then((d) => {
      if (d.status === "accepted" || d.status === "rejected") {
        const full = Object.assign({ change: p.change }, d);
        addAi(resultHtml(full), d.status);
        propCard(full);
      }
      else setTimeout(tick, POLL_MS);
    }).catch((e) => {
      waiting(null);
      const msg = "I could not check the proposal (" + e.message + "), so I stopped checking.";
      addAi('<div class="oak-steps">' + esc(msg) + "</div>", msg);
    });
    setTimeout(tick, POLL_MS);
  }

  function reply(text, d) {
    const eps = epNums(d.answer);
    for (const lk of d.links || []) if (lk && lk.episode != null && !eps.includes(Number(lk.episode))) eps.push(Number(lk.episode));
    const asked = /\bshow\b.*\bepisode\s+(\d+)/i.exec(text);
    if (asked && !eps.includes(Number(asked[1]))) eps.push(Number(asked[1]));
    const reps = {};
    return Promise.all(eps.slice(0, 4).map((n) => (L() ? L().replayFor(n) : Promise.resolve(null)).then((r) => { if (r) reps[n] = r; }))).then(() => {
      if (asked && L()) L().goTo({ episode: Number(asked[1]) });
      watchProposal(d.proposal, runForApi());
      return answerHtml(d, reps);
    });
  }

  function onLinkClick(e) {
    const p = e.target.closest ? e.target.closest("[data-plan]") : null;
    if (p && L()) { L().showPlan(linkStore[Number(p.dataset.plan)].plan); return; }
    const b = e.target.closest ? e.target.closest("[data-link]") : null;
    if (!b || !L()) return;
    L().goTo(linkStore[Number(b.dataset.link)]);
  }

  // Deep Chat styles: transparent, hairline input, accent only on the user's bubble outline and the send icon
  function styleDeepChat(el) {
    el.style.width = "100%";
    el.style.height = "100%";
    el.chatStyle = { width: "100%", height: "100%", border: "none", backgroundColor: "transparent", fontFamily: "var(--sans)", fontSize: "13px", color: "var(--text)" };
    el.messageStyles = {
      default: {
        shared: { innerContainer: { width: "100%" }, bubble: { maxWidth: "100%", padding: "8px 12px", borderRadius: "4px", fontSize: "13px", lineHeight: "1.5", boxShadow: "none" }, outerContainer: { marginTop: "8px" } },
        user: { bubble: { backgroundColor: "var(--line)", color: "var(--text)", border: "none", borderRadius: "6px" } },
        ai: { bubble: { backgroundColor: "transparent", color: "var(--text)", border: "1px solid var(--line)", padding: "8px 0 8px 12px", borderWidth: "0 0 0 2px", borderColor: "var(--line-strong)", borderRadius: "0" } },
      },
      loading: { message: { html: '<div class="oak-skel"></div><div class="oak-skel short"></div>', styles: { bubble: { backgroundColor: "transparent", border: "none", padding: "8px 0", width: "100%" } } } },
      error: { bubble: { backgroundColor: "transparent", color: "var(--bad)", border: "1px solid var(--bad)", borderRadius: "4px" } },
      intro: { bubble: { backgroundColor: "transparent", color: "var(--muted)", border: "none", padding: "4px 0", fontSize: "13px" } },
    };
    el.inputAreaStyle = { backgroundColor: "transparent", padding: "8px 0 0", borderTop: "none" };
    el.textInput = {
      placeholder: { text: "Ask the operator", style: { color: "var(--muted)" } },
      styles: {
        container: { backgroundColor: "transparent", border: "1px solid var(--line-strong)", borderRadius: "6px", boxShadow: "none", width: "100%", margin: "0" },
        text: { color: "var(--text)", padding: "8px 40px 8px 12px", fontFamily: "var(--sans)", fontSize: "13px" },
        focus: { border: "1px solid var(--text)" },
      },
    };
    el.submitButtonStyles = {
      submit: { container: { default: { backgroundColor: "transparent", borderRadius: "6px" } }, svg: { styles: { default: { filter: ACCENT_FILTER } } } },
      disabled: { container: { default: { backgroundColor: "transparent" } }, svg: { styles: { default: { filter: ACCENT_FILTER, opacity: "0.45" } } } },
      loading: { container: { default: { backgroundColor: "transparent" } } },
      stop: { container: { default: { backgroundColor: "transparent" } } },
    };
    el.htmlClassUtilities = {
      "oak-steps": { styles: { default: { color: "var(--muted)", fontSize: "11px", fontFamily: "var(--sans)", marginTop: "6px" } } },
      "oak-links": { styles: { default: { display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "8px" } } },
      "oak-link": {
        events: { click: onLinkClick },
        styles: {
          default: { font: "400 11px/22px var(--sans)", height: "24px", color: "var(--muted)", background: "transparent", border: "1px solid var(--line)", borderRadius: "6px", padding: "0 6px", whiteSpace: "nowrap", cursor: "pointer" },
          hover: { color: "var(--text)", borderColor: "var(--line-strong)" },
        },
      },
      "oak-skel": { styles: { default: { height: "8px", width: "220px", borderRadius: "4px", backgroundColor: "var(--line)", marginTop: "6px" } } },
      "short": { styles: { default: { width: "140px" } } },
      "oak-whatif": { styles: { default: { marginTop: "8px", padding: "8px 10px", border: "1px solid var(--line-strong)", borderRadius: "4px" } } },
      "oak-wi1": { styles: { default: { font: "500 12px var(--mono)" } } },
      "oak-wi2": { styles: { default: { font: "11px var(--mono)", color: "var(--muted)", marginTop: "4px" } } },
      "oak-res-nums": { styles: { default: { display: "flex", gap: "24px" } } },
      "oak-res-l": { styles: { default: { font: "500 11px var(--sans)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)" } } },
      "oak-res-v": { styles: { default: { font: "400 18px var(--mono)", marginTop: "4px" } } },
      "oak-res-ok": { styles: { default: { font: "500 13px var(--sans)", color: "var(--accent-text)", marginTop: "8px" } } },
      "oak-res-no": { styles: { default: { font: "500 13px var(--sans)", color: "var(--muted)", marginTop: "8px" } } },
      "oak-res": { styles: { default: { maxWidth: "100%", minWidth: "0", boxSizing: "border-box" } } },
      // the rule wraps inside the chat column, at most three lines then an ellipsis
      "oak-res-rule": { styles: { default: { fontSize: "13px", lineHeight: "1.4", marginTop: "4px", whiteSpace: "normal", overflowWrap: "anywhere",
        display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: "3", overflow: "hidden" } } },
    };
  }

  function mountDeepChat() {
    const host = $("chat-host");
    chatEl = document.createElement("deep-chat");
    chatEl.id = "deep-chat";
    styleDeepChat(chatEl);
    chatEl.introMessage = { text: INTRO };
    chatEl.connect = {
      handler: (body, signals) => {
        const msgs = (body && body.messages) || [];
        const last = msgs[msgs.length - 1] || {};
        const ctrl = new AbortController();
        if (signals.stopClicked) signals.stopClicked.listener = () => ctrl.abort();
        const text = String(last.text || "");
        ask(text, ctrl.signal)
          .then((d) => reply(text, d))
          .then((html) => signals.onResponse({ html: html }))
          .catch((e) => signals.onResponse({ error: e.name === "AbortError" ? "Stopped." : "The operator could not answer: " + e.message }));
      },
    };
    host.appendChild(chatEl);
  }

  // offline fallback: a list and an input, same contract
  function mountFallback() {
    const host = $("chat-host");
    host.innerHTML = '<div class="fb-list" id="fb-list" aria-live="polite"><div class="fb-intro">' + esc(INTRO) + "</div></div>" +
      '<form class="fb-form" id="fb-form"><input id="fb-in" type="text" placeholder="Ask the operator" aria-label="Ask the operator"><button class="btn" type="submit">Send</button></form>';
    const list = $("fb-list");
    $("fb-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $("fb-in").value.trim();
      if (v) send(v);
    });
    list.addEventListener("click", onLinkClick);
    chatEl = {
      submitUserMessage: (m) => {
        list.insertAdjacentHTML("beforeend", '<div class="fb-user">' + esc(m.text) + "</div>");
        const wait = document.createElement("div");
        wait.className = "fb-ai";
        wait.innerHTML = '<div class="oak-skel"></div><div class="oak-skel short"></div>';
        list.appendChild(wait);
        list.scrollTop = list.scrollHeight;
        ask(m.text).then((d) => reply(m.text, d)).then((html) => { wait.className = "fb-ai"; wait.innerHTML = html; })
          .catch((err) => { wait.className = "fb-ai fb-err"; wait.textContent = "The operator could not answer: " + err.message; })
          .finally(() => (list.scrollTop = list.scrollHeight));
      },
    };
  }

  // a clean thread: no persistence anywhere, Clear empties it and the API history
  function clear() {
    history.length = 0;
    linkStore = [];
    if (chatEl && chatEl.clearMessages) chatEl.clearMessages(true);
    const list = $("fb-list");
    if (list) list.innerHTML = '<div class="fb-intro">' + esc(INTRO) + "</div>";
  }

  function send(text) {
    if (!chatEl) return;
    if (chatEl.submitUserMessage) chatEl.submitUserMessage({ text: text });
    const inp = $("fb-in");
    if (inp) inp.value = "";
  }

  function init() {
    if (window.customElements && customElements.get("deep-chat")) mountDeepChat();
    else if (window.customElements) {
      // the module script may still be loading; fall back if it never arrives
      const t = setTimeout(() => { if (!chatEl) mountFallback(); }, 4000);
      customElements.whenDefined("deep-chat").then(() => { if (!chatEl) { clearTimeout(t); mountDeepChat(); } });
    } else mountFallback();
    // the chip row is rebuilt by learning.js when a ship is picked; one listener covers every version of it
    const row = $("chips");
    if (row) row.addEventListener("click", (e) => { const b = e.target.closest(".chip[data-q]"); if (b) send(b.dataset.q); });
    const clr = $("chat-clear");
    if (clr) clr.addEventListener("click", clear);
    const opt = $("opt-btn");
    if (opt) opt.addEventListener("click", () => send("Optimize my playbook now"));
    // the latest proposal of the run, if any: its card, and keep watching it while it verifies
    setTimeout(() => {
      const run = runForApi();
      fetch(ENDPOINT.replace(/\/chat\/?$/, "") + "/proposal?run=" + encodeURIComponent(run))
        .then((r) => (r.ok ? r.json() : null)).then((p) => { if (p && p.id != null) { if (p.status === "accepted" || p.status === "rejected") { watched[p.id] = 1; propCard(p); } else watchProposal(p, run); } })
        .catch(() => { /* no operator server: no cards */ });
    }, 1500);
    // Esc inside the chat returns focus to the scene
    $("learning").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const c = document.querySelector("#scene canvas");
        if (c) { c.setAttribute("tabindex", "-1"); c.focus(); }
      }
    });
  }

  window.OakChat = { send, clear, ask, stepsLine, answerHtml, resultHtml, addAi, reply, propCard, waiting };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
