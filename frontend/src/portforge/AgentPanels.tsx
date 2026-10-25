import { BrainCircuit, ChevronDown, ChevronUp, CirclePause, FileText, Gavel, Pause, Play, RotateCcw, Ship, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { HillClimb } from "./HillClimb";
import { replayFrames, usePortForge } from "./PortForgeProvider";
import { buildStory, describeEvent, fmt, pct, type Speaker } from "./story";
import type { AgentStatus } from "./types";

const STAGES = ["Generate challenge","Execute operator","Measure performance","Evaluate results","Propose improvement","Test candidate","Accept or reject","Next epoch"];
const STATUS_TEXT: Record<AgentStatus, string> = { thinking: "Thinking", executing: "Running", evaluating: "Evaluating", waiting: "Waiting", completed: "Idle" };
const isActive = (value?: AgentStatus) => value === "thinking" || value === "executing" || value === "evaluating";

function Status({ value }: { value?: AgentStatus }) {
  const active = isActive(value);
  return <span className={`flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wide ${value === "thinking" ? "border-signal/50 bg-signal-soft text-signal" : active ? "border-moss/40 bg-moss/10 text-moss" : "border-hairline bg-canvas text-slate"}`}><i className={`pf-orb ${value === "thinking" ? "thinking" : active ? "active" : ""}`}/>{STATUS_TEXT[value ?? "waiting"]}</span>;
}

function AgentHeader({ supervisor, status }: { supervisor: boolean; status?: AgentStatus }) {
  const { state } = usePortForge();
  return <header className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
    <span className={`pf-avatar ${isActive(status) ? "is-active" : ""} grid h-8 w-8 place-items-center rounded-full ${supervisor ? "bg-ink text-paper" : "bg-signal text-white"}`}>{supervisor ? <BrainCircuit className="h-4 w-4" /> : <Ship className="h-4 w-4" />}</span>
    <div className="min-w-0"><p className="eyebrow">Agent {supervisor ? "01" : "02"}{state?.agent_mode === "argon" ? "" : " · mock"}</p><h2 className="truncate text-[14px] font-extrabold text-ink">{supervisor ? "Supervisor" : "Port Operator"}</h2></div>
    <div className="ml-auto"><Status value={status} /></div>
  </header>;
}

function SupervisorCard() {
  const { state } = usePortForge();
  const [open, setOpen] = useState(false);
  if (!state) return <div className="panel h-28 animate-pulse bg-paper/80" />;
  return <section className="panel overflow-hidden">
    <AgentHeader supervisor status={state.evaluator.status} />
    <div className="px-3 py-2.5 text-[11.5px] leading-snug">
      <p className="eyebrow">Latest instruction to the Operator</p>
      <p className={`mt-0.5 text-ink/85 ${open ? "" : "line-clamp-2"}`}>{state.evaluator.proposal || "None yet"}</p>
      {state.evaluator.proposal ? <button className="mt-1 flex items-center gap-1 font-mono text-[9px] font-bold uppercase text-slate" onClick={() => setOpen((v) => !v)}>{open ? <ChevronUp size={11}/> : <ChevronDown size={11}/>}{open ? "Less" : "More"}</button> : null}
    </div>
  </section>;
}

function OperatorCard() {
  const { state, tally } = usePortForge();
  if (!state) return <div className="panel h-28 animate-pulse bg-paper/80" />;
  const decision = state.operator.latest_decision;
  const live = tally.epoch === state.epoch && state.status === "running";
  return <section className="panel overflow-hidden">
    <AgentHeader supervisor={false} status={state.operator.status} />
    <div className="px-3 py-2.5 text-[11.5px] leading-snug">
      <p className="eyebrow">Latest decision · plan v{state.operator.strategy.version}</p>
      <p className="mt-0.5 line-clamp-2 text-ink/85">{decision?.reasoning_summary ?? "No decision yet"}</p>
      {live ? <p className="mt-1.5 font-mono text-[9.5px] text-slate">{tally.decisions} decisions · <span className={tally.rejected ? "text-brick" : ""}>{tally.rejected} blocked</span> · {tally.testDecisions} in testing</p> : null}
    </div>
  </section>;
}

const SPEAKER: Record<Speaker, string> = { supervisor: "Supervisor", operator: "Operator", simulator: "Simulator", judge: "Judge", system: "System" };

function Conversation() {
  const { events } = usePortForge();
  const lines = useMemo(() => {
    const out = [];
    let progressShown = false;
    for (const event of events) {
      if (event.type === "benchmark_progress") { if (progressShown) continue; progressShown = true; }
      const line = describeEvent(event);
      if (line && out.at(-1)?.text !== line.text) out.push(line);
      if (out.length >= 5) break;
    }
    return out;
  }, [events]);
  return <section className="panel overflow-hidden">
    <header className="border-b border-hairline px-3 py-2"><p className="eyebrow">Agent conversation</p></header>
    <div className="pf-convo scroll-thin">{lines.length ? lines.map((line, i) => <div key={i} className={`pf-line ${line.speaker} ${line.tone ?? ""}`}><b>{SPEAKER[line.speaker]}</b><span>{line.text}</span></div>) : <em>Press Start to watch the agents talk.</em>}</div>
  </section>;
}

export function AgentStack() { return <div className="flex flex-col gap-2"><SupervisorCard /><OperatorCard /><Conversation /></div>; }

export function LoopPanel() {
  const { state, connected, command } = usePortForge();
  const [epochs, setEpochs] = useState(1);
  const running = state?.status === "running", paused = state?.status === "paused";
  const stage = state?.stage ?? 0;
  return <section className="panel overflow-hidden">
    <header className="flex items-center gap-2 border-b border-hairline px-3 py-2.5"><div><p className="eyebrow">Self-improvement loop</p><h2 className="text-[14px] font-extrabold">Epoch {state?.epoch ?? 0} · {running ? STAGES[stage] : paused ? "Paused" : state?.status === "completed" ? "Finished" : "Ready"}</h2></div><span title={connected ? "Event stream connected" : "Reconnecting"} className={`ml-auto h-2 w-2 rounded-full ${connected ? "bg-moss pw-blink" : "bg-brick"}`}/></header>
    <div className="p-3">
      <div className="pf-progress">{STAGES.map((label, i) => <i key={label} title={label} className={running || paused ? (i === stage ? "active" : i < stage ? "done" : "") : state?.status === "completed" ? "done" : ""}/>)}</div>
      {state?.current_operation ? <p className="mt-2 text-[10.5px] text-slate">{state.current_operation}{state.benchmark_progress.total && stage === 5 ? ` · ${state.benchmark_progress.completed}/${state.benchmark_progress.total} test scenarios done` : ""}</p> : null}
      <div className="mt-3 flex items-center gap-1.5">
        <select aria-label="Number of epochs" value={epochs} disabled={running || paused} onChange={(event) => setEpochs(Number(event.target.value))} className="pf-epoch-select"><option value={1}>1 epoch</option><option value={3}>3 epochs</option><option value={5}>5 epochs</option><option value={8}>8 epochs</option></select>
        <button onClick={() => void command(`/api/optimization/start?epochs=${epochs}`)} disabled={running||paused} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-signal px-2 py-2 text-[11px] font-bold text-white disabled:opacity-40"><Play className="h-3.5 w-3.5"/>{state?.history.length ? "Run more epochs" : "Start optimization"}</button>
        <button title={paused ? "Resume agents" : "Pause after current step"} onClick={() => void command(paused?"/api/optimization/resume":"/api/optimization/pause")} disabled={!running && !paused} className="grid h-9 w-9 place-items-center rounded-lg border border-hairline bg-paper disabled:opacity-35"><CirclePause className="h-3.5 w-3.5"/></button>
        <button title="Reset optimization history" onClick={() => { if (window.confirm("Clear all epochs and start from the baseline?")) void command("/api/optimization/reset"); }} className="grid h-9 w-9 place-items-center rounded-lg border border-hairline bg-paper"><RotateCcw className="h-3.5 w-3.5"/></button>
      </div>
    </div>
  </section>;
}

function Bar({ label, value, max, tone, note }: { label: string; value?: number; max: number; tone: "base" | "cand" | "best"; note?: string }) {
  return <div className="pf-bar-row"><span>{label}</span><div className="pf-bar-track"><i className={`pf-bar ${tone}`} style={{ width: value == null ? 0 : `${Math.max(4, (value / max) * 100)}%` }}/></div><b>{value == null ? "—" : `${fmt(value)}m`}</b>{note ? <small>{note}</small> : null}</div>;
}

export function ComparisonPanel() {
  const { state } = usePortForge();
  const b = state?.baseline_metrics, best = state?.best_metrics, last = state?.history.at(-1);
  const gain = b && best && state?.history.length ? pct(b.average_turnaround_time, best.average_turnaround_time) : null;
  const max = Math.max(b?.average_turnaround_time ?? 0, best?.average_turnaround_time ?? 0, 1);
  return <section className="panel overflow-hidden">
    <div className={`pf-hero ${gain != null && gain > 0.05 ? "positive" : ""}`}>
      <p className="eyebrow">Ship turnaround vs first-come-first-served</p>
      {gain != null ? <><strong>{gain > 0.05 ? `${fmt(gain)}% faster` : "No gain yet"}</strong><span>{b && best ? `${fmt(b.average_turnaround_time)} min → ${fmt(best.average_turnaround_time)} min per ship · ${state?.history.filter((r) => r.accepted).length}/${state?.history.length} ideas kept` : null}</span></> : <><strong>Not measured yet</strong><span>Run an epoch to get a real, measured answer</span></>}
    </div>
    <div className="space-y-2 px-3 py-3">
      <p className="eyebrow">Minutes per ship in port · lower is better</p>
      <Bar label="Baseline (FCFS)" value={b?.average_turnaround_time} max={max} tone="base" />
      <Bar label="Best AI plan" value={best?.average_turnaround_time} max={max} tone="best" />
      <p className="font-mono text-[8.5px] text-slate">Same 3 fixed scenarios for every plan</p>
    </div>
  </section>;
}

export function EpochStrip() { return <HillClimb />; }

export function EpochReport() {
  const { state, report, closeReport, loadReplay } = usePortForge();
  useEffect(() => {
    if (report == null) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && closeReport();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [report, closeReport]);
  if (!state || report == null) return null;
  const index = state.history.findIndex((r) => r.epoch === report);
  if (index < 0) return null;
  const s = buildStory(state, index), r = s.record;
  const max = Math.max(r.baseline_metrics.average_turnaround_time, r.previous_metrics.average_turnaround_time, r.candidate_metrics.average_turnaround_time, 1);
  return <div className="pf-report-backdrop" role="dialog" aria-modal="true" aria-label={`Epoch ${r.epoch} report`} onClick={closeReport}>
    <article className={`pf-report ${r.accepted ? "accepted" : "rejected"}`} onClick={(e) => e.stopPropagation()}>
      <header>
        <div><p className="eyebrow">Epoch {r.epoch} report · tested on "{r.scenario.name}"</p><h2>{s.headline}</h2></div>
        <button onClick={closeReport} aria-label="Close report"><X size={16}/></button>
      </header>
      <div className="pf-report-body">
        <section className="pf-step"><span><BrainCircuit size={14}/></span><div><h3>1 · What the Supervisor noticed</h3><p>{s.noticed}</p></div></section>
        <section className="pf-step"><span><FileText size={14}/></span><div><h3>2 · What it changed</h3>
          <div className="pf-diff"><div><small>Before · plan v{s.before.version}</small><p>{s.before.operating_instructions}</p></div><div><small>{(r.candidates?.length ?? 0) > 1 ? "Best idea tested" : "New idea"}</small><p>{s.changed}</p></div></div>
        </div></section>
        {(r.candidates?.length ?? 0) > 1 ? <section className="pf-step"><span><Sparkles size={14}/></span><div><h3>All ideas tested · minutes per ship on each fixed scenario</h3>
          <table className="pf-ideas"><thead><tr><th>Idea</th>{r.candidates![0].per_scenario.map((x) => <th key={x.scenario}>{x.scenario.replace("Benchmark / ", "")}</th>)}<th>Average</th></tr></thead>
          <tbody>{r.candidates!.map((c) => <tr key={c.index} className={c.selected ? "selected" : ""}><td><b>{String.fromCharCode(65 + c.index)}{c.selected ? " · best" : ""}</b><p className="line-clamp-2">{c.suggestion}</p></td>{c.per_scenario.map((x) => { const top = Math.min(...r.candidates!.map((o) => o.per_scenario.find((y) => y.scenario === x.scenario)?.average_turnaround_time ?? Infinity)); return <td key={x.scenario} className={x.average_turnaround_time === top ? "win" : ""}>{fmt(x.average_turnaround_time)}{x.completed_vessels < x.total_vessels ? `*` : ""}</td>; })}<td>{fmt(c.metrics.average_turnaround_time)}</td></tr>)}</tbody></table>
          <p className="text-[10.5px] text-slate">Green marks the fastest idea on each scenario. * means not every ship finished. The best average then has to beat the current plan ({fmt(r.previous_metrics.average_turnaround_time)} min).</p>
        </div></section> : null}
        <section className="pf-step"><span><Ship size={14}/></span><div><h3>3 · What happened when the Operator tried it</h3>
          <div className="space-y-1.5 py-1"><Bar label="FCFS baseline" value={r.baseline_metrics.average_turnaround_time} max={max} tone="base"/><Bar label="Plan to beat" value={r.previous_metrics.average_turnaround_time} max={max} tone="best"/><Bar label="New idea" value={r.candidate_metrics.average_turnaround_time} max={max} tone="cand"/></div>
          <p>{s.result}</p>{s.mistakes.sentence ? <p className="mt-1.5">{s.mistakes.sentence}</p> : null}
        </div></section>
        <section className="pf-step"><span><Gavel size={14}/></span><div><h3>4 · Verdict</h3><p className={r.accepted ? "font-bold text-moss" : "font-bold text-brick"}>{s.verdict}</p><p className="mt-1">{s.overall}</p></div></section>
      </div>
      <footer><span>Every number is measured by the port simulator, never typed in · {state.agent_mode === "argon" ? `agents: ${state.model}` : "agents: deterministic mock (no API key)"}</span><div className="flex gap-2">{r.accepted ? <button onClick={() => { closeReport(); void loadReplay(r.epoch); }}><Play size={12}/>Replay FCFS vs AI</button> : null}<button className="primary" onClick={closeReport}>Got it</button></div></footer>
    </article>
  </div>;
}

export function ReplayControls() {
  const { replay, closeReplay, setReplayIndex, toggleReplay, setReplaySpeed, setReplayView } = usePortForge();
  if (!replay) return null;
  const frames = replayFrames(replay.trace, replay.view);
  const frame = frames[Math.min(replay.index, frames.length - 1)];
  const done = frame?.vessels.filter((v) => v.status === "completed").length ?? 0, waiting = frame?.vessels.filter((v) => v.status === "waiting").length ?? 0;
  return <section className="pf-replay panel">
    <div><p className="eyebrow">Replay · Epoch {replay.trace.epoch}</p><strong>{replay.view === "baseline" ? "FCFS baseline" : "AI Operator live run"} · {done} done · {waiting} waiting</strong></div>
    <div className="pf-replay-switch"><button className={replay.view==="baseline"?"active":""} onClick={()=>setReplayView("baseline")}>FCFS baseline</button><button className={replay.view==="candidate"?"active":""} onClick={()=>setReplayView("candidate")}>AI Operator</button></div>
    <button onClick={toggleReplay} aria-label={replay.playing?"Pause replay":"Play replay"}>{replay.playing?<Pause size={13}/>:<Play size={13}/>}</button>
    <input aria-label="Replay timeline" type="range" min={0} max={Math.max(0,frames.length-1)} value={Math.min(replay.index,frames.length-1)} onChange={(e)=>setReplayIndex(Number(e.target.value))}/>
    <span className="pf-replay-time">{frame?.simulation_time ?? 0} min</span>
    <button onClick={()=>setReplaySpeed(replay.speed===4?1:replay.speed*2)}>{replay.speed}×</button>
    <button onClick={closeReplay} aria-label="Close replay"><X size={13}/></button>
  </section>;
}
