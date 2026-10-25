import { FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePortForge } from "./PortForgeProvider";
import { buildStory, fmt, pct } from "./story";

const H = 118, PAD = { l: 44, r: 18, t: 16, b: 22 };

/** Hill climb: each epoch the Supervisor proposes one step; only steps that go uphill (faster ships) are kept. */
export function HillClimb() {
  const { state, openReport } = usePortForge();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const records = state?.history ?? [];
  let best = 0;
  const points = records.map((r) => {
    const base = r.baseline_metrics.average_turnaround_time;
    const from = best;
    const tried = pct(base, r.candidate_metrics.average_turnaround_time);
    if (r.accepted) best = tried;
    const others = (r.candidates ?? []).filter((c) => !c.selected).map((c) => ({ index: c.index, gain: pct(base, c.metrics.average_turnaround_time), minutes: c.metrics.average_turnaround_time }));
    return { epoch: r.epoch, from, tried, best, accepted: r.accepted, minutes: r.candidate_metrics.average_turnaround_time, others };
  });
  const values = [0, ...points.flatMap((p) => [p.tried, p.best, ...p.others.map((o) => o.gain)])];
  const lo = Math.min(...values) - 6, hi = Math.max(...values, 10) + 10;
  const n = Math.max(points.length, 4);
  const x = (epoch: number) => PAD.l + (epoch / n) * (width - PAD.l - PAD.r);
  const y = (gain: number) => PAD.t + ((hi - gain) / (hi - lo)) * (H - PAD.t - PAD.b);
  const bestPath = points.reduce((d, p) => `${d} H${x(p.epoch)} V${y(p.best)}`, `M${x(0)} ${y(0)}`);
  const area = `${bestPath} H${x(points.at(-1)?.epoch ?? 0)} V${y(lo)} H${x(0)} Z`;
  const ticks = [0, Math.round(hi / 2 / 10) * 10, Math.floor(hi / 10) * 10].filter((v, i, a) => a.indexOf(v) === i && v > lo && v < hi);
  const latest = records.length && state ? buildStory(state, records.length - 1) : null;

  return <section className="panel pf-hill">
    <div className="pf-hill-chart">
      <div className="pf-hill-head">
        <div><p className="eyebrow">Hill climb</p><h2>Several ideas per epoch · the best one must go uphill to be kept</h2></div>
        <div className="pf-hill-legend"><span><i className="kept"/>kept</span><span><i className="rejected"/>rejected</span><span><i className="other"/>other ideas</span><span><i className="line"/>best so far</span></div>
      </div>
      <div ref={box} className="relative">
        {records.length ? <svg width={width} height={H} role="img" aria-label="Hill climb of turnaround improvement per epoch">
          {ticks.map((t) => <g key={t}><line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? "pf-axis-zero" : "pf-grid"}/><text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" className="pf-tick">{t === 0 ? "FCFS" : `+${t}%`}</text></g>)}
          <path d={area} className="pf-hill-area"/>
          <path d={bestPath} className="pf-hill-line"/>
          {points.map((p) => <line key={`a${p.epoch}`} x1={x(p.epoch - 1)} y1={y(p.from)} x2={x(p.epoch)} y2={y(p.tried)} className={`pf-attempt ${p.accepted ? "kept" : ""}`}/>)}
          <circle cx={x(0)} cy={y(0)} r={4} className="pf-start"/>
          {points.map((p) => <g key={p.epoch} className="pf-dot-group" onClick={() => openReport(p.epoch)}>
            <title>{`Epoch ${p.epoch}: ${fmt(p.minutes)} min per ship (${p.tried >= 0 ? "+" : ""}${fmt(p.tried)}% vs FCFS) · ${p.accepted ? "kept" : "rejected"}. Click for the report.`}</title>
            {p.others.map((o) => <circle key={o.index} cx={x(p.epoch)} cy={y(o.gain)} r={3} className="pf-dot other"><title>{`Epoch ${p.epoch}, idea ${String.fromCharCode(65 + o.index)}: ${fmt(o.minutes)} min per ship (not the best this epoch)`}</title></circle>)}
            <circle cx={x(p.epoch)} cy={y(p.tried)} r={12} fill="transparent"/>
            <circle cx={x(p.epoch)} cy={y(p.tried)} r={p.accepted ? 6 : 4.5} className={p.accepted ? "pf-dot kept" : "pf-dot rejected"}/>
            {p.accepted ? <text x={x(p.epoch)} y={y(p.tried) - 11} textAnchor="middle" className="pf-dot-label">+{fmt(p.tried)}%</text> : null}
          </g>)}
          {[0, ...points.map((p) => p.epoch)].map((e) => <text key={`x${e}`} x={x(e)} y={H - 6} textAnchor="middle" className="pf-tick">{e === 0 ? "start" : `E${e}`}</text>)}
        </svg> : <div className="grid place-items-center text-[11px] text-slate" style={{ height: H }}>Start the agents. Every idea they try will appear here as a dot.</div>}
      </div>
    </div>
    <div className="pf-hill-latest">
      {latest ? <>
        <p className="eyebrow">Latest · epoch {latest.record.epoch}</p>
        <p className={`pf-hill-verdict ${latest.record.accepted ? "kept" : "rejected"}`}>{latest.record.accepted ? "Kept" : "Rejected"}</p>
        <p className="text-[12px] leading-snug text-ink">{latest.headline}</p>
        <button onClick={() => openReport(latest.record.epoch)}><FileText size={12}/>What happened</button>
      </> : <p className="text-[11px] text-slate">The latest epoch's result will be explained here.</p>}
    </div>
  </section>;
}
