"""Berth-time chart of a plan as a PNG (matplotlib, Agg backend) with a high-contrast control-room aesthetic.

Sections on the y axis (section 1 at the bottom), hours on the x axis, one box per ship labelled with id, name,
LOA/draught and crane profile. Includes ILWU shift markers, hatched shallow-draft blocks with draft limits,
vertical fog/bar closure bands ("FOG / BAR CLOSED"), crane outage indicators, waiting leader lines (ETA -> berth),
and a top KPI summary header. Crane tasks add a lower panel: cranes in use per hour against the pool. Ship calls are
GENERATED, not real records.
"""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

from .check import evaluate  # noqa: E402
from .model import Plan, Task  # noqa: E402
from .reward import grade  # noqa: E402
from .solve import berth_of, counts_of, max_draught, plan_to_rows, pool_at, run  # noqa: E402

# High-contrast maritime control-room vessel palette
COLORS = [
    "#38BDF8",  # cyan
    "#F59E0B",  # amber
    "#34D399",  # emerald
    "#A78BFA",  # violet
    "#FB7185",  # rose
    "#2DD4BF",  # teal
    "#FBBF24",  # yellow
    "#60A5FA",  # blue
    "#F472B6",  # pink
    "#4ADE80",  # green
]

BG_DARK = "#0B111E"
PANEL_BG = "#111A2E"
GRID_COL = "#1E2D4A"
TEXT_MAIN = "#E2E8F0"
TEXT_MUTED = "#94A3B8"
ACCENT_CYAN = "#38BDF8"
ALERT_RED = "#EF4444"
WARN_AMBER = "#F59E0B"
FOG_COL = "#64748B"


def _label(task: Task, s, counts: dict) -> str:
    if task.kind == "crane":
        c = f"C:{counts['day']}/{counts['night']}/{counts['hoot']}"
    else:
        c = f"C:{counts['day']}"
    loa = f"{int(round(s.length_m))}m" if getattr(s, "length_m", None) else ""
    dr = f"{s.draught_m:.1f}m" if getattr(s, "draught_m", None) is not None else ""
    dims = "/".join(x for x in (loa, dr) if x)
    line1 = f"#{s.id} {s.name}"
    line2 = " · ".join(x for x in (dims, c) if x)
    return f"{line1}\n{line2}" if line2 and s.sections >= 6 else f"{line1} ({line2})"


def render(task: Task, plan: Plan, path) -> None:
    """Write the high-contrast control-room chart of `plan` on `task` to `path` (PNG)."""
    rows = plan_to_rows(task, plan)
    placed = []
    for row in rows:
        s = task.ships[int(row["ship"])]
        h, sec = berth_of(task, row)
        counts = counts_of(task, row)
        _, dep, use = run(task, s, h, counts)
        placed.append((s, h, sec, dep, counts, use))
    horizon = max([dep for *_, dep, _, _ in placed] + [max(s.due, s.arrival + 1) for s in task.ships] + [24])
    horizon = max(horizon, task.horizon_h)
    crane = task.kind == "crane"

    res = evaluate(task, plan)
    gr = grade(task, plan)

    fig, axes = plt.subplots(
        2 if crane else 1,
        1,
        figsize=(max(13.5, horizon / 12.5), 7.8 if crane else 6.2),
        sharex=True,
        gridspec_kw={"height_ratios": [3.2, 1.0]} if crane else None,
        squeeze=False,
        facecolor=BG_DARK,
    )
    ax = axes[0][0]
    ax.set_facecolor(PANEL_BG)
    lo, hi = task.first_section, task.last_section

    # Subtle grid and ILWU shift background markers (hoot 03-08, day 08-17, meal 17-18, night 18-03)
    for d in range(0, horizon + 24, 24):
        # Hoot shift band (03:00-08:00)
        if d + 3 < horizon:
            ax.axvspan(d + 3, min(horizon, d + 8), color="#1E1B4B", alpha=0.28, lw=0)
            if d == 0:
                ax.text(d + 5.5, hi + 0.35, "HOOT 03-08", color="#818CF8", fontsize=5.5, ha="center", va="bottom",
                        fontweight="bold")
        if d + 8 < horizon and d == 0:
            ax.text(d + 12.5, hi + 0.35, "DAY 08-17", color=TEXT_MUTED, fontsize=5.5, ha="center", va="bottom")
        if d + 18 < horizon and d == 0:
            ax.text(d + 21.0, hi + 0.35, "NIGHT 18-03", color=TEXT_MUTED, fontsize=5.5, ha="center", va="bottom")
        # Meal hour marker (17:00-18:00)
        for m in task.rules.get("meal_hours", [17]):
            if d + m < horizon:
                ax.axvspan(d + m, min(horizon, d + m + 1), color=WARN_AMBER, alpha=0.10, lw=0)
        # Day boundary line
        if 0 < d < horizon:
            ax.axvline(d, color=GRID_COL, lw=0.9, ls="--", alpha=0.8)

    # Vertical fog / bar closure bands ("FOG / BAR CLOSED")
    for w in task.rules.get("no_moves", []):
        w_start, w_end = w["start"], min(horizon, w["end"])
        if w_end <= w_start:
            continue
        ax.axvspan(w_start, w_end, color=FOG_COL, alpha=0.28, hatch="\\\\", edgecolor="#94A3B8", lw=0.8)
        mid_x = 0.5 * (w_start + w_end)
        lbl = (w.get("label") or "FOG / BAR CLOSED").upper()
        if "FOG" not in lbl and "BAR" not in lbl and "STORM" not in lbl:
            lbl = f"FOG / BAR CLOSED ({lbl})"
        else:
            lbl = "FOG / BAR CLOSED" if "FOG" in lbl else lbl
        ax.text(
            mid_x,
            lo + 0.5 * (hi - lo),
            lbl,
            color="#F8FAFC",
            fontsize=6.5,
            fontweight="bold",
            rotation=90,
            ha="center",
            va="center",
            bbox={"boxstyle": "round,pad=0.2", "facecolor": "#1E293B", "edgecolor": "#94A3B8", "alpha": 0.85, "lw": 0.7},
        )

    # Crane outage indicators along the top of the berth chart
    for out in task.rules.get("crane_outages", []):
        o_start, o_end = out["start"], min(horizon, out["end"])
        if o_end <= o_start:
            continue
        k = out.get("cranes", 1)
        ax.axvspan(o_start, o_end, ymin=0.93, ymax=1.0, color=ALERT_RED, alpha=0.35, lw=0)
        ax.plot([o_start, o_end], [hi + 0.15, hi + 0.15], color=ALERT_RED, lw=2.2)
        ax.text(
            0.5 * (o_start + o_end),
            hi - 0.35,
            f"CRANE OUTAGE (-{k} QC)",
            color="#FCA5A5",
            fontsize=5.8,
            fontweight="bold",
            ha="center",
            va="top",
            bbox={"boxstyle": "round,pad=0.15", "facecolor": "#450A0A", "edgecolor": ALERT_RED, "alpha": 0.85, "lw": 0.6},
        )

    # Blocks: shallow-draft hatched blocks with draft limits, closed sections, and alongside vessels at t=0
    for b in task.blocks:
        end = min(b.end, horizon)
        if end <= b.start:
            continue
        height = b.last - b.first + 1
        if b.kind == "shallow":
            dr_lim = max_draught(b)
            ax.add_patch(
                Rectangle(
                    (b.start, b.first - 0.5),
                    end - b.start,
                    height,
                    facecolor="#0EA5E9",
                    alpha=0.10,
                    hatch="..",
                    edgecolor="#38BDF8",
                    lw=0.8,
                )
            )
            lbl = f"SHALLOW DRAFT (MAX {dr_lim:.1f}m / 42ft)" if dr_lim else f"SHALLOW ({b.label})"
            ax.text(
                b.start + 1.5,
                b.first - 0.5 + 0.5 * height,
                lbl,
                color="#7DD3FC",
                fontsize=6.0,
                fontweight="bold",
                va="center",
                ha="left",
                clip_on=True,
            )
        elif b.kind == "closed":
            ax.add_patch(
                Rectangle(
                    (b.start, b.first - 0.5),
                    end - b.start,
                    height,
                    facecolor=ALERT_RED,
                    alpha=0.18,
                    hatch="//",
                    edgecolor=ALERT_RED,
                    lw=1.0,
                )
            )
            ax.text(
                0.5 * (b.start + end),
                b.first - 0.5 + 0.5 * height,
                f"CLOSED: {(b.label or 'MAINTENANCE').upper()}",
                color="#FECACA",
                fontsize=6.0,
                fontweight="bold",
                va="center",
                ha="center",
                clip_on=True,
            )
        else:
            ax.add_patch(
                Rectangle(
                    (b.start, b.first - 0.5),
                    end - b.start,
                    height,
                    facecolor="#475569",
                    alpha=0.45,
                    hatch="//",
                    edgecolor="#94A3B8",
                    lw=0.8,
                )
            )
            ax.text(
                b.start + 0.6,
                b.first - 0.5 + 0.5 * height,
                f"ALONGSIDE: {b.label}",
                color=TEXT_MAIN,
                fontsize=5.5,
                va="center",
                ha="left",
                clip_on=True,
            )

    # Ships: waiting leader lines (ETA -> berth) and vessel rectangles with LOA/draft/crane labels
    for s, h, sec, dep, counts, _ in placed:
        late = dep > s.due
        col = COLORS[s.id % len(COLORS)]
        mid_y = sec - 0.5 + 0.5 * s.sections

        # Waiting leader line from arrival (ETA) to berth_hour
        if h > s.arrival:
            ax.plot([s.arrival, h], [mid_y, mid_y], color=WARN_AMBER, lw=1.2, ls=":", zorder=4)
            ax.scatter([s.arrival], [mid_y], color=WARN_AMBER, s=14, marker=">", zorder=5)
            ax.text(
                0.5 * (s.arrival + h),
                mid_y + 0.35,
                f"WAIT +{h - s.arrival}h",
                color=WARN_AMBER,
                fontsize=5.2,
                fontweight="bold",
                ha="center",
                va="bottom",
                clip_on=True,
            )

        ax.add_patch(
            Rectangle(
                (h, sec - 0.5),
                dep - h,
                s.sections,
                facecolor=col,
                alpha=0.82,
                edgecolor=ALERT_RED if late else "#F8FAFC",
                lw=2.0 if late else 0.8,
                zorder=3,
            )
        )
        ax.text(
            h + 0.4,
            mid_y,
            _label(task, s, counts),
            color="#F8FAFC",
            fontsize=5.6,
            fontweight="bold",
            va="center",
            ha="left",
            bbox={"boxstyle": "round,pad=0.16", "facecolor": "#0B1120", "edgecolor": col, "alpha": 0.82, "lw": 0.6},
            clip_on=True,
            zorder=4,
        )

    ax.set_ylim(lo - 0.5, hi + 0.8)
    ax.set_xlim(0, horizon)
    ax.set_ylabel("Quay Section (42 m)", color=TEXT_MAIN, fontsize=8.5, fontweight="bold")
    ax.grid(True, color=GRID_COL, lw=0.5, alpha=0.55)
    ax.tick_params(colors=TEXT_MUTED, labelsize=7.5)
    for spine in ax.spines.values():
        spine.set_color(GRID_COL)

    # Top KPI summary header
    total_wait = sum(max(0, h - s.arrival) for s, h, *_ in placed)
    late_ships = sum(1 for s, _, _, dep, *_ in placed if dep > s.due)
    total_late_h = sum(max(0, dep - s.due) for s, _, _, dep, *_ in placed)
    status_str = "FEASIBLE" if res.feasible else f"INFEASIBLE ({len(res.violations)} VIOLATIONS)"
    cost_str = str(res.cost) if res.cost is not None else "N/A"
    opt_str = str(gr.optimal_cost) if gr.optimal_cost is not None else "N/A"
    kpi_header = (
        f"PORT OF OAKLAND CONTROL ROOM · {task.terminal.upper()} (BERTHS {task.quay}) · {task.kind.upper()} PLAN  |  "
        f"STATUS: {status_str} · REWARD: {gr.reward:.3f} · COST: {cost_str} (OPT {opt_str}) · "
        f"SHIPS: {len(placed)} · WAIT: {total_wait}h · LATE: {late_ships} ({total_late_h}h)"
    )
    ax.set_title(kpi_header, color=TEXT_MAIN, fontsize=8.2, fontweight="bold", pad=12, loc="left")

    if crane:
        cx = axes[1][0]
        cx.set_facecolor(PANEL_BG)
        use: dict[int, int] = {}
        for *_, u in placed:
            for t, c in u:
                use[t] = use.get(t, 0) + c
        hours = list(range(horizon))
        use_vals = [use.get(t, 0) for t in hours]
        pool_vals = [pool_at(task, t) for t in hours]
        cx.step(hours, use_vals, where="post", label="Cranes Working", color=ACCENT_CYAN, lw=1.4)
        cx.fill_between(hours, use_vals, step="post", color=ACCENT_CYAN, alpha=0.22)
        cx.step(hours, pool_vals, where="post", label="Available Pool (ILWU / Outages)", color=ALERT_RED, lw=1.2, ls="--")
        cx.set_ylabel("STS Cranes", color=TEXT_MAIN, fontsize=8, fontweight="bold")
        cx.grid(True, color=GRID_COL, lw=0.5, alpha=0.55)
        cx.tick_params(colors=TEXT_MUTED, labelsize=7.5)
        for spine in cx.spines.values():
            spine.set_color(GRID_COL)
        leg = cx.legend(fontsize=7, loc="upper right", facecolor=BG_DARK, edgecolor=GRID_COL, labelcolor=TEXT_MAIN)
        for text in leg.get_texts():
            text.set_color(TEXT_MAIN)

    axes[-1][0].set_xlabel("Simulation Hour (from Monday 00:00 Pacific · ILWU Shifts)", color=TEXT_MAIN, fontsize=8.5, fontweight="bold")
    fig.tight_layout()
    fig.savefig(path, dpi=120, facecolor=BG_DARK)
    plt.close(fig)


__all__ = ["render"]
