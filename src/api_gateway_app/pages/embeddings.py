"""Embeddings page: view + edit provider chains and default family."""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..backend import ApiError
from ..widgets.table import configure_table
from ..widgets.toast import Toaster
from .base import BasePage


class EmbeddingsPage(BasePage):
    title = "Embeddings"

    def __init__(self, api, parent=None):
        super().__init__(api, parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 26, 28, 24)
        layout.setSpacing(14)

        title = QLabel("Embeddings")
        subtitle = QLabel(
            "Provider chains and per-family usage for /v1/embeddings. "
            "Toggle providers, reorder by priority, and set the default family."
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

        # -- Default family + save ------------------------------------------------
        controls = QHBoxLayout()
        controls.addWidget(QLabel("Default family:"))
        self.default_box = QComboBox()
        self.default_box.setToolTip("Used when /v1/embeddings gets no family")
        controls.addWidget(self.default_box)
        controls.addStretch()
        self.save_btn = QPushButton("Save changes")
        self.save_btn.setObjectName("primary")
        self.save_btn.setEnabled(False)
        self.save_btn.clicked.connect(self._save)
        controls.addWidget(self.save_btn)
        layout.addLayout(controls)

        # -- Provider rows -------------------------------------------------------
        self.table = QTableWidget()
        configure_table(
            self.table,
            ["Family", "Provider", "Priority", "Enabled", "Monthly tokens", "Requests today"],
        )
        layout.addWidget(self.table, 1)

        row = QHBoxLayout()
        sync = QPushButton("Re-sync models")
        sync.clicked.connect(self._sync)
        row.addWidget(sync)
        row.addStretch()
        layout.addLayout(row)

        # Local edit state: rows are (id, priority, enabled) keyed by model id.
        self._rows: dict[int, dict] = {}      # id -> {family, provider, priority, enabled}
        self._usage: dict[str, dict] = {}     # family -> usage
        self._dirty = False

    def on_show(self):
        self.refresh()

    def refresh(self):
        self.set_loading(True)
        self.call_in_background(self._fetch, on_success=self._apply)

    def _fetch(self):
        chains = self.api.get("/api/embeddings") or []
        try:
            usage = self.api.get("/api/embeddings/usage") or {}
        except ApiError:
            usage = {}
        return chains, usage

    def _apply(self, result):
        self.set_loading(False)
        chains, usage = result
        # H27: GET /api/embeddings →
        # { defaultFamily, families: [{ family, isDefault, providers: [...] }] };
        # GET /api/embeddings/usage → { families: [{ family, requestsToday,
        # tokensMonth }] }.
        self._usage = {}
        if isinstance(usage, dict) and isinstance(usage.get("families"), list):
            for u in usage["families"]:
                if isinstance(u, dict):
                    self._usage[u.get("family")] = u

        families = (
            chains.get("families", []) if isinstance(chains, dict)
            else (chains if isinstance(chains, list) else [])
        )
        default_family = chains.get("defaultFamily") if isinstance(chains, dict) else None

        # Default-family combo (signals blocked — repopulate is not an edit)
        self.default_box.blockSignals(True)
        self.default_box.clear()
        fam_names = [f.get("family", "") for f in families if isinstance(f, dict)]
        self.default_box.addItems(fam_names)
        if default_family in fam_names:
            self.default_box.setCurrentText(default_family)
        self.default_box.blockSignals(False)
        if not getattr(self, "_combo_wired", False):
            self.default_box.currentTextChanged.connect(self._mark_dirty)
            self._combo_wired = True

        # Flat provider list across every family; row -> pid map for the
        # checkbox handler.  Table signals stay blocked until the fill is
        # done so populate-time setItem/checkstate calls are never treated
        # as user edits.
        all_providers: list[tuple[str, dict]] = []
        for fam in families:
            if not isinstance(fam, dict):
                continue
            for p in fam.get("providers", []):
                if isinstance(p, dict):
                    all_providers.append((fam.get("family", ""), p))

        self._rows = {}
        self._row_pids: dict[int, object] = {}
        self.table.blockSignals(True)
        self.table.setRowCount(len(all_providers))
        for i, (family, p) in enumerate(all_providers):
            pid = p.get("id")
            self._rows[pid] = {
                "family": family, "provider": p,
                "priority": p.get("priority", i + 1),
                "enabled": bool(p.get("enabled", 1)),
            }
            self._row_pids[i] = pid

            # Family + provider label cells
            for col, val in enumerate([family, p.get("displayName") or p.get("modelId", "")]):
                item = QTableWidgetItem(str(val))
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self.table.setItem(i, col, item)

            # Priority spin — connect AFTER setValue so the seed is not an edit
            spin = QSpinBox()
            spin.setRange(1, 999)
            spin.setValue(p.get("priority", i + 1))
            spin.valueChanged.connect(
                lambda v, _id=pid: self._edit_row(_id, priority=v)
            )
            self.table.setCellWidget(i, 2, spin)

            # Enabled checkbox cell
            check_item = QTableWidgetItem()
            check_item.setFlags(check_item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            check_item.setCheckState(
                Qt.CheckState.Checked if p.get("enabled", 1) else Qt.CheckState.Unchecked
            )
            self.table.setItem(i, 3, check_item)

            # Usage cells (read-only)
            u = self._usage.get(family) or {}
            tokens_item = QTableWidgetItem(f"{u.get('tokensMonth', 0):,}")
            req_item = QTableWidgetItem(f"{u.get('requestsToday', 0):,}")
            for item in (tokens_item, req_item):
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self.table.setItem(i, 4, tokens_item)
            self.table.setItem(i, 5, req_item)

        # Populate done — re-enable user edits, then wire the handler once.
        self.table.blockSignals(False)
        if not getattr(self, "_item_changed_wired", False):
            self.table.itemChanged.connect(self._row_item_changed)
            self._item_changed_wired = True
        self._set_dirty(False)

    # -- editing ---------------------------------------------------------------

    def _edit_row(self, pid, priority=None, enabled=None):
        row = self._rows.get(pid)
        if row is None:
            return
        if priority is not None:
            row["priority"] = priority
        if enabled is not None:
            row["enabled"] = enabled
        self._set_dirty(True)

    def _row_item_changed(self, item: QTableWidgetItem):
        """Enable-column checkbox toggles (col 3)."""
        if item.column() != 3:
            return
        pid = self._row_pids.get(item.row())
        if pid is None:
            return
        self._edit_row(pid, enabled=item.checkState() == Qt.CheckState.Checked)

    def _mark_dirty(self, _text: str = ""):
        self._set_dirty(True)

    def _set_dirty(self, dirty: bool):
        self._dirty = dirty
        self.save_btn.setEnabled(dirty)

    def _save(self):
        body: dict = {}
        default = self.default_box.currentText()
        if default:
            body["defaultFamily"] = default
        # Flat provider list across every family — ids are global.
        body["providers"] = [
            {"id": pid, "priority": row["priority"], "enabled": row["enabled"]}
            for pid, row in self._rows.items()
        ]
        self.call_in_background(
            lambda: self.api.put("/api/embeddings", json=body),
            on_success=lambda _r: (
                Toaster.show("Embeddings settings saved", "success"),
                self._set_dirty(False),
                self.refresh(),
            ),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _sync(self):
        # M81: "Re-sync models" is the model catalog sync (POST
        # /api/models/sync-all) — the old empty-body PUT to /api/embeddings
        # was the family-CONFIG save route and risked wiping it.
        self.call_in_background(
            lambda: self.api.post("/api/models/sync-all"),
            on_success=lambda _r: (Toaster.show("Model catalog re-synced", "success"), self.refresh()),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )
