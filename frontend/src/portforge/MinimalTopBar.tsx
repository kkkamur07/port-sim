import { usePortForge } from "./PortForgeProvider";
import { DataConsole } from "./DataConsole";

/** Brand, agent mode and stream status only. Replaces the template's mock navigation, alerts and clock. */
export function MinimalTopBar() {
  const { state, connected } = usePortForge();
  const live = state?.agent_mode === "argon";
  return <header className="pf-topbar" style={{ height: "var(--hud-top)", paddingTop: "var(--sat)" }}>
    <img src="/icon.png" alt="" className="h-7 w-7 rounded-[8px]" />
    <div><strong>PortForge</strong><span>Self-improving port operations</span></div>
    <div className="ml-auto flex items-center gap-2">
      <DataConsole />
      <span className={`pf-pill ${live ? "live" : "mock"}`}>{live ? `Gemini · ${state?.model}` : "Mock mode · no API key"}</span>
      <span className={`pf-pill ${connected ? "" : "off"}`} title="Event stream connection (not the AI)"><i className={connected ? "on" : ""}/>{connected ? "Connected" : "Reconnecting"}</span>
    </div>
  </header>;
}
