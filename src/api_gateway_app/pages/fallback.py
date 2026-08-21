"""Fallback chain editor: drag-and-drop model routing order."""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QVBoxLayout,
)

from ..widgets.toast import Toaster
from .base import BasePage


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
        layout.addWidget(self.list, 1)

    def on_show(self):
        self.refresh()

    def refresh(self):
        self.set_loading(True)
        self.call_in_background(
            lambda: self.api.get("/api/fallback"),
            on_success=self._apply,
        )

    def _apply(self, data):
        self.set_loading(False)
        rows = data if isinstance(data, list) else data.get("chain", data.get("models", [])) if isinstance(data, dict) else []
        self.list.clear()
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            label = row.get("displayName") or row.get("modelId") or row.get("model") or "?"
            platform = row.get("platform", "")
            enabled = bool(row.get("enabled", True))
            priority = row.get("priority")
            db_id = row.get("modelDbId", row.get("id"))
            item = QListWidgetItem(f"{label}  ·  {platform}" + ("" if enabled else "  (disabled)"))
            item.setData(Qt.ItemDataRole.UserRole, {"id": db_id, "priority": priority, "enabled": enabled})
            if not enabled:
                item.setForeground(self.palette().placeholderText())
            self.list.addItem(item)

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
