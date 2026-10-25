import { useEffect } from "react";
import { HudLayout } from "@/components/hud/HudLayout";
import { usePort } from "@/state/PortProvider";
import { AgentStack, ComparisonPanel, EpochReport, EpochStrip, LoopPanel, ReplayControls } from "@/portforge/AgentPanels";
import "@/portforge/portforge.css";

export default function Overview() {
  const { setPageSelection, setView } = usePort();
  useEffect(() => {
    setPageSelection(null);
    setView("overview");
  }, [setPageSelection, setView]);

  return <><HudLayout wideLeft left={<AgentStack />} right={<><LoopPanel /><ComparisonPanel /></>} bottom={<EpochStrip />} /><ReplayControls /><EpochReport /></>;
}
