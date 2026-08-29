"""Webhooks page: signed event deliveries (create/toggle/delete/test)."""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..widgets.table import configure_table
from ..widgets.toast import Toaster
from .base import BasePage

FILTER_HINT = "*  ·  request.*  ·  routing.*  ·  routing.model_switch  ·  budget.warn  ·  health.check.failed"


class WebhooksPage(BasePage):
    title = "Webhooks"

    def __init__(self, api, parent=None):
        super().__init__(api, parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 26, 28, 24)
        layout.setSpacing(14)

        title_block = QVBoxLayout()
        title_block.setSpacing(2)
        title = QLabel("Webhooks")
        subtitle = QLabel(
            "Get a signed HTTP POST for every matching gateway event. Deliveries retry "
            "up to 3 times and are signed with X-API-Gateway-Signature: "
            "sha256=HMAC(secret, body)."
        )
        subtitle.setWordWrap(True)
        title_block.addWidget(title)
        title_block.addWidget(subtitle)

        from ..widgets.styled import style_hero_title, style_page_subtitle, watch_style
        watch_style(lambda: style_hero_title(title))
        watch_style(lambda: style_page_subtitle(subtitle))
        style_hero_title(title)
        style_page_subtitle(subtitle)
        layout.addLayout(title_block)
        layout.addWidget(self.error_label)

        # -- Add form ------------------------------------------------------------
        form = QFormLayout()
        self.url_edit = QLineEdit()
        self.url_edit.setPlaceholderText("https://example.com/hook")
        self.secret_edit = QLineEdit()
        self.secret_edit.setPlaceholderText("signing secret")
        self.filter_edit = QLineEdit("*")
        self.filter_edit.setToolTip(FILTER_HINT)
        form.addRow("URL", self.url_edit)
        form.addRow("Secret", self.secret_edit)
        form.addRow("Events filter", self.filter_edit)
        layout.addLayout(form)

        hint = QLabel(f"Filters: {FILTER_HINT}")
        hint.setWordWrap(True)
        from ..widgets.styled import style_page_subtitle as _ps2
        from ..widgets.styled import watch_style as _ws2
        _ws2(lambda: _ps2(hint))
        _ps2(hint)
        layout.addWidget(hint)

        add_row = QHBoxLayout()
        add_btn = QPushButton("Add webhook")
        add_btn.setObjectName("primary")
        add_btn.setFixedHeight(36)
        add_btn.clicked.connect(self._add)
        add_row.addWidget(add_btn)
        add_row.addStretch()
        layout.addLayout(add_row)

        # -- Webhooks table --------------------------------------------------------
        self.table = QTableWidget()
        configure_table(self.table, ["URL", "Secret", "Filter", "Created", "Status", "Actions"])
        self.table.cellClicked.connect(self._cell_clicked)
        layout.addWidget(self.table, 1)

    def on_show(self):
        self.refresh()

    def refresh(self):
        self.set_loading(True)
        self.call_in_background(
            lambda: self.api.get("/api/webhooks"),
            on_success=self._apply,
        )

    def _apply(self, webhooks):
        self.set_loading(False)
        rows = webhooks if isinstance(webhooks, list) else (
            webhooks.get("webhooks", []) if isinstance(webhooks, dict) else []
        )
        self.table.setRowCount(0)
        self.table.setRowCount(len(rows))
        self._reveal: set[int] = set()
        for i, w in enumerate(rows):
            if not isinstance(w, dict):
                continue
            wid = w.get("id")
            enabled = bool(w.get("enabled", 1))

            url_item = QTableWidgetItem(str(w.get("url", "")))
            url_item.setFlags(url_item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self.table.setItem(i, 0, url_item)

            secret_item = QTableWidgetItem("••••••••")
            secret_item.setFlags(secret_item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            secret_item.setData(Qt.ItemDataRole.UserRole, str(w.get("secret", "")))
            # Click the secret cell to reveal/hide it.
            self.table.setItem(i, 1, secret_item)

            for col, val in enumerate([
                w.get("events_filter", "*"),
                self._fmt_date(w.get("created_at")),
                "active" if enabled else "disabled",
            ]):
                item = QTableWidgetItem(str(val))
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self.table.setItem(i, 2 + col, item)

            test = QPushButton("Send test event")
            test.clicked.connect(lambda _=False, _id=wid: self._test(_id))
            toggle = QPushButton("Disable" if enabled else "Enable")
            toggle.clicked.connect(
                lambda _=False, _id=wid, _en=enabled: self._toggle(_id, not _en)
            )
            delete = QPushButton("Delete")
            delete.setObjectName("danger")
            delete.clicked.connect(lambda _=False, _id=wid: self._delete(_id))
            actions = QWidget()
            hl = QHBoxLayout(actions)
            hl.setContentsMargins(4, 2, 4, 2)
            hl.addWidget(test)
            hl.addWidget(toggle)
            hl.addWidget(delete)
            self.table.setCellWidget(i, 5, actions)

    @staticmethod
    def _fmt_date(ms):
        if not ms:
            return "—"
        from datetime import datetime
        return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")

    def _cell_clicked(self, row: int, col: int):
        """Click the Secret cell (col 1) to reveal / hide."""
        if col != 1:
            return
        item = self.table.item(row, 1)
        if item is None:
            return
        secret = item.data(Qt.ItemDataRole.UserRole) or ""
        if item.text() == "••••••••":
            item.setText(secret or "—")
        else:
            item.setText("••••••••")

    # -- actions ------------------------------------------------------------

    def _add(self):
        url = self.url_edit.text().strip()
        secret = self.secret_edit.text().strip()
        filt = self.filter_edit.text().strip() or "*"
        if not url or not secret:
            Toaster.show("URL and secret are required", "error")
            return
        body = {"url": url, "secret": secret, "events_filter": filt}
        self.call_in_background(
            lambda: self.api.post("/api/webhooks", json=body),
            on_success=lambda _r: (
                self.url_edit.clear(),
                self.secret_edit.clear(),
                self.filter_edit.setText("*"),
                Toaster.show("Webhook created", "success"),
                self.refresh(),
            ),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _toggle(self, wid: int, new_enabled: bool):
        self.call_in_background(
            lambda: self.api.patch("/api/webhooks", params={"id": wid},
                                   json={"enabled": new_enabled}),
            on_success=lambda _r: (Toaster.show("Webhook updated", "success"), self.refresh()),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _delete(self, wid: int):
        from PyQt6.QtWidgets import QMessageBox
        confirm = QMessageBox.question(
            self, "Delete webhook",
            f"Delete webhook #{wid}? Matching events stop being delivered.",
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        self.call_in_background(
            lambda: self.api.delete("/api/webhooks", params={"id": wid}),
            on_success=lambda _r: (Toaster.show("Webhook deleted", "success"), self.refresh()),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _test(self, wid: int):
        self.call_in_background(
            lambda: self.api.post("/api/webhooks/test", params={"id": wid}),
            on_success=lambda _r: Toaster.show(
                "Test event queued — a signed webhook.test delivery is on its way", "success"),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )
