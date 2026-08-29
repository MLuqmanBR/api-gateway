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
    """Mask a secret for display.

    Matches the server's maskKey() (server/src/lib/crypto.ts) and the web
    client's lib/utils maskKey(): values of ≤6 chars are fully hidden
    (a tail would reveal too much), longer ones keep only the last 3 chars.
    N37: previously this rendered a different format than the web dashboard,
    so the same key looked different depending on which front end showed it.
    """
    if not value or len(value) <= 6:
        return "****"
    return f"****{value[-3:]}"


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
            # The server's add-key schema (routes/keys.ts) expects `key` —
            # a mismatched field name is silently stripped by zod and the
            # secret never reaches the database.
            "platform": self.platform.currentText().strip(),
            "key": self.key_edit.text().strip(),
            "label": self.label_edit.text().strip() or None,
        }



class PlatformSettingsDialog(QDialog):
    """Edit a provider's limits — works for built-ins AND custom providers.

    Body keys are camelCase exactly as the server expects
    (platformsSettingsPatchSchema / updateProviderSchema).  Only fields the
    user actually changed are sent (a null sent for an untouched limit would
    wipe it — the same bug the web UI fixed in N55).
    """

    def __init__(self, settings: dict, parent=None):
        super().__init__(parent)
        self.setWindowTitle(f"Settings — {settings.get('platform', settings.get('slug', '?'))}")
        self.setModal(True)
        self._initial = settings
        form = QFormLayout(self)

        def _limit_box(value) -> QComboBox:
            # null (no limit) is a legitimate value — represent it as an
            # empty editable combo; 0 is NOT "unlimited" server-side.
            box = QComboBox()
            box.setEditable(True)
            box.setCurrentText("" if value is None else str(int(value)))
            return box

        self.rpm = _limit_box(settings.get("rpmLimit"))
        self.rpd = _limit_box(settings.get("rpdLimit"))
        self.tpm = _limit_box(settings.get("tpmLimit"))
        self.tpd = _limit_box(settings.get("tpdLimit"))
        for box, hint in ((self.rpm, "requests"), (self.rpd, "requests"),
                          (self.tpm, "tokens"), (self.tpd, "tokens")):
            box.setPlaceholderText("no limit")
        form.addRow("Requests / minute", self.rpm)
        form.addRow("Requests / day", self.rpd)
        form.addRow("Tokens / minute", self.tpm)
        form.addRow("Tokens / day", self.tpd)
        self.sticky = QCheckBox("Sticky sessions (route a client to the same key)")
        self.sticky.setChecked(bool(settings.get("stickySessionsEnabled", False)))
        form.addRow(self.sticky)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        form.addRow(buttons)

    def payload(self) -> dict:
        """Only changed fields — untouched limits are NOT sent as null."""
        body: dict = {}
        for field, box, initial in (
            ("rpmLimit", self.rpm, self._initial.get("rpmLimit")),
            ("rpdLimit", self.rpd, self._initial.get("rpdLimit")),
            ("tpmLimit", self.tpm, self._initial.get("tpmLimit")),
            ("tpdLimit", self.tpd, self._initial.get("tpdLimit")),
        ):
            text = box.currentText().strip()
            new = int(text) if text.isdigit() and int(text) > 0 else None
            old = int(initial) if initial else None
            if new != old:
                body[field] = new
        if self.sticky.isChecked() != bool(self._initial.get("stickySessionsEnabled", False)):
            body["stickySessionsEnabled"] = self.sticky.isChecked()
        return body


class ProviderDialog(QDialog):
    """Create or edit a custom provider (POST/PATCH /api/custom-providers)."""

    def __init__(self, provider: dict | None = None, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Edit custom provider" if provider else "Add custom provider")
        self.setModal(True)
        form = QFormLayout(self)
        self.slug_edit = QLineEdit(provider.get("slug", "") if provider else "")
        self.name_edit = QLineEdit(provider.get("displayName", "") if provider else "")
        self.base_edit = QLineEdit(provider.get("baseUrl", "") if provider else "")
        self.keyless = QCheckBox("Keyless (no API key required)")
        self.keyless.setChecked(bool(provider.get("keyless")) if provider else False)
        form.addRow("Slug", self.slug_edit)
        form.addRow("Display name", self.name_edit)
        form.addRow("Base URL", self.base_edit)
        form.addRow(self.keyless)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        form.addRow(buttons)

    def payload(self) -> dict:
        return {
            "slug": self.slug_edit.text().strip(),
            "displayName": self.name_edit.text().strip(),
            "baseUrl": self.base_edit.text().strip(),
            "keyless": self.keyless.isChecked(),
        }


class RegisterModelDialog(QDialog):
    """POST /api/custom-providers/:slug/models — createModelSchema shape."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Register model")
        self.setModal(True)
        form = QFormLayout(self)
        self.model_id = QLineEdit()
        self.model_id.setPlaceholderText("e.g. my-model-v1 (no platform prefix)")
        self.display_name = QLineEdit()
        self.context_window = QLineEdit("128000")
        form.addRow("Model ID", self.model_id)
        form.addRow("Display name", self.display_name)
        form.addRow("Context window (tokens)", self.context_window)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        form.addRow(buttons)

    def payload(self) -> dict:
        body: dict = {
            "modelId": self.model_id.text().strip(),
            "displayName": self.display_name.text().strip(),
        }
        cw = self.context_window.text().strip()
        if cw.isdigit() and int(cw) > 0:
            body["contextWindow"] = int(cw)
        return body

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
        discover_btn = QPushButton("Discover models")
        discover_btn.setObjectName("ghost")
        discover_btn.setFixedHeight(38)
        discover_btn.setToolTip("Scan every provider for new models (can take minutes)")
        discover_btn.clicked.connect(self._discover_models)
        header.addWidget(discover_btn)
        checkall_btn = QPushButton("Check all keys")
        checkall_btn.setObjectName("ghost")
        checkall_btn.setFixedHeight(38)
        checkall_btn.clicked.connect(self._check_all_keys)
        header.addWidget(checkall_btn)
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
        # H27: the server's ClientKey list exposes no key preview (the secret
        # is shown ONCE at mint time) — drop the phantom column and use the
        # real field names (expires_at_ms, rpm_override).
        configure_table(self.client_keys_table, ["ID", "Label", "Enabled", "Expires", "RPM override", "Actions"])
        layout.addWidget(self.client_keys_table, 1)

        # Custom providers -----------------------------------------------------
        cp_title = QLabel("Custom providers")
        cp_title.setStyleSheet("font-weight: 700;")
        layout.addWidget(cp_title)
        cp_row = QHBoxLayout()
        add_cp_btn = QPushButton("+ Add provider")
        add_cp_btn.setObjectName("ghost")
        add_cp_btn.clicked.connect(self._add_provider)
        cp_row.addWidget(add_cp_btn)
        cp_row.addStretch()
        layout.addLayout(cp_row)
        self.providers_table = QTableWidget()
        configure_table(self.providers_table, ["Slug", "Display name", "Base URL", "Keyless", "Actions"])
        layout.addWidget(self.providers_table, 1)

        # Built-in platform settings -------------------------------------------
        bi_title = QLabel("Built-in platforms")
        bi_title.setStyleSheet("font-weight: 700;")
        layout.addWidget(bi_title)
        self.built_in_table = QTableWidget()
        configure_table(self.built_in_table, ["Platform", "Healthy keys", "Total", "Actions"])
        layout.addWidget(self.built_in_table, 1)

        layout.addStretch()

    # -- refresh ----------------------------------------------------------

    def refresh(self):
        self.call_in_background(self._fetch_all, on_success=self._apply_all)

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
                # H27: HealthPlatform has totalKeys/healthyKeys — there is no
                # "enabledKeys" field (every platform showed "0 enabled").
                name = p.get("platform", "?")
                healthy = p.get("healthyKeys", 0)
                total = p.get("totalKeys", 0)
                rate_limited = p.get("rateLimitedKeys", 0)
                invalid = p.get("invalidKeys", 0)
                extra = f", {rate_limited} limited" if rate_limited else (f", {invalid} invalid" if invalid else "")
                bits.append(f"{name}: {healthy}/{total} healthy{extra}")
            self.health_label.setText("   •   ".join(bits))
        # Per-platform enable state from the ACTUAL keys list (the health
        # endpoint has no enabled count) — mirrors the web's allOn/partial.
        keys_raw = data.get("keys") or []
        k_rows = keys_raw.get("keys") if isinstance(keys_raw, dict) and "keys" in keys_raw else keys_raw
        enabled_by_platform: dict[str, tuple[int, int]] = {}
        for k in (k_rows if isinstance(k_rows, list) else []):
            if not isinstance(k, dict):
                continue
            plat = k.get("platform", "")
            on, total = enabled_by_platform.get(plat, (0, 0))
            enabled_by_platform[plat] = (on + (1 if k.get("enabled", 1) else 0), total + 1)
        self._populate_built_ins(
            [p for p in (platforms or []) if isinstance(p, dict)], enabled_by_platform
        )

        keys = data.get("keys") or []
        rows = keys.get("keys") if isinstance(keys, dict) and "keys" in keys else keys
        self._populate_keys(rows if isinstance(rows, list) else [])

        cks = data.get("client_keys") or []
        ck_rows = cks if isinstance(cks, list) else []

        def _fmt_expiry(ms):
            if not ms:
                return "—"
            from datetime import datetime
            return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")
        self._populate_client_keys(
            [c for c in ck_rows if isinstance(c, dict)], _fmt_expiry
        )

        cps = data.get("custom_providers") or []
        self._populate_providers(
            [c for c in cps if isinstance(c, dict)]
        )

    def _populate_client_keys(self, rows: list[dict], fmt_expiry) -> None:
        """Fill the client-keys table with per-row Enable/Delete actions."""
        table = self.client_keys_table
        table.setRowCount(0)
        table.setRowCount(len(rows))
        for i, c in enumerate(rows):
            cid = c.get("id", "")
            enabled = bool(c.get("enabled", 1))
            for col, val in enumerate([
                cid,
                c.get("label", ""),
                "yes" if enabled else "no",
                fmt_expiry(c.get("expires_at_ms")),
                c.get("rpm_override") if c.get("rpm_override") is not None else "—",
            ]):
                item = QTableWidgetItem(str(val))
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                table.setItem(i, col, item)

            toggle = QPushButton("Disable" if enabled else "Enable")
            toggle.setCheckable(True)
            toggle.setChecked(enabled)
            toggle.clicked.connect(
                lambda checked, _id=cid, _btn=toggle: self._toggle_client_key(_id, checked, _btn)
            )
            delete = QPushButton("Delete")
            delete.setObjectName("danger")
            delete.clicked.connect(lambda _=False, _id=cid: self._delete_client_key(_id))
            actions = QWidget()
            hl = QHBoxLayout(actions)
            hl.setContentsMargins(4, 2, 4, 2)
            hl.addWidget(toggle)
            hl.addWidget(delete)
            table.setCellWidget(i, 5, actions)

    def _populate_providers(self, rows: list[dict]) -> None:
        """Custom providers with Edit / Models / Sync / Delete actions."""
        table = self.providers_table
        table.setRowCount(0)
        table.setRowCount(len(rows))
        for i, p in enumerate(rows):
            slug = p.get("slug", "")
            if p.get("archived"):
                continue
            for col, val in enumerate([
                slug,
                p.get("displayName", ""),
                p.get("baseUrl", ""),
                "yes" if p.get("keyless") else "no",
            ]):
                item = QTableWidgetItem(str(val))
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                table.setItem(i, col, item)

            edit = QPushButton("Edit")
            edit.clicked.connect(lambda _=False, _p=p: self._edit_provider(_p))
            models = QPushButton("Models")
            models.setToolTip("Register, edit or archive this provider's models")
            models.clicked.connect(lambda _=False, _s=slug: self._provider_models(_s))
            sync = QPushButton("Sync")
            sync.setToolTip("Re-scan the provider's /models endpoint")
            sync.clicked.connect(lambda _=False, _s=slug: self._sync_provider(_s))
            delete = QPushButton("Delete")
            delete.setObjectName("danger")
            delete.clicked.connect(lambda _=False, _s=slug, _n=p.get("displayName", slug): self._delete_provider(_s, _n))
            actions = QWidget()
            hl = QHBoxLayout(actions)
            hl.setContentsMargins(4, 2, 4, 2)
            hl.addWidget(edit)
            hl.addWidget(models)
            hl.addWidget(sync)
            hl.addWidget(delete)
            table.setCellWidget(i, 4, actions)

    def _populate_built_ins(self, platforms: list[dict],
                            enabled_by_platform: dict[str, tuple[int, int]] | None = None) -> None:
        """Built-in platforms with a master key switch + Settings per row."""
        table = self.built_in_table
        table.setRowCount(0)
        table.setRowCount(len(platforms))
        for i, p in enumerate(platforms):
            slug = p.get("platform", "")
            for col, val in enumerate([
                slug,
                p.get("healthyKeys", 0),
                p.get("totalKeys", 0),
            ]):
                item = QTableWidgetItem(str(val))
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                table.setItem(i, col, item)
            # Master switch: enable/disable ALL keys of this platform in one
            # call (web parity — PATCH /api/keys/platform/:platform). State
            # comes from the real key rows: all on / partial / all off.
            on, total = (enabled_by_platform or {}).get(slug, (0, 0))
            if total and on == total:
                state_text = "All on"
            elif on:
                state_text = f"Partial ({on}/{total})"
            else:
                state_text = "All off"
            master = QPushButton(state_text)
            master.setToolTip("Enable or disable every key of this platform at once")
            master.clicked.connect(
                lambda _=False, _s=slug, _btn=master: self._toggle_platform(_s, _btn)
            )
            settings_btn = QPushButton("Settings")
            settings_btn.setToolTip("Rate limits and sticky sessions")
            settings_btn.clicked.connect(lambda _=False, _s=slug: self._edit_built_in_settings(_s))
            actions = QWidget()
            hl = QHBoxLayout(actions)
            hl.setContentsMargins(4, 2, 4, 2)
            hl.addWidget(master)
            hl.addWidget(settings_btn)
            table.setCellWidget(i, 3, actions)

    def _toggle_platform(self, platform: str, button: QPushButton) -> None:
        """One-click enable/disable of every key on a platform."""
        turn_on = button.text() == "All off"
        from PyQt6.QtWidgets import QMessageBox
        verb = "Enable" if turn_on else "Disable"
        confirm = QMessageBox.question(
            self, f"{verb} all keys",
            f"{verb} every key of '{platform}'?",
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return

        def _on_error(e: Exception) -> None:
            Toaster.show(str(e), "error")

        self.call_in_background(
            lambda: self.api.patch(f"/api/keys/platform/{platform}", json={"enabled": turn_on}),
            on_success=lambda r: (
                Toaster.show(
                    f"{'Enabled' if turn_on else 'Disabled'} {self._updated_keys(r)} key(s) on {platform}",
                    "success"),
                self.refresh(),
            ),
            on_error=_on_error,
        )

    @staticmethod
    def _updated_keys(result) -> int:
        if isinstance(result, dict):
            n = result.get("updatedKeys")
            if isinstance(n, int):
                return n
        return 0

    def _add_provider(self):
        dialog = ProviderDialog(parent=self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        payload = dialog.payload()
        if not payload["slug"] or not payload["displayName"] or not payload["baseUrl"]:
            Toaster.show("Slug, display name and base URL are required", "error")
            return
        self.call_in_background(
            lambda: self.api.post("/api/custom-providers", json=payload),
            on_success=lambda _r: (self.refresh(), Toaster.show("Provider added", "success")),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _edit_provider(self, provider: dict):
        dialog = ProviderDialog(provider=provider, parent=self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        payload = dialog.payload()
        slug = provider.get("slug", "")
        # PATCH takes only the fields that changed (slug included when the
        # user renamed it — the server handles the rename + key migration).
        body = {
            k: v for k, v in payload.items()
            if k == "keyless" or v != (provider.get(k) or "")
        }
        if "slug" in body and body["slug"] == slug:
            del body["slug"]
        if not body:
            Toaster.info("Nothing changed")
            return
        self.call_in_background(
            lambda: self.api.patch(f"/api/custom-providers/{slug}", json=body),
            on_success=lambda _r: (self.refresh(), Toaster.show("Provider updated", "success")),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _delete_provider(self, slug: str, name: str):
        confirm = QMessageBox.question(
            self, "Delete provider",
            f"Delete provider {name} ({slug})? Its keys are disabled and its "
            "models drop out of the fallback chain. This cannot be undone.",
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        self.call_in_background(
            lambda: self.api.delete(f"/api/custom-providers/{slug}"),
            on_success=lambda _r: (self.refresh(), Toaster.show("Provider deleted", "success")),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _sync_provider(self, slug: str):
        Toaster.info(f"Syncing models from {slug}…")
        self.call_in_background(
            lambda: self.api.post(f"/api/custom-providers/{slug}/sync-models"),
            on_success=self._toast_synced,
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _toast_synced(self, result):
        if isinstance(result, dict):
            added = result.get("added") or result.get("addedModels") or []
            Toaster.success(f"Sync finished — {len(added)} new model(s)")
        else:
            Toaster.success("Sync finished")
        self.refresh()

    def _edit_built_in_settings(self, slug: str):
        """GET the live settings, then open the edit dialog (seeded)."""
        self.call_in_background(
            lambda: self.api.get(f"/api/platforms/{slug}/settings"),
            on_success=lambda s: self._open_built_in_settings(slug, s),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _open_built_in_settings(self, slug: str, settings):
        if not isinstance(settings, dict):
            Toaster.show("No settings returned", "error")
            return
        dialog = PlatformSettingsDialog(settings, self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        body = dialog.payload()
        if not body:
            Toaster.info("Nothing changed")
            return
        self.call_in_background(
            lambda: self.api.patch(f"/api/platforms/{slug}/settings", json=body),
            on_success=lambda _r: Toaster.show("Settings saved", "success"),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _provider_models(self, slug: str):
        self.call_in_background(
            lambda: self.api.get(f"/api/custom-providers/{slug}/models"),
            on_success=lambda models: self._open_provider_models(slug, models),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _toggle_client_key(self, key_id: str, new_enabled: bool, button: QPushButton) -> None:
        if not key_id:
            return

        def _on_error(e: Exception) -> None:
            button.setChecked(not new_enabled)
            Toaster.show(str(e), "error")

        self.call_in_background(
            lambda: self.api.patch(f"/api/keys/client/{key_id}", json={"enabled": new_enabled}),
            on_success=lambda _r: self.refresh(),
            on_error=_on_error,
        )

    def _delete_client_key(self, key_id: str) -> None:
        if not key_id:
            return
        confirm = QMessageBox.question(
            self, "Delete client key",
            f"Delete client key {key_id}? Apps using it lose access immediately.",
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        self.call_in_background(
            lambda: self.api.delete(f"/api/keys/client/{key_id}"),
            on_success=lambda _r: (self.refresh(), Toaster.show("Client key removed", "success")),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _open_provider_models(self, slug: str, models) -> None:
        rows = [m for m in (models or []) if isinstance(m, dict)]
        dlg = QDialog(self)
        dlg.setWindowTitle(f"Models — {slug}")
        dlg.setModal(True)
        v = QVBoxLayout(dlg)
        hint = QLabel(f"Models registered under {slug}. Register adds one at the lowest fallback priority.")
        hint.setWordWrap(True)
        v.addWidget(hint)
        table = QTableWidget()
        configure_table(table, ["ID", "Model ID", "Display name", "Enabled", "Actions"])
        v.addWidget(table)
        table.setRowCount(len(rows))
        for i, m in enumerate(rows):
            mid = m.get("id", "")
            for col, val in enumerate([
                mid,
                m.get("modelId", ""),
                m.get("displayName", ""),
                "yes" if m.get("enabled", 1) else "no",
            ]):
                item = QTableWidgetItem(str(val))
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                table.setItem(i, col, item)
            toggle = QPushButton("Disable" if m.get("enabled", 1) else "Enable")
            toggle.clicked.connect(
                lambda _=False, _id=mid, _en=m.get("enabled", 1), _btn=toggle: self._toggle_model(_id, _en, _btn)
            )
            archive = QPushButton("Archive")
            archive.setObjectName("danger")
            archive.clicked.connect(lambda _=False, _id=mid, _mid=m.get("modelId", ""): self._archive_model(_id, _mid))
            actions = QWidget()
            hl = QHBoxLayout(actions)
            hl.setContentsMargins(4, 2, 4, 2)
            hl.addWidget(toggle)
            hl.addWidget(archive)
            table.setCellWidget(i, 4, actions)
        register = QPushButton("+ Register model")
        register.setObjectName("primary")
        register.clicked.connect(lambda: self._register_model(slug, dlg))
        v.addWidget(register)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(dlg.reject)
        buttons.clicked.connect(lambda _b: dlg.reject())
        v.addWidget(buttons)
        dlg.exec()

    def _toggle_model(self, model_db_id, currently_enabled: bool, button: QPushButton) -> None:
        self.call_in_background(
            lambda: self.api.patch(f"/api/custom-models/{model_db_id}", json={"enabled": not currently_enabled}),
            on_success=lambda _r: Toaster.show("Model updated", "success"),
            on_error=lambda e: (button.setText("Enable" if not currently_enabled else "Disable"),
                                Toaster.show(str(e), "error")),
        )

    def _archive_model(self, model_db_id, model_id: str) -> None:
        confirm = QMessageBox.question(
            self, "Archive model",
            f"Archive {model_id}? It leaves the fallback chain; history is kept.",
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        self.call_in_background(
            lambda: self.api.delete(f"/api/custom-models/{model_db_id}"),
            on_success=lambda _r: Toaster.show("Model archived", "success"),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _register_model(self, slug: str, parent_dialog) -> None:
        dialog = RegisterModelDialog(parent=self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        payload = dialog.payload()
        if not payload["modelId"] or not payload["displayName"]:
            Toaster.show("Model ID and display name are required", "error")
            return
        body = {k: v for k, v in payload.items() if v is not None}
        self.call_in_background(
            lambda: self.api.post(f"/api/custom-providers/{slug}/models", json=body),
            on_success=lambda _r: (Toaster.show("Model registered", "success"),
                                   self._provider_models(slug)),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _populate_keys(self, rows: list[dict]):
        self.keys_table.setRowCount(0)
        self.keys_table.setRowCount(len(rows))
        for i, k in enumerate(rows):
            kid = k.get("id", "")
            platform = k.get("platform", "")
            masked = k.get("maskedKey") or k.get("masked") or ""
            label = k.get("label", "") or "—"
            status = k.get("status", "unknown")
            enabled = bool(k.get("enabled", 1))
            # H27: populate the Enabled column (was always blank).
            for col, val in enumerate([kid, platform, masked, label, status, "yes" if enabled else "no"]):
                item = QTableWidgetItem(str(val))
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self.keys_table.setItem(i, col, item)

            toggle = QPushButton("Disable" if enabled else "Enable")
            toggle.setCheckable(True)
            toggle.setChecked(enabled)
            # The clicked signal carries the NEW checked state — don't rely
            # on the `enabled` captured at row-build time (stale after any
            # refresh-less change). On PATCH failure the button is reverted
            # so the visual state never lies (audit L98).
            toggle.clicked.connect(lambda checked, _id=kid, _btn=toggle: self._toggle_key(_id, checked, _btn))
            rename = QPushButton("Rename")
            rename.setToolTip("Edit this key's label")
            rename.clicked.connect(lambda _=False, _id=kid, _l=label: self._rename_key(_id, _l))
            check = QPushButton("Check")
            check.setToolTip("Run a health check on this key now")
            check.clicked.connect(lambda _=False, _id=kid: self._check_key(_id))
            delete = QPushButton("Delete")
            delete.setObjectName("danger")
            delete.setToolTip("Delete this key permanently")
            delete.clicked.connect(lambda _=False, _id=kid, _p=platform, _l=label: self._delete_key(_id, _p, _l))
            actions = QWidget()
            hl = QHBoxLayout(actions)
            hl.setContentsMargins(4, 2, 4, 2)
            hl.addWidget(toggle)
            hl.addWidget(rename)
            hl.addWidget(check)
            hl.addWidget(delete)
            self.keys_table.setCellWidget(i, 6, actions)

    def _rename_key(self, key_id, current_label: str):
        """PATCH /api/keys/:id {label} — inline label rename (web parity)."""
        if key_id in (None, ""):
            return
        from PyQt6.QtWidgets import QInputDialog
        text, ok = QInputDialog.getText(
            self, "Rename key", "New label:", text="" if current_label == "—" else current_label
        )
        if not ok:
            return
        new_label = text.strip()
        if new_label == current_label or (not new_label and current_label == "—"):
            Toaster.info("Nothing changed")
            return
        self.call_in_background(
            lambda: self.api.patch(f"/api/keys/{key_id}", json={"label": new_label}),
            on_success=lambda _r: (self.refresh(), Toaster.show("Label updated", "success")),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

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
        # M79: the platform lists come from the network — fetch them on a
        # worker thread and open the dialog only when the result is back.
        self.call_in_background(self._fetch_platforms, on_success=self._open_add_key_dialog)

    def _fetch_platforms(self) -> list[str]:
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
        return sorted({p for p in platforms if p})

    def _open_add_key_dialog(self, platforms: list[str]):
        dialog = AddKeyDialog(platforms, self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        payload = dialog.payload()
        if not payload["platform"] or not payload["key"]:
            Toaster.show("Platform and key are required", "error")
            return
        self.call_in_background(
            lambda: self.api.post("/api/keys", json={k: v for k, v in payload.items() if v is not None}),
            on_success=lambda _r: (self.refresh(), Toaster.show("Key added", "success")),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _discover_models(self):
        """POST /api/models/sync-all — scans every provider; minutes-long."""
        Toaster.info("Discovering models across all providers — this can take minutes")
        self.call_in_background(
            lambda: self.api.post("/api/models/sync-all"),
            on_success=self._toast_discovered,
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _toast_discovered(self, result):
        if not isinstance(result, dict):
            Toaster.success("Model discovery finished")
            return
        added = result.get("added_by_provider") or {}
        total_added = sum(len(v) for v in added.values() if isinstance(v, list))
        errors = result.get("errors") or []
        bits = [f"{slug}: {len(models)}" for slug, models in added.items() if isinstance(models, list)]
        summary = " · ".join(bits) if bits else "no new models"
        Toaster.success(f"Discovered {total_added} new model(s) — {summary}")
        if errors:
            Toaster.show(f"{len(errors)} provider(s) failed to sync", "info")
        self.refresh()

    def _toggle_key(self, key_id, new_enabled: bool, button: QPushButton) -> None:
        if key_id in (None, ""):
            return

        def _on_error(e: Exception) -> None:
            # Revert the checkable button so the UI matches the server again.
            button.setChecked(not new_enabled)
            Toaster.show(str(e), "error")

        self.call_in_background(
            lambda: self.api.patch(f"/api/keys/{key_id}", json={"enabled": new_enabled}),
            on_success=lambda _r: self.refresh(),
            on_error=_on_error,
        )

    def _delete_key(self, key_id, platform: str, label: str | None = None):
        if key_id in (None, ""):
            return
        name = label if label and label != "—" else f"#{key_id}"
        confirm = QMessageBox.question(
            self, "Delete key",
            f"Delete key {name} ({platform})? This cannot be undone.",
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        self.call_in_background(
            lambda: self.api.delete(f"/api/keys/{key_id}"),
            on_success=lambda _r: (self.refresh(), Toaster.show("Key removed", "success")),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _check_key(self, key_id):
        """POST /api/health/check/{keyId} — one key, one toast."""
        if key_id in (None, ""):
            return
        self.call_in_background(
            lambda: self.api.post(f"/api/health/check/{key_id}"),
            on_success=lambda r: (self._toast_check_result(r), self.refresh()),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _toast_check_result(self, result):
        if isinstance(result, dict):
            status = result.get("status") or result.get("result") or "done"
            key_id = result.get("keyId") or result.get("id") or "?"
            Toaster.show(f"Key #{key_id}: {status}", "info")
        else:
            Toaster.show("Key checked", "info")

    def _check_all_keys(self):
        """POST /api/health/check-all — long; toast when the fleet is done."""
        Toaster.info("Checking all keys — this can take a while")
        self.call_in_background(
            lambda: self.api.post("/api/health/check-all"),
            on_success=lambda r: (
                Toaster.success("Health check finished"),
                self.refresh(),
            ),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )
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



def _prompt_text(parent, label: str) -> tuple[str, bool]:
    from PyQt6.QtWidgets import QInputDialog

    text, ok = QInputDialog.getText(parent, "Keys", label)
    return text.strip(), ok
