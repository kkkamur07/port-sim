from __future__ import annotations

import json
from pathlib import Path


class PersistenceStore:
    """Atomic JSON persistence for demo history, strategies, metrics, and replays."""

    def __init__(self, path: Path | None = None):
        root = Path(__file__).resolve().parents[3]
        self.path = path or root / "data" / "portforge_state.json"

    def load(self) -> dict:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def save(self, payload: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, separators=(",", ":")))
        temporary.replace(self.path)

    def clear(self) -> None:
        if self.path.exists():
            self.path.unlink()


class MemoryPersistence:
    def load(self) -> dict:
        return {}

    def save(self, payload: dict) -> None:
        return None

    def clear(self) -> None:
        return None
