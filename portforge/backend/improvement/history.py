from __future__ import annotations

from portforge.backend.agents.schemas import EpochRecord


class HistoryStore:
    def __init__(self, records: list[dict] | None = None):
        self.records: list[EpochRecord] = [EpochRecord.model_validate(record) for record in (records or [])]

    def add(self, record: EpochRecord) -> None:
        self.records.append(record)

    def clear(self) -> None:
        self.records.clear()

    def public(self) -> list[dict]:
        return [record.model_dump(mode="json") for record in self.records]
