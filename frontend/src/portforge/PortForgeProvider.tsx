import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PropsWithChildren } from "react";
import type { PortForgeEvent, PortForgeState, PortSnapshot, ReplayTrace } from "./types";

export interface EpochTally { epoch: number; decisions: number; rejected: number; testDecisions: number }

interface ReplayState { trace: ReplayTrace; index: number; playing: boolean; speed: number; view: "baseline" | "candidate" }

interface ContextValue {
  state: PortForgeState | null;
  events: PortForgeEvent[];
  connected: boolean;
  command: (path: string) => Promise<void>;
  replay: ReplayState | null;
  loadReplay: (epoch: number) => Promise<void>;
  closeReplay: () => void;
  setReplayIndex: (index: number) => void;
  toggleReplay: () => void;
  setReplaySpeed: (speed: number) => void;
  setReplayView: (view: "baseline" | "candidate") => void;
  tally: EpochTally;
  report: number | null;
  openReport: (epoch: number) => void;
  closeReport: () => void;
}

// "candidate" shows the AI Operator's real run on this epoch's scenario; candidate_frames are a rule-based rebuild.
export const replayFrames = (trace: ReplayTrace, view: "baseline" | "candidate") =>
  view === "baseline" ? trace.baseline_frames : trace.operator_frames?.length ? trace.operator_frames : trace.candidate_frames;

const Context = createContext<ContextValue | null>(null);

export function PortForgeProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<PortForgeState | null>(null);
  const [events, setEvents] = useState<PortForgeEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const [tally, setTally] = useState<EpochTally>({ epoch: 0, decisions: 0, rejected: 0, testDecisions: 0 });
  const [report, setReport] = useState<number | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/state");
    if (response.ok) setState(await response.json() as PortForgeState);
  }, []);

  useEffect(() => {
    void refresh();
    let socket: WebSocket | null = null;
    let retry = 0;
    let disposed = false;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/events`);
      socket.onopen = () => { setConnected(true); retry = 0; };
      socket.onmessage = (message) => {
        const event = JSON.parse(message.data) as PortForgeEvent;
        if (event.type === "snapshot") setState(event.payload as unknown as PortForgeState);
        else if (event.type === "simulation_tick") {
          const snapshot = event.payload.snapshot as PortSnapshot;
          const operational = (event.payload.events as Array<{ type: string; simulation_time: number; payload: Record<string, unknown> }> | undefined) ?? [];
          setState((current) => current ? { ...current, port: snapshot } : current);
          const rejected = operational.filter((item) => item.type === "decision_rejected").length;
          if (rejected) setTally((value) => ({ ...value, rejected: value.rejected + rejected }));
          if (operational.length) setEvents((list) => [
            ...operational.map((item) => ({ type: item.type, payload: { ...item.payload, simulation_time: item.simulation_time } })),
            ...list,
          ].slice(0, 80));
        } else {
          setEvents((list) => [event, ...list].slice(0, 80));
          if (event.type === "epoch_started") setTally({ epoch: Number(event.payload.epoch), decisions: 0, rejected: 0, testDecisions: 0 });
          else if (event.type === "operator_decision") setTally((value) => ({ ...value, decisions: value.decisions + 1 }));
          else if (event.type === "candidate_operator_decision") setTally((value) => ({ ...value, testDecisions: value.testDecisions + 1 }));
          else if (event.type === "epoch_completed") setReport(Number(event.payload.epoch));
          if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
          refreshTimer.current = window.setTimeout(() => void refresh(), 60);
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (!disposed) window.setTimeout(connect, Math.min(4000, 600 * ++retry));
      };
    };
    connect();
    const ping = window.setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send("ping"), 15000);
    return () => { disposed = true; window.clearInterval(ping); socket?.close(); };
  }, [refresh]);

  const command = useCallback(async (path: string) => {
    const response = await fetch(path, { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    await refresh();
  }, [refresh]);

  const loadReplay = useCallback(async (epoch: number) => {
    const response = await fetch(`/api/replays/${epoch}`);
    if (!response.ok) throw new Error(await response.text());
    setReplay({ trace: await response.json() as ReplayTrace, index: 0, playing: true, speed: 2, view: "candidate" });
  }, []);
  const closeReplay = useCallback(() => setReplay(null), []);
  const setReplayIndex = useCallback((index: number) => setReplay((value) => value ? { ...value, index, playing: false } : value), []);
  const toggleReplay = useCallback(() => setReplay((value) => value ? { ...value, playing: !value.playing } : value), []);
  const setReplaySpeed = useCallback((speed: number) => setReplay((value) => value ? { ...value, speed } : value), []);
  const setReplayView = useCallback((view: "baseline" | "candidate") => setReplay((value) => value ? { ...value, view, index: 0 } : value), []);

  useEffect(() => {
    if (!replay?.playing) return;
    const frames = replayFrames(replay.trace, replay.view);
    const timer = window.setInterval(() => setReplay((value) => {
      if (!value) return value;
      const next = value.index + 1;
      return next >= frames.length ? { ...value, playing: false } : { ...value, index: next };
    }), 240 / replay.speed);
    return () => window.clearInterval(timer);
  }, [replay?.playing, replay?.speed, replay?.view, replay?.trace]);

  const openReport = useCallback((epoch: number) => setReport(epoch), []);
  const closeReport = useCallback(() => setReport(null), []);

  const visibleState = useMemo(() => {
    if (!state || !replay) return state;
    const frames = replayFrames(replay.trace, replay.view);
    return { ...state, port: frames[Math.min(replay.index, frames.length - 1)] };
  }, [state, replay]);
  const value = useMemo(() => ({ state: visibleState, events, connected, command, replay, loadReplay, closeReplay, setReplayIndex, toggleReplay, setReplaySpeed, setReplayView, tally, report, openReport, closeReport }), [visibleState, events, connected, command, replay, loadReplay, closeReplay, setReplayIndex, toggleReplay, setReplaySpeed, setReplayView, tally, report, openReport, closeReport]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePortForge() {
  const value = useContext(Context);
  if (!value) throw new Error("usePortForge must be used inside PortForgeProvider");
  return value;
}
