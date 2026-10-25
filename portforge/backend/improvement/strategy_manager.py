from __future__ import annotations

from portforge.backend.agents.schemas import Metrics, Strategy


class StrategyManager:
    def __init__(self):
        self.baseline = Strategy()
        self.best = Strategy(
            control_mode="ai",
            label="AI operator v1",
            operating_instructions="Minimize total vessel turnaround. Re-evaluate berth and crane assignments at every operational event while preserving safety and fairness.",
        )
        self.best_metrics: Metrics | None = None
        self.versions: list[Strategy] = [self.best.model_copy(deep=True)]

    def consider(self, candidate: Strategy, candidate_metrics: Metrics) -> bool:
        if self.best_metrics is None:
            self.best_metrics = candidate_metrics
            self.best = candidate
            self.versions.append(candidate)
            return True
        improves_time = candidate_metrics.average_turnaround_time < self.best_metrics.average_turnaround_time - 0.05
        preserves_completion = candidate_metrics.completed_vessels >= self.best_metrics.completed_vessels
        if improves_time and preserves_completion:
            self.best = candidate
            self.best_metrics = candidate_metrics
            self.versions.append(candidate)
            return True
        return False

    def reset(self) -> None:
        self.__init__()

    def restore(self, best: dict | None, best_metrics: dict | None, versions: list[dict] | None) -> None:
        if best:
            self.best = Strategy.model_validate(best)
            if self.best.version > 1:
                self.best.control_mode = "ai"
        if best_metrics:
            self.best_metrics = Metrics.model_validate(best_metrics)
        if versions:
            self.versions = [Strategy.model_validate(item) for item in versions]
            for strategy in self.versions:
                if strategy.version > 1:
                    strategy.control_mode = "ai"
