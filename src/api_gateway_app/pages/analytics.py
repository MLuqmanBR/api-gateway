"""Analytics page: range-filtered summary tables + timeline chart."""

from __future__ import annotations

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QColor, QPainter, QPen
from PyQt6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QTabWidget,
    QTableWidget,
    QVBoxLayout,
    QWidget,
)

from ..widgets.statscard import StatsCard
from ..widgets.table import configure_table, fill_table
from .base import BasePage

try:  # Optional: nicer charts when PyQt6-Charts is installed
    from PyQt6.QtCharts import QChart, QChartView, QLineSeries, QValueAxis
    _HAS_CHARTS = True
except Exception:  # pragma: no cover - depends on environment
    _HAS_CHARTS = False


class SimpleTimeline(QWidget):
    """Painted line used when PyQt6-Charts is unavailable."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.points: list[tuple[str, int]] = []
        self.setMinimumHeight(180)

    def set_points(self, points):
        self.points = points
        self.update()

    def paintEvent(self, event):  # noqa: N802 - Qt override
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.fillRect(self.rect(), QColor("#181825"))
        if not self.points:
            painter.setPen(QColor("#a6adc8"))
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "No data")
            return
        w, h = self.width(), self.height()
        pad = 24
        values = [v for _, v in self.points]
        maxv = max(values) or 1
        step = (w - 2 * pad) / max(1, len(self.points) - 1)
        pen = QPen(QColor("#89b4fa"))
        pen.setWidth(2)
        painter.setPen(pen)
        for i, (_, v) in enumerate(self.points):
            x = pad + i * step
            y = h - pad - (v / maxv) * (h - 2 * pad)
            painter.drawPoint(int(x), int(y))
            if i:
                px = pad + (i - 1) * step
                pv = values[i - 1]
                py = h - pad - (pv / maxv) * (h - 2 * pad)
                painter.drawLine(int(px), int(py), int(x), int(y))


class AnalyticsPage(BasePage):
    title = "Analytics"

    def __init__(self, api, parent=None):
        super().__init__(api, parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 26, 28, 24)
        layout.setSpacing(14)

        header = QHBoxLayout()
        title_block = QVBoxLayout()
        title_block.setSpacing(2)
        title = QLabel("Analytics")
        title.setObjectName("hero_title")
        subtitle = QLabel("Traffic, cost, latency and error breakdown.")
        subtitle.setObjectName("page_subtitle")
        title_block.addWidget(title)
        title_block.addWidget(subtitle)
        header.addLayout(title_block)

        # Style the hero block palette-aware
        from ..widgets.styled import style_hero_title, style_page_subtitle, watch_style
        watch_style(lambda: style_hero_title(title))
        watch_style(lambda: style_page_subtitle(subtitle))
        style_hero_title(title)
        style_page_subtitle(subtitle)
        header.addStretch()
        self.range_box = QComboBox()
        # H27: the server's TimeRange enum is exactly 24h|7d|30d — "all"
        # failed the whole fetch with a 400.
        self.range_box.addItems(["24h", "7d", "30d"])
        self.range_box.setCurrentText("7d")
        self.range_box.currentTextChanged.connect(lambda _: self.refresh())
        header.addWidget(QLabel("Range:"))
        header.addWidget(self.range_box)
        self.refresh_btn = QPushButton("Refresh")
        self.refresh_btn.clicked.connect(self.refresh)
        header.addWidget(self.refresh_btn)
        layout.addLayout(header)
        layout.addWidget(self.error_label)

        cards = QHBoxLayout()
        self.card_requests = StatsCard("Total requests")
        self.card_cost = StatsCard("Total cost")
        self.card_tokens = StatsCard("Tokens")
        self.card_errors = StatsCard("Errors")
        for c in (self.card_requests, self.card_cost, self.card_tokens, self.card_errors):
            cards.addWidget(c)
        layout.addLayout(cards)

        self.timeline = SimpleTimeline()
        layout.addWidget(self.timeline)

        self.tabs = QTabWidget()
        self.by_model = QTableWidget()
        configure_table(self.by_model, ["Model", "Requests", "Tokens", "Cost", "Avg latency (ms)"])
        self.by_platform = QTableWidget()
        configure_table(self.by_platform, ["Platform", "Requests", "Tokens", "Cost", "Success %"])
        self.errors = QTableWidget()
        configure_table(self.errors, ["Time", "Model", "Platform", "Error"])
        self.tabs.addTab(self.by_model, "By model")
        self.tabs.addTab(self.by_platform, "By platform")
        self.tabs.addTab(self.errors, "Recent errors")
        layout.addWidget(self.tabs, 1)

        self._timer = QTimer(self)
        self._timer.setInterval(60_000)
        self._timer.timeout.connect(self.refresh)

    def on_show(self):
        self.refresh()
        self._timer.start()

    def on_hide(self):
        self._timer.stop()

    def refresh(self):
        rng = self.range_box.currentText()
        self.call_in_background(lambda: self._fetch(rng), on_success=self._apply)

    # -- data --------------------------------------------------------------

    def _fetch(self, rng: str):
        params = {"range": rng}
        summary = self.api.get("/api/analytics/summary", params=params) or {}
        by_model = self.api.get("/api/analytics/by-model", params=params) or []
        by_platform = self.api.get("/api/analytics/by-platform", params=params) or []
        errors = self.api.get("/api/analytics/errors", params=params) or []
        try:
            timeline = self.api.get("/api/analytics/timeline", params=params) or []
        except Exception:
            timeline = []
        return summary, by_model, by_platform, errors, timeline

    def _apply(self, result):
        summary, by_model, by_platform, errors, timeline = result
        self._apply_summary(summary)
        self._apply_list(self.by_model, by_model, kind="model")
        self._apply_list(self.by_platform, by_platform, kind="platform")
        self._apply_errors(errors)
        # H27: TimelinePoint = { timestamp, requests, successCount, failureCount }.
        points = []
        if isinstance(timeline, list):
            for t in timeline:
                if not isinstance(t, dict):
                    continue
                stamp = str(t.get("timestamp", ""))
                # SQLite UTC "YYYY-MM-DD HH:MM:SS" → short local label.
                label = stamp[11:16] if len(stamp) >= 16 else stamp
                points.append((label, int(t.get("requests", 0) or 0)))
        self.timeline.set_points(points)

    def _apply_summary(self, s: dict):
        # H27: AnalyticsSummary fields — totalRequests, totalInputTokens,
        # totalOutputTokens, avgLatencyMs, successRate… (shared/types.ts).
        s = s or {}
        self.card_requests.set_value(str(s.get("totalRequests", 0) or 0))
        self.card_tokens.set_value(str((s.get("totalInputTokens", 0) or 0) + (s.get("totalOutputTokens", 0) or 0)))
        self.card_errors.set_value(str(round((s.get("totalRequests", 0) or 0) * (1 - (s.get("successRate", 1) or 1)))))
        self.card_cost.set_value(f"{s.get('avgLatencyMs', 0) or 0} ms")

    def _apply_list(self, table: QTableWidget, rows, kind: str):
        rows = rows if isinstance(rows, list) else []
        data = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            if kind == "model":
                # ModelStats: displayName, requests, total{In,Out}putTokens,
                # estimatedCost (dollars), avgLatencyMs, successRate.
                name = r.get("displayName") or r.get("modelId", "")
                tok = (r.get("totalInputTokens", 0) or 0) + (r.get("totalOutputTokens", 0) or 0)
                extra = f"{r.get('avgLatencyMs', 0) or 0}"
            else:
                # PlatformStats: platform, requests, successRate, avgLatencyMs.
                name = r.get("platform", "")
                tok = (r.get("totalInputTokens", 0) or 0) + (r.get("totalOutputTokens", 0) or 0)
                rate = r.get("successRate", 0) or 0
                extra = f"{round(rate * 100)}%"
            cost = r.get("estimatedCost", 0) or 0
            try:
                cost_str = f"${float(cost):.4f}"
            except (TypeError, ValueError):
                cost_str = "$0.00"
            data.append([name, r.get("requests", 0) or 0, tok, cost_str, extra])
        fill_table(table, data)

    def _apply_errors(self, errors):
        errors = errors if isinstance(errors, list) else []
        # H27: ErrorLogEntry = { createdAt, modelId, platform, error, … }.
        fill_table(self.errors, [
            [e.get("createdAt", ""), e.get("modelId", ""), e.get("platform", ""), e.get("error", "")]
            for e in errors if isinstance(e, dict)
        ])
