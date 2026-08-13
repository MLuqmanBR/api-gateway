"""Sidebar with icons + section labels, matching modern Linux app nav."""

from __future__ import annotations

from PyQt6.QtCore import QSize, Qt, pyqtSignal
from PyQt6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..icons import icon
from ..theme import THEME_BUS, palette


class Sidebar(QWidget):
    page_selected = pyqtSignal(int)

    def __init__(self, page_names: list[str], icon_names: list[str] | None = None, parent=None):
        super().__init__(parent)
        self.setObjectName("sidebar")
        self.setFixedWidth(224)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 12, 0, 12)
        layout.setSpacing(0)

        # Brand mark
        brand = QWidget()
        brand_layout = QHBoxLayout(brand)
        brand_layout.setContentsMargins(16, 4, 16, 14)
        brand_layout.setSpacing(10)
        dot = QLabel("◆")
        dot.setObjectName("brandDot")
        brand_layout.addWidget(dot)
        name = QLabel("API Gateway")
        name.setStyleSheet("font-weight: 800; font-size: 15px;")
        brand_layout.addWidget(name)
        brand_layout.addStretch()
        layout.addWidget(brand)

        self.list = QListWidget()
        self.list.setObjectName("nav")
        self.list.setIconSize(QSize(20, 20))
        self.list.setSpacing(2)
        self.list.setVerticalScrollMode(QListWidget.ScrollMode.ScrollPerPixel)

        # WORKSPACE pages first (Dashboard, Analytics, Keys, Budget, Playground),
        # then an "ADVANCED" section (Fallback, Embeddings, Privacy, Settings).
        sections = [(0, "WORKSPACE"), (5, "ADVANCED")]
        inserted_sections: set[str] = set()
        for i, name in enumerate(page_names):
            for section_at, label in sections:
                if i == section_at and label not in inserted_sections:
                    header = QListWidgetItem()
                    header.setFlags(Qt.ItemFlag.NoItemFlags)
                    header.setSizeHint(QSize(0, 22))
                    self.list.addItem(header)
                    w = QLabel(label)
                    w.setObjectName("navSection")
                    self.list.setItemWidget(header, w)
                    inserted_sections.add(label)
            item = QListWidgetItem(name)
            if icon_names and i < len(icon_names):
                item.setIcon(icon(icon_names[i]))
            self.list.addItem(item)

        # Map sidebar row → page index (rows include section headers).
        self._mapping: list[int] = []
        page_i = 0
        for row in range(self.list.count()):
            item = self.list.item(row)
            if item.flags() & Qt.ItemFlag.ItemIsSelectable:
                self._mapping.append(page_i)
                page_i += 1
            else:
                self._mapping.append(-1)

        self.list.currentRowChanged.connect(self._row_changed)
        layout.addWidget(self.list, 1)

        # Footer
        footer = QWidget()
        f = QVBoxLayout(footer)
        f.setContentsMargins(16, 8, 16, 8)
        hint = QLabel("Powered by your gateway")
        hint.setObjectName("navHint")
        f.addWidget(hint)
        layout.addWidget(footer)

        # Select the first *real* page row.
        self.set_current(0)
        self._apply_style()
        THEME_BUS.changed.connect(lambda _d: self._apply_style())

    # ------------------------------------------------------------------ slots

    def _row_changed(self, row: int) -> None:
        if row < 0 or row >= len(self._mapping):
            return
        page_index = self._mapping[row]
        if page_index >= 0:
            self.page_selected.emit(page_index)

    def set_current(self, page_index: int) -> None:
        try:
            row = self._mapping.index(page_index)
        except ValueError:
            return
        self.list.blockSignals(True)
        self.list.setCurrentRow(row)
        self.list.blockSignals(False)

    # ------------------------------------------------------------------ theming

    def _apply_style(self) -> None:
        p = palette()
        dot = self.findChild(QLabel, "brandDot")
        if dot:
            dot.setStyleSheet(f"color: {p['blue']}; font-size: 20px;")
        hint = self.findChild(QLabel, "navHint")
        if hint:
            hint.setStyleSheet(f"color: {p['muted']}; font-size: 11.5px;")
