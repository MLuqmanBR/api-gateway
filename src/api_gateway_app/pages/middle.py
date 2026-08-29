"""Privacy (privacy middle-layer) page.

Config: `/api/middle/config` — every value is a *string* in the store, even
booleans ("0"/"1") and ratios ("0.15").
Secrets: `/api/middle/secrets`, `/bulk`, with query-param ids.
Stats:   `/api/middle/stats`.
"""

from __future__ import annotations

from PyQt6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from ..widgets.floating_bar import FloatingBar
from ..widgets.table import configure_table, fill_table
from ..widgets.toast import Toaster
from .base import BasePage

# Keys mirrored from server/src/routes/middle.ts CONFIG_KEYS / DEFAULTS
# (verified 2026-08-29 against the live route — 11 keys, exactly these).
BOOL_KEYS = [
    "middle_redaction_enabled",
    "middle_compression_enabled",
    "middle_compression_smart_crusher",
    "middle_compression_emit_sentinel",
    "middle_compression_smart_crusher_lossless_only",
    "middle_interceptor_inbound_enabled",
]
TEXT_KEYS = [
    "middle_compression_protect_recent",
    "middle_compression_min_savings_ratio",
    "middle_interceptor_model",
    "middle_interceptor_timeout_ms",
    "middle_detection_targets",
]


class PrivacyPage(BasePage):
    title = "Privacy"

    def __init__(self, api, parent=None):
        super().__init__(api, parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 26, 28, 24)
        layout.setSpacing(14)

        title = QLabel("Privacy layer")
        subtitle = QLabel(
            "Redaction physically replaces secrets with ⟦R{n}:{tag}⟧ placeholders before traffic leaves the gateway. "
            "The interceptor model spots secrets you haven't catalogued yet."
        )
        subtitle.setWordWrap(True)
        layout.addWidget(title)
        layout.addWidget(subtitle)
        layout.addWidget(self.error_label)

        from ..widgets.styled import style_hero_title, style_page_subtitle, watch_style
        watch_style(lambda: style_hero_title(title))
        watch_style(lambda: style_page_subtitle(subtitle))
        style_hero_title(title)
        style_page_subtitle(subtitle)

        tabs = QTabWidget()
        layout.addWidget(tabs, 1)

        # ---- Config tab ------------------------------------------------------
        config_tab = QWidget()
        tabs.addTab(config_tab, "Config")
        form = QFormLayout(config_tab)

        self._checks: dict[str, QCheckBox] = {}
        for key in BOOL_KEYS:
            label = key.replace("middle_", "").replace("_", " ")
            box = QCheckBox(label)
            self._checks[key] = box
            form.addRow(box)

        self._edits: dict[str, QLineEdit] = {}
        for key in TEXT_KEYS:
            label = key.replace("middle_", "").replace("_", " ")
            edit = QLineEdit()
            self._edits[key] = edit
            form.addRow(label, edit)

        self._floating = FloatingBar()
        self._floating.save_button.clicked.connect(self._save_config)
        self._floating.discard_button.clicked.connect(self.refresh)
        for box in self._checks.values():
            box.toggled.connect(lambda _c: self._floating.show_bar())
        for edit in self._edits.values():
            edit.textChanged.connect(lambda _t: self._floating.show_bar())
        layout.addWidget(self._floating)

        # ---- Secrets tab ------------------------------------------------------
        secrets_tab = QWidget()
        tabs.addTab(secrets_tab, "Secrets")
        sv = QVBoxLayout(secrets_tab)

        bulk_title = QLabel("Add secrets (one per line: value[, kind[, label]])")
        sv.addWidget(bulk_title)
        self.bulk_edit = QPlainTextEdit()
        self.bulk_edit.setPlaceholderText("sk-abc123, api_key, OpenAI prod key")
        sv.addWidget(self.bulk_edit)

        row = QHBoxLayout()
        add_btn = QPushButton("Add secrets")
        add_btn.setObjectName("primary")
        add_btn.clicked.connect(self._add_bulk)
        row.addWidget(add_btn)
        row.addStretch()
        sv.addLayout(row)

        self.secrets_table = QTableWidget()
        configure_table(self.secrets_table, ["ID", "Kind", "Label", "Mask", "Enabled"])
        self.secrets_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.secrets_table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        sv.addWidget(self.secrets_table, 1)

        srow = QHBoxLayout()
        toggle_btn = QPushButton("Toggle selected")
        toggle_btn.clicked.connect(lambda: self._toggle_selected())
        srow.addWidget(toggle_btn)
        delete_btn = QPushButton("Delete selected")
        delete_btn.setObjectName("danger")
        delete_btn.clicked.connect(self._delete_selected)
        srow.addWidget(delete_btn)
        srow.addStretch()
        sv.addLayout(srow)
        layout.addWidget(tabs, 1)

        # ---- Stats tab ----------------------------------------------------------
        stats_tab = QWidget()
        tabs.addTab(stats_tab, "Stats")
        st = QFormLayout(stats_tab)
        self.stat_failures = QLabel("—")
        self.stat_active = QLabel("—")
        st.addRow("Interceptor failures:", self.stat_failures)
        st.addRow("Active secrets:", self.stat_active)

    # ------------------------------------------------------------------
    def on_show(self):
        self.refresh()

    def refresh(self):
        self._refresh_config()
        self._refresh_secrets()
        self._refresh_stats()
        self._floating.hide_bar()

    # ---- config ---------------------------------------------------------
    def _refresh_config(self):
        self.call_in_background(
            lambda: self.api.get("/api/middle/config"),
            on_success=self._apply_config,
        )

    def _apply_config(self, cfg: dict):
        for key, box in self._checks.items():
            box.blockSignals(True)
            box.setChecked(str(cfg.get(key, "0")) == "1")
            box.blockSignals(False)
        for key, edit in self._edits.items():
            edit.blockSignals(True)
            edit.setText(str(cfg.get(key, "")))
            edit.blockSignals(False)

    def _save_config(self):
        body: dict[str, str] = {}
        for key, box in self._checks.items():
            body[key] = "1" if box.isChecked() else "0"
        for key, edit in self._edits.items():
            body[key] = edit.text()
        self.call_in_background(
            lambda: self.api.put("/api/middle/config", json=body),
            on_success=lambda _r: (self._floating.hide_bar(), Toaster.show("Privacy config saved", "success")),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    # ---- secrets ---------------------------------------------------------
    def _refresh_secrets(self):
        self.call_in_background(
            lambda: self.api.get("/api/middle/secrets"),
            on_success=self._apply_secrets,
        )

    def _apply_secrets(self, secrets):
        secrets = secrets if isinstance(secrets, list) else secrets.get("secrets", []) if isinstance(secrets, dict) else []
        fill_table(self.secrets_table, [
            [
                s.get("id", ""),
                s.get("kind", ""),
                s.get("label", ""),
                s.get("maskedPreview") or s.get("mask") or s.get("maskedValue", "••••"),
                "yes" if s.get("enabled", True) else "no",
            ]
            for s in (secrets or [])
        ])
        # Stash the raw id + enabled flag for later actions.
        for i, s in enumerate(secrets or []):
            item = self.secrets_table.item(i, 0)
            if item:
                item.setData(0x0100, s.get("id"))
                item.setData(0x0101, bool(s.get("enabled", True)))

    def _selected_rows(self) -> list[tuple[int | str, bool]]:
        """(secret_id, currently_enabled) pairs for the selected rows."""
        rows = []
        for index in self.secrets_table.selectionModel().selectedRows():
            item = self.secrets_table.item(index.row(), 0)
            if item is not None:
                sid = item.data(0x0100) or item.text()
                if sid not in ("", None):
                    rows.append((sid, bool(item.data(0x0101))))
        return rows

    def _add_bulk(self):
        secrets = []
        for line in self.bulk_edit.toPlainText().splitlines():
            line = line.strip()
            if not line:
                continue
            parts = [p.strip() for p in line.split(",")]
            if not parts or not parts[0]:
                continue
            secrets.append({
                "value": parts[0],
                "kind": parts[1] if len(parts) > 1 else "api_key",
                "label": parts[2] if len(parts) > 2 else None,
            })
        if not secrets:
            Toaster.show("Nothing to add", "error")
            return
        self.call_in_background(
            lambda: self.api.post("/api/middle/secrets/bulk", json={"secrets": secrets}),
            on_success=lambda _r: (Toaster.show(f"Added {len(secrets)} secrets", "success"), self.bulk_edit.clear(), self._refresh_secrets()),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _toggle_selected(self):
        # M80: PATCH /api/middle/secrets requires {enabled: <new boolean>}
        # per secret (the server rejects an empty body), so flip each
        # selected secret from its own current state.
        rows = self._selected_rows()
        if not rows:
            return
        for sid, enabled in rows:
            target = not enabled
            self.call_in_background(
                lambda s=sid, t=target: self.api.patch(
                    "/api/middle/secrets", params={"id": s}, json={"enabled": t}
                ),
                on_success=lambda _r: self._refresh_secrets(),
                on_error=lambda e: Toaster.show(str(e), "error"),
            )

    def _delete_selected(self):
        ids = [sid for sid, _enabled in self._selected_rows()]
        if not ids:
            return
        self.call_in_background(
            lambda: self.api.delete("/api/middle/secrets/bulk", params={"ids": ",".join(str(i) for i in ids)}),
            on_success=lambda _r: (Toaster.show("Secrets removed", "success"), self._refresh_secrets()),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    # ---- stats -----------------------------------------------------------
    def _refresh_stats(self):
        self.call_in_background(
            lambda: self.api.get("/api/middle/stats"),
            on_success=self._apply_stats,
            on_error=lambda e: None,
        )

    def _apply_stats(self, stats: dict):
        self.stat_failures.setText(str(stats.get("interceptor_failures", 0)))
        self.stat_active.setText(str(stats.get("active_secrets", 0)))
