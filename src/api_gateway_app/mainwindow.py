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
from . import systemd, theme
from .backend import ApiClient, EventStream
from .icons import icon
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

PAGE_ORDER = [
    ("Dashboard", DashboardPage, "dashboard"),
    ("Analytics", AnalyticsPage, "analytics"),
    ("Keys", KeysPage, "keys"),
    ("Budget", BudgetPage, "budget"),
    ("Playground", PlaygroundPage, "playground"),
    ("Fallback", FallbackPage, "fallback"),
    ("Embeddings", EmbeddingsPage, "embeddings"),
    ("Privacy", PrivacyPage, "privacy"),
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
        self.page_title.setStyleSheet("color: #a6adc8;")
        h.addWidget(self.page_title)

        h.addStretch()

        self.service_pill = QPushButton("●  Service: checking")
        self.service_pill.setFlat(True)
        self.service_pill.setStyleSheet(
            "padding: 6px 12px; border-radius: 14px; color: #cdd6f4; font-weight: 600;")
        self.service_pill.clicked.connect(self._restart_service_click)
        h.addWidget(self.service_pill)

        self.theme_btn = QPushButton()
        self.theme_btn.setFlat(True)
        self.theme_btn.setToolTip("Toggle theme")
        self.theme_btn.setText("☾" if self._theme_dark else "☀")
        self.theme_btn.clicked.connect(self._toggle_theme)
        h.addWidget(self.theme_btn)

        self._poll_service_status()
        return bar

    def _poll_service_status(self):
        try:
            status = systemd.service_status()
            ok = status.active
        except systemd.SystemdError:
            ok = False
        if ok:
            self.service_pill.setText("●  Service running")
            self.service_pill.setStyleSheet(
                "padding: 6px 12px; border-radius: 14px; background: #a6e3a120; color: #a6e3a1; font-weight: 700;")
        else:
            self.service_pill.setText("●  Service stopped")
            self.service_pill.setStyleSheet(
                "padding: 6px 12px; border-radius: 14px; background: #f38ba820; color: #f38ba8; font-weight: 700;")
        QTimer.singleShot(5000, self._poll_service_status)

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
        try:
            if "stopped" in self.service_pill.text().lower():
                systemd.start_service()
            else:
                systemd.restart_service()
        except systemd.SystemdError as exc:
            from .widgets.toast import Toaster
            Toaster.show(str(exc), kind="error")
        QTimer.singleShot(1500, self._poll_service_status)

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
        try:
            systemd.restart_service()
        except systemd.SystemdError:
            pass
        QTimer.singleShot(1200, self._poll_service_status)

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
