"""QApplication entry point.

Boot order:
1. Configure the Qt app identity / icon / theme
2. Ensure the systemd user unit exists and the backend is running
3. Build the ApiClient, drive the AuthGate if the server demands a session
4. Show the MainWindow (or start it in the tray with --minimized)
"""

from __future__ import annotations

import os
import sys

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QApplication, QDialog, QVBoxLayout

from . import settings as app_settings
from . import systemd, theme
from .backend import ApiClient
from .mainwindow import MainWindow
from .widgets.auth import AuthGate, show_auth_dialog


def _repo_icon() -> str:
    root = systemd.repo_root()
    icon = root / "resources" / "icons" / "api-gateway.svg"
    return str(icon) if icon.exists() else ""


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    app = QApplication(argv)
    app.setApplicationName("API Gateway")
    app.setOrganizationName(app_settings.ORG)
    app.setOrganizationDomain("api-gateway.local")
    app.setDesktopFileName("api-gateway")
    app.setQuitOnLastWindowClosed(False)  # we live in the tray

    icon_path = _repo_icon()
    if icon_path:
        app.setWindowIcon(QIcon(icon_path))

    theme.apply(app, dark=app_settings.theme_dark())

    # Ensure backend service exists and is running before we look like a "real" app.
    try:
        systemd.ensure_service_installed()
    except systemd.SystemdError:
        pass  # status page will surface details; don't hard-fail the GUI
    try:
        systemd.ensure_service_running()
    except systemd.SystemdError:
        pass

    api = ApiClient()
    # Rehydrate a persisted dashboard session token (or None) so a relaunch
    # with a still-valid session skips the login prompt.
    api.auth_token = app_settings.dashboard_token()

    window = MainWindow(api, start_minimized=app_settings.start_minimized())

    # If a session-gated request 401s mid-session (expired/revoked token),
    # re-prompt login and then refresh the page the user was on.  The signal
    # arrives queued on the GUI thread even from worker-thread fetches.
    _unauth_busy = [False]

    def _on_unauthorized():
        if _unauth_busy[0]:
            return
        _unauth_busy[0] = True
        try:
            def _refreshed():
                app_settings.set_dashboard_token(api.auth_token)
                page = window._stack.currentWidget()
                if page is not None and hasattr(page, "refresh"):
                    page.refresh()
            show_auth_dialog(api, _refreshed)
        finally:
            _unauth_busy[0] = False

    api.connect_unauthorized(_on_unauthorized)

    gate_needed = _requires_auth(api)
    if gate_needed:
        container = QDialog()
        container.setWindowTitle("API Gateway — sign in")
        v = QVBoxLayout(container)
        gate = AuthGate(api, on_authed=lambda: _after_auth(container, window, argv))
        v.addWidget(gate)
        container.exec()
        if container.result() == QDialog.DialogCode.Rejected:
            return 0
    else:
        _show_or_minimize(window, argv)

    return app.exec()


def _after_auth(dialog: QDialog, window: MainWindow, argv: list[str]) -> None:
    dialog.accept()
    _show_or_minimize(window, argv)


def _show_or_minimize(window: MainWindow, argv: list[str]) -> None:
    minimized = app_settings.start_minimized() or "--minimized" in argv
    if minimized and window._tray is not None:
        window.hide()
    else:
        window.show()


def _requires_auth(api: ApiClient) -> bool:
    """True when the server operator has turned on explicit login.

    The default is LAN trust — when the dashboard is already reachable from
    this host we boot straight into the main window.  Any 401 means the
    server requires credentials.
    """
    try:
        status = api.get("/api/auth/status")
    except Exception:
        # If we can't even reach the server we still want the main window up
        # (its dashboard will show an error and a Reconnect button).
        return False
    if not isinstance(status, dict):
        return False
    needs_setup = bool(status.get("needsSetup"))
    authenticated = bool(status.get("authenticated"))
    has_session = bool(status.get("hasSession"))
    # LAN trust reports ``authenticated: true`` with no session, but the
    # session-gated endpoints (config export, unified API key) refuse to work
    # without a real login — so prompt when there is no valid session.
    return needs_setup or not authenticated or not has_session


if __name__ == "__main__":
    raise SystemExit(main())
