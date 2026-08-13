"""QTableWidget tweaks for a cleaner, modern look."""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QAbstractItemView, QHeaderView, QTableWidget, QTableWidgetItem

from ..theme import THEME_BUS, palette


def _table_qss() -> str:
    p = palette()
    return (
        f"QTableWidget {{"
        f"  background: {p['base']};"
        f"  alternate-background-color: {p['surface0']};"
        f"  border: none;"
        f"}}"
        f"QTableWidget::item {{ padding: 8px 12px; border: none; }}"
        f"QHeaderView::section {{ padding: 10px 12px; }}"
    )


_themed_tables: list = []


def _register_for_theme(table: QTableWidget) -> None:
    if table not in _themed_tables:
        _themed_tables.append(table)
        THEME_BUS.changed.connect(lambda _d, t=table: t.isWidgetType() and t.setStyleSheet(_table_qss()))


def configure_table(table: QTableWidget, headers: list[str]) -> None:
    table.setColumnCount(len(headers))
    table.setHorizontalHeaderLabels(headers)
    table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
    table.horizontalHeader().setStretchLastSection(True)
    table.horizontalHeader().setDefaultAlignment(Qt.AlignmentFlag.AlignLeft)
    table.verticalHeader().setVisible(False)
    table.verticalHeader().setDefaultSectionSize(36)
    table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
    table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
    table.setAlternatingRowColors(True)
    table.setShowGrid(False)
    table.setFrameShape(QTableWidget.Shape.NoFrame)
    table.setStyleSheet(_table_qss())
    _register_for_theme(table)


def fill_table(table: QTableWidget, rows: list[list[object]]) -> None:
    table.setRowCount(0)
    table.setRowCount(len(rows))
    for r, row in enumerate(rows):
        for c, value in enumerate(row):
            item = QTableWidgetItem("" if value is None else str(value))
            item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            table.setItem(r, c, item)
