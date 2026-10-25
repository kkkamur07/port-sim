/*
 * Ask the operator: the Deep Chat web component (deep-chat@2.5.0 from unpkg) in the right panel, wired to the chat
 * API (oakland/chat, POST http://127.0.0.1:8771/chat). The answer renders as text, then one muted line naming the
 * tools used, link chips that jump to an episode, ship and hour, and a small card for a what-if regrade.
 *   ?chat=<url>  another chat endpoint (default http://127.0.0.1:8771/chat); ?chatrun=<name> the run the server reads
 * Without the component (offline) a minimal list and input take its place.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const ENDPOINT = params.get("chat") || "http://127.0.0.1:8771/chat";
  const INTRO = "Ask me how the run is going, what the coach changed, why a ship is late, or what would happen if a ship berthed elsewhere.";
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
      body: JSON.stringify({ run: runForApi(), messages: msgs, episode: L() ? L().currentEpisode() : null }),
      signal: signal,
    }).then((r) => r.json().catch(() => ({ error: r.status + " " + r.statusText })).then((d) => {
      if (!r.ok || d.error) throw new Error(d.error || r.status + " " + r.statusText);
      history.push({ role: "user", content: text }, { role: "assistant", content: d.answer || "" });
      return d;
    }));
  }

  // "used improvement, coach_round(2)": tool names and their key argument values, no JSON
  function stepsLine(steps) {
    const seen = [];
    for (const st of steps || []) {
      const args = st.args && typeof st.args === "object" ? Object.values(st.args).filter((v) => v !== null && v !== "" && typeof v !== "object") : [];
      const t = st.tool + (args.length ? "(" + args.join(", ") + ")" : "");
      if (!seen.includes(t)) seen.push(t);
    }
    return seen.length ? "used " + seen.join(", ") : "";
  }

  let linkStore = [];
  function answerHtml(d) {
    const out = ['<div class="oak-ans">' + esc(d.answer || "").replace(/\n/g, "<br>") + "</div>"];
    const line = stepsLine(d.steps);
    if (line) out.push('<div class="oak-steps">' + esc(line) + "</div>");
    const links = Array.isArray(d.links) ? d.links : [];
    if (links.length) {
      const chips = links.slice(0, 6).map((lk) => {
        const i = linkStore.push(lk) - 1;
        const name = L() ? L().shipName(lk) : null;
        const label = (name ? name + " · " : "") + "episode " + lk.episode + (lk.hour != null ? " · h" + lk.hour : "");
        return '<button class="oak-link" data-link="' + i + '">' + esc(label) + "</button>";
      });
      out.push('<div class="oak-links">' + chips.join("") + "</div>");
    }
    const w = d.what_if;
    if (w && typeof w === "object" && !w.error) {
      const sub = w.submitted || {};
      const a = w.after || {};
      out.push('<div class="oak-whatif"><div class="oak-wi1">cost ' + esc(sub.cost) + " → " + esc(w.cost) + " · " + esc(w.violation_count || 0) +
        " violation" + (w.violation_count === 1 ? "" : "s") + " · " + (w.feasible ? "feasible" : "infeasible") + "</div>" +
        '<div class="oak-wi2">' + esc(w.name || "ship " + w.ship) + ": berth h" + esc(a.berth_hour) + ", section " + esc(a.section) + ", " + esc(a.cranes) +
        " cranes" + (typeof w.delta_reward === "number" ? ", reward " + (w.delta_reward >= 0 ? "+" : "") + w.delta_reward.toFixed(3) : "") + "</div>" +
        (w.plan ? '<button class="oak-link" data-whatif="1">show in 3D</button>' : "") + "</div>");
      const i = linkStore.push({ episode: w.episode, ship_id: w.ship, hour: a.berth_hour }) - 1;
      out.push('<div class="oak-links"><button class="oak-link" data-link="' + i + '">' + esc(w.name || "ship " + w.ship) + " in episode " + esc(w.episode) + "</button></div>");
    }
    return out.join("");
  }

  function onLinkClick(e) {
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
        shared: { bubble: { maxWidth: "100%", padding: "8px 12px", borderRadius: "4px", fontSize: "13px", lineHeight: "1.5", boxShadow: "none" }, outerContainer: { marginTop: "8px" } },
        user: { bubble: { backgroundColor: "transparent", color: "var(--text)", border: "1px solid var(--accent)" } },
        ai: { bubble: { backgroundColor: "transparent", color: "var(--text)", border: "1px solid var(--line)", padding: "8px 0 8px 12px", borderWidth: "0 0 0 2px", borderColor: "var(--line-strong)", borderRadius: "0" } },
      },
      loading: { message: { styles: { bubble: { backgroundColor: "transparent", border: "1px solid var(--line)" } } } },
      error: { bubble: { backgroundColor: "transparent", color: "var(--bad)", border: "1px solid var(--bad)", borderRadius: "4px" } },
      intro: { bubble: { backgroundColor: "transparent", color: "var(--muted)", border: "none", padding: "4px 0", fontSize: "13px" } },
    };
    el.inputAreaStyle = { backgroundColor: "transparent", padding: "8px 0 0", borderTop: "none" };
    el.textInput = {
      placeholder: { text: "Ask the operator", style: { color: "var(--muted)" } },
      styles: {
        container: { backgroundColor: "transparent", border: "1px solid var(--line-strong)", borderRadius: "4px", boxShadow: "none", width: "100%", margin: "0" },
        text: { color: "var(--text)", padding: "8px 40px 8px 12px", fontFamily: "var(--sans)", fontSize: "13px" },
        focus: { border: "1px solid var(--text)" },
      },
    };
    el.submitButtonStyles = {
      submit: { container: { default: { backgroundColor: "transparent", borderRadius: "4px" } }, svg: { styles: { default: { filter: "brightness(0) saturate(100%) invert(36%) sepia(76%) saturate(2400%) hue-rotate(355deg) brightness(91%) contrast(92%)" } } } },
      loading: { container: { default: { backgroundColor: "transparent" } } },
      stop: { container: { default: { backgroundColor: "transparent" } } },
    };
    el.htmlClassUtilities = {
      "oak-steps": { styles: { default: { color: "var(--muted)", fontSize: "11px", fontFamily: "var(--mono)", marginTop: "6px" } } },
      "oak-links": { styles: { default: { display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "8px" } } },
      "oak-link": {
        events: { click: onLinkClick },
        styles: {
          default: { font: "500 11px var(--mono)", color: "var(--text)", background: "transparent", border: "1px solid var(--line-strong)", borderRadius: "2px", padding: "3px 6px", cursor: "pointer" },
          hover: { borderColor: "var(--accent)" },
        },
      },
      "oak-whatif": { styles: { default: { marginTop: "8px", padding: "8px 10px", border: "1px solid var(--line-strong)", borderRadius: "4px" } } },
      "oak-wi1": { styles: { default: { font: "500 12px var(--mono)" } } },
      "oak-wi2": { styles: { default: { font: "11px var(--mono)", color: "var(--muted)", marginTop: "4px" } } },
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
        ask(String(last.text || ""), ctrl.signal)
          .then((d) => signals.onResponse({ html: answerHtml(d) }))
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
        wait.className = "fb-ai muted";
        wait.textContent = "Thinking";
        list.appendChild(wait);
        list.scrollTop = list.scrollHeight;
        ask(m.text).then((d) => { wait.className = "fb-ai"; wait.innerHTML = answerHtml(d); })
          .catch((err) => { wait.className = "fb-ai fb-err"; wait.textContent = "The operator could not answer: " + err.message; })
          .finally(() => (list.scrollTop = list.scrollHeight));
      },
    };
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
    document.querySelectorAll("#chips .chip").forEach((b) => b.addEventListener("click", () => send(b.dataset.q)));
    // Esc inside the chat returns focus to the scene
    $("learning").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const c = document.querySelector("#scene canvas");
        if (c) { c.setAttribute("tabindex", "-1"); c.focus(); }
      }
    });
  }

  window.OakChat = { send, ask, stepsLine, answerHtml };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
