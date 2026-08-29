"""Fallback chain editor: drag-order, per-row enable, routing strategy, retry."""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from ..widgets.toast import Toaster
from .base import BasePage

STRATEGIES = ["priority", "balanced", "smartest", "fastest", "reliable", "custom"]


class FallbackPage(BasePage):
    title = "Fallback"

    def __init__(self, api, parent=None):
        super().__init__(api, parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 26, 28, 24)
        layout.setSpacing(14)

        title_block = QVBoxLayout()
        title_block.setSpacing(2)
        title = QLabel("Fallback chain")
        subtitle = QLabel(
            "The gateway walks models in this order until one answers. Drag to reorder — the first capable model wins."
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

        # -- Routing controls ------------------------------------------------
        controls = QHBoxLayout()
        controls.addWidget(QLabel("Strategy:"))
        self.strategy_box = QComboBox()
        self.strategy_box.addItems(STRATEGIES)
        self.strategy_box.setToolTip(
            "priority = the manual chain order; the others score models "
            "on reliability / speed / intelligence"
        )
        self.strategy_box.currentTextChanged.connect(self._strategy_changed)
        controls.addWidget(self.strategy_box)
        controls.addWidget(QLabel("Retry limit:"))
        self.retry_spin = QSpinBox()
        self.retry_spin.setRange(0, 20)
        self.retry_spin.setSpecialValueText("∞")  # 0 = infinite (server allows 0-100)
        self.retry_spin.setToolTip(
            "How many models to try before giving up. 0 = unlimited."
        )
        self.retry_spin.valueChanged.connect(self._retry_changed)
        controls.addWidget(self.retry_spin)
        self.filter_edit = QLineEdit()
        self.filter_edit.setPlaceholderText("Filter models…")
        self.filter_edit.setClearButtonEnabled(True)
        self.filter_edit.textChanged.connect(self._apply_filter)
        controls.addWidget(self.filter_edit, 1)
        layout.addLayout(controls)

        actions = QHBoxLayout()
        save_btn = QPushButton("Save order")
        save_btn.setObjectName("primary")
        save_btn.clicked.connect(self._save)
        actions.addWidget(save_btn)
        for preset in ("fastest", "cheapest", "smartest"):
            btn = QPushButton(f"Sort: {preset}")
            btn.clicked.connect(lambda _=False, p=preset: self._sort(p))
            actions.addWidget(btn)
        actions.addStretch()
        layout.addLayout(actions)

        self.list = QListWidget()
        self.list.setDragDropMode(QAbstractItemView.DragDropMode.InternalMove)
        self.list.setDefaultDropAction(Qt.DropAction.MoveAction)
        self.list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        # Per-row enable/disable: the checkbox edits the entry's `enabled`,
        # saved through the same PUT /api/fallback payload as the order.
        self.list.itemChanged.connect(self._row_toggled)
        layout.addWidget(self.list, 1)

    # -- lifecycle ----------------------------------------------------------

    def on_show(self):
        self.refresh()

    def refresh(self):
        self.set_loading(True)
        self.call_in_background(self._fetch, on_success=self._apply)

    def _fetch(self):
        chain = self.api.get("/api/fallback") or []
        try:
            routing = self.api.get("/api/fallback/routing") or {}
        except Exception:  # noqa: BLE001 — chain still renders without routing
            routing = {}
        try:
            retry = self.api.get("/api/fallback/retry-limit") or {}
        except Exception:  # noqa: BLE001
            retry = {}
        return chain, routing, retry

    def _apply(self, result):
        self.set_loading(False)
        chain, routing, retry = result
        self._block_signals(True)
        strategy = routing.get("strategy") if isinstance(routing, dict) else None
        if strategy in STRATEGIES:
            self.strategy_box.setCurrentText(strategy)
        limit = retry.get("limit") if isinstance(retry, dict) else None
        if isinstance(limit, int):
            self.retry_spin.setValue(limit)
        self._block_signals(False)

        rows = chain if isinstance(chain, list) else (
            chain.get("chain", chain.get("models", [])) if isinstance(chain, dict) else []
        )
        self._block_signals(True)
        self.list.clear()
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            label = row.get("displayName") or row.get("modelId") or row.get("model") or "?"
            platform = row.get("platform", "")
            enabled = bool(row.get("enabled", True))
            priority = row.get("priority")
            db_id = row.get("modelDbId", row.get("id"))
            item = QListWidgetItem(f"{label}  ·  {platform}")
            item.setData(Qt.ItemDataRole.UserRole, {
                "id": db_id, "priority": priority, "enabled": enabled,
                "label": label, "platform": platform,
            })
            # Checkable = the per-row enable toggle; checked state mirrors
            # `enabled` so save round-trips it.
            item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            item.setCheckState(
                Qt.CheckState.Checked if enabled else Qt.CheckState.Unchecked
            )
            self.list.addItem(item)
        self._block_signals(False)
        self._apply_filter()

    def _block_signals(self, blocked: bool) -> None:
        self.strategy_box.blockSignals(blocked)
        self.retry_spin.blockSignals(blocked)
        self.list.blockSignals(blocked)

    # -- controls -----------------------------------------------------------

    def _strategy_changed(self, strategy: str):
        self.call_in_background(
            lambda: self.api.put("/api/fallback/routing", json={"strategy": strategy}),
            on_success=lambda _r: Toaster.show(f"Routing strategy: {strategy}", "success"),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _retry_changed(self, limit: int):
        self.call_in_background(
            lambda: self.api.put("/api/fallback/retry-limit", json={"limit": limit}),
            on_success=lambda _r: Toaster.show("Retry limit saved", "success"),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    # -- chain editing --------------------------------------------------------

    def _row_toggled(self, item: QListWidgetItem):
        meta = item.data(Qt.ItemDataRole.UserRole) or {}
        meta["enabled"] = item.checkState() == Qt.CheckState.Checked
        item.setData(Qt.ItemDataRole.UserRole, meta)
        if not meta.get("enabled"):
            item.setForeground(self.palette().placeholderText())
        else:
            item.setForeground(self.palette().text())
        Toaster.info("Enable/disable staged — press Save order to apply")

    def _apply_filter(self, text: str | None = None):
        """Case-insensitive live filter on label / platform."""
        needle = (text if text is not None else self.filter_edit.text()).strip().lower()
        for i in range(self.list.count()):
            item = self.list.item(i)
            meta = item.data(Qt.ItemDataRole.UserRole) or {}
            hay = f"{meta.get('label', '')} {meta.get('platform', '')}".lower()
            item.setHidden(bool(needle) and needle not in hay)

    # -- save -----------------------------------------------------------------

    def _save(self):
        payload = []
        for i in range(self.list.count()):
            item = self.list.item(i)
            meta = item.data(Qt.ItemDataRole.UserRole) or {}
            entry = {"modelDbId": meta.get("id"), "priority": i + 1, "enabled": meta.get("enabled", True)}
            payload.append(entry)
        self.call_in_background(
            # The server's PUT /api/fallback schema is a bare JSON ARRAY of
            # chain entries — an object wrapper fails validation and the
            # drag-ordered chain could never be saved.
            lambda: self.api.put("/api/fallback", json=payload),
            on_success=lambda _r: (Toaster.show("Fallback chain saved", "success"), self.refresh()),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _sort(self, preset: str):
        self.call_in_background(
            lambda: self.api.post(f"/api/fallback/sort/{preset}"),
            on_success=lambda _r: self.refresh(),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )
