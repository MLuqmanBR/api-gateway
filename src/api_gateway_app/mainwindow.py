"""Main window with a 2026 frameless / fluent layout."""

from __future__ import annotations

from PyQt6.QtCore import Qt, QSettings, QTimer
from PyQt6.QtGui import QCloseEvent, QCursor, QMouseEvent
from PyQt6.QtWidgets import (
    QDialog,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QPushButton,
    QStackedWidget,
    QSystemTrayIcon,
    QVBoxLayout,
    QWidget,
)

from . import settings as app_settings
from .systemd_gui import run_in_background, service_status_poller
from . import theme
from .backend import ApiClient, EventStream
from .icons import icon
from .manager import BackendMode
from .widgets.nav import Sidebar
from .pages.analytics import AnalyticsPage
from .pages.base import BasePage
from .pages.budget import BudgetPage
from .pages.dashboard import DashboardPage
from .pages.embeddings import EmbeddingsPage
from .pages.fallback import FallbackPage
from .pages.keys import KeysPage
from .pages.middle import PrivacyPage
from .pages.playground import PlaygroundPage
from .pages.settings import SettingsPage
from .pages.webhooks import WebhooksPage

PAGE_ORDER = [
    ("Dashboard", DashboardPage, "dashboard"),
    ("Analytics", AnalyticsPage, "analytics"),
    ("Keys", KeysPage, "keys"),
    ("Budget", BudgetPage, "budget"),
    ("Playground", PlaygroundPage, "playground"),
    ("Fallback", FallbackPage, "fallback"),
    ("Embeddings", EmbeddingsPage, "embeddings"),
    ("Privacy", PrivacyPage, "privacy"),
    ("Webhooks", WebhooksPage, "webhooks"),
    ("Settings", SettingsPage, "settings"),
]


class MainWindow(QMainWindow):
    def __init__(self, api: ApiClient, start_minimized: bool = False):
        super().__init__()
        self.setWindowTitle("API Gateway")
        self.setMinimumSize(1240, 780)
        self.resize(1400, 900)
        self._qsettings = QSettings(app_settings.ORG, app_settings.APP)

        self.api = api
        self._force_quit = False
        self._pages: list[BasePage] = []
        self._tray: QSystemTrayIcon | None = None
        self.event_stream: EventStream | None = None
        self._drag_pos = None
        self._theme_dark = app_settings.theme_dark()
        # None = still waiting for the first poll result ("checking" state).
        self._service_ok: bool | None = None

        self._restore_geometry()
        self._build_ui(start_minimized)

    # ------------------------------------------------------------------ UI

    def _build_ui(self, start_minimized: bool):
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        self.setObjectName("mainwindow-root")
        theme.apply(self, dark=self._theme_dark)

        root.addWidget(self._build_titlebar())

        body = QWidget()
        body_layout = QHBoxLayout(body)
        body_layout.setContentsMargins(0, 0, 0, 0)
        body_layout.setSpacing(0)

        names = [n for n, _, _ in PAGE_ORDER]
        icons = [i for _, _, i in PAGE_ORDER]
        self._sidebar = Sidebar(names, icons)
        self._sidebar.page_selected.connect(self._open_page)
        body_layout.addWidget(self._sidebar)

        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(0)

        self._stack = QStackedWidget()
        right_layout.addWidget(self._stack, 1)
        body_layout.addWidget(right, 1)

        root.addWidget(body, 1)

        for name, cls, _icon_name in PAGE_ORDER:
            page = cls(self.api)
            page.setProperty("page_title", name)
            self._pages.append(page)
            self._stack.addWidget(page)

        self._build_tray()
        self.event_stream = EventStream(self.api, self)
        self.event_stream.event_received.connect(self._on_event)
        self.event_stream.start()

        self._open_page(0)

    # ------------------------------------------------------------------ Titlebar

    def _build_titlebar(self) -> QWidget:
        bar = QWidget()
        bar.setObjectName("topbar")
        bar.setFixedHeight(46)
        h = QHBoxLayout(bar)
        h.setContentsMargins(14, 0, 10, 0)
        h.setSpacing(10)

        title = QLabel("API Gateway")
        title.setObjectName("appTitle")
        title.setStyleSheet("font-weight: 700; letter-spacing: 0.3px; font-size: 14px;")
        h.addWidget(title)

        self.page_title = QLabel("Dashboard")
        # Palette-driven (audit L93): hardcoded MOCHA hexes turned illegible
        # under the LATTE light palette.
        self.page_title.setStyleSheet(f"color: {theme.palette()['subtext']};")
        h.addWidget(self.page_title)

        h.addStretch()

        self.service_pill = QPushButton("●  Service: checking")
        self.service_pill.setFlat(True)
        self.service_pill.setStyleSheet(
            f"padding: 6px 12px; border-radius: 14px; color: {theme.palette()['text']}; font-weight: 600;")
        self.service_pill.clicked.connect(self._restart_service_click)
        h.addWidget(self.service_pill)

        self.theme_btn = QPushButton()
        self.theme_btn.setFlat(True)
        self.theme_btn.setToolTip("Toggle theme")
        self.theme_btn.setText("☾" if self._theme_dark else "☀")
        self.theme_btn.clicked.connect(self._toggle_theme)
        h.addWidget(self.theme_btn)

        poller = service_status_poller()
        # The poller is a process-wide singleton (not parented here) so it
        # survives window teardown; both the pill and the dashboard subscribe.
        poller.status_ready.connect(self._apply_service_status)
        # Re-render the pill when the palette flips so its accent follows
        # MOCHA/LATTE instead of staying on hardcoded dark-theme hexes.
        theme.THEME_BUS.changed.connect(lambda _dark: self._render_service_pill())
        poller.start()
        return bar

    def _apply_service_status(self, status) -> None:
        self._service_ok = bool(status.running)
        self._service_status_obj = status
        self._render_service_pill()

    def _render_service_pill(self) -> None:
        """(Re)paint the service pill from the live palette + last status."""
        p = theme.palette()
        if self._service_ok is None:
            self.service_pill.setText("●  Service: checking")
            self.service_pill.setStyleSheet(
                f"padding: 6px 12px; border-radius: 14px; color: {p['subtext']}; font-weight: 600;")
            return
        accent = p["green"] if self._service_ok else p["red"]
        st = getattr(self, "_service_status_obj", None)
        if st is not None and getattr(st, "mode", None) == BackendMode.CLI:
            text = "●  api CLI · running"
        elif self._service_ok:
            text = "●  Service running"
        else:
            text = "●  Service stopped"
        self.service_pill.setText(text)
        # 0.125 ≈ the old '#a6e3a120' alpha byte (0x20 / 0xff).
        self.service_pill.setStyleSheet(
            "padding: 6px 12px; border-radius: 14px; "
            f"background: {theme.hex_to_rgba(accent, 0.125)}; color: {accent}; font-weight: 700;")

    def _toggle_theme(self):
        self._theme_dark = not self._theme_dark
        app_settings.set_theme(self._theme_dark)
        # Apply immediately so the user sees it without a restart.
        from PyQt6.QtWidgets import QApplication
        theme.apply(QApplication.instance(), dark=self._theme_dark)
        self.theme_btn.setText("☾" if self._theme_dark else "☀")
        from .widgets.toast import Toaster
        Toaster.success(f"{'Dark' if self._theme_dark else 'Light'} theme applied")

    def _restart_service_click(self):
        from . import systemd_gui as _sui
        action = _sui.restart_service
        run_in_background(action, on_error=self._service_action_error)
        QTimer.singleShot(1500, service_status_poller().refresh)

    def _service_action_error(self, exc: Exception) -> None:
        from .widgets.toast import Toaster
        Toaster.show(str(exc), kind="error")

    # ------------------------------------------------------------------ Pages

    def _build_tray(self):
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return
        self._tray = QSystemTrayIcon(self.windowIcon(), self)
        self._tray.setToolTip("API Gateway")
        menu = QMenu()
        menu.addAction("Show window", self.show_and_raise)
        menu.addSeparator()
        menu.addAction("Restart service", self._restart_service)
        menu.addSeparator()
        menu.addAction("Quit", self.quit_app)
        self._tray.setContextMenu(menu)
        self._tray.activated.connect(self._tray_activated)
        self._tray.show()

    def _tray_activated(self, reason):
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            if self.isVisible():
                self.hide()
            else:
                self.show_and_raise()

    def _restart_service(self):
        run_in_background(systemd_gui.restart_service)
        QTimer.singleShot(1200, service_status_poller().refresh)

    def _open_page(self, index: int) -> None:
        if not (0 <= index < self._stack.count()):
            return
        previous = self._stack.currentWidget()
        if isinstance(previous, BasePage):
            previous.on_hide()
        self._stack.setCurrentIndex(index)
        page = self._stack.currentWidget()
        self.page_title.setText(PAGE_ORDER[index][0])
        if isinstance(page, BasePage):
            page.on_show()
        self._sidebar.set_current(index)

    def open_page(self, key: str) -> None:
        """Open a page by slug or title (e.g. ``--page=settings``)."""
        wanted = key.strip().lower()
        for index, (name, _cls, slug) in enumerate(PAGE_ORDER):
            if wanted in (slug, name.lower()):
                self._open_page(index)
                return

    def _on_event(self, event: dict) -> None:
        if self._pages and isinstance(self._pages[0], DashboardPage):
            self._pages[0].add_event(event)

    def show_and_raise(self):
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def quit_app(self):
        self._force_quit = True
        self._save_geometry()
        if self._tray is not None:
            self._tray.hide()
        if self.event_stream is not None:
            # Stop the worker first so we don't crash on QThread teardown
            self.event_stream.stop()
            self.event_stream.wait(2000)  # give it up to 2s to actually exit
        self.api.close()
        self.close()
        # Drive the QApplication loop to exit: close() alone can be ignored
        # when QuitOnLastWindowClosed is False (it is, so we can live in the tray).
        from PyQt6.QtCore import QTimer
        QTimer.singleShot(0, self._final_quit)

    def _final_quit(self):
        from PyQt6.QtWidgets import QApplication
        QApplication.quit()

    # ------------------------------------------------------------------ Window lifecycle

    def _restore_geometry(self):
        geo = self._qsettings.value("ui/geometry")
        if geo:
            self.restoreGeometry(geo)

    def _save_geometry(self):
        self._qsettings.setValue("ui/geometry", self.saveGeometry())

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802
        if self._force_quit or self._tray is None:
            self._save_geometry()
            event.accept()
            return
        event.ignore()
        self.hide()
        if self._tray:
            self._tray.showMessage(
                "API Gateway",
                "Still running in the tray — backend service keeps processing requests.",
                QSystemTrayIcon.MessageIcon.Information,
            )
