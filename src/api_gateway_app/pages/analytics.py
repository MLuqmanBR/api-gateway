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
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(14)

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
        self.range_box.addItems(["24h", "7d", "30d", "all"])
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
        self.set_loading(True)
        self.call_in_background(lambda: self._fetch(rng), on_success=self._apply)
        self.set_loading(False)

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
        points = [(str(t.get("bucket", t.get("time", ""))), int(t.get("requests", t.get("count", 0)))) for t in timeline] if isinstance(timeline, list) else []
        self.timeline.set_points(points)

    def _apply_summary(self, s: dict):
        self.card_requests.set_value(str(s.get("totalRequests", s.get("requests", 0))))
        cost = s.get("totalCost", s.get("cost", 0)) or 0
        try:
            self.card_cost.set_value(f"${float(cost):.4f}")
        except (TypeError, ValueError):
            self.card_cost.set_value("$0.0000")
        tokens = s.get("totalTokens", s.get("tokens", 0)) or 0
        self.card_tokens.set_value(str(tokens))
        self.card_errors.set_value(str(s.get("failedRequests", s.get("errors", 0))))

    def _apply_list(self, table: QTableWidget, rows, kind: str):
        rows = rows if isinstance(rows, list) else []
        data = []
        for r in rows:
            name = r.get("model") or r.get("platform") or r.get("name", "")
            req = r.get("requests", r.get("count", 0))
            tok = r.get("tokens", 0)
            cost = r.get("cost", 0)
            try:
                cost_str = f"${float(cost):.4f}"
            except (TypeError, ValueError):
                cost_str = "$0.00"
            extra = r.get("avgLatencyMs", r.get("successRate", ""))
            data.append([name, req, tok, cost_str, extra])
        fill_table(table, data)

    def _apply_errors(self, errors):
        errors = errors if isinstance(errors, list) else []
        fill_table(self.errors, [
            [e.get("time", e.get("createdAt", "")), e.get("model", ""), e.get("platform", ""), e.get("error", e.get("message", ""))]
            for e in errors
        ])
