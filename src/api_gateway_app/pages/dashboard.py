"""Dashboard — hero strip, KPI cards, service controls, live events."""

from __future__ import annotations

from PyQt6.QtCore import QTimer, Qt
from PyQt6.QtWidgets import (
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .. import systemd
from ..widgets.live_events import LiveEvents
from ..widgets.statscard import StatsCard
from ..widgets.toast import Toaster
from .base import BasePage


def _fmt_money(v) -> str:
    try:
        return f"${float(v):.4f}"
    except (TypeError, ValueError):
        return "$0.0000"


def _fmt_uptime(seconds: float | None) -> str:
    if not seconds:
        return "—"
    s = int(seconds)
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, _ = divmod(s, 60)
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"


class DashboardPage(BasePage):
    title = "Dashboard"

    def __init__(self, api, parent=None):
        super().__init__(api, parent)
        root = QVBoxLayout(self)
        root.setContentsMargins(28, 22, 28, 20)
        root.setSpacing(18)

        # ------- Hero strip ---------------------------------------------------
        hero = QWidget()
        hero_layout = QHBoxLayout(hero)
        hero_layout.setContentsMargins(0, 0, 0, 0)
        hero_layout.setSpacing(14)

        title_stack = QVBoxLayout()
        title_stack.setSpacing(2)
        title = QLabel("Welcome back")
        self.hero_sub = QLabel("Everything's routed through your local gateway.")
        title_stack.addWidget(title)
        title_stack.addWidget(self.hero_sub)
        hero_layout.addLayout(title_stack)
        from ..widgets.styled import style_hero_title, style_page_subtitle, watch_style
        watch_style(lambda: style_hero_title(title))
        watch_style(lambda: style_page_subtitle(self.hero_sub))
        style_hero_title(title)
        style_page_subtitle(self.hero_sub)
        hero_layout.addStretch()

        self.pill = QLabel("●  Service is running")
        self.pill.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.pill.setFixedHeight(30)
        self._style_pill(True)
        hero_layout.addWidget(self.pill)
        root.addWidget(hero)

        # ------- KPI cards -----------------------------------------------------
        cards = QGridLayout()
        cards.setSpacing(14)
        self.card_req = StatsCard("Requests (24h)", icon_name="analytics", accent="#89b4fa")
        self.card_success = StatsCard("Success rate", icon_name="check", accent="#a6e3a1")
        self.card_cost = StatsCard("Spend (24h)", icon_name="budget", accent="#f9e2af")
        self.card_active = StatsCard("Active budgets", icon_name="budget", accent="#cba6f7")
        self.card_mem = StatsCard("Server memory", icon_name="server", accent="#74c7ec")
        self.card_up = StatsCard("Server uptime", icon_name="server", accent="#fab387")
        positions = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)]
        for (r, c), w in zip(positions, (self.card_req, self.card_success, self.card_cost,
                                         self.card_active, self.card_mem, self.card_up)):
            cards.addWidget(w, r, c)
        root.addLayout(cards)

        # ------- Service controls ---------------------------------------------
        service = QFrame()
        service.setObjectName("card")
        service_layout = QHBoxLayout(service)
        service_layout.setContentsMargins(16, 12, 16, 12)
        service_layout.setSpacing(10)
        self.service_status = QLabel("Checking system service…")
        service_layout.addWidget(self.service_status, 1)
        from ..widgets.styled import watch_style as _ws2
        from ..widgets.styled import style_page_subtitle as _psd
        _ws2(lambda: _psd(self.service_status))
        _psd(self.service_status)

        self.start_btn = QPushButton("Start")
        self.start_btn.setObjectName("ghost")
        self.start_btn.clicked.connect(self._start_service)
        self.stop_btn = QPushButton("Stop")
        self.stop_btn.setObjectName("ghost")
        self.stop_btn.clicked.connect(self._stop_service)
        self.restart_btn = QPushButton("Restart")
        self.restart_btn.setObjectName("primary")
        self.restart_btn.clicked.connect(self._restart_service)
        for b in (self.start_btn, self.stop_btn, self.restart_btn):
            service_layout.addWidget(b)
        root.addWidget(service)

        # ------- Live events -----------------------------------------------------
        self.events = LiveEvents()
        root.addWidget(self.events, 1)

        self._timer = QTimer(self)
        self._timer.setInterval(10_000)
        self._timer.timeout.connect(self._refresh_status_only)

    # ------------------------------------------------------------------ lifecycle

    def on_show(self):
        self.refresh()
        self._timer.start()

    def on_hide(self):
        self._timer.stop()

    def add_event(self, event: dict) -> None:
        self.events.add_event(event)

    # ------------------------------------------------------------------ refresh

    def refresh(self):
        self.call_in_background(self._fetch, on_success=self._apply)
        self._refresh_status_only()

    def _refresh_status_only(self):
        try:
            status = systemd.service_status()
        except systemd.SystemdError:
            self._apply_status(False, None, None, None)
            return
        self._apply_status(status.active, status.pid, status.memory_bytes, status.uptime_s)

    def _style_pill(self, running: bool):
        from ..theme import hex_to_rgba, palette as _pal
        p = _pal()
        self.pill.setText("●  Service is running" if running else "●  Service stopped")
        accent = p['green'] if running else p['red']
        self.pill.setStyleSheet(
            f"padding: 0 14px; border-radius: 15px;"
            f"background: {hex_to_rgba(accent, 0.16)}; color: {accent}; font-weight: 700;"
        )

    def _apply_status(self, active: bool, pid, memory_bytes: int | None, uptime_s: float | None):
        self._style_pill(active)
        mem = "—"
        if memory_bytes is not None:
            mem = f"{memory_bytes / (1024 * 1024):.1f} MiB"
        self.card_mem.set_value(mem)
        self.card_up.set_value(_fmt_uptime(uptime_s))
        pid_text = f"pid {pid}" if pid else "not running"
        self.service_status.setText(f"api-gateway.service — {pid_text} · {mem} · up {_fmt_uptime(uptime_s)}")

    def _fetch(self):
        summary = {}
        budgets = []
        try:
            summary = self.api.get("/api/analytics/summary", params={"range": "24h"}) or {}
        except Exception:
            summary = {}
        try:
            budgets = self.api.get("/api/budgets") or []
        except Exception:
            budgets = []
        return summary, budgets

    def _apply(self, result):
        summary, budgets = result
        total = summary.get("totalRequests", summary.get("requests", summary.get("total", 0)))
        err = summary.get("failedRequests", summary.get("errors", 0))
        try:
            rate = 100.0 * (1 - (err / total)) if total else 100.0
        except Exception:
            rate = 0.0
        self.card_req.set_value(str(total))
        pct = summary.get("successRate", rate)
        try:
            self.card_success.set_value(f"{float(pct):.1f}%")
        except (TypeError, ValueError):
            self.card_success.set_value("—")
        self.card_cost.set_value(_fmt_money(summary.get("totalCost", summary.get("cost", 0))))
        if isinstance(budgets, dict):
            budgets = budgets.get("budgets", [])
        self.card_active.set_value(str(len(budgets or [])))

    # ------------------------------------------------------------------ actions

    def _restart_service(self):
        try:
            systemd.restart_service()
            Toaster.success("Service is restarting")
        except systemd.SystemdError as exc:
            Toaster.error(str(exc))
        QTimer.singleShot(1400, self._refresh_status_only)

    def _stop_service(self):
        try:
            systemd.stop_service()
            Toaster.info("Service stopped — /v1 traffic will fail until started again.")
        except systemd.SystemdError as exc:
            Toaster.error(str(exc))
        QTimer.singleShot(800, self._refresh_status_only)

    def _start_service(self):
        try:
            systemd.ensure_service_installed()
            systemd.start_service()
            Toaster.success("Service started")
        except systemd.SystemdError as exc:
            Toaster.error(str(exc))
        QTimer.singleShot(1200, self._refresh_status_only)
