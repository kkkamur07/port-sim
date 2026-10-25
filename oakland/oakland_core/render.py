"""Berth-time chart of a plan as a PNG (matplotlib, Agg backend).

Sections on the y axis (section 1 at the bottom), hours on the x axis, one box per ship labelled "id name cranes".
Closed and shallow sections are hatched, no-movement windows (fog, storms) shaded grey, meal hours faint, ships that
leave late outlined red. Crane tasks add a lower panel: cranes in use per hour against the pool. Ship calls are
GENERATED, not real records.
"""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

from .model import Plan, Task, plan_to_list  # noqa: E402
from .solve import berth_of, counts_of, pool_at, run  # noqa: E402

COLORS = ["#4C78A8", "#F58518", "#54A24B", "#B279A2", "#72B7B2", "#EECA3B", "#9D755D", "#FF9DA6", "#79706E", "#E45756"]


def _label(task: Task, s, counts: dict) -> str:
    if task.kind == "crane":
        c = f"{counts['day']}/{counts['night']}/{counts['hoot']}"
    else:
        c = str(counts["day"])
    return f"{s.id} {s.name} {c}"


def render(task: Task, plan: Plan, path) -> None:
    """Write the chart of `plan` on `task` to `path` (PNG)."""
    rows = plan_to_list(plan)
    placed = []
    for row in rows:
        s = task.ships[int(row["ship"])]
        h, sec = berth_of(task, row)
        counts = counts_of(task, row)
        _, dep, use = run(task, s, h, counts)
        placed.append((s, h, sec, dep, counts, use))
    horizon = max([dep for *_, dep, _, _ in placed] + [max(s.due, s.arrival + 1) for s in task.ships] + [24])
    horizon = max(horizon, 168 * (2 if task.difficulty in ("storm", "extreme") else 1))
    crane = task.kind == "crane"
    fig, axes = plt.subplots(2 if crane else 1, 1, figsize=(max(12, horizon / 14), 7 if crane else 5.5), sharex=True,
                             gridspec_kw={"height_ratios": [3, 1]} if crane else None, squeeze=False)
    ax = axes[0][0]
    lo, hi = task.first_section, task.last_section
    for d in range(0, horizon + 24, 24):
        for m in task.rules.get("meal_hours", [17]):
            ax.axvspan(d + m, d + m + 1, color="#000000", alpha=0.04, lw=0)
    for w in task.rules.get("no_moves", []):
        ax.axvspan(w["start"], w["end"], color="#888888", alpha=0.3, lw=0)
    for b in task.blocks:
        end = min(b.end, horizon)
        ax.add_patch(Rectangle((b.start, b.first - 0.5), end - b.start, b.last - b.first + 1, fill=False,
                               hatch="//" if b.kind == "closed" else "..", edgecolor="#999999", lw=0.5))
    for s, h, sec, dep, counts, _ in placed:
        late = dep > s.due
        ax.add_patch(Rectangle((h, sec - 0.5), dep - h, s.sections, facecolor=COLORS[s.id % len(COLORS)], alpha=0.75,
                               edgecolor="#D62728" if late else "#333333", lw=2.0 if late else 0.6))
        ax.text(h + 0.5, sec - 0.5 + s.sections / 2, _label(task, s, counts), fontsize=6, va="center", clip_on=True)
    ax.set_ylim(lo - 0.5, hi + 0.5)
    ax.set_xlim(0, horizon)
    ax.set_ylabel("section (42 m)")
    ax.set_title(f"{task.task_id}: {task.terminal} berths {task.quay} (generated calls)", fontsize=9)
    if crane:
        cx = axes[1][0]
        use: dict[int, int] = {}
        for *_, u in placed:
            for t, c in u:
                use[t] = use.get(t, 0) + c
        hours = list(range(horizon))
        cx.step(hours, [use.get(t, 0) for t in hours], where="post", label="cranes in use", color="#4C78A8")
        cx.step(hours, [pool_at(task, t) for t in hours], where="post", label="pool", color="#D62728", lw=1)
        cx.set_ylabel("cranes")
        cx.legend(fontsize=7, loc="upper right")
    axes[-1][0].set_xlabel("hour from Monday 00:00 Pacific")
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


__all__ = ["render"]
