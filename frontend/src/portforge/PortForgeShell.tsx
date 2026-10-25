import { lazy, Suspense } from "react";
import { Activity, Radio, Waves } from "lucide-react";

import { AgentStack, ComparisonPanel, EpochStrip, LoopPanel, ReplayControls } from "./AgentPanels";
import { usePortForge } from "./PortForgeProvider";
import "./portforge.css";

const PortScene = lazy(() => import("@/three/PortScene"));

export function PortForgeShell() {
  const { connected, state } = usePortForge();
  const active = state?.status === "running";
  return (
    <main className="pf-shell">
      <div className="pf-scene" aria-label="Live 3D port simulation">
        <Suspense fallback={<div className="pf-loading">INITIALIZING PORT DIGITAL TWIN</div>}><PortScene /></Suspense>
      </div>
      <div className="pf-vignette" />
      <header className="pf-header">
        <div className="pf-brand"><span className="pf-mark"><Waves size={18} /></span><div><strong>PORTFORGE</strong><small>AUTONOMOUS OPERATIONS LAB</small></div></div>
        <div className="pf-head-metric"><span>EPOCH</span><b>{String(state?.epoch ?? 0).padStart(2, "0")}</b></div>
        <div className="pf-head-metric pf-strategy"><span>ACTIVE STRATEGY</span><b>V{state?.operator.strategy.version ?? 1} · {state?.operator.strategy.label ?? "FCFS baseline"}</b></div>
        <div className={`pf-mode ${state?.agent_mode === "argon" ? "is-argon" : ""}`}>{state?.agent_mode === "argon" ? state.model : "MOCK MODE · NO API KEY"}</div>
        <div className={`pf-connection ${connected ? "is-live" : ""}`}><Radio size={13}/>{connected ? "LIVE STREAM" : "RECONNECTING"}</div>
      </header>
      <aside className="pf-left"><AgentStack /></aside>
      <aside className="pf-right"><LoopPanel /><ComparisonPanel /></aside>
      <section className="pf-bottom"><EpochStrip /></section>
      <ReplayControls />
      <div className="pf-sim-tag"><Activity size={13}/><span>{active ? "SIMULATION RUNNING" : state?.status === "completed" ? "OPTIMIZATION COMPLETE" : "DIGITAL TWIN READY"}</span><i/><span>{state?.port?.simulation_minute ?? 0} SIM MIN</span></div>
    </main>
  );
}
