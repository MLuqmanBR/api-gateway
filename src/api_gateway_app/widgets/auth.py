"""Centered glass-card setup/login screen for the API Gateway desktop app.
Establishes a real dashboard session so session-gated endpoints (config
export, unified API key) work, matching the web dashboard.
"""

from __future__ import annotations

from typing import Callable

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .. import settings as app_settings
from ..backend import ApiClient, ApiError
from ..theme import palette as _current_palette


class AuthGate(QWidget):
    """Setup (first run) or login flow.

    /api/auth/status is LAN-trusted (``authenticated: true`` even without a
    session), so this gate keys off ``hasSession`` + ``needsSetup`` — never
    ``authenticated`` alone — and logs in through the shared ApiClient so the
    returned session token persists for subsequent API calls.
    """

    def __init__(self, api: ApiClient, on_authed: Callable[[], None], parent=None):
        super().__init__(parent)
        self.api = api
        self.on_authed = on_authed
        self._mode = "login"
        self._p = _current_palette()
        self._build()
        self._check()

    # ------------------------------------------------------------- UI

    def _build(self):
        root = QVBoxLayout(self)
        root.setAlignment(Qt.AlignmentFlag.AlignCenter)
        card = QFrame()
        card.setObjectName("card")
        card.setFixedWidth(400)
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(28, 28, 28, 28)
        card_layout.setSpacing(14)

        p = self._p
        logo = QLabel("\u25c6")
        logo.setAlignment(Qt.AlignmentFlag.AlignCenter)
        logo.setStyleSheet(f"font-size: 26px; color: {p['blue']};")
        card_layout.addWidget(logo)

        title = QLabel("API Gateway")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title.setStyleSheet(f"font-size: 18px; font-weight: 800; color: {p['text']};")
        card_layout.addWidget(title)

        self.subtitle = QLabel("Connecting to the local gateway\u2026")
        self.subtitle.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.subtitle.setWordWrap(True)
        self.subtitle.setStyleSheet(f"color: {p['green']}; font-size: 13px; padding-bottom: 4px;")
        card_layout.addWidget(self.subtitle)

        form = QVBoxLayout()
        form.setSpacing(10)
        self.email = QLineEdit()
        self.email.setPlaceholderText("you@example.com")
        self.email.setFixedHeight(40)
        self.password = QLineEdit()
        self.password.setPlaceholderText("Password")
        self.password.setEchoMode(QLineEdit.EchoMode.Password)
        self.password.setFixedHeight(40)
        form.addWidget(self.email)
        form.addWidget(self.password)

        self.submit = QPushButton("Continue")
        self.submit.setObjectName("primary")
        self.submit.setFixedHeight(40)
        self.submit.clicked.connect(self._submit)
        form.addWidget(self.submit)
        card_layout.addLayout(form)

        self.error = QLabel("")
        self.error.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.error.setWordWrap(True)
        self.error.setStyleSheet(f"color: {p['red']};")
        self.error.setVisible(False)
        card_layout.addWidget(self.error)

        root.addWidget(card)

    # ------------------------------------------------------------- flow

    def _check(self):
        try:
            status = self.api.get("/api/auth/status")
        except ApiError as exc:
            self.subtitle.setText(f"Cannot reach the gateway: {exc}")
            self.subtitle.setStyleSheet(f"color: {self._p['red']};")
            self.submit.setText("Retry")
            self.submit.clicked.disconnect()
            self.submit.clicked.connect(self._check)
            return
        if status.get("needsSetup"):
            self._mode = "setup"
            self.submit.setText("Create account")
            self.subtitle.setText("Create the dashboard account.")
            self.subtitle.setStyleSheet(f"color: {self._p['blue']};")
        else:
            self._mode = "login"
            self.submit.setText("Sign in")
            self.subtitle.setText("Sign in to continue.")
            self.subtitle.setStyleSheet(f"color: {self._p['subtext']};")

    def _submit(self):
        email = self.email.text().strip()
        password = self.password.text()
        if not email or not password:
            self.error.setText("Email and password are required.")
            self.error.setVisible(True)
            return
        self.submit.setEnabled(False)
        self.error.setVisible(False)
        try:
            if self._mode == "setup":
                token = self.api.setup(email, password)
            else:
                token = self.api.login(email, password)
            if token:
                app_settings.set_dashboard_token(token)
            elif self.api.auth_token:
                app_settings.set_dashboard_token(self.api.auth_token)
            self.on_authed()
        except ApiError as exc:
            self.error.setText(str(exc))
            self.error.setVisible(True)
        finally:
            self.submit.setEnabled(True)


def show_auth_dialog(api: ApiClient, on_authed) -> bool:
    """Show the auth gate in a modal dialog. Returns True if authenticated."""
    from PyQt6.QtWidgets import QDialog, QVBoxLayout

    dialog = QDialog()
    dialog.setWindowTitle("API Gateway \u2014 sign in")
    dialog.setModal(True)
    dialog.setFixedSize(460, 480)
    layout = QVBoxLayout(dialog)
    layout.setContentsMargins(0, 0, 0, 0)

    def _done():
        dialog.accept()
        on_authed()

    gate = AuthGate(api, _done, dialog)
    layout.addWidget(gate)
    return dialog.exec() == QDialog.DialogCode.Accepted
