from __future__ import annotations

from fastapi import APIRouter, HTTPException

from portforge.backend.improvement.improvement_loop import ImprovementLoop
from portforge.backend.simulation.scenarios import scenario_for_epoch


def build_router(loop: ImprovementLoop) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/state")
    async def state():
        return loop.public()

    @router.get("/metrics")
    async def metrics():
        return {
            "baseline": loop.baseline_metrics,
            "candidate": loop.current_metrics,
            "best": loop.strategies.best_metrics,
        }

    @router.get("/strategies")
    async def strategies():
        return {
            "baseline": loop.strategies.baseline,
            "best": loop.strategies.best,
            "versions": loop.strategies.versions,
        }

    @router.get("/history")
    async def history():
        return loop.history.public()

    @router.get("/replays")
    async def replays():
        return loop.public()["replays"]

    @router.get("/replays/{epoch}")
    async def replay(epoch: int):
        trace = loop.replays.get(str(epoch))
        if trace is None:
            raise HTTPException(404, "replay not found")
        return trace

    @router.post("/optimization/start")
    async def start(epochs: int = 8):
        if not 1 <= epochs <= 50:
            raise HTTPException(400, "epochs must be between 1 and 50")
        await loop.start(epochs)
        return {"ok": True, "status": loop.status}

    @router.post("/optimization/pause")
    async def pause():
        await loop.pause()
        return {"ok": True, "status": loop.status}

    @router.post("/optimization/resume")
    async def resume():
        await loop.resume()
        return {"ok": True, "status": loop.status}

    @router.post("/optimization/reset")
    async def reset():
        await loop.reset()
        return {"ok": True, "status": loop.status}

    @router.post("/scenarios/generate")
    async def generate():
        return scenario_for_epoch(loop.epoch + 1)

    @router.post("/simulation/compare")
    async def compare():
        baseline, previous, candidate = await __import__("asyncio").to_thread(
            loop.runner.compare, loop.strategies.best, loop.strategies.baseline
        )
        return {"baseline": baseline, "best": candidate, "reference": previous}

    return router
