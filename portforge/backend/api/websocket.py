from __future__ import annotations

import asyncio

from fastapi import WebSocket


class EventBroker:
    def __init__(self):
        self.connections: set[WebSocket] = set()
        self.recent: list[dict] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self.connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self.connections.discard(websocket)

    async def publish(self, event: dict) -> None:
        # Minute ticks are high-frequency transport, not durable audit events.
        if event.get("type") != "simulation_tick":
            self.recent.append(event)
            self.recent = self.recent[-1000:]
        dead = []
        for connection in list(self.connections):
            try:
                await connection.send_json(event)
            except Exception:
                dead.append(connection)
        async with self._lock:
            for connection in dead:
                self.connections.discard(connection)
