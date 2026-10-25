from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from portforge.backend.api.routes import build_router
from portforge.backend.api.websocket import EventBroker
from portforge.backend.improvement.improvement_loop import ImprovementLoop

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend" / "dist"

broker = EventBroker()
loop = ImprovementLoop(broker)
app = FastAPI(title="PortForge", version="1.0.0")
app.include_router(build_router(loop))
if FRONTEND.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND / "assets"), name="assets")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(FRONTEND / "index.html")


@app.get("/{path:path}", include_in_schema=False)
async def spa(path: str):
    asset = FRONTEND / path
    if path and asset.is_file():
        return FileResponse(asset)
    return FileResponse(FRONTEND / "index.html")


@app.websocket("/ws/events")
async def events(websocket: WebSocket):
    await broker.connect(websocket)
    try:
        await websocket.send_json({"type": "snapshot", "payload": loop.public()})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await broker.disconnect(websocket)
