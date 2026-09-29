#!/usr/bin/env python3
import io
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

PALETTE = {
    "blue": "#0F4D92",
    "blue2": "#3775BA",
    "green": "#8BCF8B",
    "green2": "#AADCA9",
    "red": "#B64342",
    "red2": "#E9A6A1",
    "neutral": "#CFCECE",
    "gold": "#FFD166",
    "ink": "#272727",
}
plt.rcParams.update({
    "font.family": ["Microsoft YaHei", "Noto Sans CJK SC", "SimHei", "DejaVu Sans", "sans-serif"],
    "font.size": 12,
    "axes.spines.right": False,
    "axes.spines.top": False,
    "axes.linewidth": 1.8,
    "legend.frameon": False,
    "svg.fonttype": "none",
    "savefig.facecolor": "white",
})


def metric(agent, key, default=0.0):
    value = agent.get(key, default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def save_figure(fig, stem, output):
    fig.tight_layout(pad=1.6)
    png = io.BytesIO()
    svg = io.BytesIO()
    fig.savefig(png, format="png", dpi=120, bbox_inches="tight", pad_inches=0.08)
    fig.savefig(svg, format="svg", bbox_inches="tight", pad_inches=0.08)
    output[f"{stem}.png"] = png.getvalue()
    output[f"{stem}.svg"] = svg.getvalue()
    plt.close(fig)


def core_metrics(snapshot, output):
    summary = snapshot.get("summary", {})
    targets = float(snapshot.get("settings", {}).get("targetsPerAgent", 6) or 6)
    accessibility = min(100, float(summary.get("accessibilityMeanTargets", 0)) / max(1, targets) * 100)
    wayfinding = 100 / (1 + float(summary.get("wayfindingMeanConfusions", 0)))
    safety = 100 / (1 + float(summary.get("safetyMeanNearMisses", 0)) * 5)
    values = [accessibility, wayfinding, safety]
    labels = ["Facility\naccessibility", "Wayfinding\nclarity", "Environmental\nsafety"]
    fig, ax = plt.subplots(figsize=(8.8, 5.3))
    bars = ax.bar(labels, values, color=[PALETTE["blue"], PALETTE["green"], PALETTE["red2"]], edgecolor="black", linewidth=1.5)
    ax.set_ylim(0, 105)
    ax.set_ylabel("Normalized performance score")
    ax.set_title("Core Accessibility Performance after Multi-Agent Simulation", fontweight="bold", pad=14)
    ax.grid(axis="y", color="#E7E7E7", linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    for bar, value in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width()/2, value + 2, f"{value:.1f}", ha="center", va="bottom", fontweight="bold")
    save_figure(fig, "figure_01_core_metrics_120dpi", output)


def cohort_panels(snapshot, output):
    agents = snapshot.get("agents", [])
    cohorts = list(dict.fromkeys(a.get("cohort", "Unknown") for a in agents)) or ["Unknown"]
    reached, confusion, risk = [], [], []
    for cohort in cohorts:
        rows = [a for a in agents if a.get("cohort", "Unknown") == cohort]
        reached.append(np.mean([metric(a, "targetsReached") for a in rows]) if rows else 0)
        confusion.append(np.mean([metric(a, "confusions") for a in rows]) if rows else 0)
        risk.append(np.mean([metric(a, "nearMisses") for a in rows]) if rows else 0)
    fig, axes = plt.subplots(1, 3, figsize=(13.5, 4.4))
    panels = [
        (reached, "Mean reached facilities", PALETTE["blue"]),
        (confusion, "Mean confusion events", PALETTE["green"]),
        (risk, "Mean near-miss events", PALETTE["red"]),
    ]
    for ax, (values, title, color) in zip(axes, panels):
        bars = ax.bar(cohorts, values, color=color, edgecolor="black", linewidth=1.2)
        ax.set_title(title, fontweight="bold")
        ax.tick_params(axis="x", rotation=18)
        ymax = max(values + [0.1])
        ax.set_ylim(0, ymax * 1.25)
        for bar, value in zip(bars, values):
            ax.text(bar.get_x()+bar.get_width()/2, value + ymax*.04, f"{value:.2f}", ha="center", fontsize=10)
    fig.suptitle("Age-Cohort Differences in Simulated Tourism Performance", fontweight="bold", y=1.02)
    save_figure(fig, "figure_02_cohort_comparison_120dpi", output)


def history_figure(snapshot, output):
    history = snapshot.get("history", [])
    if not history:
        summary = snapshot.get("summary", {})
        history = [{"time": 0, **summary}, {"time": float(snapshot.get("settings", {}).get("durationSeconds", 60)), **summary}]
    time = np.array([float(row.get("time", 0))/60 for row in history])
    accessibility = np.array([float(row.get("accessibilityMeanTargets", 0)) for row in history])
    confusion = np.array([float(row.get("wayfindingMeanConfusions", 0)) for row in history])
    risk = np.array([float(row.get("safetyMeanNearMisses", 0)) for row in history])
    fig, axes = plt.subplots(3, 1, figsize=(9.2, 8.0), sharex=True)
    series = [(accessibility, PALETTE["blue"], "Mean reached facilities"), (confusion, PALETTE["green"], "Mean confusion events"), (risk, PALETTE["red"], "Mean near-miss events")]
    for ax, (values, color, ylabel) in zip(axes, series):
        ax.plot(time, values, color=color, linewidth=2.8)
        ax.fill_between(time, values, color=color, alpha=.16)
        ax.set_ylabel(ylabel)
        ax.grid(axis="y", color="#E7E7E7", linewidth=.8)
    axes[-1].set_xlabel("Simulated time (minutes)")
    axes[0].set_title("Dynamic Evolution of Accessibility, Wayfinding and Safety", fontweight="bold", pad=12)
    save_figure(fig, "figure_03_dynamic_metrics_120dpi", output)


def exposure_figure(snapshot, output):
    agents = snapshot.get("agents", [])
    data = np.array([[metric(a, "vehicleExposure"), metric(a, "obstacleExposure"), metric(a, "crowdExposure")] for a in agents], dtype=float)
    if not len(data):
        data = np.zeros((1, 3))
    labels = ["Vehicle", "Obstacle", "Crowd"]
    means = data.mean(axis=0)
    medians = np.median(data, axis=0)
    x = np.arange(3)
    fig, ax = plt.subplots(figsize=(8.8, 5.2))
    ax.bar(x-.18, means, .36, label="Mean", color=PALETTE["blue2"], edgecolor="black", linewidth=1.2)
    ax.bar(x+.18, medians, .36, label="Median", color=PALETTE["green2"], edgecolor="black", linewidth=1.2, hatch="//")
    ax.set_xticks(x, labels)
    ax.set_ylabel("Exposure proxy")
    ax.set_title("Environmental Risk Exposure Distribution", fontweight="bold", pad=12)
    ax.legend(ncol=2)
    ax.grid(axis="y", color="#E7E7E7", linewidth=.8)
    save_figure(fig, "figure_04_risk_exposure_120dpi", output)


def task_domain_figure(snapshot, output):
    rows = [row for row in snapshot.get("taskSummary", []) if row.get("level") == "domain"]
    order = ["accessibility", "wayfinding", "safety"]
    labels = ["Facility\naccessibility", "Road\nwayfinding", "Environmental\nsafety"]
    lookup = {row.get("key"): row for row in rows}
    completion = [float(lookup.get(key, {}).get("completionRate", 0)) * 100 for key in order]
    progress = [float(lookup.get(key, {}).get("meanProgress", 0)) * 100 for key in order]
    x = np.arange(3)
    fig, ax = plt.subplots(figsize=(9.4, 5.5))
    ax.bar(x-.19, completion, .38, label="Completed", color=[PALETTE["blue"], PALETTE["green"], PALETTE["red"]], edgecolor="black", linewidth=1.2)
    ax.bar(x+.19, progress, .38, label="Mean progress", color=PALETTE["neutral"], edgecolor="black", linewidth=1.2, hatch="//")
    ax.set_xticks(x, labels)
    ax.set_ylim(0, 105)
    ax.set_ylabel("Rate (%)")
    ax.set_title("Task Completion across the Three Core Indicators", fontweight="bold", pad=12)
    ax.legend(ncol=2)
    ax.grid(axis="y", color="#E7E7E7", linewidth=.8)
    save_figure(fig, "figure_05_task_domain_completion_120dpi", output)


def subtask_figure(snapshot, output):
    rows = [row for row in snapshot.get("taskSummary", []) if row.get("level") == "subtask"]
    if not rows:
        rows = [{"subtaskName": "No subtask data", "subtaskId": "none", "completionRate": 0, "domainId": "accessibility"}]
    rows = sorted(rows, key=lambda row: float(row.get("completionRate", 0)))
    labels = [str(row.get("subtaskName") or row.get("subtaskId"))[:28] for row in rows]
    values = [float(row.get("completionRate", 0)) * 100 for row in rows]
    colors = [{"accessibility": PALETTE["blue"], "wayfinding": PALETTE["green"], "safety": PALETTE["red2"]}.get(row.get("domainId"), PALETTE["neutral"]) for row in rows]
    fig, ax = plt.subplots(figsize=(10.8, max(5.5, len(rows)*.55)))
    bars = ax.barh(labels, values, color=colors, edgecolor="black", linewidth=1.0)
    ax.set_xlim(0, 105)
    ax.set_xlabel("Completion rate (%)")
    ax.set_title("Completion Performance of Reusable Agent Subtasks", fontweight="bold", pad=12)
    ax.grid(axis="x", color="#E7E7E7", linewidth=.8)
    for bar, value in zip(bars, values):
        ax.text(min(value + 1.2, 99), bar.get_y()+bar.get_height()/2, f"{value:.1f}", va="center", fontsize=9)
    save_figure(fig, "figure_06_subtask_comparison_120dpi", output)


def cohort_task_heatmap(snapshot, output):
    agents = snapshot.get("agents", [])
    cohorts = list(dict.fromkeys(agent.get("cohort", "Unknown") for agent in agents))
    domains = ["accessibility", "wayfinding", "safety"]
    matrix = np.zeros((len(cohorts), len(domains)))
    for row_index, cohort in enumerate(cohorts):
        for column_index, domain in enumerate(domains):
            rows = [agent for agent in agents if agent.get("cohort", "Unknown") == cohort and (agent.get("task") or {}).get("domainId") == domain]
            matrix[row_index, column_index] = np.mean([(agent.get("task") or {}).get("status") == "completed" for agent in rows]) * 100 if rows else 0
    fig, ax = plt.subplots(figsize=(8.4, max(4.4, len(cohorts)*1.0)))
    image = ax.imshow(matrix, cmap="YlGnBu", vmin=0, vmax=100, aspect="auto")
    ax.set_xticks(np.arange(3), ["Accessibility", "Wayfinding", "Safety"])
    ax.set_yticks(np.arange(len(cohorts)), cohorts)
    ax.set_title("Age Cohort × Core Indicator Completion Heatmap", fontweight="bold", pad=12)
    for row in range(matrix.shape[0]):
        for column in range(matrix.shape[1]):
            ax.text(column, row, f"{matrix[row,column]:.1f}%", ha="center", va="center", color="white" if matrix[row,column] > 55 else PALETTE["ink"], fontweight="bold")
    fig.colorbar(image, ax=ax, label="Completion rate (%)", shrink=.8)
    save_figure(fig, "figure_07_cohort_task_heatmap_120dpi", output)


def group_strategy_figure(snapshot, output):
    rows = [row for row in snapshot.get("taskSummary", []) if row.get("level") == "group" and row.get("key") != "unassigned"]
    if not rows:
        rows = [{"groupId": "Local/default", "key": "local", "completionRate": 0, "meanConfusions": 0}]
    labels = [str(row.get("groupId") or row.get("key")) for row in rows]
    completion = [float(row.get("completionRate", 0)) * 100 for row in rows]
    confusion = [float(row.get("meanConfusions", 0)) for row in rows]
    x = np.arange(len(rows))
    fig, axes = plt.subplots(2, 1, figsize=(11.2, 7.2), sharex=True)
    axes[0].bar(x, completion, color=PALETTE["blue2"], edgecolor="black", linewidth=1.0)
    axes[0].set_ylabel("Completion (%)")
    axes[0].set_ylim(0, 105)
    axes[0].grid(axis="y", color="#E7E7E7", linewidth=.8)
    axes[1].bar(x, confusion, color=PALETTE["gold"], edgecolor="black", linewidth=1.0)
    axes[1].set_ylabel("Mean confusion")
    axes[1].set_xticks(x, labels, rotation=35, ha="right")
    axes[1].grid(axis="y", color="#E7E7E7", linewidth=.8)
    axes[0].set_title("Performance of Group-Level LLM or Local Strategies", fontweight="bold", pad=12)
    save_figure(fig, "figure_08_group_strategy_performance_120dpi", output)


def additional_figures(snapshot, output):
    agents = snapshot.get("agents", [])
    cohorts = list(dict.fromkeys(a.get("cohort", "Unknown") for a in agents)) or ["Unknown"]
    grouped = {name: [a for a in agents if a.get("cohort", "Unknown") == name] for name in cohorts}

    def averages(key, scale=1.0):
        return [float(np.mean([metric(agent, key) for agent in grouped[name]])) / scale if grouped[name] else 0 for name in cohorts]

    specifications = [
        ("09_steps_recovery", "Step Passage and Recovery", "Mean events", [("Steps climbed", averages("stepsClimbed"), PALETTE["blue"]), ("Stuck recovery", averages("stuckRecoveries"), PALETTE["gold"])]),
        ("10_collision_avoidance", "Human-like Collision Avoidance", "Mean events", [("Agent avoidance", averages("agentAvoidances"), PALETTE["blue2"]), ("Obstacle reroute", averages("collisionAvoidances"), PALETTE["red2"])]),
        ("11_vehicle_exposure", "Vehicle Exposure and Near Misses", "Mean exposure", [("Vehicle exposure", averages("vehicleExposure"), PALETTE["gold"]), ("Near misses", averages("nearMisses"), PALETTE["red"])]),
        ("12_information_signs", "Information Density and Sign Detection", "Mean value", [("Information density", averages("meanInformationDensity"), PALETTE["green"]), ("Sign detections / 10", averages("signDetections", 10), PALETTE["blue"])]),
        ("13_rest_behavior", "Rest Behaviour by Cohort", "Mean value", [("Rest count", averages("rests"), PALETTE["green2"]), ("Rest seconds / 10", averages("restSeconds", 10), PALETTE["gold"])]),
        ("14_crowd_obstacle", "Crowd and Obstacle Exposure", "Mean exposure", [("Crowd exposure", averages("crowdExposure"), PALETTE["blue2"]), ("Obstacle exposure", averages("obstacleExposure"), PALETTE["red2"])]),
    ]
    x = np.arange(len(cohorts))
    for stem, title, ylabel, rows in specifications:
        fig, ax = plt.subplots(figsize=(9.4, 5.4))
        width = .72 / max(1, len(rows))
        for index, (label, values, color) in enumerate(rows):
            ax.bar(x + (index - (len(rows) - 1) / 2) * width, values, width, label=label, color=color, edgecolor="black", linewidth=1.1)
        ax.set_xticks(x, cohorts, rotation=20, ha="right")
        ax.set_ylabel(ylabel)
        ax.set_title(title, fontweight="bold", pad=12)
        ax.grid(axis="y", color="#E7E7E7", linewidth=.8)
        ax.legend(ncol=2)
        save_figure(fig, f"figure_{stem}_120dpi", output)

    completion = [metric(agent, "completionTime", -1) / 60 for agent in agents if metric(agent, "completionTime", -1) >= 0]
    fig, ax = plt.subplots(figsize=(8.8, 5.2))
    ax.hist(completion or [0], bins=[0, 5, 10, 15, 20, 25, 30, 40], color=PALETTE["blue2"], edgecolor="black")
    ax.set_title("Task Completion Time Distribution", fontweight="bold", pad=12)
    ax.set_xlabel("Minutes")
    ax.set_ylabel("Agents")
    ax.grid(axis="y", color="#E7E7E7", linewidth=.8)
    save_figure(fig, "figure_15_completion_time_histogram_120dpi", output)

    fig, ax = plt.subplots(figsize=(7.6, 5.6))
    ax.scatter([metric(agent, "meanInformationDensity") for agent in agents], [metric(agent, "confusions") for agent in agents], s=18, alpha=.45, color=PALETTE["blue"])
    ax.set_title("Information Density vs. Navigation Confusion", fontweight="bold", pad=12)
    ax.set_xlabel("Mean information density")
    ax.set_ylabel("Confusion events")
    ax.grid(color="#E7E7E7", linewidth=.8)
    save_figure(fig, "figure_16_information_confusion_scatter_120dpi", output)

    fig, ax = plt.subplots(figsize=(7.6, 5.6))
    ax.scatter([metric(agent, "riskAversion", .7) for agent in agents], [metric(agent, "nearMisses") + metric(agent, "vehicleExposure") / 10 for agent in agents], s=18, alpha=.45, color=PALETTE["red"])
    ax.set_title("Risk Aversion vs. Safety Exposure", fontweight="bold", pad=12)
    ax.set_xlabel("Risk aversion")
    ax.set_ylabel("Combined exposure")
    ax.grid(color="#E7E7E7", linewidth=.8)
    save_figure(fig, "figure_17_risk_exposure_scatter_120dpi", output)

    completed = sum(metric(agent, "completionTime", -1) >= 0 for agent in agents)
    exited = sum(agent.get("state") == "exited" for agent in agents)
    fig, ax = plt.subplots(figsize=(7.2, 5.6))
    ax.pie([completed, exited, max(0, len(agents) - exited)], labels=["Completed", "Exited", "Remaining"], autopct="%1.1f%%", colors=[PALETTE["green"], PALETTE["blue"], PALETTE["neutral"]], wedgeprops={"edgecolor": "black", "linewidth": 1})
    ax.set_title("Completion and Exit Composition", fontweight="bold", pad=12)
    save_figure(fig, "figure_18_completion_exit_donut_120dpi", output)

    summary = snapshot.get("summary", {})
    fig, ax = plt.subplots(figsize=(8.8, 5.2))
    ax.barh(["Vehicle exposure", "Obstacle exposure", "Near misses"], [float(summary.get("safetyMeanVehicleExposureSeconds", 0)), float(summary.get("safetyMeanObstacleExposureSeconds", 0)), float(summary.get("safetyMeanNearMisses", 0))], color=[PALETTE["gold"], PALETTE["red2"], PALETTE["red"]], edgecolor="black")
    ax.set_title("Environmental Safety Risk Components", fontweight="bold", pad=12)
    ax.grid(axis="x", color="#E7E7E7", linewidth=.8)
    save_figure(fig, "figure_19_safety_components_120dpi", output)

    core = [float(summary.get("accessibilityMeanTargets", 0)), 100 / (1 + float(summary.get("wayfindingMeanConfusions", 0))), 100 / (1 + float(summary.get("safetyMeanNearMisses", 0)) * 5)]
    fig, ax = plt.subplots(figsize=(9.2, 5.4))
    ax.plot(["Accessibility", "Wayfinding", "Safety"], core, marker="o", linewidth=3, color=PALETTE["blue"])
    ax.fill_between(range(3), core, alpha=.18, color=PALETTE["blue"])
    ax.set_title("Integrated Core-indicator Profile", fontweight="bold", pad=12)
    ax.grid(axis="y", color="#E7E7E7", linewidth=.8)
    save_figure(fig, "figure_20_integrated_indicator_profile_120dpi", output)

def main():
    snapshot = json.loads(sys.stdin.buffer.read().decode('utf-8-sig'))
    snapshot["history"] = snapshot.get("history") or snapshot.get("metricHistory") or []
    output = {}
    core_metrics(snapshot, output)
    cohort_panels(snapshot, output)
    history_figure(snapshot, output)
    exposure_figure(snapshot, output)
    task_domain_figure(snapshot, output)
    subtask_figure(snapshot, output)
    cohort_task_heatmap(snapshot, output)
    group_strategy_figure(snapshot, output)
    additional_figures(snapshot, output)
    output["figure_metadata.json"] = json.dumps({
        "style": "scientific-figure-making house style",
        "raster_dpi": 120,
        "vector_text": True,
        "palette": PALETTE,
        "note": "Twenty publication-ready figures are generated on demand with the scientific-figure-making Matplotlib style."
    }, ensure_ascii=False, indent=2).encode("utf-8")
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for name, data in output.items():
            zf.writestr(name, data)
    sys.stdout.buffer.write(archive.getvalue())


if __name__ == "__main__":
    main()
