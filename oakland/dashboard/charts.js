/*
 * Small canvas chart helpers for the Oakland operations dashboard: line, bar, gantt and sparkline.
 * devicePixelRatio aware, axis labels, and a legend whose swatches are drawn with the real stroke or fill.
 * Classic script, no dependencies: exported as window.OakCharts.
 *
 * Each chart sets canvas._hit = function (x, y) -> tooltip text or null (CSS pixels), used by dashboard.js.
 */
(function () {
  "use strict";

  const THEME = {
    text: "#dbe3ec",
    muted: "#8796a8",
    grid: "rgba(255, 255, 255, 0.07)",
    axis: "rgba(255, 255, 255, 0.22)",
    bg: "#111926",
    font: '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontBold: '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  };
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // Size the backing store to the CSS box times devicePixelRatio; returns a context in CSS pixels.
  function setup(canvas, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(120, canvas.clientWidth || canvas.parentNode.clientWidth || 300);
    const h = cssHeight || canvas.clientHeight || 220;
    canvas.style.height = h + "px";
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = THEME.font;
    ctx.textBaseline = "middle";
    return { ctx: ctx, w: w, h: h };
  }

  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
  }

  function fmt(v) {
    if (v === null || v === undefined || !isFinite(v)) return "";
    if (Math.abs(v) >= 100 || Number.isInteger(v)) return String(Math.round(v));
    return Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/0$/, "");
  }

  function hourLabel(h) {
    return DAYS[Math.floor(h / 24) % 7] + " " + String(h % 24).padStart(2, "0") + ":00";
  }

  // Hour axis ticks: every 24 h labelled with the day name (hour 0 is Monday 00:00 Pacific).
  function hourTicks(x0, x1) {
    const span = x1 - x0;
    const step = span > 240 ? 48 : span > 48 ? 24 : 6;
    const out = [];
    for (let h = Math.ceil(x0 / step) * step; h <= x1; h += step) {
      out.push({ v: h, label: step >= 24 ? DAYS[Math.floor(h / 24) % 7] : String(h % 24).padStart(2, "0") });
    }
    return out;
  }

  // Legend row: items {name, color, kind: "line"|"dash"|"fill"|"hatch"|"band", fill}; returns height used.
  function legend(ctx, items, x, y, maxW) {
    let cx = x, cy = y + 7;
    ctx.font = THEME.font;
    for (const it of items) {
      const tw = ctx.measureText(it.name).width;
      const wItem = 18 + 6 + tw + 16;
      if (cx + wItem > x + maxW && cx > x) {
        cx = x;
        cy += 18;
      }
      swatch(ctx, it, cx, cy - 5, 18, 10);
      ctx.fillStyle = THEME.text;
      ctx.textAlign = "left";
      ctx.fillText(it.name, cx + 24, cy);
      cx += wItem;
    }
    return cy - y + 13;
  }

  function swatch(ctx, it, x, y, w, h) {
    ctx.save();
    if (it.kind === "line" || it.kind === "dash") {
      ctx.strokeStyle = it.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(it.kind === "dash" ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x, y + h / 2);
      ctx.lineTo(x + w, y + h / 2);
      ctx.stroke();
    } else if (it.kind === "hatch") {
      ctx.fillStyle = it.fill || "rgba(255, 90, 90, 0.12)";
      ctx.fillRect(x, y, w, h);
      hatch(ctx, x, y, w, h, it.color);
    } else {
      ctx.fillStyle = it.fill || it.color;
      ctx.fillRect(x, y, w, h);
      if (it.stroke) {
        ctx.strokeStyle = it.stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }
    }
    ctx.restore();
  }

  function hatch(ctx, x, y, w, h, color) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let d = -h; d < w; d += 6) {
      ctx.moveTo(x + d, y + h);
      ctx.lineTo(x + d + h, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function frame(ctx, area, xs, ys, opts) {
    // grid and y labels
    ctx.font = THEME.font;
    ctx.textAlign = "right";
    for (const t of ys.ticks) {
      const y = ys.map(t);
      ctx.strokeStyle = THEME.grid;
      ctx.beginPath();
      ctx.moveTo(area.x, Math.round(y) + 0.5);
      ctx.lineTo(area.x + area.w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = THEME.muted;
      ctx.fillText(fmt(t) + (opts.ySuffix || ""), area.x - 6, y);
    }
    // x labels
    ctx.textAlign = "center";
    for (const t of xs.ticks) {
      const x = xs.map(t.v);
      ctx.strokeStyle = THEME.grid;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, area.y);
      ctx.lineTo(Math.round(x) + 0.5, area.y + area.h);
      ctx.stroke();
      ctx.fillStyle = THEME.muted;
      ctx.fillText(t.label, x, area.y + area.h + 12);
    }
    ctx.strokeStyle = THEME.axis;
    ctx.beginPath();
    ctx.moveTo(area.x + 0.5, area.y);
    ctx.lineTo(area.x + 0.5, area.y + area.h + 0.5);
    ctx.lineTo(area.x + area.w, area.y + area.h + 0.5);
    ctx.stroke();
    if (opts.xLabel) {
      ctx.fillStyle = THEME.muted;
      ctx.fillText(opts.xLabel, area.x + area.w / 2, area.y + area.h + 28);
    }
    if (opts.yLabel) {
      ctx.save();
      ctx.translate(12, area.y + area.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = THEME.muted;
      ctx.fillText(opts.yLabel, 0, 0);
      ctx.restore();
    }
  }

  function scaleY(min, max, area, target) {
    if (max <= min) max = min + 1;
    const step = niceStep(max - min, target || 4);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { lo: lo, hi: hi, ticks: ticks, map: (v) => area.y + area.h - ((v - lo) / (hi - lo)) * area.h };
  }

  /*
   * line(canvas, {
   *   height, series: [{name, color, values: [y...], x: [x...], dash, step, fill, points, labels}],
   *   xMin, xMax, yMin, yMax, xTicks: "hours"|"index", xLabel, yLabel, ySuffix, bands: [{start, end, color, name}],
   *   xFormat: fn(x) -> text for tooltips
   * })
   */
  function line(canvas, o) {
    const s = setup(canvas, o.height || 220);
    const ctx = s.ctx;
    const pad = { l: o.yLabel ? 52 : 40, r: 18, t: 10, b: o.xLabel ? 40 : 26 };
    const legendItems = o.series.map((se) => ({ name: se.name, color: se.color, kind: se.dash ? "dash" : "line" }))
      .concat((o.bands || []).filter((b) => b.name).map((b) => ({ name: b.name, color: b.color, kind: "fill" })))
      .filter((it, i, arr) => arr.findIndex((o2) => o2.name === it.name) === i);
    const lh = legendItems.length > 1 || o.legend ? legend(ctx, legendItems, pad.l, pad.t, s.w - pad.l - pad.r) + 10 : 0;
    const area = { x: pad.l, y: pad.t + lh, w: s.w - pad.l - pad.r, h: s.h - pad.t - lh - pad.b };

    const xsOf = (se) => se.x || se.values.map((_, i) => i);
    let xMin = o.xMin, xMax = o.xMax, yMin = o.yMin, yMax = o.yMax;
    for (const se of o.series) {
      const xs = xsOf(se);
      se.values.forEach((v, i) => {
        if (v === null || v === undefined) return;
        if (o.xMin === undefined) xMin = xMin === undefined ? xs[i] : Math.min(xMin, xs[i]);
        if (o.xMax === undefined) xMax = xMax === undefined ? xs[i] : Math.max(xMax, xs[i]);
        if (o.yMin === undefined) yMin = yMin === undefined ? v : Math.min(yMin, v);
        if (o.yMax === undefined) yMax = yMax === undefined ? v : Math.max(yMax, v);
      });
    }
    if (xMin === undefined) { xMin = 0; xMax = 1; }
    if (yMin === undefined) { yMin = 0; yMax = 1; }
    if (xMax === xMin) { xMin -= 0.5; xMax += 0.5; }
    const ys = scaleY(yMin, yMax, area, o.yTicks || 4);
    const xmap = (v) => area.x + ((v - xMin) / (xMax - xMin)) * area.w;
    let xticks;
    if (o.xTicks === "hours") xticks = hourTicks(xMin, xMax);
    else {
      xticks = [];
      const st = Math.max(1, niceStep(xMax - xMin, 8));
      for (let v = Math.ceil(xMin); v <= xMax; v += st) xticks.push({ v: v, label: (o.xPrefix || "") + v });
    }

    for (const b of o.bands || []) {
      ctx.fillStyle = b.color;
      const x0 = xmap(Math.max(xMin, b.start)), x1 = xmap(Math.min(xMax, b.end));
      if (x1 > x0) ctx.fillRect(x0, area.y, x1 - x0, area.h);
    }
    frame(ctx, area, { ticks: xticks, map: xmap }, ys, o);

    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y - 6, area.w + 6, area.h + 7);
    ctx.clip();
    for (const se of o.series) {
      const xs = xsOf(se);
      const pts = [];
      se.values.forEach((v, i) => { if (v !== null && v !== undefined) pts.push([xmap(xs[i]), ys.map(v)]); });
      if (!pts.length) continue;
      if (se.fill) {
        ctx.fillStyle = se.fill;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], ys.map(ys.lo));
        pts.forEach((p, i) => {
          if (se.step && i > 0) ctx.lineTo(p[0], pts[i - 1][1]);
          ctx.lineTo(p[0], p[1]);
        });
        ctx.lineTo(pts[pts.length - 1][0], ys.map(ys.lo));
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = se.color;
      ctx.lineWidth = se.width || 2;
      ctx.lineJoin = "round";
      ctx.setLineDash(se.dash ? [5, 4] : []);
      ctx.beginPath();
      pts.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p[0], p[1]);
        else {
          if (se.step) ctx.lineTo(p[0], pts[i - 1][1]);
          ctx.lineTo(p[0], p[1]);
        }
      });
      ctx.stroke();
      ctx.setLineDash([]);
      if (se.points) {
        for (const p of pts) {
          ctx.fillStyle = THEME.bg;
          ctx.beginPath();
          ctx.arc(p[0], p[1], 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = se.color;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }
    ctx.restore();
    // value labels: one style for every labelled point (above the point, in the series colour)
    for (const se of o.series) {
      if (!se.labels) continue;
      const xs = xsOf(se);
      ctx.font = THEME.fontBold;
      ctx.textAlign = "center";
      ctx.fillStyle = se.color;
      se.values.forEach((v, i) => {
        if (v === null || v === undefined) return;
        ctx.fillText(fmt(v), xmap(xs[i]), ys.map(v) - 12);
      });
    }

    canvas._hit = function (mx, my) {
      if (mx < area.x || mx > area.x + area.w || my < area.y || my > area.y + area.h) return null;
      const xv = xMin + ((mx - area.x) / area.w) * (xMax - xMin);
      const lines = [];
      let head = null;
      for (const se of o.series) {
        const xs = xsOf(se);
        let bi = -1, bd = Infinity;
        xs.forEach((x, i) => { const d = Math.abs(x - xv); if (d < bd) { bd = d; bi = i; } });
        if (bi < 0) continue;
        if (head === null) head = o.xFormat ? o.xFormat(xs[bi]) : String(xs[bi]);
        lines.push(se.name + ": " + fmt(se.values[bi]) + (o.ySuffix || ""));
      }
      return head === null ? null : head + "\n" + lines.join("\n");
    };
  }

  /*
   * bar(canvas, {height, categories: [..], series: [{name, color, values: [..]}], yLabel, ySuffix})
   * Value labels are always above the bar, in the muted text colour.
   */
  function bar(canvas, o) {
    const s = setup(canvas, o.height || 200);
    const ctx = s.ctx;
    const pad = { l: o.yLabel ? 52 : 40, r: 18, t: 10, b: 26 };
    const lh = o.series.length > 1 ? legend(ctx, o.series.map((se) => ({ name: se.name, color: se.color, kind: "fill" })), pad.l, pad.t, s.w - pad.l - pad.r) + 10 : 0;
    const area = { x: pad.l, y: pad.t + lh + 14, w: s.w - pad.l - pad.r, h: s.h - pad.t - lh - 14 - pad.b };
    let max = 0;
    for (const se of o.series) for (const v of se.values) max = Math.max(max, v || 0);
    const ys = scaleY(0, max || 1, area, 4);
    const n = o.categories.length;
    const gw = area.w / n;
    const bw = Math.min(46, (gw * 0.7) / o.series.length);
    const xticks = o.categories.map((c, i) => ({ v: i, label: c }));
    frame(ctx, area, { ticks: xticks, map: (i) => area.x + gw * (i + 0.5) }, ys, o);
    const rects = [];
    o.categories.forEach((c, i) => {
      const gx = area.x + gw * (i + 0.5) - (bw * o.series.length) / 2;
      o.series.forEach((se, j) => {
        const v = se.values[i] || 0;
        const y = ys.map(v), y0 = ys.map(0);
        const x = gx + j * bw;
        ctx.fillStyle = se.color;
        ctx.fillRect(x + 1, y, bw - 2, y0 - y);
        ctx.font = THEME.fontBold;
        ctx.textAlign = "center";
        ctx.fillStyle = THEME.text;
        ctx.fillText(fmt(v) + (o.ySuffix || ""), x + bw / 2, y - 9);
        rects.push({ x: x, y: y, w: bw, h: y0 - y, text: c + "\n" + se.name + ": " + fmt(v) + (o.ySuffix || "") });
      });
    });
    canvas._hit = function (mx, my) {
      for (const r of rects) if (mx >= r.x && mx <= r.x + r.w && my >= r.y - 14 && my <= r.y + r.h) return r.text;
      return null;
    };
  }

  /*
   * gantt(canvas, {
   *   first, last (sections), horizon,
   *   bars: [{first, last, start, end, due, color, label, tip}],
   *   blocks: [{first, last, start, end, kind, label}],   // kind "closed" hatched, "shallow" tinted
   *   fog: [{start, end, label}],
   *   legend: [{name, color, kind, fill}]
   * })
   * Sections on y (section 1 at the top), hours on x; the part of a bar after its due hour is red.
   */
  function gantt(canvas, o) {
    const nSec = o.last - o.first + 1;
    const rowH = nSec > 30 ? 8 : nSec > 16 ? 12 : 18;
    const pad = { l: 52, r: 18, t: 10, b: 40 };
    // legend height first, on a measuring pass
    const probe = document.createElement("canvas").getContext("2d");
    const wGuess = Math.max(120, canvas.clientWidth || 300);
    const lhGuess = legend(probe, o.legend || [], pad.l, 0, wGuess - pad.l - pad.r) + 12;
    const s = setup(canvas, pad.t + lhGuess + nSec * rowH + pad.b);
    const ctx = s.ctx;
    const lh = legend(ctx, o.legend || [], pad.l, pad.t, s.w - pad.l - pad.r) + 12;
    const area = { x: pad.l, y: pad.t + lh, w: s.w - pad.l - pad.r, h: nSec * rowH };
    const xmap = (h) => area.x + (h / o.horizon) * area.w;
    const ymap = (sec) => area.y + (sec - o.first) * rowH;

    // fog windows: shaded full-height bands
    for (const f of o.fog || []) {
      ctx.fillStyle = "rgba(190, 205, 220, 0.13)";
      ctx.fillRect(xmap(f.start), area.y, xmap(f.end) - xmap(f.start), area.h);
    }
    // blocks
    for (const b of o.blocks || []) {
      const x = xmap(Math.max(0, b.start)), x1 = xmap(Math.min(o.horizon, b.end));
      const y = ymap(Math.max(o.first, b.first)), y1 = ymap(Math.min(o.last, b.last) + 1);
      if (b.kind === "shallow") {
        ctx.fillStyle = "rgba(120, 190, 255, 0.10)";
        ctx.fillRect(x, y, x1 - x, y1 - y);
      } else {
        ctx.fillStyle = "rgba(255, 90, 90, 0.10)";
        ctx.fillRect(x, y, x1 - x, y1 - y);
        hatch(ctx, x, y, x1 - x, y1 - y, "rgba(255, 110, 110, 0.55)");
      }
    }
    // grid
    ctx.font = THEME.font;
    const step = nSec > 30 ? 5 : nSec > 16 ? 2 : 1;
    ctx.textAlign = "right";
    for (let sec = o.first; sec <= o.last; sec++) {
      if ((sec - o.first) % step !== 0 && sec !== o.last) continue;
      ctx.fillStyle = THEME.muted;
      ctx.fillText(String(sec), area.x - 6, ymap(sec) + rowH / 2);
    }
    const ticks = hourTicks(0, o.horizon);
    ctx.textAlign = "center";
    for (const t of ticks) {
      const x = Math.round(xmap(t.v)) + 0.5;
      ctx.strokeStyle = THEME.grid;
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, area.y + area.h);
      ctx.stroke();
      ctx.fillStyle = THEME.muted;
      ctx.fillText(t.label, x, area.y + area.h + 12);
    }
    ctx.fillStyle = THEME.muted;
    ctx.fillText("hour of the week (Pacific)", area.x + area.w / 2, area.y + area.h + 28);
    ctx.save();
    ctx.translate(12, area.y + area.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("quay section", 0, 0);
    ctx.restore();
    ctx.strokeStyle = THEME.axis;
    ctx.strokeRect(area.x + 0.5, area.y + 0.5, area.w - 1, area.h - 1);

    // ship bars
    const rects = [];
    for (const b of o.bars) {
      const x = xmap(b.start), x1 = xmap(Math.min(o.horizon, b.end));
      const y = ymap(b.first) + 1, y1 = ymap(b.last + 1) - 1;
      ctx.fillStyle = b.color;
      ctx.fillRect(x, y, x1 - x, y1 - y);
      if (b.due !== undefined && b.end > b.due) {
        const xd = xmap(Math.max(b.start, b.due));
        ctx.fillStyle = "#ff4d4d";
        ctx.fillRect(xd, y, x1 - xd, y1 - y);
      }
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, x1 - x - 1, y1 - y - 1);
      rects.push({ x: x, y: y, w: x1 - x, h: y1 - y, tip: b.tip || b.label });
    }
    // bar labels: every label in the same style, white with a dark halo, inside the bar, only if it fits
    ctx.font = THEME.fontBold;
    ctx.textAlign = "left";
    for (let i = 0; i < o.bars.length; i++) {
      const r = rects[i];
      const label = o.bars[i].label;
      if (!label || r.h < 12) continue;
      const tw = ctx.measureText(label).width;
      if (tw + 8 > r.w) continue;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      ctx.strokeText(label, r.x + 4, r.y + r.h / 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, r.x + 4, r.y + r.h / 2);
    }

    canvas._hit = function (mx, my) {
      for (let i = rects.length - 1; i >= 0; i--) {
        const r = rects[i];
        if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return r.tip;
      }
      if (mx < area.x || mx > area.x + area.w || my < area.y || my > area.y + area.h) return null;
      const h = Math.floor(((mx - area.x) / area.w) * o.horizon);
      const sec = o.first + Math.floor((my - area.y) / rowH);
      for (const b of o.blocks || []) if (sec >= b.first && sec <= b.last && h >= b.start && h < b.end) return "section " + sec + ", " + hourLabel(h) + "\n" + b.label;
      for (const f of o.fog || []) if (h >= f.start && h < f.end) return hourLabel(h) + "\n" + (f.label || "fog");
      return null;
    };
  }

  // sparkline(canvas, values, color): a tiny unlabelled trend line for KPI tiles.
  function sparkline(canvas, values, color) {
    const s = setup(canvas, canvas.clientHeight || 28);
    const ctx = s.ctx;
    const vs = values.filter((v) => v !== null && v !== undefined);
    if (vs.length < 2) return;
    let lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
    if (hi === lo) { hi += 1; lo -= 1; }
    const xm = (i) => 2 + (i / (values.length - 1)) * (s.w - 4);
    const ym = (v) => s.h - 3 - ((v - lo) / (hi - lo)) * (s.h - 6);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      if (!started) { ctx.moveTo(xm(i), ym(v)); started = true; } else ctx.lineTo(xm(i), ym(v));
    });
    ctx.stroke();
  }

  window.OakCharts = { setup: setup, line: line, bar: bar, gantt: gantt, sparkline: sparkline, hourLabel: hourLabel, THEME: THEME };
})();
