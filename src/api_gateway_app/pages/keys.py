"""Keys & Platforms page."""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..backend import ApiError
from ..widgets.table import configure_table, fill_table
from ..widgets.toast import Toaster
from .base import BasePage


def _mask(value: str | None) -> str:
    if not value:
        return "••••••••"
    if len(value) <= 8:
        return "••••••••"
    return f"{value[:6]}{'•' * 20}{value[-4:]}"


class AddKeyDialog(QDialog):
    def __init__(self, platforms: list[str], parent=None):
        super().__init__(parent)
        self.setWindowTitle("Add API key")
        self.setModal(True)
        form = QFormLayout(self)
        self.platform = QComboBox()
        self.platform.setEditable(True)
        self.platform.addItems(platforms)
        self.key_edit = QLineEdit()
        self.key_edit.setEchoMode(QLineEdit.EchoMode.Password)
        self.label_edit = QLineEdit()
        form.addRow("Platform", self.platform)
        form.addRow("API key", self.key_edit)
        form.addRow("Label (optional)", self.label_edit)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        form.addRow(buttons)

    def payload(self) -> dict:
        return {
            "platform": self.platform.currentText().strip(),
            "apiKey": self.key_edit.text().strip(),
            "label": self.label_edit.text().strip() or None,
        }


class KeysPage(BasePage):
    title = "Keys"

    def __init__(self, api, parent=None):
        super().__init__(api, parent)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        outer.addWidget(scroll)
        body = QWidget()
        body.setObjectName("pageBody")
        scroll.setWidget(body)
        layout = QVBoxLayout(body)
        layout.setContentsMargins(28, 26, 28, 24)
        layout.setSpacing(20)

        header = QHBoxLayout()
        title_block = QVBoxLayout()
        title_block.setSpacing(2)
        title = QLabel("Keys & Platforms")
        subtitle = QLabel("Manage provider keys, the unified client key, and custom platforms.")
        title_block.addWidget(title)
        title_block.addWidget(subtitle)
        header.addLayout(title_block)

        from ..widgets.styled import style_hero_title, style_page_subtitle, watch_style
        watch_style(lambda: style_hero_title(title))
        watch_style(lambda: style_page_subtitle(subtitle))
        style_hero_title(title)
        style_page_subtitle(subtitle)
        header.addStretch()
        add_btn = QPushButton("+ Add key")
        add_btn.setObjectName("primary")
        add_btn.setFixedHeight(38)
        add_btn.clicked.connect(self._add_key)
        header.addWidget(add_btn)
        refresh_btn = QPushButton("Refresh")
        refresh_btn.setObjectName("ghost")
        refresh_btn.setFixedHeight(38)
        refresh_btn.clicked.connect(self.refresh)
        header.addWidget(refresh_btn)
        layout.addLayout(header)
        layout.addWidget(self.error_label)

        # Unified key card ---------------------------------------------------
        unified_box = QVBoxLayout()
        unified_title = QLabel("Unified API key")
        unified_title.setStyleSheet("font-weight: 700;")
        # Y offset: parent layout add
        self.unified_value = QLineEdit()
        self.unified_value.setReadOnly(True)
        self.unified_value.setEchoMode(QLineEdit.EchoMode.Password)
        unified_row = QHBoxLayout()
        unified_row.addWidget(self.unified_value, 1)
        show_btn = QPushButton("Show")
        show_btn.setCheckable(True)
        show_btn.toggled.connect(self._toggle_unified_echo)
        unified_row.addWidget(show_btn)
        copy_btn = QPushButton("Copy")
        copy_btn.clicked.connect(self._copy_unified)
        unified_row.addWidget(copy_btn)
        regen_btn = QPushButton("Regenerate")
        regen_btn.setObjectName("danger")
        regen_btn.clicked.connect(self._regen_unified)
        unified_row.addWidget(regen_btn)
        unified_box.addWidget(unified_title)
        unified_box.addLayout(unified_row)
        layout.addLayout(unified_box)

        # Health / platforms summary -----------------------------------------
        self.health_label = QLabel("")
        from ..widgets.styled import watch_style, style_page_subtitle as _ps2
        watch_style(lambda: _ps2(self.health_label))
        _ps2(self.health_label)
        layout.addWidget(self.health_label)

        # Keys table ----------------------------------------------------------
        keys_title = QLabel("Provider keys")
        keys_title.setStyleSheet("font-weight: 700;")
        layout.addWidget(keys_title)
        self.keys_table = QTableWidget()
        configure_table(self.keys_table, ["ID", "Platform", "Key", "Label", "Status", "Enabled", "Actions"])
        self.keys_table.cellClicked.connect(self._noop)
        layout.addWidget(self.keys_table, 1)

        # Client keys ----------------------------------------------------------
        ck_title = QLabel("Client keys (for scripts / apps)")
        ck_title.setStyleSheet("font-weight: 700;")
        layout.addWidget(ck_title)
        ck_row = QHBoxLayout()
        mint_btn = QPushButton("Mint client key")
        mint_btn.clicked.connect(self._mint_client_key)
        ck_row.addWidget(mint_btn)
        ck_row.addStretch()
        layout.addLayout(ck_row)
        self.client_keys_table = QTableWidget()
        configure_table(self.client_keys_table, ["ID", "Label", "Key", "Enabled", "Expires", "RPM"])
        layout.addWidget(self.client_keys_table, 1)

        layout.addStretch()

    # -- refresh ----------------------------------------------------------

    def refresh(self):
        self.set_loading(True)
        self.call_in_background(self._fetch_all, on_success=self._apply_all)
        self.set_loading(False)

    def _fetch_all(self):
        data = {}
        try:
            data["unified"] = self.api.get("/api/settings/api-key")
        except ApiError:
            data["unified"] = {"apiKey": None}
        for key, path in [
            ("health", "/api/health"),
            ("keys", "/api/keys"),
            ("client_keys", "/api/keys/client"),
            ("custom_providers", "/api/custom-providers"),
        ]:
            try:
                data[key] = self.api.get(path)
            except ApiError:
                data[key] = None
        return data

    def _apply_all(self, data):
        unified = (data.get("unified") or {}).get("apiKey")
        self.unified_value.setText(unified or "")

        health = data.get("health") or {}
        platforms = health.get("platforms") if isinstance(health, dict) else None
        if platforms:
            bits = []
            for p in platforms:
                name = p.get("platform", "?")
                healthy = p.get("healthyKeys", 0)
                total = p.get("totalKeys", 0)
                enabled = p.get("enabledKeys", 0)
                bits.append(f"{name}: {healthy}/{total} healthy, {enabled} enabled")
            self.health_label.setText("   •   ".join(bits))

        keys = data.get("keys") or []
        rows = keys.get("keys") if isinstance(keys, dict) and "keys" in keys else keys
        self._populate_keys(rows if isinstance(rows, list) else [])

        cks = data.get("client_keys") or []
        ck_rows = cks if isinstance(cks, list) else []
        fill_table(self.client_keys_table, [
            [
                c.get("id", ""),
                c.get("label", ""),
                c.get("keyPreview") or _mask(c.get("keyId", "") + ":" + "••••"),
                "yes" if c.get("enabled", True) else "no",
                c.get("expiresAt", "") or "—",
                c.get("rpmLimit", "—"),
            ]
            for c in ck_rows
        ])

    def _populate_keys(self, rows: list[dict]):
        self.keys_table.setRowCount(0)
        self.keys_table.setRowCount(len(rows))
        for i, k in enumerate(rows):
            kid = k.get("id", "")
            platform = k.get("platform", "")
            masked = k.get("masked") or k.get("maskedKey") or _mask(k.get("apiKey"))
            label = k.get("label", "") or "—"
            status = k.get("status", "unknown")
            enabled = bool(k.get("enabled", True))
            for col, val in enumerate([kid, platform, masked, label, status]):
                item = QTableWidgetItem(str(val))
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self.keys_table.setItem(i, col, item)

            toggle = QPushButton("Disable" if enabled else "Enable")
            toggle.setCheckable(True)
            toggle.setChecked(enabled)
            toggle.clicked.connect(lambda checked, _id=kid, _en=enabled: self._toggle_key(_id, _en))
            delete = QPushButton("Delete")
            delete.setObjectName("danger")
            delete.clicked.connect(lambda _=False, _id=kid, _p=platform: self._delete_key(_id, _p))
            actions = QWidget()
            hl = QHBoxLayout(actions)
            hl.setContentsMargins(4, 2, 4, 2)
            hl.addWidget(toggle)
            hl.addWidget(delete)
            item = QTableWidgetItem("")
            item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self.keys_table.setItem(i, 5, item)
            self.keys_table.setCellWidget(i, 6, actions)

    # -- actions -----------------------------------------------------------

    def _toggle_unified_echo(self, checked: bool):
        self.unified_value.setEchoMode(
            QLineEdit.EchoMode.Normal if checked else QLineEdit.EchoMode.Password
        )

    def _copy_unified(self):
        QApplication.clipboard().setText(self.unified_value.text())
        Toaster.show("Unified API key copied to clipboard", "success")

    def _regen_unified(self):
        confirm = QMessageBox.question(
            self, "Regenerate unified key",
            "Regenerating the unified API key invalidates every existing client. Continue?",
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        self.call_in_background(
            lambda: self.api.post("/api/settings/api-key/regenerate"),
            on_success=lambda _r: (self.refresh(), Toaster.show("Regenerated", "success")),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _add_key(self):
        platforms: list[str] = []
        try:
            health = self.api.get("/api/health") or {}
            platforms = [p.get("platform", "") for p in health.get("platforms", [])]
        except ApiError:
            pass
        try:
            customs = self.api.get("/api/custom-providers") or []
            platforms += [c.get("slug", "") for c in customs if isinstance(c, dict)]
        except ApiError:
            pass
        platforms = sorted({p for p in platforms if p})
        dialog = AddKeyDialog(platforms, self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        payload = dialog.payload()
        if not payload["platform"] or not payload["apiKey"]:
            Toaster.show("Platform and key are required", "error")
            return
        self.call_in_background(
            lambda: self.api.post("/api/keys", json={k: v for k, v in payload.items() if v is not None}),
            on_success=lambda _r: (self.refresh(), Toaster.show("Key added", "success")),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _toggle_key(self, key_id, currently_enabled: bool):
        if key_id in (None, ""):
            return
        self.call_in_background(
            lambda: self.api.patch(f"/api/keys/{key_id}", json={"enabled": not currently_enabled}),
            on_success=lambda _r: self.refresh(),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _delete_key(self, key_id, platform: str):
        if key_id in (None, ""):
            return
        confirm = QMessageBox.question(self, "Delete key", f"Delete key #{key_id} for {platform}?")
        if confirm != QMessageBox.StandardButton.Yes:
            return
        self.call_in_background(
            lambda: self.api.delete(f"/api/keys/{key_id}"),
            on_success=lambda _r: (self.refresh(), Toaster.show("Key removed", "success")),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _mint_client_key(self):
        label, ok = _prompt_text(self, "Client key label (optional)")
        if not ok:
            return
        body = {"label": label or None}
        self.call_in_background(
            lambda: self.api.post("/api/keys/client", json={k: v for k, v in body.items() if v}),
            on_success=self._show_minted,
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _show_minted(self, result):
        key = result.get("key") if isinstance(result, dict) else None
        if not key:
            key = (result or {}).get("apiKey") or (result or {}).get("secret")
        msg = QMessageBox(self)
        msg.setWindowTitle("Client key minted")
        msg.setText("Copy this key now — it is shown only once.")
        msg.setDetailedText(str(key))
        QApplication.clipboard().setText(str(key))
        msg.exec()
        self.refresh()

    @staticmethod
    def _noop(*_args):
        return None


def _prompt_text(parent, label: str) -> tuple[str, bool]:
    from PyQt6.QtWidgets import QInputDialog

    text, ok = QInputDialog.getText(parent, "Keys", label)
    return text.strip(), ok
