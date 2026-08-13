"""Settings page: import/export + app preferences."""

from __future__ import annotations

import json

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QCheckBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .. import settings as app_settings
from ..widgets.toast import Toaster
from .base import BasePage

EXPORT_SECTIONS = [
    ("api_keys", "API keys (unified + provider + client)"),
    ("custom_providers", "Custom providers and their models"),
    ("fallback", "Fallback chain + retry + routing weights"),
    ("embeddings", "Embeddings family chains"),
    ("budgets", "Budgets"),
    ("settings", "Server settings (middle config, etc.)"),
]


class SettingsPage(BasePage):
    title = "Settings"

    def __init__(self, api, parent=None):
        super().__init__(api, parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 26, 28, 28)
        layout.setSpacing(16)

        title = QLabel("Settings")
        subtitle = QLabel("Backup, restore and personalize the gateway + this desktop app.")
        layout.addWidget(title)
        layout.addWidget(subtitle)
        layout.addWidget(self.error_label)

        from ..widgets.styled import style_hero_title, style_page_subtitle, watch_style
        watch_style(lambda: style_hero_title(title))
        watch_style(lambda: style_page_subtitle(subtitle))
        style_hero_title(title)
        style_page_subtitle(subtitle)

        layout.addWidget(self._build_export())
        layout.addWidget(self._build_import())
        layout.addWidget(self._build_app_prefs())
        layout.addStretch()

    # ---- Export ----------------------------------------------------------

    def _build_export(self) -> QWidget:
        box = QGroupBox("Export configuration")
        v = QVBoxLayout(box)
        v.addWidget(QLabel("Sections to include:"))
        self._section_checks: dict[str, QCheckBox] = {}
        for slug, label in EXPORT_SECTIONS:
            cb = QCheckBox(label)
            cb.setChecked(True)
            self._section_checks[slug] = cb
            v.addWidget(cb)
        export_pass = QLineEdit()
        export_pass.setEchoMode(QLineEdit.EchoMode.Password)
        export_pass.setPlaceholderText("Optional passphrase (encrypts keys in the export)")
        self.export_pass = export_pass
        v.addWidget(export_pass)
        row = QHBoxLayout()
        preview_btn = QPushButton("Preview")
        preview_btn.setObjectName("ghost")
        preview_btn.setFixedHeight(36)
        preview_btn.clicked.connect(lambda: self._do_export(preview=True))
        row.addWidget(preview_btn)
        save_btn = QPushButton("Export to file…")
        save_btn.setObjectName("primary")
        save_btn.setFixedHeight(36)
        save_btn.clicked.connect(lambda: self._do_export(preview=False))
        row.addWidget(save_btn)
        row.addStretch()
        v.addLayout(row)
        return box

    def _do_export(self, preview: bool):
        sections = [s for s, cb in self._section_checks.items() if cb.isChecked()]
        if not sections:
            Toaster.show("Pick at least one section", "error")
            return
        body: dict = {"sections": sections}
        if self.export_pass.text():
            body["passphrase"] = self.export_pass.text()
        self.call_in_background(
            lambda: self.api.post("/api/config/export", json=body),
            on_success=lambda data: self._after_export(data, preview),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _after_export(self, data, preview: bool):
        text = json.dumps(data, indent=2)
        if preview:
            dlg = QMessageBox(self)
            dlg.setWindowTitle("Export preview")
            dlg.setText("Review the export envelope (truncated):")
            dlg.setDetailedText(text[:6000])
            dlg.exec()
            return
        path, _ = QFileDialog.getSaveFileName(self, "Save export", "api-gateway-export.json", "JSON (*.json)")
        if not path:
            return
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        Toaster.show(f"Export written to {path}", "success")

    # ---- Import -----------------------------------------------------------

    def _build_import(self) -> QWidget:
        box = QGroupBox("Import configuration")
        v = QVBoxLayout(box)

        row = QHBoxLayout()
        self.import_path = QLineEdit()
        self.import_path.setReadOnly(True)
        self.import_path.setPlaceholderText("Choose an export file…")
        row.addWidget(self.import_path, 1)
        browse = QPushButton("Browse")
        browse.clicked.connect(self._pick_file)
        row.addWidget(browse)
        v.addLayout(row)

        self.import_pass = QLineEdit()
        self.import_pass.setEchoMode(QLineEdit.EchoMode.Password)
        self.import_pass.setPlaceholderText("Passphrase (if the export was protected)")
        v.addWidget(self.import_pass)

        mode_row = QHBoxLayout()
        self.dry_run = QCheckBox("Dry-run (preview diff only)")
        self.dry_run.setChecked(True)
        mode_row.addWidget(self.dry_run)
        mode_row.addStretch()
        v.addLayout(mode_row)

        go = QPushButton("Run import")
        go.setObjectName("primary")
        go.clicked.connect(self._do_import)
        v.addWidget(go)

        self.import_result = QLabel("")
        self.import_result.setWordWrap(True)
        from ..widgets.styled import style_page_subtitle as _ps3
        from ..widgets.styled import watch_style as _ws
        _ws(lambda: _ps3(self.import_result))
        _ps3(self.import_result)
        v.addWidget(self.import_result)
        return box

    def _pick_file(self):
        path, _ = QFileDialog.getOpenFileName(self, "Open export", "", "JSON (*.json)")
        if path:
            self.import_path.setText(path)

    def _do_import(self):
        path = self.import_path.text().strip()
        if not path:
            Toaster.show("Pick a file first", "error")
            return
        try:
            with open(path, "r", encoding="utf-8") as fh:
                envelope = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            Toaster.show(f"Cannot read file: {exc}", "error")
            return
        if self.import_pass.text():
            envelope["passphrase"] = self.import_pass.text()

        if self.dry_run.isChecked():
            self.call_in_background(
                lambda: self.api.post("/api/config/preview", json=envelope),
                on_success=self._show_preview,
                on_error=lambda e: Toaster.show(str(e), "error"),
            )
        else:
            confirm = QMessageBox.question(
                self, "Apply import",
                "This merges the export into the live configuration. Continue?",
            )
            if confirm != QMessageBox.StandardButton.Yes:
                return
            self.call_in_background(
                lambda: self.api.post("/api/config/import", json=envelope),
                on_success=self._show_import_done,
                on_error=lambda e: Toaster.show(str(e), "error"),
            )

    def _show_preview(self, summary):
        self.import_result.setText("Preview: " + json.dumps(summary, indent=2))
        Toaster.show("Dry-run complete — nothing changed", "info")

    def _show_import_done(self, summary):
        self.import_result.setText("Import applied: " + json.dumps(summary, indent=2))
        Toaster.show("Import applied", "success")

    # ---- App preferences ---------------------------------------------------

    def _build_app_prefs(self) -> QWidget:
        box = QGroupBox("Application preferences")
        form = QFormLayout(box)

        self.autostart = QCheckBox("Start at login (system tray)")
        self.autostart.setChecked(app_settings.autostart_enabled())
        self.autostart.toggled.connect(self._set_autostart)
        form.addRow(self.autostart)

        self.minimized = QCheckBox("Start minimized")
        self.minimized.setChecked(app_settings.start_minimized())
        self.minimized.toggled.connect(app_settings.set_start_minimized)
        form.addRow(self.minimized)

        self.dark = QCheckBox("Dark theme")
        self.dark.setChecked(app_settings.theme_dark())
        self.dark.toggled.connect(self._set_theme)
        form.addRow(self.dark)

        self.notify = QCheckBox("Notify on errors")
        self.notify.setChecked(app_settings.notify_on_error())
        self.notify.toggled.connect(app_settings.set_notify_on_error)
        form.addRow(self.notify)

        boot = QHBoxLayout()
        self.boot_btn = QPushButton("Enable backend at boot")
        self.boot_btn.clicked.connect(self._toggle_service_boot)
        boot.addWidget(self.boot_btn)
        boot.addStretch()
        form.addRow(boot)
        self._refresh_boot_label()
        return box

    def on_show(self):
        # Sync toggles with the system state every visit.
        self.autostart.blockSignals(True)
        self.autostart.setChecked(app_settings.autostart_enabled())
        self.autostart.blockSignals(False)
        self.minimized.setChecked(app_settings.start_minimized())
        self.dark.blockSignals(True)
        self.dark.setChecked(app_settings.theme_dark())
        self.dark.blockSignals(False)
        self._refresh_boot_label()

    def _set_autostart(self, enabled: bool):
        try:
            app_settings.set_autostart(enabled)
            Toaster.success(
                "Autostart enabled — the app will start in the tray at login"
                if enabled else
                "Autostart disabled — the app won't auto-launch"
            )
        except Exception as exc:  # noqa: BLE001
            Toaster.error(f"Autostart failed: {exc}")

    def _set_theme(self, dark: bool):
        app_settings.set_theme(dark)
        # Apply right now — no restart needed.
        from PyQt6.QtWidgets import QApplication
        from .. import theme
        theme.apply(QApplication.instance(), dark=dark)
        Toaster.success(f"{'Dark' if dark else 'Light'} theme applied")

    def _toggle_service_boot(self):
        want = not app_settings.service_boot_enabled()
        try:
            app_settings.service_enable_at_boot(want)
        except Exception as exc:  # noqa: BLE001
            Toaster.show(str(exc), "error")
        self._refresh_boot_label()

    def _refresh_boot_label(self):
        enabled = app_settings.service_boot_enabled()
        self.boot_btn.setText("Disable backend at boot" if enabled else "Enable backend at boot")
