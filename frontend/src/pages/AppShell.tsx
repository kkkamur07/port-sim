import { Suspense, lazy, useEffect } from "react";
import { BootScreen } from "@/components/BootScreen";
import { Outlet, useLocation } from "react-router-dom";
import { MinimalTopBar } from "@/portforge/MinimalTopBar";
import { usePort } from "@/state/PortProvider";
import { useBootRevealed } from "@/state/boot";
import { installTapHaptics } from "@/lib/haptics";

const PortScene = lazy(() => import("@/three/PortScene"));

/** Persistent 3D scene + top bar; routes render floating HUD panels into the Outlet. */
export default function AppShell() {
  const { pathname } = useLocation();
  const { closeOverride } = usePort();
  const isRevealed = useBootRevealed();

  useEffect(() => installTapHaptics(), []);

  useEffect(() => {
    closeOverride();
  }, [pathname, closeOverride]);

  return (
    <div className="pw-app relative w-full overflow-hidden bg-canvas">
      <div className="absolute inset-x-0 bottom-0 top-[var(--hud-top)]">
        <Suspense fallback={null}>
          <PortScene />
        </Suspense>
      </div>
      <MinimalTopBar />
      {/* HUD mounts as the boot screen lifts so its rise-in animations play in view. */}
      {isRevealed ? (
        <>
          <Outlet />
        </>
      ) : null}
      <BootScreen />
    </div>
  );
}
