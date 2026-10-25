import { useMemo, useState } from "react";
import { BarChart3, Check, Database, Radio, Ship, X, XCircle } from "lucide-react";
import { usePortForge } from "./PortForgeProvider";

type Tab = "starter" | "live" | "epochs" | "events" | "raw";
const tabs: Array<[Tab, string]> = [["starter", "Starter data"], ["live", "Live port"], ["epochs", "Epochs"], ["events", "Event log"], ["raw", "Raw state"]];
const value = (input: unknown) => input == null ? "—" : String(input);

function DataTable({ headers, rows }: { headers: string[]; rows: Array<Array<unknown>> }) {
  return <div className="pf-data-table-wrap"><table className="pf-data-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{value(cell)}</td>)}</tr>)}</tbody></table></div>;
}

export function DataConsole() {
  const { state, events } = usePortForge();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("starter");
  const accepted = state?.history.filter((item) => item.accepted).length ?? 0;
  const latestDelta = useMemo(() => {
    const last = state?.history.at(-1);
    if (!last) return null;
    return ((last.previous_metrics.average_turnaround_time - last.candidate_metrics.average_turnaround_time) / last.previous_metrics.average_turnaround_time) * 100;
  }, [state?.history]);

  return <>
    <button className="pf-data-launch" onClick={() => setOpen(true)}><Database size={14}/><span>Evidence console</span><b>{state?.history.length ?? 0} epochs</b></button>
    {open ? <div className="pf-data-backdrop" role="dialog" aria-modal="true" aria-label="PortForge evidence console">
      <section className="pf-data-console">
        <header><div><p className="eyebrow">Full experiment evidence</p><h2>Starter data → AI decisions → measured improvement</h2></div><div className="pf-data-summary"><span><b>{state?.ai_calls.completed ?? 0}</b>AI calls</span><span><b>{state?.history.length ?? 0}</b>epochs</span><span><b>{accepted}</b>accepted</span><span><b>{state?.best_metrics?.improvement_percentage.toFixed(1) ?? "0.0"}%</b>best gain</span></div><button aria-label="Close evidence console" onClick={() => setOpen(false)}><X size={16}/></button></header>
        <nav>{tabs.map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}{id === "events" ? <i>{events.length}</i> : null}</button>)}</nav>
        <main>
          {tab === "starter" ? <div className="pf-data-stack">
            <div className="pf-data-callout"><Database size={18}/><div><b>Fixed starter benchmark</b><p>The baseline and every AI candidate use the same scenarios, seeds, arrival schedules, and 720-minute horizon. Lower turnaround is better; completed vessel count cannot regress.</p></div></div>
            <h3>Baseline strategy</h3><DataTable headers={["Version", "Control", "Label", "Priority", "Crane policy", "Max cranes"]} rows={state ? [[state.starter_data.baseline_strategy.version, state.starter_data.baseline_strategy.control_mode, state.starter_data.baseline_strategy.label, state.starter_data.baseline_strategy.priority_rule, state.starter_data.baseline_strategy.crane_policy, state.starter_data.baseline_strategy.max_cranes_per_vessel]] : []}/>
            <h3>Benchmark scenarios</h3><DataTable headers={["Scenario", "Seed", "Horizon", "Vessels", "Arrival spread", "Cargo range", "Disruption"]} rows={(state?.starter_data.benchmark_scenarios ?? []).map((scenario) => [scenario.name, scenario.seed, `${scenario.horizon_minutes}m`, scenario.arrival_count, `${scenario.arrival_spread}m`, `${scenario.cargo_min}–${scenario.cargo_max}`, [...scenario.disabled_cranes, ...scenario.closed_berths].join(", ") || "None"])}/>
            <h3>Initial vessel manifest / current scenario</h3><DataTable headers={["Vessel", "Arrival", "Size", "Cargo", "Status", "Berth", "Cranes"]} rows={(state?.port?.vessels ?? []).map((vessel) => [vessel.id, `${vessel.arrival_time}m`, vessel.size, vessel.cargo_total, vessel.status, vessel.berth_id, vessel.assigned_cranes.join(", ") || "—"])}/>
          </div> : null}
          {tab === "live" ? <div className="pf-data-stack"><div className="pf-data-kpis"><span><small>Simulation minute</small><b>{state?.port?.simulation_time ?? 0}</b></span><span><small>Waiting</small><b>{state?.port?.vessels.filter((v) => v.status === "waiting").length ?? 0}</b></span><span><small>Working cranes</small><b>{state?.port?.cranes.filter((c) => c.vessel_id).length ?? 0}</b></span><span><small>Completed</small><b>{state?.port?.vessels.filter((v) => v.status === "completed").length ?? 0}</b></span></div><h3>Vessels</h3><DataTable headers={["Vessel", "Status", "Arrival", "Berth", "Cargo total", "Remaining", "Cranes", "Departure"]} rows={(state?.port?.vessels ?? []).map((v) => [v.id, v.status, v.arrival_time, v.berth_id, v.cargo_total, v.cargo_remaining.toFixed(1), v.assigned_cranes.join(", ") || "—", v.departure_time])}/><h3>Berths</h3><DataTable headers={["Berth", "Capacity", "Vessel", "Closed"]} rows={(state?.port?.berths ?? []).map((b) => [b.id, b.max_size, b.vessel_id, b.closed ? "YES" : "NO"])}/><h3>Cranes</h3><DataTable headers={["Crane", "Reach", "Vessel", "Disabled", "Rate/min"]} rows={(state?.port?.cranes ?? []).map((c) => [c.id, c.reachable_berths.join(", "), c.vessel_id, c.disabled ? "YES" : "NO", c.capacity_per_minute])}/></div> : null}
          {tab === "epochs" ? <div className="pf-data-stack"><div className="pf-data-kpis"><span><small>Baseline turnaround</small><b>{state?.baseline_metrics?.average_turnaround_time ?? "—"}m</b></span><span><small>Best AI turnaround</small><b>{state?.best_metrics?.average_turnaround_time ?? "—"}m</b></span><span><small>Total improvement</small><b>{state?.best_metrics?.improvement_percentage.toFixed(1) ?? "0.0"}%</b></span><span><small>Latest candidate</small><b>{latestDelta == null ? "—" : `${latestDelta > 0 ? "−" : "+"}${Math.abs(latestDelta).toFixed(1)}%`}</b></span></div>{state?.history.length ? [...state.history].reverse().map((record) => <article className="pf-epoch-detail" key={record.epoch}><div className="pf-epoch-title"><span>EPOCH {record.epoch}</span><b className={record.accepted ? "accepted" : "rejected"}>{record.accepted ? <Check size={12}/> : <XCircle size={12}/>} {record.accepted ? "ACCEPTED" : "REJECTED"}</b></div><h3>{record.scenario.name} · seed {record.scenario.seed}</h3><p><strong>Supervisor found:</strong> {record.evaluator_feedback}</p><p><strong>Instruction change:</strong> {record.proposed_modification}</p><DataTable headers={["Metric", "Previous", "Candidate", "Baseline"]} rows={[["Turnaround", `${record.previous_metrics.average_turnaround_time}m`, `${record.candidate_metrics.average_turnaround_time}m`, `${record.baseline_metrics.average_turnaround_time}m`], ["Waiting", `${record.previous_metrics.average_waiting_time}m`, `${record.candidate_metrics.average_waiting_time}m`, `${record.baseline_metrics.average_waiting_time}m`], ["Crane utilization", `${record.previous_metrics.crane_utilization}%`, `${record.candidate_metrics.crane_utilization}%`, `${record.baseline_metrics.crane_utilization}%`], ["Completed", record.previous_metrics.completed_vessels, record.candidate_metrics.completed_vessels, record.baseline_metrics.completed_vessels]]}/><p><strong>Strategy after epoch:</strong> V{record.strategy_after.version} · {record.strategy_after.label}<br/><span>{record.strategy_after.operating_instructions}</span></p></article>) : <div className="pf-data-empty"><BarChart3/><b>No completed epochs yet</b><span>Live results will appear here as soon as the current epoch finishes.</span></div>}</div> : null}
          {tab === "events" ? <div className="pf-event-console">{events.length ? events.map((event, index) => <article key={`${event.type}-${index}`}><Radio size={11}/><time>{event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : `T+${value(event.payload.simulation_time)}m`}</time><div><b>{event.type.replaceAll("_", " ")}</b><pre>{JSON.stringify(event.payload, null, 2)}</pre></div></article>) : <div className="pf-data-empty"><Radio/><b>No live events yet</b></div>}</div> : null}
          {tab === "raw" ? <pre className="pf-raw-state">{JSON.stringify(state, null, 2)}</pre> : null}
        </main>
      </section>
    </div> : null}
  </>;
}
